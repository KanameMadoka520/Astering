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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func asterNoteAgentPrincipal(t *testing.T, s *xorm.Session, uid int64) (web.Auth, *Session) {
	t.Helper()
	session := &Session{
		ID:         uuid.NewString(),
		UserID:     uid,
		TokenHash:  uuid.NewString(),
		LastActive: time.Now(),
	}
	_, err := s.Insert(session)
	require.NoError(t, err)
	return user.RestrictToResourcePermissions(user.WithSessionCredential(&user.User{ID: uid}, session.ID)), session
}

func TestAsterNoteAgentGrantIsExactAndCannotAlterRawTranscript(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	note := asterNoteTestCreate(t, s, 1)
	other := asterNoteTestCreate(t, s, 1)
	segment := asterNoteTestSegment("Immutable source", 0, 200)
	require.NoError(t, AppendAsterNoteSegment(s, &user.User{ID: 1}, note.ID, segment))
	principal, _ := asterNoteAgentPrincipal(t, s, 1)
	for _, name := range []string{"get_note", "list_note_segments", "update_note", "delete_note", "create_note", "list_notes"} {
		t.Run(name, func(t *testing.T) {
			id := note.ID
			if name == "create_note" || name == "list_notes" {
				id = 0
			}
			actor := user.WithPersonalNotesAgentAccess(principal, name, id)
			candidate := &AsterNote{
				ID:               note.ID,
				Title:            "Must not bypass another operation",
				ExpectedRevision: 1,
			}
			if name == "get_note" {
				require.NoError(t, candidate.ReadOne(s, actor))
			} else {
				require.Error(t, candidate.ReadOne(s, actor))
			}
			if name != "create_note" {
				require.Error(t, (&AsterNote{Title: "Denied"}).Create(s, actor))
			}
			if name != "update_note" {
				require.Error(t, candidate.Update(s, actor))
			}
			if name != "delete_note" {
				require.Error(t, candidate.Delete(s, actor))
			}
			require.Error(t, (&AsterNote{ID: other.ID}).ReadOne(s, actor))
			require.Error(t, AppendAsterNoteSegment(s, actor, note.ID, asterNoteTestSegment("Not ASR", 200, 400)))
			_, err := AsterNoteRecordingOffset(s, actor, note.ID)
			require.Error(t, err)
			_, err = ReadAsterNoteTranscriptState(s, actor, note.ID)
			require.Error(t, err)
			if name == "list_note_segments" {
				page, err := ListAsterNoteSegments(s, actor, note.ID, 0, 10, false)
				require.NoError(t, err)
				require.Len(t, page.Items, 1)
				original, err := ReadAsterNoteSegment(s, actor, note.ID, segment.ID)
				require.NoError(t, err)
				require.Equal(t, segment.Text, original.Text)
				_, err = ReadAsterNoteSegment(s, actor, other.ID, segment.ID)
				require.Error(t, err)
			} else {
				_, err = ListAsterNoteSegments(s, actor, note.ID, 0, 10, false)
				require.Error(t, err)
			}
			if name != "update_note" && name != "delete_note" {
				_, err = ReadAsterNoteForToolMutation(s, actor, note.ID)
				require.Error(t, err)
			}
		})
	}
	deleter := user.WithPersonalNotesAgentAccess(principal, "delete_note", note.ID)
	require.ErrorContains(t, (&AsterNote{ID: note.ID}).Delete(s, deleter), "note_revision_conflict")
	require.ErrorContains(t, (&AsterNote{
		ID:               note.ID,
		ExpectedRevision: 9,
	}).Delete(s, deleter), "note_revision_conflict")
	current := &AsterNote{ID: note.ID}
	require.NoError(t, current.ReadOne(s, &user.User{ID: 1}))
	require.EqualValues(t, 1, current.SegmentCount)
	require.Equal(t, "Personal research", current.Title)
}

func TestAsterNoteAgentGrantRechecksSessionAndOwner(t *testing.T) {
	for _, scenario := range []string{"foreign", "revoked", "expired", "disabled"} {
		t.Run(scenario, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			note := asterNoteTestCreate(t, s, 1)
			uid := int64(1)
			if scenario == "foreign" {
				uid = 2
			}
			principal, session := asterNoteAgentPrincipal(t, s, uid)
			switch scenario {
			case "revoked":
				_, err := s.ID(session.ID).Delete(&Session{})
				require.NoError(t, err)
			case "expired":
				_, err := s.ID(session.ID).Cols("last_active").Update(&Session{LastActive: time.Now().Add(-365 * 24 * time.Hour)})
				require.NoError(t, err)
			case "disabled":
				_, err := s.ID(uid).Cols("status").Update(&user.User{Status: user.StatusDisabled})
				require.NoError(t, err)
			}
			reader := user.WithPersonalNotesAgentAccess(principal, "get_note", note.ID)
			require.Error(t, (&AsterNote{ID: note.ID}).ReadOne(s, reader))
			writer := user.WithPersonalNotesAgentAccess(principal, "update_note", note.ID)
			_, err := ReadAsterNoteForToolMutation(s, writer, note.ID)
			require.Error(t, err)
		})
	}
}
