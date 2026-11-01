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
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func steeringFixture(t *testing.T) {
	t.Helper()
	oldPath, oldSecret, oldLocal := config.FilesBasePath.GetString(), config.ServiceSecret.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("steering-fixture-encryption-secret")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldLocal)
	})
}

func steeringWait(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(8 * time.Second):
		t.Fatal("timed out waiting for deterministic steering barrier")
	}
}

func steeringResponse(t *testing.T, w http.ResponseWriter, content string) {
	t.Helper()
	w.Header().Set("Content-Type", "application/json")
	message := map[string]any{"role": "assistant", "content": content}
	assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 3}}))
}

func steeringStart(t *testing.T, c Connection, execute Executor, prepare Preparer) (Conversation, *liveConversation) {
	t.Helper()
	chat, err := CreateConversation(1, "steering")
	require.NoError(t, err)
	chat, err = StartConversation(context.Background(), 1, chat.ID, RunInput{Message: "ORIGINAL_GOAL", RequestID: uuid.NewString(), Mode: "write", Approval: "auto", MaxRounds: 16, MaxOperations: 40, TimeoutSeconds: 180}, c, execute, prepare)
	require.NoError(t, err)
	conversations.Lock()
	live := conversations.live[1]
	conversations.Unlock()
	require.NotNil(t, live)
	t.Cleanup(func() { live.cancel(); steeringWait(t, live.done); steeringWait(t, live.watchDone) })
	return chat, live
}

func steeringInput(turnID, message string) SteeringInput {
	return SteeringInput{TurnID: turnID, RequestID: uuid.NewString(), Message: message}
}

func TestTCYAISteeringModelBoundaryAndIdempotency(t *testing.T) {
	steeringFixture(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	var requests atomic.Int32
	bodies := make(chan []Message, 3)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []Message `json:"messages"`
		}
		if json.NewDecoder(r.Body).Decode(&body) != nil {
			w.WriteHeader(400)
			return
		}
		bodies <- body.Messages
		if requests.Add(1) == 1 {
			close(entered)
			select {
			case <-release:
			case <-r.Context().Done():
				return
			}
		}
		steeringResponse(t, w, "answer")
	}))
	t.Cleanup(server.Close)
	c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
	chat, live := steeringStart(t, c, nil, nil)
	steeringWait(t, entered)
	first, second := steeringInput(chat.Turns[0].ID, "FIRST_ADDITION"), steeringInput(chat.Turns[0].ID, "SECOND_ADDITION")
	accepted, err := SteerConversation(1, chat.ID, first)
	require.NoError(t, err)
	require.Equal(t, "pending", accepted.Turns[0].Steering[0].Status)
	_, err = SteerConversation(2, chat.ID, first)
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = SteerConversation(1, chat.ID, second)
	require.NoError(t, err)
	duplicate, err := SteerConversation(1, chat.ID, first)
	require.NoError(t, err)
	require.Len(t, duplicate.Turns[0].Steering, 2)
	changed := first
	changed.Message = "different"
	_, err = SteerConversation(1, chat.ID, changed)
	require.ErrorIs(t, err, ErrConversationRequest)
	path, err := conversationPath(1, chat.ID)
	require.NoError(t, err)
	encrypted, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.NotContains(t, string(encrypted), first.Message)
	duplicate.Turns[0].Steering[0].Message = "client mutation"
	releaseOnce.Do(func() { close(release) })
	steeringWait(t, live.done)
	result, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	require.Equal(t, "completed", result.Turns[0].Status)
	assert.EqualValues(t, 2, requests.Load())
	<-bodies
	after := <-bodies
	serialized, err := json.Marshal(after)
	require.NoError(t, err)
	assert.Equal(t, 1, strings.Count(string(serialized), "ORIGINAL_GOAL"))
	assert.Equal(t, 1, strings.Count(string(serialized), first.Message))
	assert.Equal(t, 1, strings.Count(string(serialized), second.Message))
	assert.Less(t, strings.Index(string(serialized), first.Message), strings.Index(string(serialized), second.Message))
	for _, entry := range result.Turns[0].Steering {
		assert.Equal(t, "applied", entry.Status)
		assert.NotNil(t, entry.AppliedAt)
	}
	assert.Equal(t, "ORIGINAL_GOAL", result.Turns[0].Prompt)
	assert.Equal(t, 16, result.Turns[0].Result.Budget.RoundLimit)
	_, err = SteerConversation(1, chat.ID, first)
	require.NoError(t, err, "late identical retry returns durable receipt")
	_, err = SteerConversation(1, chat.ID, steeringInput(chat.Turns[0].ID, "too late"))
	require.ErrorIs(t, err, ErrSteeringUnavailable)
	found, err := SearchConversations(1, "second_addition", "all")
	require.NoError(t, err)
	require.Len(t, found, 1)
}

