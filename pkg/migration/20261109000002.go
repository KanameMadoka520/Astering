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

type AsterAccountDevice20261109000002 struct {
	ID      string    `xorm:"varchar(64) pk"`
	Expires time.Time `xorm:"not null index"`
}

func (*AsterAccountDevice20261109000002) TableName() string { return "aster_account_devices" }

type AsterRememberedAccount20261109000002 struct {
	ID        int64  `xorm:"bigint autoincr pk"`
	DeviceID  string `xorm:"varchar(64) not null unique(aster_device_session) index"`
	SessionID string `xorm:"varchar(36) not null unique(aster_device_session) index"`
}

func (*AsterRememberedAccount20261109000002) TableName() string { return "aster_remembered_accounts" }
func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261109000002",
		Description: "Add device-scoped hashed remembered-account credentials bound to live login sessions",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(&AsterAccountDevice20261109000002{}, &AsterRememberedAccount20261109000002{}) //nolint:forbidigo // New tables only.
		},
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(&AsterRememberedAccount20261109000002{}, &AsterAccountDevice20261109000002{})
		},
	})
}
