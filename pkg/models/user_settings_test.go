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

package models

import (
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/user"

	"github.com/stretchr/testify/assert"
)

func TestUserSettingsEffectiveTimezone(t *testing.T) {
	previous := config.ServiceTimeZone.GetString()
	t.Cleanup(func() { config.ServiceTimeZone.Set(previous) })
	for _, serverZone := range []string{"GMT", "Asia/Shanghai", "America/New_York"} {
		t.Run(serverZone, func(t *testing.T) {
			config.ServiceTimeZone.Set(serverZone)
			legacy := &user.User{}
			assert.Equal(t, serverZone, NewUserGeneralSettings(legacy).Timezone)
			assert.Empty(t, legacy.Timezone, "a read must not write the fallback into the stored user")
			explicit := &user.User{Timezone: "Europe/Berlin"}
			assert.Equal(t, "Europe/Berlin", NewUserGeneralSettings(explicit).Timezone)
			assert.Equal(t, "Europe/Berlin", explicit.Timezone)
		})
	}
}