func steeringRecord(t *testing.T) (*conversationFile, *AgentState, *liveConversation) {
	t.Helper()
	chat, err := CreateConversation(1, "manual steering boundary")
	require.NoError(t, err)
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	state := NewAgentState(context.Background(), Connection{Model: "fixture"}, RunInput{Message: "ORIGINAL_GOAL", Mode: "write", Approval: "auto"})
	state.Result.Stage = "model"
	record.Turns = []ChatTurn{{ID: uuid.NewString(), Prompt: state.Input.Message, Status: "running", Started: time.Now().UTC(), Result: publicResult(state.Result)}}
	record.States = []*AgentState{snapshotAgentState(state)}
	record.Contexts = [][]storedMessage{{}}
	require.NoError(t, writeConversation(1, record))
	live := &liveConversation{uid: 1, id: record.ID, record: record, cancel: func() {}, acceptingSteering: true, storeRoot: accountKey(1).root}
	conversations.Lock()
	conversations.live[1] = live
	conversations.Unlock()
	t.Cleanup(func() { conversations.Lock(); delete(conversations.live, 1); conversations.Unlock() })
	return record, state, live
}

func TestTCYAISteeringAtomicFinalFenceAndPersistenceFailure(t *testing.T) {
	steeringFixture(t)
	record, state, live := steeringRecord(t)
	in := steeringInput(record.Turns[0].ID, "late final correction")
	_, err := SteerConversation(1, record.ID, in)
	require.NoError(t, err)
	state.Result.Reply = "old final answer"
	state.Result.Stage = "completed"
	control := conversationControl(1, live, 0)
	originalWrite := accountWrite
	accountWrite = func(int64, func() error) error { return errors.New("disk unavailable") }
	changed, err := control.Complete(state)
	accountWrite = originalWrite
	require.Error(t, err)
	assert.False(t, changed)
	assert.Empty(t, state.AppliedSteering)
	assert.Equal(t, "pending", record.Turns[0].Steering[0].Status)
	assert.Equal(t, "old final answer", state.Result.Reply)
	changed, err = control.Complete(state)
	require.NoError(t, err)
	require.True(t, changed)
	assert.Empty(t, state.Result.Reply, "old final answer cannot survive a redirected run failure")
	assert.True(t, live.acceptingSteering)
	require.True(t, completeToolHistory(state.Messages))
	changed, err = control.Complete(state)
	require.NoError(t, err)
	assert.False(t, changed)
	assert.False(t, live.acceptingSteering)
	_, err = SteerConversation(1, record.ID, steeringInput(in.TurnID, "after completion fence"))
	require.ErrorIs(t, err, ErrSteeringUnavailable)
	snapshot := cloneConversation(record)
	*snapshot.Turns[0].Steering[0].AppliedAt = time.Time{}
	assert.False(t, record.Turns[0].Steering[0].AppliedAt.IsZero())
}

