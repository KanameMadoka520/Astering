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

func TestTCYAIAllDayToolContract(t *testing.T) {
	raw := json.RawMessage(`{"project_id":1,"title":"Civil task","all_day":true,"all_day_start":"2026-11-03","all_day_end":"2026-11-04"}`)
	_, err := ValidateTool("create_task", raw, RunInput{Mode: "write"})
	require.NoError(t, err)
	_, err = ValidateTool("update_task", json.RawMessage(`{"id":1,"all_day":false,"all_day_start":"","all_day_end":""}`), RunInput{Mode: "write"})
	require.NoError(t, err)
	projected := modelToolResult("create_task", raw, `{"id":3,"title":"Civil task","all_day":true,"all_day_start":"2026-11-03","all_day_end":"2026-11-04"}`, "result")
	assert.Contains(t, projected, `"all_day":true`)
	assert.Contains(t, projected, `"all_day_start":"2026-11-03"`)
	assert.Contains(t, projected, `"all_day_end":"2026-11-04"`)
}
