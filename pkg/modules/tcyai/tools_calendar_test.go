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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAICalendarToolContract(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	assert.NotContains(t, state.Available, "list_calendar_events")
	found, err := state.discover(json.RawMessage(`{"query":"list_calendar_events","limit":1}`))
	require.NoError(t, err)
	assert.Contains(t, found, `"name":"list_calendar_events"`)
	assert.Contains(t, state.Available, "list_calendar_events")
	assert.False(t, IsWriteTool("list_calendar_events"))
	_, err = ValidateTool("list_calendar_events", json.RawMessage(`{"from":"2024-03-10","to":"2024-03-11","timezone":"America/New_York","project_id":0,"done":"all","include_archived":true,"page":2,"per_page":10}`), state.Input)
	require.NoError(t, err)
	for _, raw := range []string{
		`{"from":"2024-03-10"}`,
		`{"from":"2024-03-10T00:00:00Z","to":"2024-03-11"}`,
		`{"from":"2024-03-10","to":"2024-03-11","project_id":-1}`,
		`{"from":"2024-03-10","to":"2024-03-11","done":"invalid"}`,
		`{"from":"2024-03-10","to":"2024-03-11","description":"not a filter"}`,
	} {
		_, err = ValidateTool("list_calendar_events", json.RawMessage(raw), state.Input)
		require.Error(t, err)
	}
	clearDates := json.RawMessage(`{"id":1,"start_date":"0001-01-01T00:00:00Z","end_date":"0001-01-01T00:00:00Z","due_date":"0001-01-01T00:00:00Z"}`)
	_, err = ValidateTool("update_task", clearDates, RunInput{Mode: "write"})
	require.NoError(t, err, "calendar removal reuses the existing explicit date-clear contract")
	_, err = ValidateTool("update_task", clearDates, RunInput{Mode: "read"})
	require.Error(t, err, "calendar reads must not grant write capabilities")
	prompt := SystemPrompt(context.Background(), RunInput{Mode: "read"})
	assert.Contains(t, prompt, "list_calendar_events")
	assert.Contains(t, prompt, "0001-01-01T00:00:00Z")
}

func TestTCYAICalendarModelProjection(t *testing.T) {
	raw := json.RawMessage(`{"from":"2024-03-10","to":"2024-03-11"}`)
	data := `{"items":[{"id":1,"title":"Sample event","project_id":1,"start_date":"2024-03-10T12:00:00Z","end_date":"0001-01-01T00:00:00Z","due_date":"2024-03-10T13:00:00Z","updated":"2024-03-01T00:00:00Z"}],"total":3,"page":2,"per_page":1,"total_pages":3,"timezone":"America/New_York","from":"2024-03-10","to":"2024-03-11","days":[{"date":"2024-03-10","start_at":"2024-03-10T05:00:00Z","end_at":"2024-03-11T04:00:00Z"}]}`
	actual := modelToolResult("list_calendar_events", raw, data, "calendar-receipt")
	var original, projected map[string]any
	require.NoError(t, json.Unmarshal([]byte(data), &original))
	require.NoError(t, json.Unmarshal([]byte(actual), &projected))
	for _, field := range []string{"items", "total", "page", "per_page", "total_pages", "timezone", "from", "to"} {
		assert.Equal(t, original[field], projected[field], field)
	}
	assert.NotContains(t, projected, "days")
	assert.NotContains(t, actual, "description")
	assert.Equal(t, "calendar-receipt", projected["result_ref"])
	assert.Equal(t, "read_tool_result", projected["read_more"])
}
