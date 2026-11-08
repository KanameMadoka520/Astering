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

func notesToolInput(mode string) RunInput {
	return RunInput{
		Mode:        "write",
		Approval:    "auto",
		AllowDelete: true,
		ToolModules: ToolModules{
			ProjectTasks: "off",
			Compass:      "off",
			Notes:        mode,
		},
	}
}

func notesToolArguments() map[string]string {
	return map[string]string{
		"list_notes":         `{"page":1,"per_page":10}`,
		"get_note":           `{"id":1}`,
		"list_note_segments": `{"id":1,"latest":true,"per_page":10}`,
		"create_note":        `{"title":"Synthetic note","content":"Fixture article"}`,
		"update_note":        `{"id":1,"expected_revision":1,"append_content":"\nFixture appendix"}`,
		"delete_note":        `{"id":1,"expected_revision":1}`,
	}
}

func TestTCYAINotesModuleBoundary(t *testing.T) {
	for _, globalMode := range []string{"read", "write"} {
		for _, noteMode := range []string{"", "off", "read", "write", "all"} {
			t.Run(globalMode+"/"+noteMode, func(t *testing.T) {
				in := notesToolInput(noteMode)
				in.Mode = globalMode
				in.ToolModules.ProjectTasks = "write"
				in.ToolModules.Compass = "write"
				for name, arguments := range notesToolArguments() {
					allowed := (noteMode == "read" || noteMode == "write") &&
						(!IsWriteTool(name) || (globalMode == "write" && noteMode == "write"))
					_, err := ValidateTool(name, json.RawMessage(arguments), in)
					if allowed {
						require.NoError(t, err, name)
					} else {
						require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", name)
					}
				}
			})
		}
	}
	for name := range notesToolArguments() {
		assert.True(t, IsNoteTool(name), name)
	}
	for _, name := range []string{"append_note_segment", "start_note_recording", "get_task", "unknown_note_tool"} {
		assert.False(t, IsNoteTool(name), name)
		_, err := ValidateTool(name, json.RawMessage(`{"id":1}`), notesToolInput("write"))
		require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", name)
	}
	withoutDelete := notesToolInput("write")
	withoutDelete.AllowDelete = false
	_, err := ValidateTool("delete_note", json.RawMessage(`{"id":1,"expected_revision":1}`), withoutDelete)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	assert.Len(t, NoteToolDefinitions("read", true), 3)
	assert.Len(t, NoteToolDefinitions("write", false), 5)
	assert.Len(t, NoteToolDefinitions("write", true), 6)
}

func TestTCYAINotesToolArgumentContracts(t *testing.T) {
	invalid := []struct {
		name string
		raw  string
	}{
		{
			name: "get_note",
			raw:  `{"id":0}`,
		},
		{
			name: "get_note",
			raw:  `{"id":1,"owner_id":2}`,
		},
		{
			name: "get_note",
			raw:  `{"id":1,"max_chars":32001}`,
		},
		{
			name: "get_note",
			raw:  `{"id":1,"offset":-1}`,
		},
		{
			name: "get_note",
			raw:  `{"id":1,"offset":1}`,
		},
		{
			name: "create_note",
			raw:  `{"title":"   "}`,
		},
		{
			name: "create_note",
			raw:  `{"title":"Fixture","segments":[]}`,
		},
		{
			name: "update_note",
			raw:  `{"id":1,"title":"No revision"}`,
		},
		{
			name: "update_note",
			raw:  `{"id":1,"expected_revision":1}`,
		},
		{
			name: "update_note",
			raw:  `{"id":1,"expected_revision":1,"content":"Replacement","append_content":"Appendix"}`,
		},
		{
			name: "update_note",
			raw:  `{"id":1,"expected_revision":1,"transcript_bytes":0}`,
		},
		{
			name: "delete_note",
			raw:  `{"id":1}`,
		},
		{
			name: "delete_note",
			raw:  `{"id":1,"expected_revision":0}`,
		},
		{
			name: "list_notes",
			raw:  `{"per_page":26}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"per_page":11}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"segment_id":2,"latest":false}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"segment_id":2,"after_id":0}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"segment_id":2,"per_page":1}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"offset":0}`,
		},
		{
			name: "list_note_segments",
			raw:  `{"id":1,"max_chars":100}`,
		},
	}
	for _, test := range invalid {
		_, err := ValidateTool(test.name, json.RawMessage(test.raw), notesToolInput("write"))
		require.ErrorContains(t, err, "INVALID_ARGUMENTS", test.name+": "+test.raw)
	}
	for _, arguments := range []string{
		`{"id":1,"expected_revision":1,"content":""}`,
		`{"id":1,"expected_revision":1,"append_content":""}`,
		`{"id":1,"expected_revision":1,"pinned":false}`,
	} {
		_, err := ValidateTool("update_note", json.RawMessage(arguments), notesToolInput("write"))
		require.NoError(t, err)
	}
	_, err := ValidateTool("list_note_segments", json.RawMessage(`{"id":1,"segment_id":2,"offset":10,"max_chars":32000}`), notesToolInput("read"))
	require.NoError(t, err)
	_, err = ValidateTool("get_note", json.RawMessage(`{"id":1,"offset":10,"max_chars":32000,"expected_revision":7}`), notesToolInput("read"))
	require.NoError(t, err)
}

