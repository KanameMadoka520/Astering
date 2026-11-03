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
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAICompassToolContracts(t *testing.T) {
	reader := CompassToolDefinitions("read")
	writer := CompassToolDefinitions("write")
	require.Len(t, reader, 7)
	require.Len(t, writer, 12)
	seen := map[string]bool{}
	for _, definition := range writer {
		name := toolName(definition)
		assert.True(t, IsCompassTool(name))
		assert.False(t, seen[name])
		seen[name] = true
		assert.NotContains(t, name, "delete")
	}
	for _, definition := range reader {
		assert.False(t, IsWriteTool(toolName(definition)))
	}
	input := RunInput{
		Mode:        "write",
		ToolModules: ToolModules{Compass: "write"},
	}
	for _, raw := range []string{
		`{"id":1,"title":"Missing revision"}`,
		`{"id":1,"revision":0,"title":"Bad revision"}`,
		`{"id":1,"revision":1,"owner_id":2}`,
		`{"id":1,"revision":1,"space_id":2}`,
		`{"id":1,"revision":1,"state":"deleted"}`,
	} {
		_, err := ValidateTool("update_compass_entry", json.RawMessage(raw), input)
		require.Error(t, err)
	}
	_, err := ValidateTool("update_compass_entry", json.RawMessage(`{"id":1,"revision":2,"content":"","tags":[],"pinned":false,"state":"active"}`), input)
	require.NoError(t, err)
	for _, mode := range []string{"off", "read"} {
		input.ToolModules.Compass = mode
		_, err = ValidateTool("update_compass_entry", json.RawMessage(`{"id":1,"revision":2,"title":"Changed"}`), input)
		require.Error(t, err)
	}
	input.ToolModules.Compass = "write"
	input.Mode = "read"
	_, err = ValidateTool("create_compass_entry", json.RawMessage(`{"space_id":1,"title":"Changed"}`), input)
	require.Error(t, err)
	input.Mode = "write"
	input.Approval = "auto"
	assert.True(t, NeedsReview("restore_compass_revision", input))
	assert.True(t, NeedsReview("update_compass_entry", input))
}
