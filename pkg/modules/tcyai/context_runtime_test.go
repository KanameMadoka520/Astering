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
	"io"
	"net/http"
	"net/http/httptest"
	"runtime"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIResultProjectionLargeJSON(t *testing.T) {
	raw, marshalErr := json.Marshal(map[string]any{"items": []any{map[string]any{"id": 42, "title": "visible", "description": strings.Repeat("long body", 16000)}}, "page": 1, "total": 1})
	require.NoError(t, marshalErr)
	require.Greater(t, len(raw), 64000)
	projected := modelToolResult("list_tasks", json.RawMessage(`{}`), string(raw), "receipt")
	assert.True(t, json.Valid([]byte(projected)))
	assert.Less(t, len(projected), 1000)
	assert.Contains(t, projected, `"id":42`)
	assert.NotContains(t, projected, "long body")
	state := &AgentState{Result: RunResult{Actions: []Action{{ResultRef: "receipt", Result: string(raw)}}}}
	page, err := state.readToolResult(json.RawMessage(`{"result_ref":"receipt","offset":64000,"max_chars":100}`))
	require.NoError(t, err)
	assert.Contains(t, page, `"next_offset":64100`)
	_, err = state.readToolResult(json.RawMessage(`{"result_ref":"foreign"}`))
	require.Error(t, err)
	assert.Len(t, state.Result.Actions[0].Result, len(raw), "complete audit is unchanged")
}
func TestTCYAIResultProjectionNestedTaskAndWrites(t *testing.T) {
	raw, marshalErr := json.Marshal(map[string]any{"id": 42, "description": "keep main description", "related_tasks": map[string]any{"subtask": []any{map[string]any{"id": 43, "title": "child", "description": strings.Repeat("nested", 10000), "related_tasks": map[string]any{"parent": []any{map[string]any{"id": 42}}}}}}})
	require.NoError(t, marshalErr)
	result := compactToolResult("get_task", json.RawMessage(`{"id":42}`), string(raw))
	assert.Less(t, len(result), 1000)
	assert.Contains(t, result, "keep main description")
	assert.Contains(t, result, `"id":43`)
	raw, marshalErr = json.Marshal(map[string]any{"id": 42, "description": strings.Repeat("large description", 1000)})
	require.NoError(t, marshalErr)
	result = compactToolResult("update_task", json.RawMessage(`{"id":42,"description":"provided"}`), string(raw))
	assert.Contains(t, result, `"stored":true`)
	assert.Contains(t, result, `"sha256"`)
	assert.Less(t, len(result), 500)
}
func TestTCYAIContextScopeAndThreshold(t *testing.T) {
	c := Connection{Protocol: "openai-chat", ContextWindow: 200000, MaxOutputTokens: 40000}
	assert.EqualValues(t, 160000, compactThreshold(c))
	assert.EqualValues(t, 128000, compactThreshold(Connection{}))
	disabled := NewAgentState(context.Background(), Connection{}, RunInput{Message: "hello"})
	disabled.updateContextStatus(Connection{DisableAutoCompact: true})
	assert.Zero(t, disabled.Result.ContextStatus.ThresholdTokens)
	s := NewAgentState(context.Background(), Connection{}, RunInput{Message: "hello"})
	s.LastInputEstimate = estimateMessages(s.messages())
	s.LastInputTokens = 10000
	s.Result.Usage.Input = 1108119
	s.updateContextStatus(Connection{})
	assert.EqualValues(t, 10000, s.Result.ContextStatus.Tokens)
	assert.Zero(t, s.Result.ContextStatus.ContextWindow)
	assert.False(t, s.Result.ContextStatus.Estimated)
	s.appendMessage(Message{Role: "tool", Content: strings.Repeat("extra", 100)})
	s.updateContextStatus(Connection{})
	assert.True(t, s.Result.ContextStatus.Estimated)
	assert.Greater(t, s.Result.ContextStatus.Tokens, int64(10000))
}
func TestTCYAIAutoCompactionTransactional(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, fail := range []bool{false, true} {
		t.Run(map[bool]string{false: "success", true: "failure"}[fail], func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if fail {
					w.WriteHeader(503)
					_, _ = w.Write([]byte(`{"error":{"message":"unavailable"}}`))
					return
				}
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				assert.NotContains(t, body, "tools")
				w.Header().Set("Content-Type", "application/json")
				_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "Task 42 is already updated. Continue remaining research; do not repeat that write."}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 20}})
			}))
			defer server.Close()
			c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true, AutoCompactTokens: 1000}
			state := NewAgentState(context.Background(), c, RunInput{Message: "finish remaining work", Mode: "write"})
			state.appendMessage(Message{Role: "assistant", Content: strings.Repeat("historical detail ", 5000)})
			state.Result.Actions = []Action{{Tool: "update_task", Success: true, Result: `{"id":42}`}}
			before := append([]storedMessage{}, state.Messages...)
			err := state.autoCompact(context.Background(), c, func() error { return nil }, false)
			require.Len(t, state.Result.AutoCompactions, 1)
			if fail {
				require.Error(t, err)
				assert.Equal(t, before, state.Messages)
				assert.False(t, state.Rebased)
				assert.Equal(t, "failed", state.Result.AutoCompactions[0].Status)
				return
			}
			require.NoError(t, err)
			assert.True(t, state.Rebased)
			assert.Len(t, state.Messages, 4)
			assert.Equal(t, 1, state.HistoryStart)
			assert.Contains(t, state.Messages[1].Content, "Task 42")
			assert.Contains(t, state.Messages[2].Content, `"mode":"write"`)
			assert.Equal(t, "finish remaining work", state.Messages[3].Content)
			assert.Len(t, state.Result.Actions, 1)
			assert.True(t, completeToolHistory(state.Messages))
			record := &conversationFile{Conversation: Conversation{Turns: []ChatTurn{{ID: "old", Status: "completed"}, {ID: "new", Status: "completed"}}}, Contexts: [][]storedMessage{{{Message: Message{Role: "user", Content: "old uncompressed"}}}, state.Messages[1:]}, ContextRebased: map[string]bool{"new": true}}
			history, summary, err := conversationHistory(record, c)
			require.NoError(t, err)
			assert.Empty(t, summary)
			encoded, _ := json.Marshal(history)
			assert.NotContains(t, string(encoded), "old uncompressed")
			assert.Contains(t, string(encoded), "Task 42")
		})
	}
}
func TestTCYAISegmentContinuationAndExplicitPause(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{MaxRounds: 2, MaxOperations: 3})
	state.Result.Budget.Rounds = 2
	state.Result.Budget.Operations = 3
	require.NoError(t, state.nextSegment(func() error { return nil }))
	assert.Equal(t, 4, state.Result.Budget.RoundLimit)
	assert.Equal(t, 6, state.Result.Budget.OperationLimit)
	assert.Equal(t, 2, state.Result.SegmentCount)
	state.Input.StopAtSegmentLimit = true
	require.ErrorIs(t, state.nextSegment(func() error { return nil }), ErrAgentPaused)
	state.Input.StopAtSegmentLimit = false
	state.Input.TokenBudget = 10
	state.Result.Budget.TokenLimit = 10
	state.Result.Usage.Input = 10
	_, err := RunAgent(context.Background(), Connection{}, state, nil, nil, nil)
	assert.ErrorIs(t, err, ErrAgentPaused)
}
func TestTCYAISubagentsJoinAndReadonly(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	var active, peak atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := active.Add(1)
		defer active.Add(-1)
		for p := peak.Load(); n > p && !peak.CompareAndSwap(p, n); p = peak.Load() {
			runtime.Gosched()
		}
		time.Sleep(30 * time.Millisecond)
		var body map[string]any
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		payload, _ := json.Marshal(body)
		assert.NotContains(t, string(payload), "parent private unrelated content")
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "finding"}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 20}})
	}))
	defer server.Close()
	c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true}
	state := NewAgentState(context.Background(), c, RunInput{Message: "parent private unrelated content", EnableSubagents: true, Mode: "write"})
	raw := json.RawMessage(`{"tasks":[{"goal":"first"},{"goal":"second"}]}`)
	result, err := state.delegateTasks(context.Background(), c, raw, func(context.Context, string, json.RawMessage) (string, error) {
		return "", errors.New("unexpected tool")
	}, func() error { return nil })
	require.NoError(t, err)
	assert.Contains(t, result, `"all_joined":true`)
	assert.EqualValues(t, 2, peak.Load())
	assert.Zero(t, active.Load())
	require.Len(t, state.Result.Subagents, 2)
	assert.Equal(t, "completed", state.Result.Subagents[0].Status)
	assert.EqualValues(t, 200, state.Result.Usage.Input)
	_, err = ValidateTool("delegate_tasks", raw, RunInput{Mode: "read"})
	require.Error(t, err)
	for _, definition := range NewAgentState(context.Background(), c, RunInput{Mode: "read"}).catalog() {
		assert.NotEqual(t, "delegate_tasks", toolName(definition))
	}
}