func TestTCYAINotesDiscoveryRemainsDeferredAndRechecksHistory(t *testing.T) {
	for _, stable := range []bool{false, true} {
		t.Run(map[bool]string{
			false: "native definitions",
			true:  "stable invocation",
		}[stable], func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, notesToolInput("write"))
			state.CacheStable = stable
			for name := range notesToolArguments() {
				assert.NotContains(t, state.Available, name)
			}
			arguments := json.RawMessage(`{"query":"update_note"}`)
			data, err := state.discover(arguments)
			require.NoError(t, err)
			assert.Contains(t, state.Available, "update_note")
			assert.NotContains(t, state.Available, "get_note")
			var directory struct {
				Tools []json.RawMessage `json:"tools"`
			}
			require.NoError(t, json.Unmarshal([]byte(data), &directory))
			require.Len(t, directory.Tools, 1)
			in := notesToolInput("off")
			in.ServerHistory = []Message{
				{
					Role:      "assistant",
					ToolCalls: []ToolCall{toolCall("old-discovery", "find_tools", arguments)},
				},
				{
					Role:       "tool",
					ToolCallID: "old-discovery",
					Content:    data,
				},
			}
			restored := NewAgentState(context.Background(), Connection{}, in)
			assert.NotContains(t, restored.Available, "update_note")
			blocked, err := restored.discover(arguments)
			require.NoError(t, err)
			assert.Contains(t, blocked, `"tools":[]`)
			assert.NotContains(t, restored.Available, "update_note")
		})
	}
}

func TestTCYAINotesWritesAlwaysRequireIndividualReview(t *testing.T) {
	for _, name := range []string{"create_note", "update_note", "delete_note"} {
		t.Run(name, func(t *testing.T) {
			in := notesToolInput("write")
			assert.True(t, NeedsReview(name, in))
			state := NewAgentState(context.Background(), Connection{}, in)
			state.Available = append(state.Available, name)
			arguments := json.RawMessage(notesToolArguments()[name])
			state.Pending = []ToolCall{toolCall("first-write", name, arguments)}
			writes := 0
			execute := func(context.Context, string, json.RawMessage) (string, error) {
				writes++
				return `{"id":1,"revision":2,"verified":true}`, nil
			}
			prepare := func(context.Context, string, json.RawMessage) (Operation, error) {
				return Operation{
					Before:  `{"id":1,"revision":1,"segment_count":0}`,
					Version: "fixture-revision-1",
					Units:   1,
				}, nil
			}
			save := func() error { return nil }
			require.ErrorIs(t, state.toolStep(context.Background(), Connection{}, execute, prepare, save), ErrAgentPaused)
			assert.Zero(t, writes)
			require.NotNil(t, state.Result.Pending)
			firstID := state.Result.Pending.ID
			require.NoError(t, ReviewAgent(context.Background(), state, ReviewInput{
				OperationID: firstID,
				Decision:    "approve",
			}, prepare))
			require.NoError(t, state.toolStep(context.Background(), Connection{}, execute, prepare, save))
			assert.Equal(t, 1, writes)
			state.Pending = []ToolCall{toolCall("second-write", name, arguments)}
			require.ErrorIs(t, state.toolStep(context.Background(), Connection{}, execute, prepare, save), ErrAgentPaused)
			assert.Equal(t, 1, writes)
			require.NotNil(t, state.Result.Pending)
			assert.NotEqual(t, firstID, state.Result.Pending.ID)
		})
	}
}

