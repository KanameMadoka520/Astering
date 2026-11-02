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

func TestTCYAITaskOrderContractAndProjection(t *testing.T) {
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	found, err := read.discover(json.RawMessage(`{"query":"list_view_tasks","limit":1}`))
	require.NoError(t, err)
	assert.Contains(t, found, `"name":"list_view_tasks"`)
	_, err = ValidateTool("list_view_tasks", json.RawMessage(`{"project_id":1,"view_id":1,"page":2}`), read.Input)
	require.NoError(t, err)
	raw := json.RawMessage(`{"project_id":1,"view_id":1,"task_ids":[3],"after_task_id":0,"before_task_id":1,"order_version":"` + strings.Repeat("a", 64) + `"}`)
	_, err = ValidateTool("reorder_view_tasks", raw, read.Input)
	require.Error(t, err)
	_, err = ValidateTool("reorder_view_tasks", raw, RunInput{Mode: "write"})
	require.NoError(t, err)
	for _, approval := range []string{"smart", "review", "auto"} {
		assert.Equal(t, approval != "auto", NeedsReview("reorder_view_tasks", RunInput{Mode: "write", Approval: approval}))
	}
	// Write catalog construction must not mutate the read definition's properties.
	_, err = ValidateTool("list_view_tasks", json.RawMessage(`{"project_id":1,"view_id":1,"page":2}`), RunInput{Mode: "write"})
	require.NoError(t, err)
	result := modelToolResult("reorder_view_tasks", raw, `{"project_id":1,"view_id":1,"bucket_id":0,"task_ids":[3],"order_version":"abc","changed_positions":[{"task_id":3,"project_view_id":1,"position":10}],"manual_order_saved":true,"position_recalculated":false,"verified":true}`, "receipt")
	assert.NotContains(t, result, "changed_positions")
	assert.Contains(t, result, `"task_ids":[3]`)
	assert.Contains(t, result, `"manual_order_saved":true`)
	assert.Contains(t, result, `"read_more":"read_tool_result"`)
}