func TestTCYAISteeringAcceptFailureAndStopFence(t *testing.T) {
	steeringFixture(t)
	record, _, live := steeringRecord(t)
	in := steeringInput(record.Turns[0].ID, "keep after explicit stop")
	originalWrite := accountWrite
	accountWrite = func(int64, func() error) error { return errors.New("disk unavailable") }
	_, err := SteerConversation(1, record.ID, in)
	accountWrite = originalWrite
	require.Error(t, err)
	assert.Empty(t, record.Turns[0].Steering)
	_, err = SteerConversation(1, record.ID, in)
	require.NoError(t, err)
	require.NoError(t, StopConversation(1, record.ID))
	assert.False(t, live.acceptingSteering)
	_, err = SteerConversation(1, record.ID, steeringInput(in.TurnID, "must not accept"))
	require.ErrorIs(t, err, ErrSteeringUnavailable)
	_, err = SteerConversation(1, record.ID, in)
	require.NoError(t, err, "retry of an accepted receipt remains idempotent after stop")
	assert.Equal(t, "pending", record.Turns[0].Steering[0].Status)
}

func steeringCall(id, name, arguments string) ToolCall {
	return ToolCall{ID: id, Type: "function", Function: FunctionCall{Name: name, Arguments: arguments}}
}

func TestTCYAISteeringReplansToolBatchAtDurableBoundary(t *testing.T) {
	for _, beforeIntent := range []bool{true, false} {
		t.Run(map[bool]string{true: "during prepare", false: "during first execution"}[beforeIntent], func(t *testing.T) {
			steeringFixture(t)
			entered, release := make(chan struct{}), make(chan struct{})
			var once sync.Once
			defer once.Do(func() { close(release) })
			observed := make(chan []Message, 1)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Messages []Message `json:"messages"`
				}
				_ = json.NewDecoder(r.Body).Decode(&body)
				observed <- body.Messages
				steeringResponse(t, w, "replanned answer")
			}))
			t.Cleanup(server.Close)
			c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
			record, _, _ := steeringRecord(t)
			state := NewAgentState(context.Background(), c, RunInput{Message: "ORIGINAL_GOAL", Mode: "write", Approval: "auto"})
			state.Available = append(state.Available, "create_task")
			calls := []ToolCall{steeringCall("first", "create_task", `{"project_id":1,"title":"first"}`), steeringCall("second", "create_task", `{"project_id":1,"title":"second"}`)}
			state.appendMessage(Message{Role: "assistant", ToolCalls: calls})
			state.Pending = calls
			record.States[0] = state
			var writes atomic.Int32
			var prepared atomic.Int32
			wait := func(ctx context.Context) {
				close(entered)
				select {
				case <-release:
				case <-ctx.Done():
				}
			}
			execute := func(ctx context.Context, _ string, _ json.RawMessage) (string, error) {
				if writes.Add(1) == 1 && !beforeIntent {
					wait(ctx)
				}
				return `{"id":123}`, nil
			}
			prepare := func(ctx context.Context, _ string, _ json.RawMessage) (Operation, error) {
				if prepared.Add(1) == 1 && beforeIntent {
					wait(ctx)
				}
				return Operation{Units: 1, ProjectIDs: []int64{1}}, nil
			}
			conversations.Lock()
			launchConversation(context.Background(), 1, record, 0, c, execute, prepare)
			live := conversations.live[1]
			conversations.Unlock()
			t.Cleanup(func() { live.cancel(); steeringWait(t, live.done); steeringWait(t, live.watchDone) })
			steeringWait(t, entered)
			_, err := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "DO_NOT_CREATE_THE_SECOND_TASK"))
			require.NoError(t, err)
			once.Do(func() { close(release) })
			steeringWait(t, live.done)
			result, err := GetConversation(1, record.ID)
			require.NoError(t, err)
			require.Equal(t, "completed", result.Turns[0].Status)
			expected := int32(1)
			if beforeIntent {
				expected = 0
			}
			assert.Equal(t, expected, writes.Load(), "already running operation settles once; uncommitted operations must not run")
			assert.Equal(t, int(expected), result.Turns[0].Result.Budget.Operations)
			msgs := <-observed
			stored := make([]storedMessage, len(msgs))
			for i, m := range msgs {
				stored[i] = storedMessage{Message: m}
			}
			assert.True(t, completeToolHistory(stored), "every cancelled provider call still has one tool response")
			data, err := json.Marshal(msgs)
			require.NoError(t, err)
			assert.Contains(t, string(data), "ORIGINAL_GOAL")
			assert.Contains(t, string(data), "DO_NOT_CREATE_THE_SECOND_TASK")
			assert.Contains(t, string(data), "STEERING_REPLAN")
			assert.Equal(t, "rejected", result.Turns[0].Result.Operations[len(calls)-1].Status)
		})
	}
}

