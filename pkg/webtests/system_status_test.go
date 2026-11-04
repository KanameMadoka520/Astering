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

package webtests

import (
	"encoding/json"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/systemstatus"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYSystemStatus(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	path := "/api/v2/system/status"
	assert.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
	share, err := auth.NewLinkShareJWTAuthtoken(&models.LinkSharing{ID: 1, Hash: "test", ProjectID: 1})
	require.NoError(t, err)
	assert.Contains(t, []int{401, 403}, humaRequest(t, e, "GET", path, "", share, "").Code)
	token := humaTokenFor(t, &testuser1)
	first := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, first.Code, first.Body.String())
	assert.Equal(t, "no-store", first.Header().Get("Cache-Control"))
	var status systemstatus.Snapshot
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &status))
	assert.True(t, status.Healthy)
	assert.Equal(t, "host", status.Scope)
	assert.False(t, status.Started.IsZero())
	assert.False(t, status.Sampled.IsZero())
	second := humaRequest(t, e, "GET", path, "", token, "")
	assert.JSONEq(t, first.Body.String(), second.Body.String())
}
