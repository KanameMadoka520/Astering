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

type taskRoutines20261102191757 struct {
	Period      string `xorm:"varchar(10) not null default 'daily'"`
	ResetHour   int    `xorm:"not null default 0"`
	ResetMinute int    `xorm:"not null default 0"`
	WeekStart   int    `xorm:"not null default 0"`
	MonthDay    int    `xorm:"not null default 1"`
	Target      int64  `xorm:"bigint not null default 1"`
	Unit        string `xorm:"varchar(40) not null default ''"`
}

func (*taskRoutines20261102191757) TableName() string { return "task_routines" }

type routineProgress20261102191757 struct {
	ID            int64      `xorm:"bigint autoincr not null pk"`
	TaskID        int64      `xorm:"bigint not null unique(routine_period)"`
	ScheduleKey   string     `xorm:"varchar(64) not null unique(routine_period)"`
	LocalDate     time.Time  `xorm:"DATE not null unique(routine_period)"`
	Period        string     `xorm:"varchar(10) not null"`
	Timezone      string     `xorm:"varchar(100) not null"`
	PeriodStartAt time.Time  `xorm:"not null"`
	PeriodEndAt   time.Time  `xorm:"not null"`
	Amount        int64      `xorm:"bigint not null"`
	Target        int64      `xorm:"bigint not null"`
	Unit          string     `xorm:"varchar(40) not null default ''"`
	CompletedAt   *time.Time `xorm:"null"`
	CompletedByID int64      `xorm:"bigint not null default 0"`
	UpdatedByID   int64      `xorm:"bigint not null"`
	Created       time.Time  `xorm:"created not null"`
	Updated       time.Time  `xorm:"updated not null"`
}

func (*routineProgress20261102191757) TableName() string { return "task_routine_progress" }

func migrateRoutinePeriods20261102191757(tx *xorm.Engine) error {
	if err := partialSync(tx, &taskRoutines20261102191757{}); err != nil {
		return err
	}
	return tx.Sync(&routineProgress20261102191757{}) //nolint:forbidigo // Brand-new table, existing routine indexes are preserved by partialSync.
}

func init() {
	migrations = append(migrations, &xormigrate.Migration{
		ID:          "20261102191757",
		Description: "Add anchored routine periods and isolated quota history",
		Migrate:     migrateRoutinePeriods20261102191757,
		Rollback:    func(tx *xorm.Engine) error { return tx.DropTables(&routineProgress20261102191757{}) },
	})
}
