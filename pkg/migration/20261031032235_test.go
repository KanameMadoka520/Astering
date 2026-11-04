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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/stretchr/testify/require"
)

type projectBefore20261031032235 struct {
	ID         int64  `xorm:"bigint autoincr not null unique pk"`
	Title      string `xorm:"varchar(250) not null index"`
	IsArchived bool   `xorm:"not null default false"`
}

func (*projectBefore20261031032235) TableName() string { return "projects" }

func TestProjectHistoryMigration20261031032235(t *testing.T) {
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	before := &projectBefore20261031032235{}
	require.NoError(t, engine.DropTables(before, &projectLifecycle20261031032235{}))
	t.Cleanup(func() { require.NoError(t, engine.DropTables(before, &projectLifecycle20261031032235{})) })
	require.NoError(t, engine.Sync2(before))
	_, err = engine.Insert(&projectBefore20261031032235{ID: 1, Title: "Legacy archive", IsArchived: true}, &projectBefore20261031032235{ID: 2, Title: "Active"})
	require.NoError(t, err)
	tables, err := engine.DBMetas()
	require.NoError(t, err)
	var indexes []string
	for _, table := range tables {
		if table.Name == "projects" {
			for name := range table.Indexes {
				indexes = append(indexes, name)
			}
		}
	}
	require.NoError(t, migrateProjectLifecycle20261031032235(engine))
	after, err := engine.DBMetas()
	require.NoError(t, err)
	for _, table := range after {
		if table.Name == "projects" {
			for _, name := range indexes {
				require.Contains(t, table.Indexes, name)
			}
			require.NotNil(t, table.GetColumn("title"))
			require.NotNil(t, table.GetColumn("is_completed"))
		}
	}
	var records []projectLifecycle20261031032235
	require.NoError(t, engine.Find(&records))
	require.Len(t, records, 1)
	require.EqualValues(t, 1, records[0].ProjectID)
	require.Equal(t, "archived", records[0].Kind)
	require.Equal(t, time.Time{}, records[0].OccurredAt)
}