func TestTCYAINotesApprovedPreviewAndPermissionAreRechecked(t *testing.T) {
	for _, change := range []string{"editorial revision", "new transcript", "module disabled", "delete disabled"} {
		t.Run(change, func(t *testing.T) {
			state := NewAgentState(context.Background(), Connection{}, notesToolInput("write"))
			state.Available = append(state.Available, "delete_note")
			state.Pending = []ToolCall{toolCall("delete", "delete_note", json.RawMessage(`{"id":1,"expected_revision":1}`))}
			before := `{"id":1,"revision":1,"segment_count":0}`
			version := "fixture-revision-1"
			prepare := func(context.Context, string, json.RawMessage) (Operation, error) {
				return Operation{
					Before:  before,
					Version: version,
					Units:   1,
				}, nil
			}
			writes := 0
			execute := func(context.Context, string, json.RawMessage) (string, error) {
				writes++
				return `{}`, nil
			}
			save := func() error { return nil }
			require.ErrorIs(t, state.toolStep(context.Background(), Connection{}, execute, prepare, save), ErrAgentPaused)
			firstID := state.Result.Pending.ID
			require.NoError(t, ReviewAgent(context.Background(), state, ReviewInput{
				OperationID: firstID,
				Decision:    "approve",
			}, prepare))
			switch change {
			case "editorial revision":
				version = "fixture-revision-2"
			case "new transcript":
				before = `{"id":1,"revision":1,"segment_count":1}`
			case "module disabled":
				state.Input.ToolModules.Notes = "off"
			case "delete disabled":
				state.Input.AllowDelete = false
			}
			err := state.toolStep(context.Background(), Connection{}, execute, prepare, save)
			assert.Zero(t, writes)
			if change == "module disabled" || change == "delete disabled" {
				require.NoError(t, err)
				require.Len(t, state.Result.Actions, 1)
				assert.False(t, state.Result.Actions[0].Success)
				assert.Contains(t, state.Result.Actions[0].Result, "TOOL_NOT_ALLOWED")
			} else {
				require.ErrorIs(t, err, ErrAgentPaused)
				require.NotNil(t, state.Result.Pending)
				assert.NotEqual(t, firstID, state.Result.Pending.ID)
				assert.False(t, state.Result.Pending.Approved)
			}
		})
	}
}

func TestTCYAINotesHistoricalSourcesCannotBypassCurrentScope(t *testing.T) {
	original := Action{
		Tool:      "delete_note",
		ResultRef: "note-source",
		Arguments: `{"id":1,"expected_revision":1}`,
		Result:    `{"id":1,"title":"Synthetic private note"}`,
	}
	copied := Action{
		Tool:      "read_tool_result",
		ResultRef: "copied-source",
		Arguments: `{"result_ref":"note-source"}`,
		Result:    `{"content":"Synthetic private copy"}`,
	}
	group, err := json.Marshal(map[string]any{
		"children": []map[string]any{
			{
				"id":       "fixture-child",
				"findings": compactActions([]Action{original, copied}),
			},
		},
	})
	require.NoError(t, err)
	for _, mode := range []string{"off", "read"} {
		for _, child := range []bool{false, true} {
			t.Run(mode+"/"+map[bool]string{
				false: "parent",
				true:  "child",
			}[child], func(t *testing.T) {
				state := NewAgentState(context.Background(), Connection{}, notesToolInput(mode))
				state.Input.AllowDelete = false
				state.Input.ToolModules.ProjectTasks = "write"
				actions := []Action{
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
					{
						ResultRef: "missing-tool-source",
						Result:    original.Result,
					},
					{
						Tool:      "unknown_note_tool",
						ResultRef: "unknown-tool-source",
						Result:    original.Result,
					},
				}
				if child {
					state.Result.Subagents = []SubagentTask{{Actions: actions}}
				} else {
					state.Result.Actions = actions
				}
				for _, ref := range []string{"note-source", "copied-source", "group-source", "cyclic-source", "missing-tool-source", "unknown-tool-source"} {
					for _, part := range []string{"result", "arguments"} {
						raw, err := json.Marshal(map[string]string{
							"result_ref": ref,
							"part":       part,
						})
						require.NoError(t, err)
						data, err := state.readToolResult(raw)
						allowed := mode == "read" && (ref == "note-source" || ref == "copied-source" || ref == "group-source")
						if allowed {
							require.NoError(t, err, ref)
							assert.NotEmpty(t, data)
						} else {
							require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", ref)
							assert.Empty(t, data)
						}
					}
				}
			})
		}
	}
}

