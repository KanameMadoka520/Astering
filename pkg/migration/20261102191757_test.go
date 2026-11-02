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
	"time"

	"code.vikunja.io/api/pkg/db"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

func TestRoutinePeriodMigrationPreservesDailyHistory(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	tables := []any{&routine20261031234639{}, &checkin20261031234639{}, &routineProgress20261102191757{}}
	require.NoError(t, x.DropTables(tables...))
	t.Cleanup(func() { require.NoError(t, x.DropTables(tables...)) })
	require.NoError(t, x.Sync2(tables[:2]...))
	_, err = x.Insert(&routine20261031234639{
		TaskID:   94101,
		Enabled:  true,
		Timezone: "UTC",
		Revision: 7,
	})
	require.NoError(t, err)
	day := time.Date(2026, 11, 2, 0, 0, 0, 0, time.UTC)
	check := &checkin20261031234639{
		TaskID:        94101,
		LocalDate:     day,
		Timezone:      "UTC",
		CompletedAt:   day.Add(time.Hour),
		CompletedByID: 1,
	}
	_, err = x.Insert(check)
	require.NoError(t, err)
	before, err := x.DBMetas()
	require.NoError(t, err)
	require.NoError(t, migrateRoutinePeriods20261102191757(x))
	after, err := x.DBMetas()
	require.NoError(t, err)
	byName := map[string]*schemas.Table{}
	for _, table := range after {
		byName[table.Name] = table
	}
	for _, table := range before {
		if table.Name != "task_routines" && table.Name != "task_routine_checkins" {
			continue
		}
		require.NotNil(t, byName[table.Name])
		for _, col := range table.ColumnsSeq() {
			require.NotNil(t, byName[table.Name].GetColumn(col))
		}
		for name, index := range table.Indexes {
			got := byName[table.Name].Indexes[name]
			require.NotNil(t, got)
			require.Equal(t, index.Type, got.Type)
			require.Equal(t, index.Cols, got.Cols)
		}
	}
	saved := &routine20261031234639{}
	exists, err := x.ID(94101).Get(saved)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, int64(7), saved.Revision)
	require.True(t, saved.Enabled)
	var config taskRoutines20261102191757
	exists, err = x.Where("task_id = ?", 94101).Get(&config)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, "daily", config.Period)
	require.Equal(t, int64(1), config.Target)
	require.Zero(t, config.ResetHour)
	check.ID = 0
	_, err = x.Insert(check)
	require.Error(t, err, "legacy task/date uniqueness must survive migration")
	record := &routineProgress20261102191757{
		TaskID:        94101,
		ScheduleKey:   "configuration-one",
		LocalDate:     day,
		Period:        "weekly",
		Timezone:      "UTC",
		PeriodStartAt: day,
		PeriodEndAt:   day.AddDate(0, 0, 7),
		Amount:        2,
		Target:        3,
		Unit:          "sessions",
		UpdatedByID:   1,
	}
	_, err = x.Insert(record)
	require.NoError(t, err, "incomplete progress allows null completion time")
	record.ID = 0
	_, err = x.Insert(record)
	require.Error(t, err, "a configuration and period cannot be recorded twice")
	record.ID = 0
	record.ScheduleKey = "configuration-two"
	_, err = x.Insert(record)
	require.NoError(t, err, "same date in a different configuration is independent history")
}