func TestTCYAISteeringIntentAndPauseRace(t *testing.T) {
	for _, name := range []string{"intent", "review", "question"} {
		t.Run(name, func(t *testing.T) {
			steeringFixture(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { steeringResponse(t, w, "new plan") }))
			t.Cleanup(server.Close)
			c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
			record, _, live := steeringRecord(t)
			state := NewAgentState(context.Background(), c, RunInput{Message: "ORIGINAL_GOAL", Mode: "write", Approval: "auto"})
			call := steeringCall("old-plan", "create_task", `{"project_id":1,"title":"obsolete"}`)
			if name == "review" {
				state.Input.Approval = "review"
			}
			if name == "question" {
				call = steeringCall("old-question", "ask_user", `{"question":"obsolete question","choices":["yes","no"]}`)
			}
			state.Available = append(state.Available, call.Function.Name)
			state.appendMessage(Message{Role: "assistant", ToolCalls: []ToolCall{call}})
			state.Pending = []ToolCall{call}
			record.States[0] = snapshotAgentState(state)
			control := conversationControl(1, live, 0)
			actual := control.Boundary
			checks := 0
			control.Boundary = func(s *AgentState) (bool, error) {
				changed, err := actual(s)
				checks++
				if checks == 3 {
					_, acceptErr := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "CORRECTION_AFTER_CHECK"))
					require.NoError(t, acceptErr)
				}
				return changed, err
			}
			writes := 0
			result, err := RunAgent(context.Background(), c, state, func(context.Context, string, json.RawMessage) (string, error) { writes++; return "{}", nil }, nil, func(s *AgentState) error { return checkpointConversation(1, live, 0, s) }, control)
			require.NoError(t, err)
			assert.Zero(t, writes)
			assert.Equal(t, "new plan", result.Reply)
			assert.True(t, completeToolHistory(state.Messages))
			assert.Empty(t, result.Pause)
			assert.Nil(t, result.Pending)
			assert.Len(t, state.AppliedSteering, 1)
			assert.Zero(t, result.Budget.Operations, "cancelled intent must refund the unexecuted operation unit")
		})
	}
}

func TestTCYAISteeringCancelledCallsAreNotNoProgress(t *testing.T) {
	steeringFixture(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { requests.Add(1); steeringResponse(t, w, "updated plan") }))
	t.Cleanup(server.Close)
	c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
	record, _, live := steeringRecord(t)
	state := NewAgentState(context.Background(), c, RunInput{Message: "ORIGINAL_GOAL", Mode: "write", Approval: "auto"})
	calls := make([]ToolCall, 8)
	for i := range calls {
		calls[i] = steeringCall(uuid.NewString(), "create_task", `{"project_id":1,"title":"identical old plan"}`)
	}
	state.Pending = calls
	state.appendMessage(Message{Role: "assistant", ToolCalls: calls})
	record.States[0] = snapshotAgentState(state)
	_, err := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "REPLAN_ALL_EIGHT"))
	require.NoError(t, err)
	writes := 0
	_, err = RunAgent(context.Background(), c, state, func(context.Context, string, json.RawMessage) (string, error) { writes++; return "{}", nil }, nil, func(s *AgentState) error { return checkpointConversation(1, live, 0, s) }, conversationControl(1, live, 0))
	require.NoError(t, err)
	assert.Zero(t, writes)
	assert.EqualValues(t, 1, requests.Load())
	assert.Len(t, state.Result.Actions, 8)
	assert.True(t, completeToolHistory(state.Messages))
	assert.Len(t, state.AppliedSteering, 1)
}

