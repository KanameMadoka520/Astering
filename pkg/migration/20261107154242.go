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

type AccountAdminEvent20261107154242 struct {
	ID               int64     `xorm:"bigint autoincr pk"`
	ActorID          int64     `xorm:"bigint not null index"`
	ActorUsername    string    `xorm:"varchar(250) not null"`
	TargetID         int64     `xorm:"bigint not null index"`
	TargetUsername   string    `xorm:"varchar(250) not null"`
	Action           string    `xorm:"varchar(24) not null"`
	OldStatus        int       `xorm:"not null"`
	NewStatus        int       `xorm:"not null"`
	RevokedSessions  int64     `xorm:"bigint not null"`
	RevokedAPITokens int64     `xorm:"bigint not null"`
	Reason           string    `xorm:"varchar(250) not null"`
	Created          time.Time `xorm:"created not null index"`
}

func (*AccountAdminEvent20261107154242) TableName() string { return "account_admin_events" }
func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261107154242",
		Description: "Add Astering account-operation journal without changing account roles or business resources",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(&AccountAdminEvent20261107154242{}) //nolint:forbidigo // Brand-new table; no existing indexes or constraints are synchronized.
		},
		Rollback: func(tx *xorm.Engine) error { return tx.DropTables(&AccountAdminEvent20261107154242{}) },
	})
}
