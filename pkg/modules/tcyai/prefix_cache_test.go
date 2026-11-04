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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package tcyai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"slices"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAICacheStableDiscoveryAndTurns(t *testing.T) {
	ctx := context.Background()
	c := Connection{Model: "fixture"}
	state := NewAgentState(ctx, c, RunInput{Mode: "write", Message: "first", ProjectID: 1})
	before, err := json.Marshal(state.tools())
	require.NoError(t, err)
	data, err := state.discover(json.RawMessage(`{"query":"update_task","limit":5}`))
	require.NoError(t, err)
	assert.Contains(t, data, `"parameters"`)
	assert.NotContains(t, data, `"name":"bulk_update_tasks"`)
	call := toolCall("discover", "find_tools", json.RawMessage(`{"query":"update_task"}`))
	state.appendMessage(Message{Role: "assistant", ToolCalls: []ToolCall{call}})
	state.appendMessage(Message{Role: "tool", ToolCallID: "discover", Content: data})
	state.appendMessage(Message{Role: "assistant", Content: "done"})
	after, err := json.Marshal(state.tools())
	require.NoError(t, err)
	assert.Equal(t, string(before), string(after))
	oldMessages := state.messages()
	next := NewAgentState(ctx, c, RunInput{Mode: "write", ProjectID: 2, PageContext: "new page", Message: "next", ServerHistory: oldMessages[state.HistoryStart:]})
	assert.Equal(t, oldMessages, next.messages()[:len(oldMessages)], "a new turn must only append; runtime changes cannot rewrite history/system")
	assert.Contains(t, next.Available, "update_task", "reuse exact definitions retained in history")
	read := NewAgentState(ctx, c, RunInput{Mode: "read", Message: "read", ServerHistory: oldMessages[state.HistoryStart:]})
	assert.NotContains(t, read.Available, "update_task", "history never grants current write permission")
	assert.Equal(t, state.Messages[0].Content, read.Messages[0].Content)
	assert.NotContains(t, state.Messages[0].Content, "2026-")
	assert.Contains(t, read.Messages[read.HistoryStart].Content, `"mode":"read"`)
	readTools, err := json.Marshal(read.tools())
	require.NoError(t, err)
	assert.Equal(t, string(before), string(readTools))
	compacted := NewAgentState(ctx, c, RunInput{Mode: "write", Message: "next", Summary: "old work"})
	assert.NotContains(t, compacted.Available, "update_task", "compaction drops unavailable contracts; rediscover")
}

func discoveryContractHistory(t *testing.T, name string, stale bool) []Message {
	t.Helper()
	state := NewAgentState(context.Background(), Connection{}, RunInput{
		Mode:        "write",
		AllowDelete: true,
	})
	arguments, err := json.Marshal(map[string]any{"query": name})
	require.NoError(t, err)
	data, err := state.discover(arguments)
	require.NoError(t, err)
	callID := "discover-" + name
	if stale {
		var result map[string]any
		require.NoError(t, json.Unmarshal([]byte(data), &result))
		definitions := result["tools"].([]any)
		require.Len(t, definitions, 1)
		definitions[0].(map[string]any)["description"] = "Historical contract description"
		encoded, err := json.Marshal(result)
		require.NoError(t, err)
		data = string(encoded)
		callID += "-stale"
	}
	return []Message{
		{
			Role:      "assistant",
			ToolCalls: []ToolCall{toolCall(callID, "find_tools", arguments)},
		},
		{
			Role:       "tool",
			ToolCallID: callID,
			Content:    data,
		},
	}
}

func TestTCYAIStaleDiscoveryContext(t *testing.T) {
	old := discoveryContractHistory(t, "update_task", true)
	fresh := discoveryContractHistory(t, "update_task", false)
	oldDelete := discoveryContractHistory(t, "delete_task", true)
	for _, test := range []struct {
		name       string
		mode       string
		history    []Message
		wantStale  []string
		wantLoaded bool
	}{
		{
			name:      "changed contract requires rediscovery",
			mode:      "write",
			history:   old,
			wantStale: []string{"update_task"},
		},
		{
			name:       "unchanged contract stays reusable",
			mode:       "write",
			history:    fresh,
			wantLoaded: true,
		},
		{
			name:       "new valid definition supersedes stale history",
			mode:       "write",
			history:    append(append([]Message{}, old...), fresh...),
			wantLoaded: true,
		},
		{
			name:       "older valid definition still remains in context",
			mode:       "write",
			history:    append(append([]Message{}, fresh...), old...),
			wantLoaded: true,
		},
		{
			name:    "read mode cannot rediscover historical writes",
			mode:    "read",
			history: old,
		},
		{
			name:    "disabled deletion cannot be restored",
			mode:    "write",
			history: oldDelete,
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, RunInput{
				Mode:          test.mode,
				Message:       "next request",
				ServerHistory: test.history,
			})
			assert.Equal(t, test.history, state.messages()[1:state.HistoryStart], "historical messages remain byte-stable")
			current := state.Messages[state.HistoryStart].Content
			_, payload, ok := strings.Cut(current, "\n")
			require.True(t, ok)
			var execution struct {
				StaleTools []string `json:"stale_tool_definitions"`
			}
			require.NoError(t, json.Unmarshal([]byte(payload), &execution))
			assert.Equal(t, test.wantStale, execution.StaleTools)
			if len(test.wantStale) > 0 {
				assert.Contains(t, current, "find_tools")
			}
			assert.Equal(t, test.wantLoaded, slices.Contains(state.Available, "update_task"))
			assert.NotContains(t, state.Available, "delete_task")
		})
	}
}

