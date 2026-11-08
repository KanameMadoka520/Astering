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
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type AsterNote20261108185654 struct {
	ID              int64     `xorm:"bigint autoincr pk"`
	OwnerID         int64     `xorm:"bigint not null index(aster_notes_owner_updated)"`
	Title           string    `xorm:"varchar(250) not null"`
	Content         string    `xorm:"longtext not null"`
	Pinned          bool      `xorm:"not null default false"`
	Revision        int64     `xorm:"bigint not null"`
	ContentBytes    int64     `xorm:"bigint not null default 0"`
	TitleBytes      int64     `xorm:"bigint not null default 0"`
	TranscriptBytes int64     `xorm:"bigint not null default 0"`
	SegmentCount    int64     `xorm:"bigint not null default 0"`
	Excerpt         string    `xorm:"text not null"`
	Created         time.Time `xorm:"created not null"`
	Updated         time.Time `xorm:"updated not null index(aster_notes_owner_updated)"`
}

func (*AsterNote20261108185654) TableName() string { return "aster_notes" }

type AsterNoteSegment20261108185654 struct {
	NoteID          int64     `xorm:"bigint not null unique(aster_note_client) index(aster_note_cursor) index(aster_note_end)"`
	ID              int64     `xorm:"bigint autoincr pk index(aster_note_cursor)"`
	ClientID        string    `xorm:"varchar(36) not null unique(aster_note_client)"`
	Text            string    `xorm:"longtext not null"`
	StartMS         int64     `xorm:"bigint not null"`
	EndMS           int64     `xorm:"bigint not null index(aster_note_end)"`
	TimingEstimated bool      `xorm:"not null default false"`
	Created         time.Time `xorm:"created not null"`
}

func (*AsterNoteSegment20261108185654) TableName() string { return "aster_note_segments" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261108185654",
		Description: "Add owner-isolated editable notes and immutable text-only transcript segments",
		Migrate:     createAsterNotes20261108185654,
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(&AsterNoteSegment20261108185654{}, &AsterNote20261108185654{})
		},
	})
}

func createAsterNotes20261108185654(tx *xorm.Engine) error {
	return tx.Sync(&AsterNote20261108185654{}, &AsterNoteSegment20261108185654{}) //nolint:forbidigo // New tables only; existing columns/indexes remain untouched.
}
