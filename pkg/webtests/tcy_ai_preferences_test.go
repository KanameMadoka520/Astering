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

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIPreferences(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	old := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(old) })
	token, other := humaTokenFor(t, &testuser1), humaTokenFor(t, &testuser2)
	path := "/api/v2/ai/preferences"
	assert.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
	p := tcyai.AssistantPreferences{DefaultProfile: "custom-weekly", Profiles: []tcyai.AssistantProfile{{ID: "custom-weekly", Name: "Weekly", Options: tcyai.AssistantOptions{Mode: "write", Approval: "review", MaxRounds: 12, MaxOperations: 30, TimeoutSeconds: 180, WriteProjectIDs: []int64{1}}}}}
	data, err := json.Marshal(p)
	require.NoError(t, err)
	saved := humaRequest(t, e, "POST", path, string(data), token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	assert.Equal(t, 409, humaRequest(t, e, "POST", path, string(data), token, "").Code)
	require.NoError(t, json.Unmarshal(saved.Body.Bytes(), &p))
	assert.EqualValues(t, 1, p.Revision)
	assert.NotContains(t, humaRequest(t, e, "GET", path, "", other, "").Body.String(), "custom-weekly")
	// Saving connection settings from an older client must preserve templates.
	require.Equal(t, 200, humaRequest(t, e, "POST", "/api/v2/ai/settings", `{"connections":[],"assistant":"","transcription":"","cleanup":""}`, token, "").Code)
	assert.Contains(t, humaRequest(t, e, "GET", path, "", token, "").Body.String(), "custom-weekly")
	// Read-only templates cannot carry deletion capability; invalid budgets rejected.
	p.Profiles[0].Options.Mode = "read"
	p.Profiles[0].Options.AllowDelete = true
	data, err = json.Marshal(p)
	require.NoError(t, err)
	assert.Equal(t, 400, humaRequest(t, e, "POST", path, string(data), token, "").Code)
	p.Profiles[0].Options.AllowDelete = false
	p.Profiles[0].Options.MaxRounds = 41
	data, err = json.Marshal(p)
	require.NoError(t, err)
	assert.Equal(t, 422, humaRequest(t, e, "POST", path, string(data), token, "").Code)
	p.Profiles[0].Options.MaxRounds = 8
	p.DefaultProfile = "custom-missing"
	data, err = json.Marshal(p)
	require.NoError(t, err)
	assert.Equal(t, 400, humaRequest(t, e, "POST", path, string(data), token, "").Code)
	// Explicitly verify secrets and streaming settings survive profile writes.
	_, err = tcyai.Save(testuser1.ID, tcyai.Settings{Connections: []tcyai.Connection{{ID: "test", Name: "test", Kind: "chat", BaseURL: "https://example.com/v1", Model: "test", APIKey: "secret", NonStreaming: true}}, Assistant: "test"})
	require.NoError(t, err)
	p.DefaultProfile = "ask"
	data, err = json.Marshal(p)
	require.NoError(t, err)
	require.Equal(t, 200, humaRequest(t, e, "POST", path, string(data), token, "").Code)
	s, err := tcyai.Load(testuser1.ID)
	require.NoError(t, err)
	assert.Equal(t, "secret", s.Connections[0].APIKey)
	assert.True(t, s.Connections[0].NonStreaming)
}