func TestTCYAIInvocationValidationAndReview(t *testing.T) {
	ctx := context.Background()
	for _, raw := range []string{`{"name":"invoke_tool","arguments":{}}`, `{"name":"update_task","arguments":"{}"}`, `{"name":"update_task","arguments":{},"extra":1}`, `{"name":"update_task","arguments":null}`} {
		_, err := resolveInvocation(toolCall("bad", "invoke_tool", json.RawMessage(raw)))
		require.Error(t, err)
	}
	state := NewAgentState(ctx, Connection{}, RunInput{Mode: "write", Approval: "review"})
	_, err := state.discover(json.RawMessage(`{"query":"update_task"}`))
	require.NoError(t, err)
	state.Pending = []ToolCall{toolCall("write", "invoke_tool", json.RawMessage(`{"name":"update_task","arguments":{"id":1,"title":"proposed"}}`))}
	writes := 0
	execute := func(_ context.Context, name string, raw json.RawMessage) (string, error) {
		writes++
		assert.Equal(t, "update_task", name)
		assert.JSONEq(t, `{"id":1,"title":"edited"}`, string(raw))
		return `{"id":1,"title":"edited","description":"private long detail"}`, nil
	}
	prepare := func(_ context.Context, _ string, _ json.RawMessage) (Operation, error) {
		return Operation{Before: `{"id":1,"title":"old"}`, Version: "unchanged", Units: 1}, nil
	}
	save := func() error { return nil }
	require.ErrorIs(t, state.toolStep(ctx, Connection{}, execute, prepare, save), ErrAgentPaused)
	assert.Zero(t, writes)
	require.Equal(t, "update_task", state.Result.Pending.Tool)
	require.NoError(t, ReviewAgent(ctx, state, ReviewInput{OperationID: state.Result.Pending.ID, Decision: "edit", Arguments: `{"id":1,"title":"edited"}`}, prepare))
	assert.Equal(t, "invoke_tool", state.Pending[0].Function.Name)
	require.NoError(t, ReviewAgent(ctx, state, ReviewInput{OperationID: state.Result.Pending.ID, Decision: "approve"}, prepare))
	require.NoError(t, state.toolStep(ctx, Connection{}, execute, prepare, save))
	assert.Equal(t, 1, writes)
	assert.Equal(t, "update_task", state.Result.Actions[0].Tool)
	assert.Contains(t, state.Result.Actions[0].Result, "private long detail", "audit retains full result")
	assert.NotContains(t, state.Messages[len(state.Messages)-1].Content, "private long detail")
	for _, mode := range []string{"read", "write"} {
		denied := NewAgentState(ctx, Connection{}, RunInput{Mode: mode})
		denied.Pending = []ToolCall{toolCall("denied", "invoke_tool", json.RawMessage(`{"name":"update_task","arguments":{"id":1,"title":"x"}}`))}
		require.NoError(t, denied.toolStep(ctx, Connection{}, execute, prepare, save))
		assert.Equal(t, 1, writes)
		assert.False(t, denied.Result.Actions[0].Success)
	}
}

