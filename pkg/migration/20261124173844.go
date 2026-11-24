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

type ProjectVersionSchedule20261124173844 struct {
	ProjectID int64     `xorm:"bigint pk"`
	NextRunAt time.Time `xorm:"not null index"`
}

func (ProjectVersionSchedule20261124173844) TableName() string {
	return "project_version_schedules"
}

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261124173844",
		Description: "Add per-project daily history schedules",
		Migrate: func(tx *xorm.Engine) error {
			return tx.Sync(&ProjectVersionSchedule20261124173844{}) //nolint:forbidigo // New table only.
		},
		Rollback: func(tx *xorm.Engine) error {
			return tx.DropTables(&ProjectVersionSchedule20261124173844{})
		},
	})
}
