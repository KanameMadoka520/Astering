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

func TestProjectVersionToolsDeferredAndModuleBoundaries(t *testing.T) {
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	for _, name := range []string{"list_project_versions", "get_project_version", "list_project_version_entities", "get_project_version_entity", "get_project_version_preview"} {
		assert.True(t, IsProjectVersionTool(name))
		assert.False(t, IsWriteTool(name))
		assert.NotContains(t, read.Available, name, "extension definitions must stay deferred")
		found, err := read.discover(json.RawMessage(`{"query":"` + name + `","limit":1}`))
		require.NoError(t, err)
		assert.Contains(t, found, `"name":"`+name+`"`)
	}
	hash := strings.Repeat("a", 64)
	args := json.RawMessage(`{"project_id":1,"version_id":2,"expected_current_hash":"` + hash + `","plan_hash":"` + hash + `"}`)
	for _, name := range []string{"save_project_version", "restore_project_version"} {
		input := args
		if name == "save_project_version" {
			input = json.RawMessage(`{"project_id":1,"name":"Before redesign"}`)
		}
		_, err := ValidateTool(name, input, RunInput{Mode: "write"})
		require.NoError(t, err)
		for _, restricted := range []RunInput{
			{Mode: "read"},
			{Mode: "write", ToolModules: ToolModules{ProjectTasks: "off", Compass: "write"}},
			{Mode: "write", ToolModules: ToolModules{ProjectTasks: "read"}},
		} {
			_, err = ValidateTool(name, input, restricted)
			require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
		}
	}
	for _, approval := range []string{"auto", "smart", "review"} {
		assert.True(t, NeedsReview("restore_project_version", RunInput{Mode: "write", Approval: approval}))
	}
	_, err := ValidateTool("get_project_version_preview", json.RawMessage(`{"project_id":1,"version_id":2}`), RunInput{Mode: "write", ToolModules: ToolModules{ProjectTasks: "off"}})
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	assert.NotContains(t, localModulePrompt(RunInput{Mode: "write", ToolModules: ToolModules{ProjectTasks: "off"}}), "restore_project_version")
}

func TestProjectVersionToolsRejectSpoofedAndUnboundedArguments(t *testing.T) {
	for _, tc := range []struct{ tool, args string }{
		{"list_project_versions", `{"project_id":0}`},
		{"list_project_versions", `{"project_id":1,"per_page":100000}`},
		{"get_project_version_entity", `{"project_id":1,"version_id":2,"kind":"task/other","entity_id":"1"}`},
		{"get_project_version_entity", `{"project_id":1,"version_id":2,"kind":"task","entity_id":"../other"}`},
		{"save_project_version", `{"project_id":1,"name":"saved","request_id":"model-spoofed"}`},
		{"restore_project_version", `{"project_id":1,"version_id":2,"expected_current_hash":"guess","plan_hash":"guess"}`},
		{"restore_project_version", `{"project_id":1,"version_id":2,"force":true}`},
	} {
		_, err := ValidateTool(tc.tool, json.RawMessage(tc.args), RunInput{Mode: "write"})
		require.Error(t, err, tc.args)
	}
	_, err := ValidateTool("get_project_version_entity", json.RawMessage(`{"project_id":1,"version_id":2,"kind":"position","entity_id":"1:2"}`), RunInput{Mode: "read"})
	require.NoError(t, err, "compound index IDs must survive intact")
}

func TestProjectVersionRestoreResultKeepsAuditMappingOutsideContext(t *testing.T) {
	data := `{"project_id":1,"restored_from_version_id":2,"before_version_id":3,"version":{"id":4,"project_id":1,"name":"Restored"},"current_hash":"accepted","changed_task_ids":[10,11,12],"removed_task_ids":[13],"id_map":{"tasks":{"10":20}},"verified":true}`
	result := modelToolResult("restore_project_version", json.RawMessage(`{"project_id":1}`), data, "restore-receipt")
	assert.NotContains(t, result, `"id_map"`)
	assert.NotContains(t, result, `"changed_task_ids":[`)
	assert.Contains(t, result, `"changed_task_ids":3`)
	assert.Contains(t, result, `"removed_task_ids":1`)
	assert.Contains(t, result, `"before_version_id":3`)
	assert.Contains(t, result, `"read_more":"read_tool_result"`)
	assert.Contains(t, data, `"id_map"`, "the raw audit result must not be mutated")
}