func TestTCYAIAutoContinueCompletesBeyondSegment(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	calls := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		calls++
		message := map[string]any{"role": "assistant", "content": "complete"}
		if calls <= 3 {
			message["content"] = "working"
			message["tool_calls"] = []ToolCall{toolCall("call-"+strconv.Itoa(calls), "list_tasks", json.RawMessage(`{"page":`+strconv.Itoa(calls)+`}`))}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": "stop"}}})
	}))
	defer server.Close()
	c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true}
	state := NewAgentState(context.Background(), c, RunInput{Message: "check three pages", MaxRounds: 1, MaxOperations: 1})
	operations := 0
	result, err := RunAgent(context.Background(), c, state, func(context.Context, string, json.RawMessage) (string, error) {
		operations++
		return `{"items":[],"total":0}`, nil
	}, nil, nil)
	require.NoError(t, err)
	assert.Equal(t, 4, calls)
	assert.Equal(t, 3, operations)
	assert.Equal(t, "completed", result.Stage)
	assert.Equal(t, 4, result.SegmentCount)
	assert.Len(t, result.Steps, 4)
	assert.Len(t, result.Actions, 3)
}
func TestTCYAISubagentsStopWithParent(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	entered := make(chan struct{}, 2)
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		entered <- struct{}{}
		<-r.Context().Done()
	}))
	defer server.Close()
	c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true}
	state := NewAgentState(context.Background(), c, RunInput{Message: "parallel", EnableSubagents: true})
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	done := make(chan error, 1)
	go func() {
		_, err := state.delegateTasks(ctx, c, json.RawMessage(`{"tasks":[{"goal":"first"},{"goal":"second"}]}`), nil, func() error { return nil })
		done <- err
	}()
	for i := 0; i < 2; i++ {
		select {
		case <-entered:
		case <-time.After(3 * time.Second):
			t.Fatal("children did not start")
		}
	}
	cancel()
	select {
	case err := <-done:
		require.ErrorIs(t, err, context.Canceled)
	case <-time.After(3 * time.Second):
		t.Fatal("children survived parent cancellation")
	}
	for _, child := range state.Result.Subagents {
		assert.Equal(t, "stopped", child.Status)
	}
}
func TestTCYAIHistoricalImageReferencesRemainReadable(t *testing.T) {
	conversation, attachment, _ := chatAttachmentFixture(t)
	record, err := readConversation(1, conversation.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: "old", Status: "completed", Attachments: []ChatAttachment{attachment}}}
	record.DraftAttachments = nil
	record.Contexts = [][]storedMessage{{}}
	record.Compactions = []Compaction{{Through: 1, Summary: "previous picture analysis"}}
	require.NoError(t, writeConversation(1, record))
	c := Connection{InputTypes: []string{"text", "image"}}
	_, summary, err := conversationHistory(record, c)
	require.NoError(t, err)
	assert.Contains(t, summary, attachment.ID)
	state := NewAgentState(context.Background(), c, RunInput{Message: "read that image again", Summary: summary})
	state.OwnerID, state.ConversationID = 1, conversation.ID
	state.KnownAttachments = sentAttachments(record.Conversation)
	_, err = state.viewAttachment(c, json.RawMessage(`{"attachment_id":"`+attachment.ID+`"}`))
	require.NoError(t, err)
	require.Len(t, state.QueuedAttachments, 1)
	hydrated, err := hydrateMessages(c, []Message{{Role: "user", Attachments: state.QueuedAttachments, AttachmentOwner: 1}})
	require.NoError(t, err)
	require.Len(t, hydrated[0].imageData, 1)
	state.OwnerID = 2
	_, err = state.viewAttachment(c, json.RawMessage(`{"attachment_id":"`+attachment.ID+`"}`))
	require.Error(t, err)
	state.OwnerID = 1
	state.KnownAttachments = nil
	_, err = state.viewAttachment(c, json.RawMessage(`{"attachment_id":"`+attachment.ID+`"}`))
	require.ErrorIs(t, err, ErrAttachmentMissing)
}
func TestTCYAILegacyMalformedResultDoesNotInflateReplay(t *testing.T) {
	messages := []Message{{Role: "assistant", ToolCalls: []ToolCall{toolCall("old", "list_tasks", json.RawMessage(`{}`))}}, {Role: "tool", ToolCallID: "old", Content: `{"items":[{"description":"` + strings.Repeat("large result", 6000)}}
	projected := projectLegacyMessages(messages)
	assert.Less(t, len(projected[1].Content), 500)
	assert.True(t, json.Valid([]byte(projected[1].Content)))
	assert.Contains(t, projected[1].Content, "legacy_result_incomplete")
}

