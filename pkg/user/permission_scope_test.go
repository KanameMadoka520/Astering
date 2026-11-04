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

package user

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestResourcePermissionScope(t *testing.T) {
	original := &User{ID: 2, Username: "operator", IsAdmin: true}
	restricted, err := GetFromAuth(RestrictToResourcePermissions(original))
	require.NoError(t, err)
	assert.Equal(t, original.ID, restricted.ID)
	assert.Equal(t, original.Username, restricted.Username)
	assert.True(t, restricted.IsAdmin, "the scope must not rewrite the account role")
	assert.True(t, restricted.HasResourceOnlyPermissions())
	assert.False(t, original.HasResourceOnlyPermissions(), "normal admin requests must keep their original principal")

	raw, err := json.Marshal(restricted)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "resourcePermissions")
	var fromJSON User
	require.NoError(t, json.Unmarshal([]byte(`{"id":2,"resourcePermissionsOnly":true,"resource_permissions_only":true}`), &fromJSON))
	assert.False(t, fromJSON.HasResourceOnlyPermissions(), "wire input cannot create a trusted execution scope")
}

func TestResourcePermissionContext(t *testing.T) {
	type unrelatedKey string
	ordinary := context.WithValue(context.Background(), unrelatedKey("resourcePermissionsOnly"), true)
	assert.False(t, ResourcePermissionsOnly(ordinary))
	scoped := WithResourceOnlyPermissions(ordinary)
	child, cancel := context.WithCancel(scoped)
	defer cancel()
	assert.True(t, ResourcePermissionsOnly(child))
	assert.False(t, ResourcePermissionsOnly(ordinary), "a derived internal request must not change its caller")
}
