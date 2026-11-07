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
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIAccountSuspensionStopsWithoutDeletingHistory(t *testing.T) {
	for index, external := range []bool{false, true} {
		t.Run(fmt.Sprintf("external-suspension-%t", external), func(t *testing.T) {
			uid := int64(91220 + index)
			engine := accountCleanupFixture(t, uid)
			a, b := concurrentConversation(t, uid), concurrentConversation(t, uid)
			_, err := Save(uid, accountSettings())
			require.NoError(t, err)
			entered, canceled := make(chan string, 4), make(chan string, 4)
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
				_, _ = io.Copy(io.Discard, request.Body)
				requests.Add(1)
				entered <- request.URL.Path
				<-request.Context().Done()
				canceled <- request.URL.Path
			}))
			t.Cleanup(server.Close)
			connection := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "suspension-fixture", NonStreaming: true}
			_, err = CompactConversation(WithAccountRunAdmission(context.Background(), uid), uid, a.ID, connection)
			require.NoError(t, err)
			concurrentSignal(t, entered)
			_, err = StartConversation(WithAccountRunAdmission(context.Background(), uid), uid, b.ID, RunInput{Message: "Keep the original requirement", RequestID: uuid.NewString()}, connection, nil)
			require.NoError(t, err)
			concurrentSignal(t, entered)
			conversations.Lock()
			liveA, liveB := conversations.live[liveKey(uid, a.ID)], conversations.live[liveKey(uid, b.ID)]
			conversations.Unlock()
			require.NotNil(t, liveA)
			require.NotNil(t, liveB)
			t.Cleanup(liveA.cancel)
			t.Cleanup(liveB.cancel)
			if external {
				_, err = engine.ID(uid).Cols("status").Update(&user.User{Status: user.StatusDisabled})
				require.NoError(t, err)
				// A separately committed suspension must be detected by the watcher.
			} else {
				// The operational revoke path also cancels active accounts, which
				// cannot be detected from account status alone.
				CancelAccountRuns(uid)
			}
			concurrentSignal(t, canceled)
			concurrentSignal(t, canceled)
			for _, live := range []*liveConversation{liveA, liveB} {
				steeringWait(t, live.done)
				steeringWait(t, live.watchDone)
				assert.False(t, ConversationJobRunning(uid, live.id))
			}
			assert.EqualValues(t, 2, requests.Load(), "stopped jobs never begin another model call")
			assert.False(t, accountDeleted(uid), "suspension/revocation must not set the permanent deletion fence")
			assert.FileExists(t, fileFor(uid))
			assert.DirExists(t, conversationDir(uid))
			_, err = engine.ID(uid).Cols("status").Update(&user.User{Status: user.StatusActive})
			require.NoError(t, err)
			compacted, err := GetConversation(uid, a.ID)
			require.NoError(t, err)
			assert.False(t, compacted.Compacting)
			assert.NotEmpty(t, compacted.CompactError)
			restored, err := GetConversation(uid, b.ID)
			require.NoError(t, err)
			require.Len(t, restored.Turns, 2)
			assert.Equal(t, "A confirmed result", restored.Turns[0].Result.Reply)
			assert.Equal(t, "stopped", restored.Turns[1].Status)
			assert.Equal(t, "Keep the original requirement", restored.Turns[1].Prompt)
			_, err = Load(uid)
			require.NoError(t, err)
			assert.False(t, ConversationJobRunning(uid, b.ID), "reactivation does not restart jobs")
		})
	}
}
