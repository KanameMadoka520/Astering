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
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIMCPPrivateSettings(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	previous := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(previous) })
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	path := "/api/v2/user/settings/tcy-ai/mcp"
	assert.Equal(t, http.StatusUnauthorized, humaRequest(t, e, http.MethodGet, path, "", "", "").Code)
	payload := `{"revision":0,"connections":[{"id":"remote","name":"Private MCP","url":"https://mcp.example/endpoint","transport":"streamable_http","preset":"custom","enabled":true,"allow_write":false,"allow_delete":false,"read_tools":["lookup"],"api_key":"private-server-credential"}]}`
	response := humaRequest(t, e, http.MethodPut, path, payload, token, "")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	assert.NotContains(t, response.Body.String(), "private-server-credential")
	var saved tcyai.MCPSettings
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &saved))
	require.Len(t, saved.Connections, 1)
	assert.True(t, saved.Connections[0].HasKey)
	assert.False(t, saved.Connections[0].AllowWrite)
	assert.Equal(t, http.StatusConflict, humaRequest(t, e, http.MethodPut, path, payload, token, "").Code)
	own := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, own.Code)
	assert.Contains(t, own.Body.String(), "Private MCP")
	assert.NotContains(t, own.Body.String(), "private-server-credential")
	different := humaRequest(t, e, http.MethodGet, path, "", other, "")
	require.Equal(t, http.StatusOK, different.Code)
	assert.NotContains(t, different.Body.String(), "Private MCP")
	assert.Equal(t, http.StatusBadRequest, humaRequest(t, e, http.MethodPost, path+"/test", `{"id":"remote","name":"Remote","url":"https://mcp.example/endpoint","transport":"streamable_http","preset":"custom","read_tools":[]}`, other, "").Code)
	saved.Connections[0].URL = "https://other.example/mcp"
	data, err := json.Marshal(saved)
	require.NoError(t, err)
	assert.Equal(t, http.StatusBadRequest, humaRequest(t, e, http.MethodPut, path, string(data), token, "").Code, "a retained secret cannot move to a new destination")
}
