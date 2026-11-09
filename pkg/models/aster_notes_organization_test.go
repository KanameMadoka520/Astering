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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestAsterNoteOrganizationIsolationPreviewAndRevisionProtection(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	other := &user.User{ID: 2}
	note := asterNoteTestCreate(t, s, 1)
	job, err := CreateAsterNoteOrganization(s, actor, note.ID, "article", "selected", "model")
	require.NoError(t, err)
	require.Equal(t, note.Content, job.SourceArticle)
	_, err = ReadAsterNoteOrganization(s, other, note.ID, job.ID)
	require.EqualError(t, err, "note_not_found")
	_, err = CreateAsterNoteOrganization(s, actor, note.ID, "article", "selected", "model")
	require.EqualError(t, err, "note_organization_busy")
	job.Status = "completed"
	job.Result = "# Organized\nClear ideas"
	require.NoError(t, SaveAsterNoteOrganizationCheckpoint(s, actor, job))
	require.NoError(t, note.ReadOne(s, actor))
	require.NotContains(t, note.Content, "Clear ideas", "a model result must remain a preview until explicitly adopted")
	_, err = ApplyAsterNoteOrganization(s, actor, note.ID, job.ID, note.Revision-1, "replace")
	require.EqualError(t, err, "note_revision_conflict")
	applied, err := ApplyAsterNoteOrganization(s, actor, note.ID, job.ID, note.Revision, "append")
	require.NoError(t, err)
	require.Contains(t, applied.Content, "Keep this editorial text.")
	require.Contains(t, applied.Content, "Clear ideas")
	storage, err := AsterNotesStorage(s, actor.ID)
	require.NoError(t, err)
	require.Positive(t, storage.OrganizationBytes)
	_, err = ChangeAsterNoteOrganization(s, actor, note.ID, job.ID, "discard")
	require.NoError(t, err)
	gone, err := ReadAsterNoteOrganization(s, actor, note.ID, job.ID)
	require.NoError(t, err)
	require.Nil(t, gone)
	require.NoError(t, note.ReadOne(s, actor))
	require.Contains(t, note.Content, "Clear ideas")
}

func TestAsterNoteOrganizationCancellationFencesLateCheckpointAndDeletesPrivately(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, 1)
	job, err := CreateAsterNoteOrganization(s, actor, note.ID, "article", "selected", "model")
	require.NoError(t, err)
	old := *job
	cancelled, err := ChangeAsterNoteOrganization(s, actor, note.ID, job.ID, "cancel")
	require.NoError(t, err)
	require.Equal(t, "cancelled", cancelled.Status)
	old.Status = "completed"
	old.Result = "Late result"
	require.EqualError(t, SaveAsterNoteOrganizationCheckpoint(s, actor, &old), "note_organization_stale")
	retried, err := ChangeAsterNoteOrganization(s, actor, note.ID, job.ID, "retry")
	require.NoError(t, err)
	require.EqualValues(t, 2, retried.Attempt)
	require.EqualError(t, SaveAsterNoteOrganizationCheckpoint(s, actor, &old), "note_organization_stale")
	require.NoError(t, note.Delete(s, actor))
	exists, err := s.ID(job.ID).Exist(&AsterNoteOrganization{})
	require.NoError(t, err)
	require.False(t, exists)
}
