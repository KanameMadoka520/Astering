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

type AsterNoteCapture20261109000001 struct {
	NoteID             int64      `xorm:"bigint not null unique(aster_note_client) index(aster_note_cursor) index(aster_note_end) index(aster_note_recording)"`
	RecordingID        string     `xorm:"varchar(36) not null default '' index(aster_note_recording)"`
	RecordingStartedAt *time.Time `xorm:"datetime(3) null"`
	RecordingOffsetMS  int64      `xorm:"bigint not null default 0"`
	CapturedAt         *time.Time `xorm:"datetime(3) null"`
	Timezone           string     `xorm:"varchar(80) not null default ''"`
	AppendToArticle    bool       `xorm:"not null default false"`
	ArticleAppended    bool       `xorm:"not null default false"`
}

func (*AsterNoteCapture20261109000001) TableName() string { return "aster_note_segments" }

type AsterNoteOrganization20261109000001 struct {
	ID             int64     `xorm:"bigint autoincr pk"`
	OwnerID        int64     `xorm:"bigint not null index(aster_note_org_owner)"`
	NoteID         int64     `xorm:"bigint not null index(aster_note_org_note)"`
	SessionID      string    `xorm:"varchar(100) not null"`
	ConnectionID   string    `xorm:"varchar(80) not null"`
	Model          string    `xorm:"varchar(150) not null"`
	Source         string    `xorm:"varchar(20) not null"`
	SourceRevision int64     `xorm:"bigint not null"`
	SourceEndID    int64     `xorm:"bigint not null"`
	SourceArticle  string    `xorm:"longtext not null"`
	SourceBytes    int64     `xorm:"bigint not null"`
	StorageBytes   int64     `xorm:"bigint not null default 0"`
	ProcessedBytes int64     `xorm:"bigint not null default 0"`
	Status         string    `xorm:"varchar(20) not null"`
	Phase          string    `xorm:"varchar(20) not null"`
	CompletedSteps int64     `xorm:"bigint not null default 0"`
	Level          int64     `xorm:"bigint not null default 0"`
	Attempt        int64     `xorm:"bigint not null"`
	InputTokens    int64     `xorm:"bigint not null default 0"`
	OutputTokens   int64     `xorm:"bigint not null default 0"`
	UsagePartial   bool      `xorm:"not null default false"`
	Result         string    `xorm:"longtext not null"`
	Error          string    `xorm:"text not null"`
	Work           string    `xorm:"longtext not null"`
	Created        time.Time `xorm:"created not null"`
	Updated        time.Time `xorm:"updated not null"`
}

func (*AsterNoteOrganization20261109000001) TableName() string { return "aster_note_organizations" }
func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261109000001",
		Description: "Add real capture clocks and resumable tool-free note organization jobs",
		Migrate: func(tx *xorm.Engine) error {
			if err := partialSync(tx, &AsterNoteCapture20261109000001{}); err != nil {
				return err
			}
			return tx.Sync(&AsterNoteOrganization20261109000001{}) //nolint:forbidigo // Brand-new job table only.
		},
		Rollback: func(tx *xorm.Engine) error { return tx.DropTables(&AsterNoteOrganization20261109000001{}) },
	})
}
