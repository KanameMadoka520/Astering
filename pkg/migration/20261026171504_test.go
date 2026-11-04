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
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDriveMigrationPreservesIndexesAndOwnership(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	tables := []interface{}{&files.DriveFile{}, &files.File{}, &models.TaskAttachment{}, &models.Project{}, &user.User{}}
	require.NoError(t, x.DropTables(tables...))
	t.Cleanup(func() {
		require.NoError(t, x.DropTables(tables...))
	})
	require.NoError(t, x.Sync2(tables[1:]...))
	_, err = x.Exec("CREATE UNIQUE INDEX drive_migration_unique_file_name ON files (name)")
	require.NoError(t, err)
	_, err = x.Insert(&user.User{ID: 901, Username: "drive-migration", Email: "drive@example.test"})
	require.NoError(t, err)
	_, err = x.Insert(&files.File{ID: 901, Name: "owned", CreatedByID: 901}, &files.File{ID: 902, Name: "anonymous", CreatedByID: -901}, &files.File{ID: 903, Name: "export", CreatedByID: 901})
	require.NoError(t, err)
	_, err = x.Insert(&models.TaskAttachment{ID: 901, TaskID: 901, FileID: 901}, &models.TaskAttachment{ID: 902, TaskID: 901, FileID: 902})
	require.NoError(t, err)
	require.NoError(t, migrateDrive20261026171504(x))
	require.NoError(t, migrateDrive20261026171504(x))
	list := []files.DriveFile{}
	require.NoError(t, x.Find(&list))
	require.Len(t, list, 1)
	assert.EqualValues(t, 901, list[0].FileID)
	assert.EqualValues(t, 901, list[0].OwnerID)
	_, err = x.Insert(&files.File{Name: "owned", CreatedByID: 901})
	require.Error(t, err, "unique index must survive migration")
}
