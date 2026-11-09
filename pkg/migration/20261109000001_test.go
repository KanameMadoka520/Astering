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

package migration

import (
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/stretchr/testify/require"
)

func TestAsterNoteCaptureMigrationPreservesLegacyRowsAndIdempotencyKey(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, x.DropTables(&AsterNoteOrganization20261109000001{}, &AsterNoteSegment20261108185654{}))
	t.Cleanup(func() {
		require.NoError(t, x.DropTables(&AsterNoteOrganization20261109000001{}, &AsterNoteSegment20261108185654{}))
	})
	require.NoError(t, x.Sync2(&AsterNoteSegment20261108185654{}))
	legacy := &AsterNoteSegment20261108185654{
		NoteID:   1,
		ClientID: "89125610-c710-4c76-a251-be8c7f5fa724",
		Text:     "Before capture clocks",
		StartMS:  1,
		EndMS:    2,
	}
	_, err = x.Insert(legacy)
	require.NoError(t, err)
	applied := false
	for _, m := range migrations {
		if m.ID == "20261109000001" {
			require.NoError(t, m.Migrate(x))
			applied = true
			break
		}
	}
	require.True(t, applied)
	capture := &AsterNoteCapture20261109000001{}
	found, err := x.Where("id = ?", legacy.ID).Get(capture)
	require.NoError(t, err)
	require.True(t, found)
	require.Nil(t, capture.CapturedAt)
	require.Nil(t, capture.RecordingStartedAt)
	duplicate := &AsterNoteSegment20261108185654{
		NoteID:   1,
		ClientID: legacy.ClientID,
		Text:     "Must still conflict",
	}
	_, err = x.Insert(duplicate)
	require.Error(t, err, "partial migration must preserve the note/client unique key")
	table := asterNotesTable20261108185654(t, x, "aster_note_segments")
	require.NotNil(t, table.GetColumn("recording_id"))
	require.NotNil(t, table.GetColumn("captured_at"))
}