func TestTCYAISteeringStopRestartAndExplicitRetry(t *testing.T) {
	steeringFixture(t)
	entered := make(chan struct{})
	var requests atomic.Int32
	seen := make(chan []Message, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []Message `json:"messages"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		if requests.Add(1) == 1 {
			close(entered)
			<-r.Context().Done()
			return
		}
		seen <- body.Messages
		steeringResponse(t, w, "resumed")
	}))
	t.Cleanup(server.Close)
	c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
	chat, live := steeringStart(t, c, nil, nil)
	steeringWait(t, entered)
	in := steeringInput(chat.Turns[0].ID, "PERSIST_THROUGH_STOP")
	_, err := SteerConversation(1, chat.ID, in)
	require.NoError(t, err)
	require.NoError(t, StopConversation(1, chat.ID))
	steeringWait(t, live.done)
	stopped, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	require.Equal(t, "stopped", stopped.Turns[0].Status)
	require.True(t, stopped.Turns[0].Retryable)
	require.Equal(t, "pending", stopped.Turns[0].Steering[0].Status)
	// A fresh disk read represents the restart path; no implicit execution happens.
	restored, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, retryableTurn(restored, 0))
	assert.EqualValues(t, 1, requests.Load())
	_, err = ReviewConversation(context.Background(), 1, chat.ID, ReviewInput{TurnID: in.TurnID, Decision: "retry"}, c, nil, nil)
	require.NoError(t, err)
	conversations.Lock()
	retry := conversations.live[1]
	conversations.Unlock()
	require.NotNil(t, retry)
	t.Cleanup(func() { retry.cancel(); steeringWait(t, retry.done); steeringWait(t, retry.watchDone) })
	steeringWait(t, retry.done)
	completed, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.Equal(t, "completed", completed.Turns[0].Status)
	body, err := json.Marshal(<-seen)
	require.NoError(t, err)
	assert.Contains(t, string(body), "ORIGINAL_GOAL")
	assert.Equal(t, 1, strings.Count(string(body), in.Message))
	assert.Equal(t, "applied", completed.Turns[0].Steering[0].Status)
}

func TestTCYAISteeringCompactionAndHistory(t *testing.T) {
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "summary succeeds", true: "summary fails"}[fail], func(t *testing.T) {
			steeringFixture(t)
			record, state, live := steeringRecord(t)
			first := steeringInput(record.Turns[0].ID, "APPLIED_CONSTRAINT")
			_, err := SteerConversation(1, record.ID, first)
			require.NoError(t, err)
			control := conversationControl(1, live, 0)
			changed, err := control.Boundary(state)
			require.NoError(t, err)
			require.True(t, changed)
			state.appendMessage(Message{Role: "assistant", Content: strings.Repeat("historical detail ", 6000)})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				_, steerErr := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "ARRIVED_DURING_COMPACT"))
				assert.NoError(t, steerErr)
				if fail {
					w.WriteHeader(http.StatusBadRequest)
					return
				}
				steeringResponse(t, w, "Small historical checkpoint.")
			}))
			t.Cleanup(server.Close)
			c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
			err = state.autoCompact(context.Background(), c, func() error { return checkpointConversation(1, live, 0, state) }, true)
			if fail {
				require.Error(t, err)
			} else {
				require.NoError(t, err)
			}
			assert.Equal(t, "ORIGINAL_GOAL", state.Input.Message)
			assert.Equal(t, "pending", record.Turns[0].Steering[1].Status)
			changed, err = control.Boundary(state)
			require.NoError(t, err)
			require.True(t, changed)
			body, err := json.Marshal(state.messages())
			require.NoError(t, err)
			assert.Contains(t, string(body), "ORIGINAL_GOAL")
			assert.Equal(t, 1, strings.Count(string(body), "APPLIED_CONSTRAINT"))
			assert.Equal(t, 1, strings.Count(string(body), "ARRIVED_DURING_COMPACT"))
			assert.Len(t, state.AppliedSteering, 2)
		})
	}
}

//nolint:gosmopolitan // Verify the existing bilingual Markdown export headings with their actual timestamps.
func TestTCYAISteeringHistoryForkAndExport(t *testing.T) {
	steeringFixture(t)
	record, _, _ := steeringRecord(t)
	stamp := time.Date(2026, 11, 1, 20, 30, 0, 0, time.UTC)
	record.Created = stamp
	record.Turns[0].Started = stamp
	record.Turns[0].Finished = &stamp
	record.Turns[0].Status = "failed"
	record.Turns[0].Result.Reply = "historical answer"
	record.Turns[0].Steering = []SteeringInstruction{{ID: uuid.NewString(), RequestID: uuid.NewString(), Message: "VERBATIM_PENDING", Created: stamp, Status: "pending"}}
	history, _, err := conversationHistory(record, Connection{Model: "different-model"})
	require.NoError(t, err)
	raw, err := json.Marshal(history)
	require.NoError(t, err)
	assert.Contains(t, string(raw), "ORIGINAL_GOAL")
	assert.Contains(t, string(raw), "VERBATIM_PENDING")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []Message `json:"messages"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		data, marshalErr := json.Marshal(body.Messages)
		assert.NoError(t, marshalErr)
		assert.Contains(t, string(data), "VERBATIM_PENDING")
		steeringResponse(t, w, "Checkpoint preserving outstanding correction.")
	}))
	t.Cleanup(server.Close)
	_, _, _, err = summarizeConversation(context.Background(), record, Connection{BaseURL: server.URL, Protocol: "openai-chat", NonStreaming: true}, 1, nil)
	require.NoError(t, err)
	require.NoError(t, writeConversation(1, record))
	conversations.Lock()
	delete(conversations.live, 1)
	conversations.Unlock()
	fork, err := ForkConversation(1, record.ID, record.Turns[0].ID)
	require.NoError(t, err)
	assert.Equal(t, record.Turns[0].Steering, fork.Turns[0].Steering)
	md := conversationMarkdown(fork, nil)
	assert.Contains(t, md, "VERBATIM_PENDING")
	assert.Contains(t, md, "## You / 你 · 2026-11-02 04:30:00 GMT+8")
	assert.Contains(t, md, "## Arona / 阿罗娜 · 2026-11-02 04:30:00 GMT+8")
	assert.Contains(t, md, "### Additional instruction / 补充指令 · 2026-11-02 04:30:00 GMT+8 · pending")
	assert.NotContains(t, conversationMarkdown(Conversation{Turns: []ChatTurn{{Prompt: "undated"}}}, nil), "0001")
	assert.Empty(t, exportTimeSuffix(time.Time{}))
}

