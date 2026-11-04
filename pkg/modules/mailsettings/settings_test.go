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

package mailsettings

import (
	"encoding/json"
	"os"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYMailSettings(t *testing.T) {
	config.InitDefaultConfig()
	config.SetMailerRuntime(nil)
	t.Cleanup(func() { config.SetMailerRuntime(nil) })
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("isolated-settings-test-key")
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
	require.NoError(t, os.Unsetenv("ASTERING_SETTINGS_ADMIN_IDS"))
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2, 4")
	assert.True(t, CanManage(2))
	assert.True(t, CanManage(4))
	assert.False(t, CanManage(1))
	assert.False(t, CanManage(0))
	initial := Read()
	assert.Equal(t, "environment", initial.Source)
	candidate := MailSettings{Enabled: true, Host: "smtp.example.com", Port: 2525, Username: "sender", Password: "private-smtp-fixture", FromEmail: "noreply@example.com", AuthType: "plain", TLSMode: "auto"}
	saved, err := Save(candidate)
	require.NoError(t, err)
	assert.True(t, saved.HasPassword)
	assert.Empty(t, saved.Password)
	assert.EqualValues(t, 1, saved.Revision)
	wire, err := json.Marshal(saved)
	require.NoError(t, err)
	assert.NotContains(t, string(wire), candidate.Password)
	disk, err := os.ReadFile(settingsPath())
	require.NoError(t, err)
	assert.NotContains(t, string(disk), candidate.Password)
	stat, err := os.Stat(settingsPath())
	require.NoError(t, err)
	assert.EqualValues(t, 0600, stat.Mode().Perm())
	_, err = Save(candidate)
	require.ErrorIs(t, err, ErrConflict)
	saved.Port = 587
	saved.TLSMode = "starttls"
	saved, err = Save(saved)
	require.NoError(t, err)
	assert.Equal(t, candidate.Password, config.MailerPassword.GetString())
	assert.Equal(t, 587, config.MailerPort.GetInt())
	bad := saved
	bad.Host = "https://other.example.com/v1"
	_, err = Save(bad)
	require.Error(t, err)
	bad.Host = "other.example.com"
	_, err = Save(bad)
	require.Error(t, err)
	assert.Equal(t, "smtp.example.com", config.MailerHost.GetString())
	config.SetMailerRuntime(nil)
	require.NoError(t, Initialize())
	assert.Equal(t, 587, Read().Port)
	assert.True(t, Read().HasPassword)
	saved.Enabled = false
	saved.ClearPassword = true
	saved, err = Save(saved)
	require.NoError(t, err)
	assert.False(t, config.MailerEnabled.GetBool())
	assert.False(t, saved.HasPassword)
	config.ServiceSecret.Set("wrong-key")
	assert.Error(t, Initialize())
}

func TestAsteringMailSettingsAdminCompatibility(t *testing.T) {
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2, 4")
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "7, invalid, 0, -1")
	assert.True(t, CanManage(7))
	assert.False(t, CanManage(2))
	assert.False(t, CanManage(4))
	assert.False(t, CanManage(0))
	assert.False(t, CanManage(-1))

	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
	assert.False(t, CanManage(2))
	assert.False(t, CanManage(7))

	require.NoError(t, os.Unsetenv("ASTERING_SETTINGS_ADMIN_IDS"))
	assert.True(t, CanManage(2))
	assert.True(t, CanManage(4))
	assert.False(t, CanManage(7))
}
