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
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIDiscoveryContractProjection(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write"})
	arguments := json.RawMessage(`{"query":"update_task"}`)
	result, err := state.discover(arguments)
	require.NoError(t, err)
	var receipt map[string]any
	require.NoError(t, json.Unmarshal([]byte(result), &receipt))
	// Keep the real contract intact while crossing the generic preview threshold.
	// Discovery is a protocol message, even when its explanatory text grows.
	receipt["note"] = strings.Repeat("contract explanation ", 1000)
	encoded, err := json.Marshal(receipt)
	require.NoError(t, err)
	projected := modelToolResult("find_tools", arguments, string(encoded), "discovery-result")
	var decoded map[string]any
	require.NoError(t, json.Unmarshal([]byte(projected), &decoded))
	assert.Equal(t, "invoke_tool_v1", decoded["transport"])
	assert.Equal(t, receipt["tools"], decoded["tools"])
	assert.NotContains(t, decoded, "preview")
	assert.NotContains(t, decoded, "read_more")
	assert.Equal(t, "discovery-result", decoded["result_ref"])

	call := toolCall("discovery", "find_tools", arguments)
	history := projectLegacyMessages([]Message{
		{
			Role:      "assistant",
			ToolCalls: []ToolCall{call},
		},
		{
			Role:       "tool",
			ToolCallID: call.ID,
			Content:    projected,
		},
	})
	assert.Equal(t, projected, history[1].Content, "history replay must not repeatedly wrap or truncate discovery")
	next := NewAgentState(context.Background(), Connection{}, RunInput{
		Mode:          "write",
		ServerHistory: history,
	})
	assert.Contains(t, next.Available, "update_task", "the complete current contract must survive the next turn")
	read := NewAgentState(context.Background(), Connection{}, RunInput{
		Mode:          "read",
		ServerHistory: history,
	})
	assert.NotContains(t, read.Available, "update_task", "preserving a definition must not grant write permission")
}

func TestTCYAIOrdinaryResultStillUsesPreview(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{
		"items": []map[string]any{{
			"id":      1,
			"comment": strings.Repeat("content ", 4000),
		}},
	})
	require.NoError(t, err)
	projected := modelToolResult("list_comments", json.RawMessage(`{"task_id":1}`), string(encoded), "comments-result")
	var decoded map[string]any
	require.NoError(t, json.Unmarshal([]byte(projected), &decoded))
	assert.Equal(t, true, decoded["preview_is_partial"])
	assert.Equal(t, "read_tool_result", decoded["read_more"])
	assert.Equal(t, "comments-result", decoded["result_ref"])
	assert.Len(t, []rune(decoded["preview"].(string)), 16000)
}
