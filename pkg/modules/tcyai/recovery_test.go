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
	"net/http"
	"net/http/httptest"
	"slices"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIRetryAfterToolThenBrokenStream(t *testing.T) {
	oldPath, oldSecret, oldLocal := config.FilesBasePath.GetString(), config.ServiceSecret.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("recovery-test")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldLocal)
	})
	for _, legacy := range []bool{false, true} {
		t.Run(map[bool]string{true: "legacy", false: "durable"}[legacy], func(t *testing.T) {
			var requests, writes atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Messages []Message `json:"messages"`
				}
				assert.NoError(t, json.NewDecoder(r.Body).Decode(&body))
				n := requests.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				switch n {
				case 1:
					_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"write-1\",\"type\":\"function\",\"function\":{\"name\":\"create_task\",\"arguments\":\"{\\\"project_id\\\":1,\\\"title\\\":\\\"meeting\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n\ndata: [DONE]\n\n"))
				case 2:
					_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n"))
				default:
					assert.Equal(t, "tool", body.Messages[len(body.Messages)-1].Role)
					assert.Contains(t, body.Messages[len(body.Messages)-1].Content, "123")
					_, _ = w.Write([]byte("data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Recovered\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n"))
				}
			}))
			defer server.Close()
			c := Connection{BaseURL: server.URL, Model: "test", Protocol: "openai-chat"}
			chat, err := CreateConversation(1, "retry")
			require.NoError(t, err)
			state := NewAgentState(context.Background(), c, RunInput{Message: "create", Mode: "write", Approval: "auto", ConnectionID: "original"})
			state.Available = append(state.Available, "create_task")
			execute := func(context.Context, string, json.RawMessage) (string, error) {
				writes.Add(1)
				return `{"id":123}`, nil
			}
			result, err := RunAgent(context.Background(), c, state, execute, nil, nil)
			require.Error(t, err)
			require.True(t, safeModelState(state))
			assert.EqualValues(t, 1, writes.Load())
			record, err := readConversation(1, chat.ID)
			require.NoError(t, err)
			record.Turns = []ChatTurn{{ID: chat.ID, Prompt: "create", Status: "failed", Result: publicResult(result)}}
			record.Contexts = [][]storedMessage{append([]storedMessage{}, state.Messages[state.HistoryStart:]...)}
			record.States = []*AgentState{state}
			if legacy {
				record.States[0] = nil
			}
			require.NoError(t, writeConversation(1, record))
			public, err := GetConversation(1, chat.ID)
			require.NoError(t, err)
			require.True(t, public.Turns[0].Retryable)
			policy, err := PendingConnection(1, chat.ID)
			require.NoError(t, err)
			assert.Equal(t, "original", policy.ConnectionID)
			_, err = ReviewConversation(context.Background(), 1, chat.ID, ReviewInput{TurnID: chat.ID, Decision: "retry"}, c, execute, nil)
			require.NoError(t, err)
			require.Eventually(t, func() bool { v, e := GetConversation(1, chat.ID); return e == nil && v.Turns[0].Status == "completed" }, 3*time.Second, 10*time.Millisecond)
			public, err = GetConversation(1, chat.ID)
			require.NoError(t, err)
			assert.False(t, public.Turns[0].Retryable)
			assert.Equal(t, "Recovered", public.Turns[0].Result.Reply)
			assert.Len(t, public.Turns[0].Result.Steps, 3)
			assert.EqualValues(t, 1, writes.Load())
			_, err = ReviewConversation(context.Background(), 1, chat.ID, ReviewInput{TurnID: chat.ID, Decision: "retry"}, c, execute, nil)
			require.Error(t, err)
		})
	}
}
func TestTCYAIRetryRejectsUncertainAndIncompleteHistory(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{Message: "test"})
	state.Result.Stage = "model"
	require.True(t, safeModelState(state))
	for _, status := range []string{"running", "unknown", "prepared"} {
		state.Result.Operations = []Operation{{Status: status}}
		assert.False(t, safeModelState(state))
	}
	state.Result.Operations = nil
	state.Pending = []ToolCall{{ID: "pending"}}
	assert.False(t, safeModelState(state))
	state.Pending = nil
	state.Messages = append(state.Messages, storedMessage{Message: Message{Role: "assistant", ToolCalls: []ToolCall{{ID: "unanswered"}}}})
	assert.False(t, safeModelState(state))
	state.Messages = append(state.Messages, storedMessage{Message: Message{Role: "tool", ToolCallID: "unanswered", Content: "done"}})
	assert.True(t, safeModelState(state))
	state.Result.ErrorCode = "SAVE_FAILED"
	assert.False(t, safeModelState(state))
}