func TestTCYAISteeringStopAfterConfirmedTool(t *testing.T) {
	steeringFixture(t)
	record, _, _ := steeringRecord(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var once sync.Once
	defer once.Do(func() { close(release) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { steeringResponse(t, w, "resumed after confirmed write") }))
	t.Cleanup(server.Close)
	c := Connection{BaseURL: server.URL, Model: "fixture", Protocol: "openai-chat", NonStreaming: true}
	state := NewAgentState(context.Background(), c, RunInput{Message: "ORIGINAL_GOAL", Mode: "write", Approval: "auto"})
	state.Available = append(state.Available, "create_task")
	call := steeringCall("confirmed", "create_task", `{"project_id":1,"title":"once"}`)
	state.appendMessage(Message{Role: "assistant", ToolCalls: []ToolCall{call}})
	state.Pending = []ToolCall{call}
	record.States[0] = state
	var writes atomic.Int32
	execute := func(context.Context, string, json.RawMessage) (string, error) {
		writes.Add(1)
		close(entered)
		<-release
		return `{"id":123}`, nil
	}
	conversations.Lock()
	launchConversation(context.Background(), 1, record, 0, c, execute, nil)
	live := conversations.live[1]
	conversations.Unlock()
	t.Cleanup(func() { live.cancel(); steeringWait(t, live.done); steeringWait(t, live.watchDone) })
	steeringWait(t, entered)
	_, err := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "AFTER_CONFIRMED_WRITE"))
	require.NoError(t, err)
	require.NoError(t, StopConversation(1, record.ID))
	once.Do(func() { close(release) })
	steeringWait(t, live.done)
	stopped, err := GetConversation(1, record.ID)
	require.NoError(t, err)
	require.True(t, stopped.Turns[0].Retryable)
	_, err = ReviewConversation(context.Background(), 1, record.ID, ReviewInput{TurnID: record.Turns[0].ID, Decision: "retry"}, c, execute, nil)
	require.NoError(t, err)
	conversations.Lock()
	retry := conversations.live[1]
	conversations.Unlock()
	require.NotNil(t, retry)
	t.Cleanup(func() { retry.cancel(); steeringWait(t, retry.done); steeringWait(t, retry.watchDone) })
	steeringWait(t, retry.done)
	final, err := GetConversation(1, record.ID)
	require.NoError(t, err)
	assert.Equal(t, "completed", final.Turns[0].Status)
	assert.Equal(t, "applied", final.Turns[0].Steering[0].Status)
	assert.EqualValues(t, 1, writes.Load())
}