func TestTCYAINotesHistoricalDiscoveryChecksAllProvenanceFormats(t *testing.T) {
	for _, directory := range []string{
		`{"tools":[{"name":"get_note"}]}`,
		`{"tools":[{"type":"function","function":{"name":"get_note"}}]}`,
		`{"tools":[{"name":"get_note","function":{"name":"get_task"}}]}`,
		`{"tools":[{"name":"unknown_note_tool"}]}`,
		`{"tools":[{}]}`,
	} {
		state := NewAgentState(context.Background(), Connection{}, notesToolInput("off"))
		state.Input.ToolModules.ProjectTasks = "write"
		state.Result.Actions = []Action{
			{
				Tool:      "find_tools",
				ResultRef: "directory",
				Result:    directory,
			},
		}
		_, err := state.readToolResult(json.RawMessage(`{"result_ref":"directory"}`))
		require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", directory)
		state.Input.ToolModules.Notes = "read"
		_, err = state.readToolResult(json.RawMessage(`{"result_ref":"directory"}`))
		if strings.Contains(directory, "unknown_note_tool") || strings.Contains(directory, "[{}]") {
			require.ErrorContains(t, err, "TOOL_NOT_ALLOWED", directory)
		} else {
			require.NoError(t, err, directory)
		}
	}
}

