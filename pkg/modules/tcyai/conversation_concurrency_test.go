// Vikunja is a to-do list application to facilitate your life.
// Copyright 2018-present Vikunja and contributors. All rights reserved.
//
// This program is free software: you can redistribute it and/or modify
// it under the terms of the GNU Affero General Public License as published by
// the Free Software Foundation, either version 3 of the License, or
// (at your option) any later version.
//
// This program is distributed in the hope that it will be useful,
// but WITHOUT ANY WARRANTY; without even the implied warranty of
// MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE.  See the
// GNU Affero General Public License for more details.
//
// You should have received a copy of the GNU Affero General Public License
// along with this program.  If not, see <https://www.gnu.org/licenses/>.

package tcyai

import (
	"context"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/user"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func concurrentSignal(t *testing.T, signal <-chan string) string {
	t.Helper()
	select {
	case value := <-signal:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("model request did not reach the expected lifecycle barrier")
		return ""
	}
}

func concurrentConversation(t *testing.T, uid int64) Conversation {
	t.Helper()
	chat, err := CreateConversation(uid, "Concurrent conversation")
	require.NoError(t, err)
	record, err := readConversation(uid, chat.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{
		ID:     uuid.NewString(),
		Prompt: "Remember the independent goal",
		Status: "completed",
		Result: RunResult{Reply: "A confirmed result"},
	}}
	record.Contexts = [][]storedMessage{{}}
	require.NoError(t, writeConversation(uid, record))
	return cloneConversation(record)
}

func concurrentLive(t *testing.T, id string) *liveConversation {
	t.Helper()
	conversations.Lock()
	defer conversations.Unlock()
	for _, live := range conversations.live {
		if live.uid == 1 && live.id == id {
			return live
		}
	}
	t.Fatal("conversation has no live job")
	return nil
}

func TestTCYAIConversationConcurrentJobs(t *testing.T) {
	for _, operation := range []string{
		"execute",
		"compact",
	} {
		t.Run(operation, func(t *testing.T) {
			steeringFixture(t)
			a, b, idle := concurrentConversation(t, 1), concurrentConversation(t, 1), concurrentConversation(t, 1)
			entered, cancelled := make(chan string, 8), make(chan string, 8)
			releaseA, releaseB, releaseFinal := make(chan struct{}), make(chan struct{}), make(chan struct{})
			var onceA, onceB, onceFinal sync.Once
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				_, _ = io.Copy(io.Discard, r.Body)
				label, release := "a", releaseA
				if strings.HasPrefix(r.URL.Path, "/b/") {
					label, release = "b", releaseB
				} else if strings.HasPrefix(r.URL.Path, "/final/") {
					label, release = "final", releaseFinal
				}
				entered <- label
				select {
				case <-r.Context().Done():
					cancelled <- label
				case <-release:
					steeringResponse(t, w, "An independent checkpoint")
				}
			}))
			t.Cleanup(server.Close)
			var jobs []*liveConversation
			t.Cleanup(func() {
				for _, live := range jobs {
					live.cancel()
				}
				onceA.Do(func() { close(releaseA) })
				onceB.Do(func() { close(releaseB) })
				onceFinal.Do(func() { close(releaseFinal) })
				for _, live := range jobs {
					steeringWait(t, live.done)
					steeringWait(t, live.watchDone)
				}
			})
			connection := func(label string) Connection {
				return Connection{
					Protocol:     "openai-chat",
					BaseURL:      server.URL + "/" + label,
					Model:        "concurrency-fixture",
					NonStreaming: true,
				}
			}
			input := func() RunInput {
				return RunInput{
					Message:   "Continue this conversation only",
					RequestID: uuid.NewString(),
				}
			}
			requestCtx, cancelRequest := context.WithCancel(context.Background())
			t.Cleanup(cancelRequest)
			_, err := CompactConversation(requestCtx, 1, a.ID, connection("a"))
			require.NoError(t, err)
			liveA := concurrentLive(t, a.ID)
			jobs = append(jobs, liveA)
			require.Equal(t, "a", concurrentSignal(t, entered))
			cancelRequest() // Closing the initiating HTTP request must not cancel the durable job.

			_, err = StartConversation(context.Background(), 1, a.ID, input(), connection("a"), nil)
			require.ErrorIs(t, err, ErrConversationBusy)
			_, err = CompactConversation(context.Background(), 1, a.ID, connection("a"))
			require.ErrorIs(t, err, ErrConversationBusy)
			_, err = ReviewConversation(context.Background(), 1, a.ID, ReviewInput{
				TurnID:   a.Turns[0].ID,
				Decision: "retry",
			}, connection("a"), nil, nil)
			require.ErrorIs(t, err, ErrConversationBusy)
			_, err = ForkConversation(1, a.ID, a.Turns[0].ID)
			require.ErrorIs(t, err, ErrConversationBusy)
			require.ErrorIs(t, DeleteConversation(1, a.ID), ErrConversationBusy)
			require.ErrorIs(t, StopConversation(2, a.ID), ErrConversationMissing)

			var started Conversation
			if operation == "compact" {
				started, err = CompactConversation(context.Background(), 1, b.ID, connection("b"))
			} else {
				started, err = StartConversation(context.Background(), 1, b.ID, input(), connection("b"), nil)
			}
			require.NoError(t, err, "a blocked compaction must not reserve another conversation")
			liveB := concurrentLive(t, b.ID)
			jobs = append(jobs, liveB)
			require.Equal(t, "b", concurrentSignal(t, entered))
			assert.True(t, ConversationJobRunning(1, a.ID))
			assert.True(t, ConversationJobRunning(1, b.ID))
			_, err = StartConversation(context.Background(), 1, b.ID, input(), connection("b"), nil)
			require.ErrorIs(t, err, ErrConversationBusy)
			_, err = CompactConversation(context.Background(), 1, b.ID, connection("b"))
			require.ErrorIs(t, err, ErrConversationBusy)
			assert.False(t, ConversationJobRunning(2, a.ID))
			_, err = ForkConversation(1, idle.ID, idle.Turns[0].ID)
			require.NoError(t, err, "an idle conversation may branch while other jobs work")
			if operation == "execute" {
				_, err = SteerConversation(1, b.ID, steeringInput(started.Turns[len(started.Turns)-1].ID, "Keep this instruction in B"))
				require.NoError(t, err)
			}

			require.NoError(t, StopConversation(1, b.ID))
			require.Equal(t, "b", concurrentSignal(t, cancelled))
			steeringWait(t, liveB.done)
			steeringWait(t, liveB.watchDone)
			assert.False(t, ConversationJobRunning(1, b.ID))
			assert.True(t, ConversationJobRunning(1, a.ID))
			select {
			case label := <-cancelled:
				t.Fatalf("stopping B also cancelled %s", label)
			default:
			}
			if operation == "execute" {
				_, err = ReviewConversation(context.Background(), 1, b.ID, ReviewInput{
					TurnID:   started.Turns[len(started.Turns)-1].ID,
					Decision: "retry",
				}, connection("b"), nil, nil)
			} else {
				_, err = CompactConversation(context.Background(), 1, b.ID, connection("b"))
			}
			require.NoError(t, err, "cancelled B must release only its own slot")
			restartedB := concurrentLive(t, b.ID)
			jobs = append(jobs, restartedB)
			require.Equal(t, "b", concurrentSignal(t, entered))
			onceB.Do(func() { close(releaseB) })
			steeringWait(t, restartedB.done)
			assert.False(t, ConversationJobRunning(1, b.ID))
			assert.True(t, ConversationJobRunning(1, a.ID))
			onceA.Do(func() { close(releaseA) })
			steeringWait(t, liveA.done)
			assert.False(t, ConversationJobRunning(1, a.ID))
			_, err = StartConversation(context.Background(), 1, a.ID, input(), connection("final"), nil)
			require.NoError(t, err, "completed A must release its slot")
			finalA := concurrentLive(t, a.ID)
			jobs = append(jobs, finalA)
			require.Equal(t, "final", concurrentSignal(t, entered))
			onceFinal.Do(func() { close(releaseFinal) })
			steeringWait(t, finalA.done)
			steeringWait(t, finalA.watchDone)
		})
	}
}