func TestTCYAILegacyRetryRestoresCurrentTurnDiscovery(t *testing.T) {
	for _, mode := range []string{"write", "read"} {
		t.Run(mode, func(t *testing.T) {
			connection := Connection{Model: "fixture"}
			state := NewAgentState(context.Background(), connection, RunInput{
				Message:  "continue this request",
				Mode:     mode,
				Approval: "auto",
			})
			for _, name := range []string{"update_task", "delete_task"} {
				for _, message := range discoveryContractHistory(t, name, false) {
					state.appendMessage(message)
				}
			}
			state.Result.Stage = "model"
			step := ModelStep{}
			for _, definition := range state.tools() {
				step.LoadedTools = append(step.LoadedTools, toolName(definition))
			}
			state.Result.Steps = []ModelStep{step}
			record := &conversationFile{
				Conversation: Conversation{Turns: []ChatTurn{{
					ID:     "legacy-turn",
					Prompt: state.Input.Message,
					Status: "failed",
					Result: state.Result,
				}}},
				Contexts: [][]storedMessage{state.Messages[state.HistoryStart:]},
			}
			require.NoError(t, restoreRetryState(context.Background(), record, connection))
			restored := record.States[0]
			require.True(t, restored.CacheStable)
			assert.Equal(t, mode == "write", slices.Contains(restored.Available, "update_task"))
			assert.NotContains(t, restored.Available, "delete_task", "history cannot restore disabled deletion")
			writes := 0
			restored.Pending = []ToolCall{toolCall("next-write", "invoke_tool", json.RawMessage(`{"name":"update_task","arguments":{"id":1,"title":"updated"}}`))}
			restored.appendMessage(Message{
				Role:      "assistant",
				ToolCalls: restored.Pending,
			})
			require.NoError(t, restored.toolStep(context.Background(), connection, func(context.Context, string, json.RawMessage) (string, error) {
				writes++
				return `{"id":1,"title":"updated"}`, nil
			}, nil, func() error { return nil }))
			if mode == "write" {
				assert.Equal(t, 1, writes)
				assert.True(t, restored.Result.Actions[0].Success)
			} else {
				assert.Zero(t, writes)
				assert.Equal(t, "TOOL_NOT_ALLOWED", restored.Result.Operations[0].ErrorCode)
			}
		})
	}
}

func TestTCYAIRetryAfterRestartUsesCheckpoint(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("retry-restart-test")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	chat, err := CreateConversation(1, "restart")
	require.NoError(t, err)
	state := NewAgentState(context.Background(), Connection{Model: "test"}, RunInput{Message: "test"})
	state.Result.Stage = "model"
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: chat.ID, Status: "running", Result: state.Result}}
	record.States = []*AgentState{state}
	record.Contexts = [][]storedMessage{{}}
	require.NoError(t, writeConversation(1, record))
	value, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.Equal(t, "interrupted", value.Turns[0].Status)
	assert.True(t, value.Turns[0].Retryable)
	activity, err := GetConversationActivity(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, activity.Turn.Retryable)
	record.Turns[0].Result.Operations = []Operation{{Status: "running", Tool: "create_task"}}
	require.NoError(t, writeConversation(1, record))
	value, err = GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.False(t, value.Turns[0].Retryable)
}
