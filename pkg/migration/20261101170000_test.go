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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

func TestCompassMediaMigrationPreservesWritingSchema(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	tables := []interface{}{&compassspace20261101011920{}, &compassentry20261101011920{}, &compassrevision20261101011920{}, &compassMedia20261101170000{}, &compassEntryMedia20261101170000{}}
	require.NoError(t, x.DropTables(tables...))
	t.Cleanup(func() { require.NoError(t, x.DropTables(tables...)) })
	require.NoError(t, x.Sync2(tables[:3]...))
	c := &compassspace20261101011920{OwnerID: 1, Title: "Preserve writing", Theme: "aurora", Revision: 7}
	_, err = x.Insert(c)
	require.NoError(t, err)
	before, err := x.DBMetas()
	require.NoError(t, err)
	found := false
	for _, m := range migrations {
		if m.ID == "20261101170000" {
			require.NoError(t, m.Migrate(x))
			found = true
			break
		}
	}
	require.True(t, found)
	after, err := x.DBMetas()
	require.NoError(t, err)
	byName := map[string]*schemas.Table{}
	for _, table := range after {
		byName[table.Name] = table
	}
	for _, table := range before {
		if table.Name != "compass_spaces" && table.Name != "compass_entries" && table.Name != "compass_revisions" {
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
	var row compassSpaceMedia20261101170000
	ok, err := x.Where("id = ?", c.ID).Get(&row)
	require.NoError(t, err)
	require.True(t, ok)
	require.Zero(t, row.BackgroundFileID)
	require.Equal(t, 50, row.BackgroundFocusX)
	require.Equal(t, "medium", row.BackgroundScrim)
	saved := &compassspace20261101011920{}
	ok, err = x.ID(c.ID).Get(saved)
	require.NoError(t, err)
	require.True(t, ok)
	require.Equal(t, c.Title, saved.Title)
	require.Equal(t, c.Revision, saved.Revision)
	_, err = x.Insert(&compassMedia20261101170000{SpaceID: c.ID, FileID: 1, AddedByID: 1})
	require.NoError(t, err)
	_, err = x.Insert(&compassMedia20261101170000{SpaceID: c.ID, FileID: 1, AddedByID: 2})
	require.Error(t, err)
}
