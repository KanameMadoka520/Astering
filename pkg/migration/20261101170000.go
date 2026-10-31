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

type compassMedia20261101170000 struct {
	ID        int64     `xorm:"bigint autoincr pk"`
	SpaceID   int64     `xorm:"bigint not null unique(compass_media)"`
	FileID    int64     `xorm:"bigint not null unique(compass_media) index"`
	AddedByID int64     `xorm:"bigint not null"`
	Width     int       `xorm:"int not null default 0"`
	Height    int       `xorm:"int not null default 0"`
	Created   time.Time `xorm:"created not null"`
}

func (*compassMedia20261101170000) TableName() string { return "compass_media" }

type compassEntryMedia20261101170000 struct {
	ID      int64 `xorm:"bigint autoincr pk"`
	EntryID int64 `xorm:"bigint not null unique(compass_entry_media)"`
	FileID  int64 `xorm:"bigint not null unique(compass_entry_media) index"`
	SpaceID int64 `xorm:"bigint not null index"`
	Current bool  `xorm:"not null default false"`
}

func (*compassEntryMedia20261101170000) TableName() string { return "compass_entry_media" }

type compassSpaceMedia20261101170000 struct {
	BackgroundFileID int64  `xorm:"bigint not null default 0"`
	BackgroundFocusX int    `xorm:"int not null default 50"`
	BackgroundFocusY int    `xorm:"int not null default 50"`
	BackgroundScrim  string `xorm:"varchar(8) not null default 'medium'"`
}

func (*compassSpaceMedia20261101170000) TableName() string { return "compass_spaces" }

type compassEntryImages20261101170000 struct {
	ImageCount int `xorm:"int not null default 0"`
}

func (*compassEntryImages20261101170000) TableName() string { return "compass_entries" }
func init() {
	migrations = append(migrations, &xormigrate.Migration{ID: "20261101170000", Description: "Add space-authorized Compass images and backgrounds with historical references", Migrate: func(tx *xorm.Engine) error {
		if err := partialSync(tx, &compassSpaceMedia20261101170000{}); err != nil {
			return err
		}
		if err := partialSync(tx, &compassEntryImages20261101170000{}); err != nil {
			return err
		}
		return tx.Sync(&compassMedia20261101170000{}, &compassEntryMedia20261101170000{}) //nolint:forbidigo // New tables only.
	}, Rollback: func(tx *xorm.Engine) error {
		return tx.DropTables(&compassEntryMedia20261101170000{}, &compassMedia20261101170000{})
	}})
}