func TestTCYAINotesPersistedHistoryIsOwnerScopedAndModuleGated(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("notes-history-fixture-secret")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
	conversation, err := CreateConversation(1, "Synthetic note history")
	require.NoError(t, err)
	record, err := readConversation(1, conversation.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{
		{
			ID:     "fixture-turn",
			Status: "completed",
			Result: RunResult{
				Actions: []Action{
					{
						Tool:      "get_note",
						ResultRef: "persisted-note",
						Result:    `{"id":1,"content":"Synthetic private article"}`,
					},
				},
			},
		},
	}
	require.NoError(t, writeConversation(1, record))
	state := &AgentState{
		OwnerID:        1,
		ConversationID: conversation.ID,
		Input:          notesToolInput("off"),
	}
	_, err = state.readToolResult(json.RawMessage(`{"result_ref":"persisted-note"}`))
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	state.Input.ToolModules.Notes = "read"
	data, err := state.readToolResult(json.RawMessage(`{"result_ref":"persisted-note"}`))
	require.NoError(t, err)
	assert.Contains(t, data, "Synthetic private article")
	state.OwnerID = 2
	data, err = state.readToolResult(json.RawMessage(`{"result_ref":"persisted-note"}`))
	require.ErrorContains(t, err, "RESULT_NOT_FOUND")
	assert.Empty(t, data)
}

func TestTCYAINotesConfigurationAndBoundedPagesSurviveReplay(t *testing.T) {
	in := notesToolInput("write")
	options := runOptions(in)
	require.True(t, validAssistantOptions(*options))
	assert.Equal(t, "write", options.ToolModules.Notes)
	assert.Equal(t, "write", retryInput(ChatTurn{Result: RunResult{Configuration: options}}).ToolModules.Notes)
	assert.Equal(t, "off", runOptions(RunInput{Mode: "write"}).ToolModules.Notes)
	options.ToolModules.Notes = "all"
	assert.False(t, validAssistantOptions(*options))
	content := strings.Repeat("n", 32000)
	encoded, err := json.Marshal(map[string]any{
		"id":          1,
		"revision":    7,
		"content":     content,
		"offset":      0,
		"next_offset": 32000,
		"has_more":    true,
	})
	require.NoError(t, err)
	for _, name := range []string{"get_note", "list_note_segments"} {
		projected := modelToolResult(name, json.RawMessage(`{"id":1}`), string(encoded), "fixture-result")
		var result map[string]any
		require.NoError(t, json.Unmarshal([]byte(projected), &result))
		assert.Equal(t, content, result["content"])
		assert.EqualValues(t, 32000, result["next_offset"])
		assert.Equal(t, true, result["has_more"])
		assert.Equal(t, "fixture-result", result["result_ref"])
		assert.NotContains(t, result, "preview_is_partial")
		history := projectLegacyMessages([]Message{
			{
				Role:      "assistant",
				ToolCalls: []ToolCall{toolCall("old-note-result", name, json.RawMessage(`{"id":1}`))},
			},
			{
				Role:       "tool",
				ToolCallID: "old-note-result",
				Content:    string(encoded),
			},
		})
		require.NoError(t, json.Unmarshal([]byte(history[1].Content), &result))
		assert.Equal(t, content, result["content"])
		assert.Equal(t, true, result["has_more"])
	}
}

func TestTCYAINotesSubagentsInheritOnlyReadAccess(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, mode := range []string{"off", "write"} {
		t.Run(mode, func(t *testing.T) {
			var requests atomic.Int64
			expected := mode
			if expected == "write" {
				expected = "read"
			}
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body struct {
					Messages []Message `json:"messages"`
				}
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				foundScope := false
				for _, message := range body.Messages {
					if !strings.HasPrefix(message.Content, "Current execution_context (") {
						continue
					}
					var scope struct {
						Mode                 string      `json:"mode"`
						EffectiveToolModules ToolModules `json:"effective_tool_modules"`
						SubagentsEnabled     bool        `json:"subagents_enabled"`
					}
					if assert.NoError(t, json.Unmarshal([]byte(message.Content[strings.IndexByte(message.Content, '\n')+1:]), &scope)) {
						foundScope = true
						assert.Equal(t, "read", scope.Mode)
						assert.Equal(t, expected, scope.EffectiveToolModules.Notes)
						assert.False(t, scope.SubagentsEnabled)
					}
				}
				assert.True(t, foundScope)
				message := Message{
					Role:    "assistant",
					Content: "Synthetic research complete",
				}
				switch requests.Add(1) {
				case 1:
					message.ToolCalls = []ToolCall{toolCall("discover", "find_tools", json.RawMessage(`{"query":"get_note"}`))}
				case 2:
					message.ToolCalls = []ToolCall{toolCall("read", "invoke_tool", json.RawMessage(`{"name":"get_note","arguments":{"id":1}}`))}
				case 3:
					message.ToolCalls = []ToolCall{toolCall("write", "invoke_tool", json.RawMessage(`{"name":"update_note","arguments":{"id":1,"expected_revision":1,"title":"Forbidden child edit"}}`))}
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
			in := notesToolInput(mode)
			in.EnableSubagents = true
			state := NewAgentState(context.Background(), connection, in)
			var executions atomic.Int64
			result, err := state.delegateTasks(context.Background(), connection,
				json.RawMessage(`{"tasks":[{"goal":"Inspect synthetic note"}]}`),
				func(_ context.Context, name string, _ json.RawMessage) (string, error) {
					executions.Add(1)
					assert.Equal(t, "get_note", name)
					return `{"id":1,"revision":1,"content":"Synthetic note"}`, nil
				}, func() error { return nil })
			require.NoError(t, err)
			assert.Contains(t, result, `"all_joined":true`)
			assert.EqualValues(t, 4, requests.Load())
			if mode == "off" {
				assert.Zero(t, executions.Load())
			} else {
				assert.EqualValues(t, 1, executions.Load())
			}
			require.Len(t, state.Result.Subagents, 1)
			var writeDenied bool
			for _, action := range state.Result.Subagents[0].Actions {
				if action.Tool == "update_note" {
					writeDenied = !action.Success && strings.Contains(action.Result, "TOOL_NOT_ALLOWED")
				}
			}
			assert.True(t, writeDenied)
		})
	}
}
