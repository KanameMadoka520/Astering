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

package config

import (
	"os"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAsteringSettingsAdminEnvironmentCompatibility(t *testing.T) {
	t.Run("legacy variable is used only when new variable is absent", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
		require.NoError(t, os.Unsetenv("ASTERING_SETTINGS_ADMIN_IDS"))
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2, 4")
		assert.Equal(t, "2, 4", SettingsAdminIDsEnv())
	})
	t.Run("new allowlist replaces legacy grants", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "7")
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2, 4")
		assert.Equal(t, "7", SettingsAdminIDsEnv())
	})
	t.Run("explicitly empty new variable revokes legacy grants", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2, 4")
		assert.Empty(t, SettingsAdminIDsEnv())
	})
}
