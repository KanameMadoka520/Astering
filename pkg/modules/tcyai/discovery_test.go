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
	"fmt"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIDeferredTools(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write", AllowDelete: true})
	state.CacheStable = false // Legacy persisted runs keep the old deferred-header transport.
	require.Len(t, state.Available, 6)
	assert.NotContains(t, state.Available, "update_task")
	initial, err := json.Marshal(state.tools())
	require.NoError(t, err)
	full, err := json.Marshal(AllTools("write", true))
	require.NoError(t, err)
	t.Logf("initial definitions: %d bytes vs full %d bytes (%.1f%% reduction)", len(initial), len(full), 100*(1-float64(len(initial))/float64(len(full))))
	require.Less(t, len(initial)*2, len(full))
	result, err := state.discover(json.RawMessage(`{"query":"update_task", "limit":5}`))
	require.NoError(t, err)
	assert.Contains(t, state.Available, "update_task")
	assert.NotContains(t, state.Available, "bulk_update_tasks")
	assert.NotContains(t, result, "parameters")
	assert.NotContains(t, result, "properties")
	var directory struct {
		Tools   []toolEntry
		Matched int  `json:"matched"`
		More    bool `json:"more_available"`
	}
	require.NoError(t, json.Unmarshal([]byte(result), &directory))
	require.Len(t, directory.Tools, 1)
	assert.Equal(t, "update_task", directory.Tools[0].Name)
	result, err = state.discover(json.RawMessage(`{"query":"task project label comment assign relate"}`))
	require.NoError(t, err)
	require.NoError(t, json.Unmarshal([]byte(result), &directory))
	assert.LessOrEqual(t, len(directory.Tools), 5)
	assert.True(t, directory.More)
	state.Pending = []ToolCall{{ID: "pending"}}
	state.Pending[0].Function.Name = "update_task"
	for _, tool := range AllTools("write", true) {
		_, err = state.discover(json.RawMessage(`{"query":"` + toolName(tool) + `","limit":1}`))
		require.NoError(t, err)
	}
	assert.Contains(t, state.Available, "update_task", "must not evict queued calls")
	assert.LessOrEqual(t, len(state.Available), 15, "6 core + 8 recent + pinned call")
	state.Pending = nil
	state.trimTools()
	assert.LessOrEqual(t, len(state.Available), 14, "release completed call pins before the next model request")
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	result, err = read.discover(json.RawMessage(`{"query":"delete_task create_task update_task"}`))
	require.NoError(t, err)
	assert.NotContains(t, result, `"name":"delete_task"`)
	assert.NotContains(t, result, `"name":"create_task"`)
	assert.NotContains(t, result, `"name":"update_task"`)
	// Parameter-only search must not match every schema's ubiquitous id field.
	result, err = state.discover(json.RawMessage(`{"query":"additionalProperties"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"tools":[]`)
}

func TestTCYAIDiscoveryHistory(t *testing.T) {
	call := ToolCall{ID: "discovery"}
	call.Function.Name = "find_tools"
	raw, err := json.Marshal(map[string]any{"tools": AllTools("write", true)})
	require.NoError(t, err)
	messages := []Message{{Role: "assistant", ToolCalls: []ToolCall{call}}, {Role: "tool", ToolCallID: call.ID, Content: string(raw)}, {Role: "tool", ToolCallID: "other", Content: string(raw)}}
	compacted := compactDiscoveryMessages(append([]Message{}, messages...))
	assert.NotContains(t, compacted[1].Content, "parameters")
	assert.Equal(t, messages[2].Content, compacted[2].Content, "unrelated results must remain intact")
	assert.Contains(t, messages[1].Content, "parameters", "stored history is untouched")
}

func TestTCYAICurrentPermissionsOverrideHistory(t *testing.T) {
	for _, mode := range []string{"read", "write", "read"} {
		state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: mode, Approval: "smart", Summary: "The old session was read-only; create_project was unavailable.", ServerHistory: []Message{{Role: "assistant", Content: "I cannot create projects."}}, Message: "Create a project"})
		require.NotNil(t, state.Result.Configuration)
		assert.Equal(t, mode, state.Result.Configuration.Mode)
		assert.Contains(t, state.Messages[1].Content, "past runs only")
		data, err := state.discover(json.RawMessage(`{"query":"create_project","limit":1}`))
		require.NoError(t, err)
		var result struct {
			Tools         []toolEntry      `json:"tools"`
			Configuration AssistantOptions `json:"execution_configuration"`
		}
		require.NoError(t, json.Unmarshal([]byte(data), &result))
		assert.Equal(t, mode, result.Configuration.Mode)
		if mode == "write" {
			require.Len(t, result.Tools, 1)
			assert.Equal(t, "create_project", result.Tools[0].Name)
			assert.Contains(t, state.Available, "create_project")
		} else {
			assert.Empty(t, result.Tools)
			assert.NotContains(t, state.Available, "create_project")
		}
	}
}

