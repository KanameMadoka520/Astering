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
	"strings"
	"sync/atomic"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func moduleInput(t *testing.T, value string) RunInput {
	t.Helper()
	var in RunInput
	require.NoError(t, json.Unmarshal([]byte(value), &in))
	return in
}

func TestTCYAIToolModulesProjectBoundary(t *testing.T) {
	tests := []struct {
		name      string
		input     string
		tool      string
		arguments string
		allowed   bool
	}{
		{
			name:      "legacy write stays compatible",
			input:     `{"mode":"write"}`,
			tool:      "update_task",
			arguments: `{"id":1,"title":"updated"}`,
			allowed:   true,
		},
		{
			name:      "disabled project read",
			input:     `{"mode":"write","tool_modules":{"project_tasks":"off","compass":"write"}}`,
			tool:      "get_task",
			arguments: `{"id":1}`,
		},
		{
			name:      "disabled project write",
			input:     `{"mode":"write","tool_modules":{"project_tasks":"off","compass":"write"}}`,
			tool:      "update_task",
			arguments: `{"id":1,"title":"updated"}`,
		},
		{
			name:      "project read allows query",
			input:     `{"mode":"write","tool_modules":{"project_tasks":"read"}}`,
			tool:      "get_task",
			arguments: `{"id":1}`,
			allowed:   true,
		},
		{
			name:      "project read rejects write",
			input:     `{"mode":"write","tool_modules":{"project_tasks":"read"}}`,
			tool:      "create_task",
			arguments: `{"project_id":1,"title":"new"}`,
		},
		{
			name:      "global read caps module write",
			input:     `{"mode":"read","tool_modules":{"project_tasks":"write"}}`,
			tool:      "update_task",
			arguments: `{"id":1,"title":"updated"}`,
		},
		{
			name:      "unknown module mode fails closed",
			input:     `{"mode":"write","tool_modules":{"project_tasks":"everything"}}`,
			tool:      "get_task",
			arguments: `{"id":1}`,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			_, err := ValidateTool(test.tool, json.RawMessage(test.arguments), moduleInput(t, test.input))
			if test.allowed {
				require.NoError(t, err)
			} else {
				require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
			}
		})
	}
}

func TestTCYAIToolModulesDiscoveryAndHistory(t *testing.T) {
	ctx := context.Background()
	history := discoveryContractHistory(t, "update_task", false)
	in := moduleInput(t, `{"mode":"write","tool_modules":{"project_tasks":"off","compass":"off"}}`)
	in.ServerHistory = history
	state := NewAgentState(ctx, Connection{}, in)
	assert.NotContains(t, state.Available, "update_task")
	encoded, err := json.Marshal(state.tools())
	require.NoError(t, err)
	assert.NotContains(t, string(encoded), `"name":"list_projects"`)
	assert.NotContains(t, string(encoded), `"name":"list_tasks"`)
	assert.NotContains(t, string(encoded), `"name":"get_task"`)
	result, err := state.discover(json.RawMessage(`{"query":"update_task"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"tools":[]`)
	assert.NotContains(t, state.Available, "update_task")
	assert.Contains(t, state.Messages[state.HistoryStart].Content, `"effective_tool_modules":{"project_tasks":"off","compass":"off"}`)
}

func TestTCYAIToolModulesHistoricalResults(t *testing.T) {
	for _, child := range []bool{false, true} {
		t.Run(map[bool]string{false: "parent", true: "child"}[child], func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, moduleInput(t, `{"mode":"write","tool_modules":{"project_tasks":"off"}}`))
			action := Action{
				Tool:      "get_task",
				ResultRef: "historical-task-result",
				Arguments: `{"id":1}`,
				Result:    `{"id":1,"description":"fixture-private-content"}`,
			}
			if child {
				state.Result.Subagents = []SubagentTask{{Actions: []Action{action}}}
			} else {
				state.Result.Actions = []Action{action}
			}
			for _, part := range []string{"result", "arguments"} {
				raw, err := json.Marshal(map[string]string{
					"result_ref": action.ResultRef,
					"part":       part,
				})
				require.NoError(t, err)
				data, err := state.readToolResult(raw)
				require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
				assert.Empty(t, data)
			}
		})
	}
}