func TestTCYAICompactToolResults(t *testing.T) {
	detail := strings.Repeat("very long description ", 200)
	original, err := json.Marshal(map[string]any{"items": []any{map[string]any{"id": 1, "title": "task", "project_id": 2, "description": detail, "hex_color": "aabbcc", "attachments": []any{map[string]any{"id": 9}}, "related_tasks": map[string]any{"subtask": []any{map[string]any{"id": 2, "description": detail}}}}}, "total": 50, "page": 1, "per_page": 25, "total_pages": 2})
	require.NoError(t, err)
	compact := compactToolResult("list_tasks", json.RawMessage(`{}`), string(original))
	assert.Less(t, len(compact), len(original)/10)
	assert.Contains(t, compact, `"total_pages":2`)
	assert.Contains(t, compact, `"detail_tool":"get_task"`)
	assert.Contains(t, compact, "aabbcc")
	assert.NotContains(t, compact, detail)
	assert.Equal(t, string(original), compactToolResult("get_task", json.RawMessage(`{"id":1}`), string(original)))
	result := compactToolResult("bulk_update_tasks", json.RawMessage(`{"updates":[{"id":1,"changes":{"hex_color":"aabbcc"}}]}`), `[{"id":1,"title":"task","hex_color":"aabbcc","description":"omitted"}]`)
	assert.Contains(t, result, `"hex_color":"aabbcc"`)
	assert.NotContains(t, result, "description")
}

func TestTCYAIDeepSeekUsageAliases(t *testing.T) {
	u, _ := providerUsage("openai-chat", []byte(`{"usage":{"prompt_tokens":1000,"completion_tokens":20,"prompt_cache_hit_tokens":768,"prompt_cache_miss_tokens":232}}`))
	assert.EqualValues(t, 1000, u.Input)
	assert.True(t, u.CacheReported)
	assert.EqualValues(t, 768, u.Cached)
	u, _ = providerUsage("openai-chat", []byte(`{"usage":{"input_tokens":1000,"prompt_tokens":1000,"output_tokens":20,"completion_tokens":20}}`))
	assert.EqualValues(t, 1000, u.Input)
	assert.EqualValues(t, 20, u.Output)
	assert.False(t, u.CacheReported)
}

func TestTCYAIStableEntryWireProtocols(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, protocol := range []string{"openai-chat", "openai-responses", "anthropic", "gemini"} {
		t.Run(protocol, func(t *testing.T) {
			calls, writes := 0, 0
			var originalTools string
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				tools, err := json.Marshal(body["tools"])
				if !assert.NoError(t, err) {
					return
				}
				calls++
				if calls == 1 {
					originalTools = string(tools)
				} else {
					assert.Equal(t, originalTools, string(tools))
				}
				name := "find_tools"
				args := map[string]any{"query": "update_task"}
				id := "discovery"
				if calls == 2 {
					name = "invoke_tool"
					args = map[string]any{"name": "update_task", "arguments": map[string]any{"id": 1, "title": "new"}}
					id = "write"
				}
				raw, err := json.Marshal(args)
				if !assert.NoError(t, err) {
					return
				}
				var response any
				switch protocol {
				case "openai-chat":
					message := map[string]any{"role": "assistant", "content": "done"}
					if calls < 3 {
						message["content"] = ""
						message["tool_calls"] = []any{map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": string(raw)}}}
					}
					response = map[string]any{"choices": []any{map[string]any{"message": message, "finish_reason": "stop"}}}
				case "openai-responses":
					item := map[string]any{"type": "message", "role": "assistant", "content": []any{map[string]any{"type": "output_text", "text": "done"}}}
					if calls < 3 {
						item = map[string]any{"type": "function_call", "call_id": id, "name": name, "arguments": string(raw)}
					}
					response = map[string]any{"status": "completed", "output": []any{item}}
				case "anthropic":
					part := map[string]any{"type": "text", "text": "done"}
					if calls < 3 {
						part = map[string]any{"type": "tool_use", "id": id, "name": name, "input": args}
					}
					response = map[string]any{"stop_reason": "end_turn", "content": []any{part}}
				case "gemini":
					part := map[string]any{"text": "done"}
					if calls < 3 {
						part = map[string]any{"functionCall": map[string]any{"id": id, "name": name, "args": args}}
					}
					response = map[string]any{"candidates": []any{map[string]any{"finishReason": "STOP", "content": map[string]any{"role": "model", "parts": []any{part}}}}}
				}
				w.Header().Set("Content-Type", "application/json")
				assert.NoError(t, json.NewEncoder(w).Encode(response))
			}))
			defer server.Close()
			c := Connection{Protocol: protocol, BaseURL: server.URL, Model: "model", NonStreaming: true}
			result, err := Run(context.Background(), c, RunInput{Mode: "write", Approval: "auto", Message: "update fixture"}, func(_ context.Context, name string, raw json.RawMessage) (string, error) {
				writes++
				assert.Equal(t, "update_task", name)
				assert.JSONEq(t, `{"id":1,"title":"new"}`, string(raw))
				return `{"id":1,"title":"new"}`, nil
			})
			require.NoError(t, err)
			assert.Equal(t, 3, calls)
			assert.Equal(t, 1, writes)
			assert.Equal(t, "completed", result.Stage)
			assert.Equal(t, "update_task", result.Actions[1].Tool)
		})
	}
}