func TestTCYAIAccountCleanupCancelsConcurrentConversations(t *testing.T) {
	const uid int64 = 91130
	engine := accountCleanupFixture(t, uid)
	a, b := concurrentConversation(t, uid), concurrentConversation(t, uid)
	entered, cancelled := make(chan string, 4), make(chan string, 4)
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
		_, _ = io.Copy(io.Discard, request.Body)
		entered <- request.URL.Path
		<-request.Context().Done()
		cancelled <- request.URL.Path
	}))
	t.Cleanup(server.Close)
	connection := Connection{
		Protocol:     "openai-chat",
		BaseURL:      server.URL,
		Model:        "account-concurrency-fixture",
		NonStreaming: true,
	}
	_, err := CompactConversation(context.Background(), uid, a.ID, connection)
	require.NoError(t, err)
	conversations.Lock()
	liveA := conversations.live[liveKey(uid, a.ID)]
	conversations.Unlock()
	t.Cleanup(liveA.cancel)
	concurrentSignal(t, entered)
	_, err = StartConversation(context.Background(), uid, b.ID, RunInput{
		Message:   "Continue independently",
		RequestID: uuid.NewString(),
	}, connection, nil)
	require.NoError(t, err)
	conversations.Lock()
	liveB := conversations.live[liveKey(uid, b.ID)]
	conversations.Unlock()
	t.Cleanup(liveB.cancel)
	concurrentSignal(t, entered)
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	concurrentSignal(t, cancelled)
	concurrentSignal(t, cancelled)
	for _, live := range []*liveConversation{
		liveA,
		liveB,
	} {
		steeringWait(t, live.done)
		steeringWait(t, live.watchDone)
		assert.False(t, ConversationJobRunning(uid, live.id))
		_, err = GetConversation(uid, live.id)
		require.ErrorIs(t, err, ErrAccountDeleted)
	}
	assert.NoDirExists(t, conversationDir(uid), "late callbacks must not recreate either conversation")
	conversations.Lock()
	defer conversations.Unlock()
	for key := range conversations.live {
		assert.NotEqual(t, uid, key.uid)
	}
}
