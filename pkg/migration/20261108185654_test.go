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
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

type asterNotesSentinel20261108185654 struct {
	ID    int64  `xorm:"bigint autoincr pk"`
	Value string `xorm:"varchar(50) not null unique"`
}

func (*asterNotesSentinel20261108185654) TableName() string {
	return "aster_notes_migration_sentinel"
}

func asterNotesTable20261108185654(t *testing.T, x *xorm.Engine, name string) *schemas.Table {
	t.Helper()
	tables, err := x.DBMetas()
	require.NoError(t, err)
	for _, table := range tables {
		if table.Name == name {
			return table
		}
	}
	t.Fatalf("table %s not found", name)
	return nil
}

func TestAsterNotesMigration20261108185654CreatesOnlyNewTablesAndPreservesUniqueKeys(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	sentinel := &asterNotesSentinel20261108185654{}
	require.NoError(t, x.DropTables(&AsterNoteSegment20261108185654{}, &AsterNote20261108185654{}, sentinel))
	t.Cleanup(func() {
		require.NoError(t, x.DropTables(&AsterNoteSegment20261108185654{}, &AsterNote20261108185654{}, sentinel))
	})
	require.NoError(t, x.Sync2(sentinel))
	_, err = x.Insert(&asterNotesSentinel20261108185654{Value: "keep this existing row"})
	require.NoError(t, err)
	before := asterNotesTable20261108185654(t, x, sentinel.TableName())
	require.NotEmpty(t, before.Indexes)

	require.NoError(t, createAsterNotes20261108185654(x))
	note := &AsterNote20261108185654{
		OwnerID:  42,
		Title:    "A personal draft",
		Content:  "Keep this Markdown",
		Revision: 1,
	}
	_, err = x.Insert(note)
	require.NoError(t, err)
	segment := &AsterNoteSegment20261108185654{
		NoteID:          note.ID,
		ClientID:        "550e8400-e29b-41d4-a716-446655440001",
		Text:            "Original final transcript",
		EndMS:           1234,
		TimingEstimated: true,
	}
	_, err = x.Insert(segment)
	require.NoError(t, err)
	require.NoError(t, createAsterNotes20261108185654(x), "running new-table migration again must preserve existing data and constraints")

	after := asterNotesTable20261108185654(t, x, sentinel.TableName())
	require.Equal(t, before.ColumnsSeq(), after.ColumnsSeq())
	for name, index := range before.Indexes {
		preserved, found := after.Indexes[name]
		require.Truef(t, found, "unrelated existing index %s disappeared", name)
		require.Equal(t, index.Type, preserved.Type)
		require.Equal(t, index.Cols, preserved.Cols)
	}
	sentinelRead := &asterNotesSentinel20261108185654{}
	found, err := x.Where("value = ?", "keep this existing row").Get(sentinelRead)
	require.NoError(t, err)
	require.True(t, found)
	read := &AsterNote20261108185654{}
	found, err = x.ID(note.ID).Get(read)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, note.Content, read.Content)
	require.Equal(t, note.Revision, read.Revision)
	final := &AsterNoteSegment20261108185654{}
	found, err = x.ID(segment.ID).Get(final)
	require.NoError(t, err)
	require.True(t, found)
	require.Equal(t, segment.Text, final.Text)
	require.True(t, final.TimingEstimated)

	segmentTable := asterNotesTable20261108185654(t, x, segment.TableName())
	var uniqueClientKey bool
	for _, index := range segmentTable.Indexes {
		if index.Type == schemas.UniqueType && len(index.Cols) == 2 && index.Cols[0] == "note_id" && index.Cols[1] == "client_id" {
			uniqueClientKey = true
		}
	}
	require.True(t, uniqueClientKey, "one idempotency key must identify exactly one segment per note")
	_, err = x.Insert(&AsterNoteSegment20261108185654{
		NoteID:   note.ID,
		ClientID: segment.ClientID,
		Text:     "A duplicate key cannot replace original text",
	})
	require.Error(t, err)
	_, err = x.Insert(&AsterNoteSegment20261108185654{
		NoteID:   note.ID + 1,
		ClientID: segment.ClientID,
		Text:     "The same client key belongs to a different note",
	})
	require.NoError(t, err)
}