func TestTCYAIToolModulesPendingAndApproved(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, moduleInput(t, `{"mode":"write","tool_modules":{"project_tasks":"off"}}`))
	state.Available = append(state.Available, "update_task")
	state.Pending = []ToolCall{toolCall("old-proposal", "invoke_tool", json.RawMessage(`{"name":"update_task","arguments":{"id":1,"title":"new"}}`))}
	state.Approved = &Operation{
		ID:        "old-approved",
		Tool:      "update_task",
		Arguments: `{"id":1,"title":"new"}`,
		Approved:  true,
		Units:     1,
	}
	writes := 0
	executor := func(context.Context, string, json.RawMessage) (string, error) {
		writes++
		return `{}`, nil
	}
	require.NoError(t, state.toolStep(context.Background(), Connection{}, executor, nil, func() error { return nil }))
	assert.Zero(t, writes)
	require.Len(t, state.Result.Actions, 1)
	assert.False(t, state.Result.Actions[0].Success)
	assert.Contains(t, state.Result.Actions[0].Result, "TOOL_NOT_ALLOWED")
}

func TestTCYAIToolModulesConfigurationAndRetry(t *testing.T) {
	in := moduleInput(t, `{"mode":"read","tool_modules":{"project_tasks":"off","compass":"write"}}`)
	options := runOptions(in)
	encoded, err := json.Marshal(options)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"tool_modules":{"project_tasks":"off","compass":"write"}`)
	restored, err := json.Marshal(retryInput(ChatTurn{Result: RunResult{Configuration: options}}))
	require.NoError(t, err)
	assert.Contains(t, string(restored), `"tool_modules":{"project_tasks":"off","compass":"write"}`)
	defaults, err := json.Marshal(runOptions(RunInput{Mode: "write"}))
	require.NoError(t, err)
	assert.Contains(t, string(defaults), `"tool_modules":{"project_tasks":"write","compass":"off"}`)
}

func TestTCYAIToolModulesResultReferenceChains(t *testing.T) {
	for _, mode := range []string{"off", "read"} {
		t.Run(mode, func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, RunInput{
				Mode: "write",
				ToolModules: ToolModules{
					ProjectTasks: mode,
					Compass:      "off",
				},
			})
			original := Action{
				Tool:      "update_task",
				ResultRef: "task-source",
				Arguments: `{"id":1,"title":"updated"}`,
				Result:    `{"id":1,"title":"updated"}`,
			}
			copied := Action{
				Tool:      "read_tool_result",
				ResultRef: "copied-source",
				Arguments: `{"result_ref":"task-source"}`,
				Result:    `{"content":"fixture source copy"}`,
			}
			group, err := json.Marshal(map[string]any{
				"children": []map[string]any{
					{
						"id":       "child",
						"findings": compactActions([]Action{original, copied, copied}),
					},
				},
			})
			require.NoError(t, err)
			state.Result.Actions = []Action{
				original,
				copied,
				{
					Tool:      "delegate_tasks",
					ResultRef: "group-source",
					Result:    string(group),
				},
				{
					Tool:      "read_tool_result",
					ResultRef: "cyclic-source",
					Arguments: `{"result_ref":"cyclic-source"}`,
					Result:    `{"content":"cycle"}`,
				},
			}
			for _, ref := range []string{"task-source", "copied-source", "group-source", "cyclic-source"} {
				raw, err := json.Marshal(map[string]string{"result_ref": ref})
				require.NoError(t, err)
				data, err := state.readToolResult(raw)
				if mode == "off" || ref == "cyclic-source" {
					require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", ref)
					assert.Empty(t, data)
				} else {
					require.NoError(t, err, ref)
					assert.NotEmpty(t, data)
				}
			}
		})
	}
}

func TestTCYAIToolModulesHistoricalDiscoveryFormats(t *testing.T) {
	for _, legacySchema := range []bool{false, true} {
		t.Run(map[bool]string{false: "current discovery", true: "legacy provider schema"}[legacySchema], func(t *testing.T) {
			old := NewAgentState(context.Background(), Connection{}, RunInput{
				ToolModules: ToolModules{
					ProjectTasks: "off",
					Compass:      "read",
				},
			})
			data, err := old.discover(json.RawMessage(`{"query":"get_compass_entry"}`))
			require.NoError(t, err)
			if legacySchema {
				var definition map[string]any
				for _, candidate := range CompassToolDefinitions("read") {
					if toolName(candidate) == "get_compass_entry" {
						definition = candidate
						break
					}
				}
				require.NotNil(t, definition)
				encoded, marshalErr := json.Marshal(map[string]any{"tools": []map[string]any{definition}})
				require.NoError(t, marshalErr)
				data = string(encoded)
			}
			state := NewAgentState(context.Background(), Connection{}, RunInput{})
			state.Result.Actions = []Action{
				{
					Tool:      "find_tools",
					ResultRef: "old-compass-directory",
					Result:    data,
				},
			}
			_, err = state.readToolResult(json.RawMessage(`{"result_ref":"old-compass-directory"}`))
			require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
			state.Input.ToolModules.Compass = "read"
			_, err = state.readToolResult(json.RawMessage(`{"result_ref":"old-compass-directory"}`))
			require.NoError(t, err)
		})
	}
}

func TestTCYAIToolModulesPersistedResultsAndLegacySources(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("module-results-fixture-secret")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
	conversation, err := CreateConversation(1, "module history fixture")
	require.NoError(t, err)
	record, err := readConversation(1, conversation.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{
		{
			ID:     "old-turn",
			Status: "completed",
			Result: RunResult{
				Actions: []Action{
					{
						Tool:      "get_compass_entry",
						ResultRef: "compass-source",
						Result:    `{"id":1,"content":"private fixture body"}`,
					},
					{
						ResultRef: "legacy-source-without-tool",
						Result:    `{"id":1,"description":"old task fixture"}`,
					},
				},
			},
		},
	}
	require.NoError(t, writeConversation(1, record))
	state := &AgentState{
		OwnerID:        1,
		ConversationID: conversation.ID,
		Input: RunInput{
			Mode: "read",
			ToolModules: ToolModules{
				ProjectTasks: "off",
				Compass:      "off",
			},
		},
	}
	for _, ref := range []string{"compass-source", "legacy-source-without-tool"} {
		raw, err := json.Marshal(map[string]string{"result_ref": ref})
		require.NoError(t, err)
		_, err = state.readToolResult(raw)
		require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	}
	state.Input.ToolModules.Compass = "read"
	data, err := state.readToolResult(json.RawMessage(`{"result_ref":"compass-source"}`))
	require.NoError(t, err)
	assert.Contains(t, data, "private fixture body")
}

func TestTCYAIToolModulesReviewRechecksPermission(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{
		Mode:        "write",
		ToolModules: ToolModules{ProjectTasks: "off"},
	})
	state.Pending = []ToolCall{toolCall("old-review", "update_task", json.RawMessage(`{"id":1,"title":"new"}`))}
	state.Result.Pause = "review"
	state.Result.Pending = &Operation{
		ID:        "old-operation",
		Tool:      "update_task",
		Arguments: `{"id":1,"title":"new"}`,
	}
	require.ErrorContains(t, ReviewAgent(context.Background(), state, ReviewInput{
		OperationID: "old-operation",
		Decision:    "approve",
	}, nil), "TOOL_NOT_ALLOWED")
	assert.Nil(t, state.Approved)
	assert.NotNil(t, state.Result.Pending)
}

func TestTCYAIToolModulesSubagentsInheritReadScope(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	var requests atomic.Int64
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []Message        `json:"messages"`
			Tools    []map[string]any `json:"tools"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		foundScope := false
		for _, message := range body.Messages {
			if message.Role == "user" && len(message.Content) > 0 {
				if strings.Contains(message.Content, `"effective_tool_modules":{"project_tasks":"off","compass":"read"}`) {
					foundScope = true
				}
			}
		}
		assert.True(t, foundScope)
		encoded, err := json.Marshal(body.Tools)
		if !assert.NoError(t, err) {
			return
		}
		assert.NotContains(t, string(encoded), `"name":"get_task"`)
		message := Message{
			Role:    "assistant",
			Content: "done",
		}
		if requests.Add(1) == 1 {
			message.ToolCalls = []ToolCall{toolCall("forbidden-child-read", "get_task", json.RawMessage(`{"id":1}`))}
		}
		w.Header().Set("Content-Type", "application/json")
		_ = json.NewEncoder(w).Encode(map[string]any{
			"choices": []map[string]any{
				{
					"message":       message,
					"finish_reason": "stop",
				},
			},
		})
	}))
	defer server.Close()
	connection := Connection{
		Protocol:     "openai-chat",
		BaseURL:      server.URL,
		Model:        "fixture",
		NonStreaming: true,
	}
	state := NewAgentState(context.Background(), connection, RunInput{
		Mode:            "write",
		EnableSubagents: true,
		ToolModules: ToolModules{
			ProjectTasks: "off",
			Compass:      "write",
		},
	})
	executions := 0
	result, err := state.delegateTasks(context.Background(), connection, json.RawMessage(`{"tasks":[{"goal":"inspect allowed module"}]}`), func(context.Context, string, json.RawMessage) (string, error) {
		executions++
		return `{}`, nil
	}, func() error { return nil })
	require.NoError(t, err)
	assert.Contains(t, result, `"all_joined":true`)
	assert.Zero(t, executions)
	assert.EqualValues(t, 2, requests.Load())
	require.Len(t, state.Result.Subagents, 1)
	require.Len(t, state.Result.Subagents[0].Actions, 1)
	assert.False(t, state.Result.Subagents[0].Actions[0].Success)
}