func TestTCYAILiveRecordSnapshotsDuringRename(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	oldNetwork := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("snapshot-fixture")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldNetwork)
	})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		w.Header().Set("Content-Type", "text/event-stream")
		for i := 0; i < 80; i++ {
			_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{\"content\":\"x\"}}]}\n\n"))
			w.(http.Flusher).Flush()
			select {
			case <-r.Context().Done():
				return
			case <-time.After(2 * time.Millisecond):
			}
		}
		_, _ = w.Write([]byte("data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}],\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":80}}\n\ndata: [DONE]\n\n"))
	}))
	defer server.Close()
	conversation, err := CreateConversation(1, "before")
	require.NoError(t, err)
	c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture"}
	_, err = StartConversation(context.Background(), 1, conversation.ID, RunInput{Message: "reply", RequestID: "snapshot-test-1"}, c, nil)
	require.NoError(t, err)
	for i := 0; i < 25; i++ {
		_, err = RenameConversation(1, conversation.ID, "renamed")
		require.NoError(t, err)
		view, err := GetConversationActivity(1, conversation.ID)
		require.NoError(t, err)
		_, err = json.Marshal(view)
		require.NoError(t, err)
	}
	require.Eventually(t, func() bool {
		value, err := GetConversation(1, conversation.ID)
		return err == nil && value.Turns[0].Status == "completed"
	}, 4*time.Second, 10*time.Millisecond)
	value, err := GetConversation(1, conversation.ID)
	require.NoError(t, err)
	assert.Equal(t, "renamed", value.Title)
	assert.Equal(t, strings.Repeat("x", 80), value.Turns[0].Result.Reply)
}

