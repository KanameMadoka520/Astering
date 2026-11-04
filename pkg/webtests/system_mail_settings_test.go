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
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/mailsettings"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYMailSettingsAccess(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.SetMailerRuntime(nil)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.SetMailerRuntime(nil) })
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "1")
	path := "/api/v2/system/mail-settings"
	token := humaTokenFor(t, &testuser1)
	assert.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
	other := humaTokenFor(t, &testuser2)
	assert.Equal(t, 403, humaRequest(t, e, "GET", path, "", other, "").Code)
	assert.Equal(t, 403, humaRequest(t, e, "POST", path, `{"port":2525,"auth_type":"none","tls_mode":"auto"}`, other, "").Code)
	share, err := auth.NewLinkShareJWTAuthtoken(&models.LinkSharing{ID: 1, Hash: "test", ProjectID: 1})
	require.NoError(t, err)
	assert.Contains(t, []int{401, 403}, humaRequest(t, e, "GET", path, "", share, "").Code)
	access := humaRequest(t, e, "GET", "/api/v2/system/settings-access", "", other, "")
	assert.Contains(t, access.Body.String(), `"can_manage_mail":false`)
	access = humaRequest(t, e, "GET", "/api/v2/system/settings-access", "", token, "")
	assert.Contains(t, access.Body.String(), `"can_manage_mail":true`)
	get := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, get.Code)
	assert.Equal(t, "no-store", get.Header().Get("Cache-Control"))
	body := `{"enabled":true,"host":"smtp.example.com","port":2525,"username":"sender","password":"isolated-password","from_email":"test@example.com","auth_type":"plain","tls_mode":"auto","revision":0}`
	saved := humaRequest(t, e, "POST", path, body, token, "")
	require.Equal(t, 201, saved.Code, saved.Body.String())
	assert.NotContains(t, saved.Body.String(), "isolated-password")
	var value mailsettings.MailSettings
	require.NoError(t, json.Unmarshal(saved.Body.Bytes(), &value))
	assert.True(t, value.HasPassword)
	assert.Equal(t, 409, humaRequest(t, e, "POST", path, body, token, "").Code)
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "")
	assert.Equal(t, 403, humaRequest(t, e, "GET", path, "", token, "").Code)
}
