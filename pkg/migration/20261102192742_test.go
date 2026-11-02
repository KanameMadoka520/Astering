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
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

type taskBucketsBefore20261102192742 struct {
	TaskID        int64 `xorm:"bigint not null index unique(task_view)"`
	ProjectViewID int64 `xorm:"bigint not null index unique(task_view)"`
	BucketID      int64 `xorm:"bigint not null index"`
}

func (taskBucketsBefore20261102192742) TableName() string { return "task_buckets" }

type taskBucketsAfter20261102192742 struct {
	TaskID               int64  `xorm:"bigint not null index unique(task_view)"`
	ProjectViewID        int64  `xorm:"bigint not null index unique(task_view)"`
	BucketID             int64  `xorm:"bigint not null index"`
	RepeatReturnMode     string `xorm:"varchar(10) not null default 'default'"`
	RepeatReturnBucketID int64  `xorm:"bigint not null default 0"`
}

func (taskBucketsAfter20261102192742) TableName() string { return "task_buckets" }

func repeatBucketsMetadata(t *testing.T, x *xorm.Engine) *schemas.Table {
	t.Helper()
	tables, err := x.DBMetas()
	require.NoError(t, err)
	for _, table := range tables {
		if table.Name == "task_buckets" {
			return table
		}
	}
	t.Fatal("task_buckets table missing")
	return nil
}

func TestTaskRepeatBucketMigrationPreservesPlacementIndexes(t *testing.T) {
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	table := taskBucketsBefore20261102192742{}
	require.NoError(t, x.DropTables(table))
	t.Cleanup(func() { require.NoError(t, x.DropTables(table)) })
	require.NoError(t, x.Sync2(table))
	original := &taskBucketsBefore20261102192742{
		TaskID:        7,
		ProjectViewID: 8,
		BucketID:      9,
	}
	_, err = x.Insert(original)
	require.NoError(t, err)
	before := repeatBucketsMetadata(t, x)
	require.NotEmpty(t, before.Indexes)
	require.NoError(t, partialSync(x, TaskBuckets20261102192742{}))
	after := repeatBucketsMetadata(t, x)
	require.NotNil(t, after.GetColumn("repeat_return_mode"))
	require.NotNil(t, after.GetColumn("repeat_return_bucket_id"))
	for _, name := range before.ColumnsSeq() {
		require.NotNil(t, after.GetColumn(name))
	}
	for name, index := range before.Indexes {
		got, ok := after.Indexes[name]
		require.True(t, ok, name)
		require.Equal(t, index.Type, got.Type)
		require.Equal(t, index.Cols, got.Cols)
	}
	row := &taskBucketsAfter20261102192742{}
	exists, err := x.Where("task_id = ? AND project_view_id = ?", 7, 8).Get(row)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, int64(9), row.BucketID)
	require.Equal(t, "default", row.RepeatReturnMode)
	require.Zero(t, row.RepeatReturnBucketID)
	_, err = x.Insert(original)
	require.Error(t, err, "one placement per task/view must remain unique")
}