func TestTCYAISteeringModelIntentRefundsUnsentRound(t *testing.T) {
	steeringFixture(t)
	record, state, live := steeringRecord(t)
	var requests atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests.Add(1)
		var body struct {
			Messages []Message `json:"messages"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		raw, err := json.Marshal(body.Messages)
		assert.NoError(t, err)
		assert.Contains(t, string(raw), "BEFORE_FIRST_HTTP")
		steeringResponse(t, w, "redirected first request")
	}))
	t.Cleanup(server.Close)
	queued := false
	result, err := RunAgent(context.Background(), Connection{BaseURL: server.URL, Protocol: "openai-chat", Model: "fixture", NonStreaming: true}, state, nil, nil, func(current *AgentState) error {
		if !queued && current.steeringFence && current.Result.Stage == "model" {
			queued = true
			_, enqueueErr := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "BEFORE_FIRST_HTTP"))
			require.NoError(t, enqueueErr)
		}
		return checkpointConversation(1, live, 0, current)
	}, conversationControl(1, live, 0))
	require.NoError(t, err)
	assert.Equal(t, "redirected first request", result.Reply)
	assert.EqualValues(t, 1, requests.Load())
	assert.Equal(t, 1, result.Budget.Rounds)
}

func TestTCYAISteeringStopWinsFinalReply(t *testing.T) {
	steeringFixture(t)
	record, state, live := steeringRecord(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	live.cancel = cancel
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		_, err := SteerConversation(1, record.ID, steeringInput(record.Turns[0].ID, "PENDING_WHEN_STOP_WINS"))
		assert.NoError(t, err)
		steeringResponse(t, w, "Old final reply before the correction")
	}))
	t.Cleanup(server.Close)
	control := conversationControl(1, live, 0)
	complete := control.Complete
	control.Complete = func(current *AgentState) (bool, error) {
		require.NoError(t, StopConversation(1, record.ID))
		return complete(current)
	}
	result, err := RunAgent(ctx, Connection{BaseURL: server.URL, Protocol: "openai-chat", Model: "fixture", NonStreaming: true}, state, nil, nil, func(current *AgentState) error {
		return checkpointConversation(1, live, 0, current)
	}, control)
	require.ErrorIs(t, err, context.Canceled)
	assert.Equal(t, "pending", record.Turns[0].Steering[0].Status)
	assert.Empty(t, state.AppliedSteering)
	assert.True(t, safeModelState(state), "the stopped turn must retain a safe checkpoint for explicit retry")
	assert.Empty(t, result.Reply)
	require.NotEmpty(t, result.Steps)
	assert.Equal(t, "Old final reply before the correction", result.Steps[len(result.Steps)-1].Text)
	// This fence must never make an uncertain write retryable.
	state.Result.Stage = "completed"
	state.Result.Operations = append(state.Result.Operations, Operation{Status: "unknown", ErrorCode: "WRITE_UNCERTAIN"})
	_, err = complete(state)
	require.ErrorIs(t, err, context.Canceled)
	assert.False(t, safeModelState(state))
	assert.Equal(t, "completed", state.Result.Stage)
}
