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

type compassspace20261101011920 struct {
	ID           int64     `xorm:"bigint autoincr pk"`
	OwnerID      int64     `xorm:"bigint not null index"`
	TeamID       int64     `xorm:"bigint not null default 0 index"`
	Title        string    `xorm:"varchar(80) not null"`
	Motto        string    `xorm:"text"`
	Introduction string    `xorm:"longtext"`
	Theme        string    `xorm:"varchar(16) not null"`
	Revision     int64     `xorm:"bigint not null"`
	Created      time.Time `xorm:"created not null"`
	Updated      time.Time `xorm:"updated not null"`
}

func (*compassspace20261101011920) TableName() string { return "compass_spaces" }

type compassentry20261101011920 struct {
	ID           int64     `xorm:"bigint autoincr pk"`
	SpaceID      int64     `xorm:"bigint not null index(compass_space_state)"`
	Kind         string    `xorm:"varchar(16) not null"`
	Title        string    `xorm:"varchar(200) not null"`
	Subtitle     string    `xorm:"text"`
	Content      string    `xorm:"longtext"`
	Quote        string    `xorm:"text"`
	Category     string    `xorm:"varchar(80)"`
	Tags         []string  `xorm:"json"`
	TagsSearch   string    `xorm:"text"`
	Theme        string    `xorm:"varchar(16) not null"`
	Pinned       bool      `xorm:"not null default false"`
	State        string    `xorm:"varchar(16) not null index(compass_space_state)"`
	Revision     int64     `xorm:"bigint not null"`
	Created      time.Time `xorm:"created not null"`
	Updated      time.Time `xorm:"updated not null index"`
	CreatedByID  int64     `xorm:"bigint not null"`
	UpdatedByID  int64     `xorm:"bigint not null"`
	Excerpt      string    `xorm:"text"`
	ContentBytes int64     `xorm:"bigint not null"`
}

func (*compassentry20261101011920) TableName() string { return "compass_entries" }

type compassrevision20261101011920 struct {
	ID           int64     `xorm:"bigint autoincr pk"`
	EntryID      int64     `xorm:"bigint not null unique(compass_revision)"`
	Revision     int64     `xorm:"bigint not null unique(compass_revision)"`
	Title        string    `xorm:"varchar(200) not null"`
	Kind         string    `xorm:"varchar(16) not null"`
	State        string    `xorm:"varchar(16) not null"`
	UpdatedByID  int64     `xorm:"bigint not null"`
	Created      time.Time `xorm:"created not null"`
	ContentBytes int64     `xorm:"bigint not null"`
	Snapshot     string    `xorm:"longtext not null"`
}

func (*compassrevision20261101011920) TableName() string { return "compass_revisions" }

func init() {
	migrations = append(migrations, &xormigrate.Migration{ID: "20261101011920", Description: "Add private and team compass spaces, writings and revision history", Migrate: func(tx *xorm.Engine) error {
		return tx.Sync(&compassspace20261101011920{}, &compassentry20261101011920{}, &compassrevision20261101011920{}) //nolint:forbidigo // All are new tables.
	}, Rollback: func(tx *xorm.Engine) error {
		return tx.DropTables(&compassrevision20261101011920{}, &compassentry20261101011920{}, &compassspace20261101011920{})
	}})
}
