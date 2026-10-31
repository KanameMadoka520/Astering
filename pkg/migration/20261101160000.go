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

type driveChatRefs20261101160000 struct {
	ID             int64     `xorm:"bigint autoincr not null unique pk"`
	OwnerID        int64     `xorm:"bigint not null unique(drive_chat_ref)"`
	ConversationID string    `xorm:"varchar(36) not null unique(drive_chat_ref)"`
	FileID         int64     `xorm:"bigint not null unique(drive_chat_ref) index"`
	Created        time.Time `xorm:"created not null"`
}

func (*driveChatRefs20261101160000) TableName() string { return "drive_chat_refs" }

// Conversations live in encrypted files, so drive usage checks need these pins.
// Existing conversations only hold legacy encrypted attachments: nothing to backfill.
func migrateDriveChatRefs20261101160000(tx *xorm.Engine) error {
	return tx.Sync(&driveChatRefs20261101160000{}) //nolint:forbidigo // Brand-new table; no existing indexes can be dropped.
}

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261101160000",
		Description: "Pin drive files referenced by private AI conversations",
		Migrate:     migrateDriveChatRefs20261101160000,
		Rollback:    func(tx *xorm.Engine) error { return tx.DropTables(&driveChatRefs20261101160000{}) },
	})
}
