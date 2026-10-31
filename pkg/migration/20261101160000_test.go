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

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/files"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

func driveChatRefIndexes(t *testing.T, engine *xorm.Engine) map[string]*schemas.Index {
	t.Helper()
	tables, err := engine.DBMetas()
	require.NoError(t, err)
	for _, table := range tables {
		if table.Name == "drive_chat_refs" {
			for _, column := range []string{"id", "owner_id", "conversation_id", "file_id", "created"} {
				assert.NotNil(t, table.GetColumn(column), column)
			}
			return table.Indexes
		}
	}
	t.Fatal("drive_chat_refs table missing")
	return nil
}

func TestDriveChatRefsMigration20261101160000(t *testing.T) {
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.DropTables(&driveChatRefs20261101160000{}))
	t.Cleanup(func() { require.NoError(t, engine.DropTables(&driveChatRefs20261101160000{})) })
	require.NoError(t, migrateDriveChatRefs20261101160000(engine))
	require.NoError(t, migrateDriveChatRefs20261101160000(engine), "re-running must be harmless")

	conversation := "4b1d5c4e-7f0a-4f5e-9b8a-2c1d0e3f4a5b"
	_, err = engine.Insert(&files.DriveChatRef{OwnerID: 1, ConversationID: conversation, FileID: 7})
	require.NoError(t, err)
	_, err = engine.Insert(&files.DriveChatRef{OwnerID: 1, ConversationID: conversation, FileID: 7})
	require.Error(t, err, "one pin per owner, conversation and file")
	_, err = engine.Insert(&files.DriveChatRef{OwnerID: 1, ConversationID: conversation, FileID: 8}, &files.DriveChatRef{OwnerID: 2, ConversationID: conversation, FileID: 7})
	require.NoError(t, err)

	indexes := driveChatRefIndexes(t, engine)
	unique, lookup := false, false
	for _, index := range indexes {
		if index.Type == schemas.UniqueType && assert.ObjectsAreEqual([]string{"owner_id", "conversation_id", "file_id"}, index.Cols) {
			unique = true
		}
		if index.Type == schemas.IndexType && assert.ObjectsAreEqual([]string{"file_id"}, index.Cols) {
			lookup = true
		}
	}
	assert.True(t, unique, "composite unique index")
	assert.True(t, lookup, "usage lookups by file")
	// The model must describe exactly the migrated table: syncing it adds or drops nothing.
	require.NoError(t, engine.Sync2(&files.DriveChatRef{}))
	after := driveChatRefIndexes(t, engine)
	assert.Len(t, after, len(indexes))
	for name := range indexes {
		assert.Contains(t, after, name)
	}
}
