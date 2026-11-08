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
	"encoding/json"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/stretchr/testify/require"
)

func TestPersonalNotesAgentGrantPreservesIdentityAndCannotComeFromWire(t *testing.T) {
	original := &User{
		ID:      2,
		IsAdmin: true,
	}
	principal := RestrictToResourcePermissions(WithSessionCredential(original, "original-session"))
	grant := WithPersonalNotesAgentAccess(principal, "update_note", 42).(*User)
	require.True(t, grant.PersonalNotesAgentAllows("update_note", 42))
	require.False(t, grant.PersonalNotesAgentAllows("update_note", 43))
	require.False(t, grant.PersonalNotesAgentAllows("delete_note", 42))
	require.True(t, grant.HasResourceOnlyPermissions())
	require.True(t, grant.IsAdmin)
	require.Equal(t, original.ID, grant.ID)
	require.Equal(t, "original-session", grant.CredentialScope().SessionID)
	require.False(t, original.HasPersonalNotesAgentAccess())
	require.False(t, principal.(*User).HasPersonalNotesAgentAccess(), "granting one operation must not mutate the run's principal")
	raw, err := json.Marshal(grant)
	require.NoError(t, err)
	require.NotContains(t, string(raw), "original-session")
	require.NotContains(t, string(raw), "personalNotes")
	require.NotContains(t, string(raw), "update_note")
	var decoded User
	require.NoError(t, json.Unmarshal([]byte(`{"id":2,"personalNotesTool":"update_note","personal_notes_tool":"update_note","personalNotesTarget":42,"credential":{"SessionID":"original-session"},"resourcePermissionsOnly":true}`), &decoded))
	require.False(t, decoded.HasPersonalNotesAgentAccess())
	require.False(t, decoded.HasResourceOnlyPermissions())
}

func TestPersonalNotesAgentGrantRejectsUntrustedAndWrongOperations(t *testing.T) {
	base := &User{ID: 1}
	for _, principal := range []web.Auth{
		nil,
		base,
		RestrictToResourcePermissions(base),
		WithSessionCredential(base, "session"),
		RestrictToResourcePermissions(WithAPITokenCredential(base, 1)),
		RestrictToResourcePermissions(WithSessionCredential(&User{
			ID:         23,
			BotOwnerID: 21,
		}, "session")),
	} {
		granted := WithPersonalNotesAgentAccess(principal, "get_note", 42)
		if actor, ok := granted.(*User); ok {
			require.False(t, actor.HasPersonalNotesAgentAccess())
		}
	}
	principal := RestrictToResourcePermissions(WithSessionCredential(base, "session"))
	for _, operation := range []struct {
		name string
		id   int64
	}{
		{
			name: "create_note",
			id:   42,
		},
		{
			name: "list_notes",
			id:   42,
		},
		{name: "get_note"},
		{
			name: "delete_note",
			id:   -1,
		},
		{
			name: "append_note_segment",
			id:   42,
		},
		{
			name: "live_recording_offset",
			id:   42,
		},
	} {
		granted := WithPersonalNotesAgentAccess(principal, operation.name, operation.id).(*User)
		require.False(t, granted.HasPersonalNotesAgentAccess())
	}
}
