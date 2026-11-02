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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

type allDayLegacyTask struct {
	ID        int64 `xorm:"pk autoincr"`
	ProjectID int64 `xorm:"bigint not null unique(project_index)"`
	Index     int64 `xorm:"bigint not null unique(project_index)"`
	Title     string
	StartDate time.Time `xorm:"DATETIME INDEX null 'start_date'"`
}

func (allDayLegacyTask) TableName() string { return "tasks" }

type allDayMigratedTask struct {
	ID          int64
	ProjectID   int64
	Index       int64
	Title       string
	StartDate   time.Time `xorm:"DATETIME null 'start_date'"`
	AllDay      bool
	AllDayStart string
	AllDayEnd   string
}

func (allDayMigratedTask) TableName() string { return "tasks" }

func allDayTaskMetadata(t *testing.T, engine *xorm.Engine) *schemas.Table {
	t.Helper()
	tables, err := engine.DBMetas()
	require.NoError(t, err)
	for _, table := range tables {
		if table.Name == "tasks" {
			return table
		}
	}
	t.Fatal("tasks table missing")
	return nil
}

func TestTaskAllDayMigrationPreservesLegacyIndexes(t *testing.T) {
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.DropTables(allDayLegacyTask{}))
	t.Cleanup(func() { require.NoError(t, engine.DropTables(allDayLegacyTask{})) })
	require.NoError(t, engine.Sync2(allDayLegacyTask{}))
	original := &allDayLegacyTask{
		ProjectID: 7,
		Index:     8,
		Title:     "Legacy midnight is not all-day",
		StartDate: time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC),
	}
	_, err = engine.Insert(original)
	require.NoError(t, err)
	before := allDayTaskMetadata(t, engine)
	require.NotEmpty(t, before.Indexes)
	require.NoError(t, partialSync(engine, Task20261103031634{}))
	require.NoError(t, partialSync(engine, Task20261103031634{}))
	after := allDayTaskMetadata(t, engine)
	for _, column := range before.ColumnsSeq() {
		require.NotNil(t, after.GetColumn(column))
	}
	for name, index := range before.Indexes {
		actual, exists := after.Indexes[name]
		require.True(t, exists, name)
		assert.Equal(t, index.Type, actual.Type)
		assert.Equal(t, index.Cols, actual.Cols)
	}
	for _, column := range []string{"all_day", "all_day_start", "all_day_end"} {
		require.NotNil(t, after.GetColumn(column))
	}
	var stored allDayMigratedTask
	found, err := engine.ID(original.ID).Get(&stored)
	require.NoError(t, err)
	require.True(t, found)
	assert.False(t, stored.AllDay)
	assert.Empty(t, stored.AllDayStart)
	assert.Empty(t, stored.AllDayEnd)
	assert.Equal(t, original.Title, stored.Title)
	assert.True(t, original.StartDate.Equal(stored.StartDate))
	_, err = engine.Insert(&allDayLegacyTask{ProjectID: 7, Index: 8})
	require.Error(t, err, "existing project/index uniqueness must remain enforced")
}