func TestTCYAIToolModulesInvalidProfileAndPrompt(t *testing.T) {
	options := *runOptions(RunInput{Mode: "write"})
	require.True(t, validAssistantOptions(options))
	options.ToolModules.Compass = "all"
	assert.False(t, validAssistantOptions(options))
	prompt := SystemPrompt(context.Background(), RunInput{
		Mode: "write",
		ToolModules: ToolModules{
			ProjectTasks: "off",
			Compass:      "read",
		},
	})
	assert.Contains(t, prompt, "get_compass_entry")
	assert.NotContains(t, prompt, "bulk_update_tasks")
	assert.NotContains(t, prompt, "reorder_view_tasks")
	catalog, err := json.Marshal(NewAgentState(context.Background(), Connection{}, RunInput{
		ToolModules: ToolModules{ProjectTasks: "off"},
	}).tools())
	require.NoError(t, err)
	assert.NotContains(t, string(catalog), "bucket/column")
}

func TestTCYAIListChatAttachmentsDiscoveryAndValidation(t *testing.T) {
	in := RunInput{
		Mode: "read",
		ToolModules: ToolModules{
			ProjectTasks: "off",
			Compass:      "off",
		},
	}
	assert.False(t, IsWriteTool("list_chat_attachments"))
	assert.False(t, NeedsReview("list_chat_attachments", in))
	_, err := ValidateTool("list_chat_attachments", json.RawMessage(`{}`), in)
	require.NoError(t, err)
	for _, raw := range []string{
		`{"offset":-1}`,
		`{"offset":10000001}`,
		`{"limit":0}`,
		`{"limit":51}`,
		`{"owner_id":2}`,
		`{"conversation_id":"another-conversation"}`,
		`{"url":"https://example.invalid/file.png"}`,
	} {
		_, err = ValidateTool("list_chat_attachments", json.RawMessage(raw), in)
		require.Error(t, err, raw)
	}
	for _, query := range []string{"list_chat_attachments", "list_attachments", "附件清单"} { //nolint:gosmopolitan // Chinese discovery keywords are part of the supported tool contract.
		state := NewAgentState(context.Background(), Connection{}, in)
		assert.NotContains(t, state.Available, "list_chat_attachments", "list remains deferred")
		raw, marshalErr := json.Marshal(map[string]any{
			"query": query,
			"limit": 1,
		})
		require.NoError(t, marshalErr)
		_, err = state.discover(raw)
		require.NoError(t, err)
		assert.Contains(t, state.Available, "list_chat_attachments", query)
		assert.NotContains(t, state.Available, "insert_chat_image")
	}
}
