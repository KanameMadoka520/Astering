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

	"github.com/KanameMadoka520/Astering/pkg/web"
)

type resourcePermissionsContextKey struct{}

// WithResourceOnlyPermissions prevents a trusted internal request from inheriting
// an instance administrator's cross-user resource bypass. It never grants access.
// The private context key cannot be supplied through headers, JSON or JWT claims.
func WithResourceOnlyPermissions(ctx context.Context) context.Context {
	return context.WithValue(ctx, resourcePermissionsContextKey{}, true)
}

// ResourcePermissionsOnly reports the trusted scope on an internal request.
func ResourcePermissionsOnly(ctx context.Context) bool {
	restricted, _ := ctx.Value(resourcePermissionsContextKey{}).(bool)
	return restricted
}

// RestrictToResourcePermissions copies a user principal while retaining identity,
// ownership and explicit sharing rights. It does not modify the original user or
// clear the persisted administrator flag. Other principal types gain no rights.
func RestrictToResourcePermissions(a web.Auth) web.Auth {
	u, ok := a.(*User)
	if !ok || u == nil {
		return a
	}
	restricted := *u
	restricted.resourcePermissionsOnly = true
	return &restricted
}

// HasResourceOnlyPermissions reports whether this principal must use only normal
// ownership and sharing checks, even when it is an instance administrator.
func (u *User) HasResourceOnlyPermissions() bool {
	return u != nil && u.resourcePermissionsOnly
}

// WithPersonalNotesAgentAccess authorizes only the dedicated in-process notes
// executor. The principal stays resource-restricted and keeps its original
// human session; JSON, JWT claims and HTTP headers cannot create this marker.
func WithPersonalNotesAgentAccess(a web.Auth, tool string, noteID int64) web.Auth {
	u, ok := a.(*User)
	if !ok || u == nil || !u.HasResourceOnlyPermissions() || u.IsBot() || u.credential.SessionID == "" || u.credential.APITokenID != 0 {
		return a
	}
	switch tool {
	case "list_notes", "create_note":
		if noteID != 0 {
			return a
		}
	case "get_note", "list_note_segments", "update_note", "delete_note":
		if noteID <= 0 {
			return a
		}
	default:
		return a
	}
	scoped := *u
	scoped.personalNotesTool = tool
	scoped.personalNotesTarget = noteID
	return &scoped
}

func (u *User) HasPersonalNotesAgentAccess() bool {
	return u != nil && u.personalNotesTool != "" && u.HasResourceOnlyPermissions() && u.credential.SessionID != "" && u.credential.APITokenID == 0 && !u.IsBot()
}

func (u *User) PersonalNotesAgentAllows(tool string, noteID int64) bool {
	return u.HasPersonalNotesAgentAccess() && u.personalNotesTool == tool && u.personalNotesTarget == noteID
}