func TestTCYAISubagentResultsRemainReadable(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("subagent-result-test-secret")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	result := RunResult{Subagents: []SubagentTask{{ID: "worker", Status: "completed", Actions: []Action{{ResultRef: "worker-receipt", Result: strings.Repeat("detail", 2000), Arguments: `{"id":42}`}}}}}
	state := &AgentState{Result: result}
	page, err := state.readToolResult(json.RawMessage(`{"result_ref":"worker-receipt","offset":100,"max_chars":20}`))
	require.NoError(t, err)
	assert.Contains(t, page, `"next_offset":120`)
	c, err := CreateConversation(1, "worker result")
	require.NoError(t, err)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: "finished", Status: "completed", Result: result}}
	require.NoError(t, writeConversation(1, record))
	replay := &AgentState{OwnerID: 1, ConversationID: c.ID}
	page, err = replay.readToolResult(json.RawMessage(`{"result_ref":"worker-receipt","part":"arguments"}`))
	require.NoError(t, err)
	assert.Contains(t, page, `42`)
	other, err := CreateConversation(1, "unrelated")
	require.NoError(t, err)
	replay.ConversationID = other.ID
	_, err = replay.readToolResult(json.RawMessage(`{"result_ref":"worker-receipt"}`))
	require.Error(t, err)
	replay.OwnerID = 2
	replay.ConversationID = c.ID
	_, err = replay.readToolResult(json.RawMessage(`{"result_ref":"worker-receipt"}`))
	require.Error(t, err)
}

