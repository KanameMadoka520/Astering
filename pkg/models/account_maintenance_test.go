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
	"errors"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAccountMaintenanceDoesNotLeakOrGrantForeignPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	actor := &user.User{ID: 2}
	project := &Project{Title: "Account maintenance retains existing ownership"}
	require.NoError(t, project.Create(s, actor))
	_, err := s.ID(2).Cols("status").Update(&user.User{Status: user.StatusDisabled})
	require.NoError(t, err)
	_, _, err = currentProjectReadPermission(s, actor, project.ID)
	require.True(t, IsErrGenericForbidden(err))
	maintenanceFailure := errors.New("maintenance interrupted")
	err = withProjectAccountMaintenance(s, 2, func() error {
		_, _, permissionErr := currentProjectReadPermission(s, actor, project.ID)
		require.NoError(t, permissionErr, "internal provisioning/deletion retains the user's existing ownership")
		_, _, permissionErr = currentProjectReadPermission(s, actor, 2)
		assert.True(t, IsErrGenericForbidden(permissionErr), "maintenance must not create cross-user project access")
		for _, external := range []web.Auth{
			user.RestrictToResourcePermissions(actor),
			user.WithSessionCredential(actor, "browser-session"),
			user.WithAPITokenCredential(actor, 100),
		} {
			_, _, permissionErr = currentProjectReadPermission(s, external, project.ID)
			assert.True(t, IsErrGenericForbidden(permissionErr), "external and agent principals cannot inherit an internal maintenance scope")
		}
		return maintenanceFailure
	})
	require.ErrorIs(t, err, maintenanceFailure)
	_, stillScoped := projectAccountMaintenance.Load(s)
	assert.False(t, stillScoped, "a failed maintenance operation must always remove its transaction-local scope")
	_, _, err = currentProjectReadPermission(s, actor, project.ID)
	assert.True(t, IsErrGenericForbidden(err), "the same transaction must recover its normal active-account requirement")
}

func TestAccountMaintenanceNestedIdentityScopeRestoresParent(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 2}
	require.NoError(t, withProjectAccountMaintenance(s, 2, func() error {
		assert.True(t, accountMaintenanceAllowsInactive(s, actor, 2))
		assert.False(t, accountMaintenanceAllowsInactive(s, actor, 3))
		require.NoError(t, withProjectAccountMaintenance(s, 3, func() error {
			assert.True(t, accountMaintenanceAllowsInactive(s, actor, 2))
			assert.True(t, accountMaintenanceAllowsInactive(s, actor, 3))
			return nil
		}))
		assert.True(t, accountMaintenanceAllowsInactive(s, actor, 2))
		assert.False(t, accountMaintenanceAllowsInactive(s, actor, 3))
		return nil
	}))
	assert.False(t, accountMaintenanceAllowsInactive(s, actor, 2))
	_, stillScoped := projectAccountMaintenance.Load(s)
	assert.False(t, stillScoped)
}