//nolint:gosmopolitan // Bilingual discovery keywords.
func TestAppearanceToolDiscovery(t *testing.T) {
	for _, query := range []string{"color", "hex_color", "颜色", "progress", "percent_done", "favorite", "repeat", "move", "cover"} {
		state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write"})
		result, err := state.discover(json.RawMessage(fmt.Sprintf(`{"query":%q}`, query)))
		require.NoError(t, err)
		assert.Contains(t, result, `"name":"update_task"`, query)
	}
	for _, raw := range []string{`{"id":1,"hex_color":"#123456"}`, `{"id":1,"hex_color":"invalid"}`, `{"id":1,"percent_done":101}`, `{"id":1,"repeat_mode":9}`, `{"id":1,"project_id":0}`} {
		_, err := ValidateTool("update_task", json.RawMessage(raw), RunInput{Mode: "write"})
		require.Error(t, err, raw)
	}
	_, err := ValidateTool("update_project", json.RawMessage(`{"id":1,"hex_color":"123456"}`), RunInput{Mode: "read"})
	require.Error(t, err)
}

func TestTCYAIProjectLifecycleContracts(t *testing.T) {
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	result, err := read.discover(json.RawMessage(`{"query":"list_project_history"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"name":"list_project_history"`)
	_, err = ValidateTool("set_project_completed", json.RawMessage(`{"id":1,"completed":true}`), RunInput{Mode: "read"})
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	for _, raw := range []string{`{"id":1}`, `{"id":1,"completed":"false"}`, `{"id":0,"completed":true}`, `{"id":1,"completed":true,"is_archived":true}`} {
		_, err = ValidateTool("set_project_completed", json.RawMessage(raw), RunInput{Mode: "write"})
		require.Error(t, err, raw)
	}
	for _, raw := range []string{`{"year":2026,"kind":"task_done"}`, `{"year":2026,"timezone":5}`, `{"year":2026,"project_id":-1}`, `{"year":2026,"page":0}`} {
		_, err = ValidateTool("list_project_history", json.RawMessage(raw), RunInput{Mode: "read"})
		require.Error(t, err, raw)
	}
	result = compactToolResult("list_project_history", json.RawMessage(`{"year":2026}`), `{"days":{"2026-10-31":1},"items":[{"id":1,"kind":"completed"}],"total":1,"page":1,"total_pages":1,"unknown":0,"milestones":1}`)
	assert.NotContains(t, result, `"days"`, "model does not need the heatmap rendering payload")
	assert.Contains(t, result, `"kind":"completed"`)
	assert.Contains(t, result, `"total_pages":1`)
	result = compactToolResult("set_project_completed", json.RawMessage(`{"id":1,"completed":false}`), `{"id":1,"title":"work","is_completed":false,"is_archived":true,"description":"large unused text"}`)
	assert.Contains(t, result, `"is_completed":false`)
	assert.Contains(t, result, `"is_archived":true`)
	assert.NotContains(t, result, "description")
}

func TestTCYAIProjectTimelineContract(t *testing.T) {
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	result, err := read.discover(json.RawMessage(`{"query":"list_project_timeline"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"name":"list_project_timeline"`)
	for _, raw := range []string{`{"year":2026,"status":"task_done"}`, `{"year":2026,"timezone":5}`, `{"year":2026,"project_id":-1}`, `{"year":2026,"page":0}`, `{"year":2026,"unknown":true}`} {
		_, err = ValidateTool("list_project_timeline", json.RawMessage(raw), RunInput{Mode: "read"})
		require.Error(t, err, raw)
	}
	result = compactToolResult("list_project_timeline", json.RawMessage(`{"year":2026}`), `{"days":{"2026-10-31":{"scheduled_projects":1}},"items":[{"id":1,"progress":0.5,"overdue_since":"2026-10-30","scheduled_spans":[{"start":"2026-10-01","end":"2026-10-31"}]}],"total":1,"page":1,"total_pages":1,"excluded_tasks":2,"dated_tasks":3}`)
	assert.NotContains(t, result, `"days"`)
	assert.NotContains(t, result, "scheduled_spans")
	assert.Contains(t, result, `"progress":0.5`)
	assert.Contains(t, result, `"excluded_tasks":2`)
	assert.Contains(t, result, `"overdue_since":"2026-10-30"`)
}

func TestTCYAIRoutineTools(t *testing.T) {
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	write := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write"})
	for _, name := range []string{"get_project_announcement", "get_task_routine", "get_task_routine_history"} {
		result, err := read.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		require.Contains(t, result, `"name":"`+name+`"`)
	}
	for _, name := range []string{"update_project_announcement", "configure_task_routine", "check_in_task_routine"} {
		result, err := read.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		require.NotContains(t, result, `"name":"`+name+`"`)
		result, err = write.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		require.Contains(t, result, `"name":"`+name+`"`)
	}
	require.True(t, NeedsReview("update_project_announcement", RunInput{Mode: "write", Approval: "auto"}))
	_, err := ValidateTool("check_in_task_routine", json.RawMessage(`{"id":1,"date":"yesterday","completed":true}`), RunInput{Mode: "write"})
	require.Error(t, err)
	result := compactToolResult("list_tasks", json.RawMessage(`{}`), `{"items":[{"id":1,"title":"Daily","done":false,"routine":{"enabled":true,"completed_today":true,"date":"2026-11-01"}}]}`)
	require.Contains(t, result, `"routine"`)
	require.Contains(t, result, `"completed_today":true`)
}