func TestTCYAIAttachmentEvidenceSurvivesHumanBoundary(t *testing.T) {
	attachment := ChatAttachment{ID: "requested-image", MIME: "image/png"}
	for _, decision := range []string{"answer", "reject"} {
		t.Run(decision, func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, RunInput{Message: "inspect"})
			state.QueuedAttachments = []ChatAttachment{attachment}
			state.Pending = []ToolCall{{ID: "question"}}
			state.Result.Pause = "question"
			review := ReviewInput{Decision: "answer", Answer: "continue"}
			if decision == "reject" {
				state.Result.Pause = "review"
				state.Result.Pending = &Operation{ID: "pending"}
				review = ReviewInput{Decision: "reject", OperationID: "pending"}
			}
			state.deliverQueuedAttachments()
			assert.Empty(t, state.Messages[len(state.Messages)-1].Attachments)
			require.NoError(t, ReviewAgent(context.Background(), state, review, nil))
			state.deliverQueuedAttachments()
			require.Equal(t, []ChatAttachment{attachment}, state.Messages[len(state.Messages)-1].Attachments)
			count := len(state.Messages)
			state.deliverQueuedAttachments()
			assert.Len(t, state.Messages, count, "retry cannot duplicate evidence")
			// Rebased context after compaction omits old pixels. Still-unconsumed evidence must be delivered again.
			state.Messages = state.Messages[:len(state.Messages)-1]
			state.deliverQueuedAttachments()
			require.Equal(t, []ChatAttachment{attachment}, state.Messages[len(state.Messages)-1].Attachments)
			require.Len(t, state.QueuedAttachments, 1, "only a successful provider round consumes pending evidence")
		})
	}
}

func TestTCYAIAttachmentEvidenceDeliveredAfterAutoCompact(t *testing.T) {
	conversation, attachment, _ := chatAttachmentFixture(t)
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, err := io.ReadAll(r.Body)
		if !assert.NoError(t, err) {
			return
		}
		n := requests.Add(1)
		if n == 1 {
			assert.NotContains(t, string(body), "data:image/png;base64,")
		} else {
			assert.Contains(t, string(body), "data:image/png;base64,")
		}
		answer := "Earlier context summarized. The requested image remains to inspect."
		if n > 1 {
			answer = "I received the image."
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": answer}, "finish_reason": "stop"}}, "usage": map[string]int{"prompt_tokens": 100, "completion_tokens": 20}})
	}))
	defer server.Close()
	c := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true, InputTypes: []string{"text", "image"}, AutoCompactTokens: 1000}
	state := NewAgentState(context.Background(), c, RunInput{Message: "inspect the requested picture"})
	state.OwnerID = 1
	state.ConversationID = conversation.ID
	state.KnownAttachments = []ChatAttachment{attachment}
	state.QueuedAttachments = []ChatAttachment{attachment}
	state.appendMessage(Message{Role: "assistant", Content: strings.Repeat("earlier research ", 5000)})
	state.LastInputTokens = 20000
	_, err := RunAgent(context.Background(), c, state, nil, nil, nil)
	require.NoError(t, err)
	require.EqualValues(t, 2, requests.Load())
	require.Empty(t, state.QueuedAttachments)
	require.Len(t, state.Result.AutoCompactions, 1)
}
