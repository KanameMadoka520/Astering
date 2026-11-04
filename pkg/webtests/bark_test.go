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
	"net/http"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/bark"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBarkPersonalSettings(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	old := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(old) })
	token, other := humaTokenFor(t, &testuser1), humaTokenFor(t, &testuser2)
	path := "/api/v2/user/push/bark"
	assert.Equal(t, http.StatusUnauthorized, humaRequest(t, e, "GET", path, "", "", "").Code)
	body := `{"revision":0,"enabled":true,"server_url":"https://api.day.app","device_key":"private-test-key","scope":"reminders","level":"timeSensitive","preview":false,"language":"en"}`
	res := humaRequest(t, e, "POST", path, body, token, "")
	require.Equal(t, http.StatusCreated, res.Code, res.Body.String())
	assert.NotContains(t, res.Body.String(), "private-test-key")
	assert.Equal(t, "no-store", res.Header().Get("Cache-Control"))
	assert.Equal(t, http.StatusConflict, humaRequest(t, e, "POST", path, body, token, "").Code)
	res = humaRequest(t, e, "GET", path, "", other, "")
	var s bark.BarkStatus
	require.NoError(t, json.Unmarshal(res.Body.Bytes(), &s))
	assert.False(t, s.Settings.HasKey)
	assert.False(t, s.Settings.Enabled)
	assert.Equal(t, http.StatusBadRequest, humaRequest(t, e, "POST", path+"/test", "{}", other, "").Code)
}
