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

package models

import (
	"testing"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"github.com/stretchr/testify/require"
)

func TestTaskRepeatBucketCompletion(t *testing.T) {
	for _, method := range []string{
		"checkbox",
		"drag",
	} {
		for _, mode := range []string{
			"default",
			"keep",
			"bucket",
			"deleted_target",
		} {
			t.Run(method+"/"+mode, func(t *testing.T) {
				db.LoadAndAssertFixtures(t)
				s := db.NewSession()
				defer s.Close()
				u := &user.User{ID: 1}
				_, err := s.Where("task_id = ? AND project_view_id = ?", 28, 4).Cols("bucket_id").Update(&TaskBucket{BucketID: 2})
				require.NoError(t, err)
				target := &Bucket{
					ProjectID:     1,
					ProjectViewID: 4,
					Title:         "Return",
					Position:      4,
				}
				_, err = s.Insert(target)
				require.NoError(t, err)
				policy := &TaskRepeatBucketPolicy{
					TaskID:           28,
					ProjectViewID:    4,
					RepeatReturnMode: mode,
				}
				expected := int64(1)
				switch mode {
				case "keep":
					expected = 2
				case "bucket":
					policy.RepeatReturnBucketID = target.ID
					expected = target.ID
				case "deleted_target":
					policy.RepeatReturnMode = "bucket"
					policy.RepeatReturnBucketID = target.ID
				}
				require.NoError(t, policy.Update(s, u))
				if mode == "deleted_target" {
					require.NoError(t, target.Delete(s, u))
				}
				task := &Task{ID: 28}
				require.NoError(t, task.ReadOne(s, u))
				before := task.DueDate
				for i := 0; i < 2; i++ {
					if method == "checkbox" {
						task.Done = true
						require.NoError(t, task.Update(s, u))
					} else {
						move := &TaskBucket{
							TaskID:        28,
							ProjectViewID: 4,
							ProjectID:     1,
							BucketID:      3,
						}
						require.NoError(t, move.Update(s, u))
						require.Equal(t, expected, move.Bucket.ID, "response must identify the actual destination")
						task = move.Task
					}
					require.False(t, task.Done)
					require.True(t, task.DueDate.After(before))
					before = task.DueDate
					row := &TaskBucket{}
					exists, err := s.Where("task_id = ? AND project_view_id = ?", 28, 4).Get(row)
					require.NoError(t, err)
					require.True(t, exists)
					require.Equal(t, expected, row.BucketID)
					require.Equal(t, policy.RepeatReturnMode, row.RepeatReturnMode, "moves must preserve the policy")
				}
				require.NoError(t, s.Commit())
			})
		}
	}
}

func TestTaskRepeatBucketTargetValidation(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	for _, target := range []int64{
		0,
		3,
		4,
		999999,
	} {
		p := &TaskRepeatBucketPolicy{
			TaskID:               28,
			ProjectViewID:        4,
			RepeatReturnMode:     "bucket",
			RepeatReturnBucketID: target,
		}
		require.Error(t, p.Update(s, u))
	}
	p := &TaskRepeatBucketPolicy{
		TaskID:               28,
		ProjectViewID:        4,
		RepeatReturnMode:     "keep",
		RepeatReturnBucketID: 2,
	}
	require.Error(t, p.Update(s, u))
	p = &TaskRepeatBucketPolicy{
		TaskID:           28,
		ProjectViewID:    8,
		RepeatReturnMode: "keep",
	}
	require.Error(t, p.Update(s, u), "a task outside the project view must be rejected")
	p = &TaskRepeatBucketPolicy{
		TaskID:           28,
		ProjectViewID:    1,
		RepeatReturnMode: "keep",
	}
	require.Error(t, p.Update(s, u), "list views cannot store return policies")
}

func TestTaskRepeatBucketPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for i, tt := range []struct {
		project int64
		auth    web.Auth
		read    bool
		write   bool
	}{
		{
			1,
			&user.User{ID: 1},
			true,
			true,
		},
		{
			1,
			&user.User{ID: 2},
			false,
			false,
		},
		{
			9,
			&user.User{ID: 1},
			true,
			false,
		},
		{
			10,
			&user.User{ID: 1},
			true,
			true,
		},
		{
			6,
			&user.User{ID: 1},
			true,
			false,
		},
		{
			7,
			&user.User{ID: 1},
			true,
			true,
		},
		{
			12,
			&user.User{ID: 1},
			true,
			false,
		},
		{
			1,
			&LinkSharing{
				ID:         1,
				ProjectID:  1,
				Permission: PermissionRead,
			},
			true,
			false,
		},
		{
			2,
			&LinkSharing{
				ID:         2,
				ProjectID:  2,
				Permission: PermissionWrite,
			},
			true,
			true,
		},
	} {
		task := &Task{
			ProjectID: tt.project,
			Title:     "Repeat ACL",
			Index:     int64(9900 + i),
		}
		_, err := s.Insert(task)
		require.NoError(t, err)
		// Use the fixture's project view rather than creating a new permission source.
		view := &ProjectView{}
		exists, err := s.Where("project_id = ? AND view_kind = ?", tt.project, ProjectViewKindKanban).Get(view)
		require.NoError(t, err)
		require.True(t, exists)
		p := &TaskRepeatBucketPolicy{
			TaskID:        task.ID,
			ProjectViewID: view.ID,
		}
		read, _, err := p.CanRead(s, tt.auth)
		require.NoError(t, err)
		require.Equal(t, tt.read, read)
		write, err := p.CanUpdate(s, tt.auth)
		require.NoError(t, err)
		require.Equal(t, tt.write, write)
	}
}

func TestTaskRepeatBucketViewIsolation(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	other := &ProjectView{
		ProjectID:               1,
		ViewKind:                ProjectViewKindKanban,
		BucketConfigurationMode: BucketConfigurationModeManual,
		Title:                   "Second",
	}
	_, err := s.Insert(other)
	require.NoError(t, err)
	bucket := &Bucket{
		ProjectViewID: other.ID,
		Title:         "Second return",
	}
	_, err = s.Insert(bucket)
	require.NoError(t, err)
	other.DefaultBucketID = bucket.ID
	_, err = s.ID(other.ID).Cols("default_bucket_id").Update(other)
	require.NoError(t, err)
	_, err = s.Insert(&TaskBucket{
		TaskID:        28,
		ProjectViewID: other.ID,
		BucketID:      bucket.ID,
	})
	require.NoError(t, err)
	p := &TaskRepeatBucketPolicy{
		TaskID:           28,
		ProjectViewID:    4,
		RepeatReturnMode: "keep",
	}
	require.NoError(t, p.Update(s, u))
	p = &TaskRepeatBucketPolicy{
		TaskID:               28,
		ProjectViewID:        other.ID,
		RepeatReturnMode:     "bucket",
		RepeatReturnBucketID: 1,
	}
	require.Error(t, p.Update(s, u), "a return bucket cannot cross views even in the same project")
	p.RepeatReturnBucketID = bucket.ID
	require.NoError(t, p.Update(s, u))
	task := &Task{ID: 28}
	require.NoError(t, task.ReadOne(s, u))
	task.Done = true
	require.NoError(t, task.Update(s, u))
	p = &TaskRepeatBucketPolicy{
		TaskID:        28,
		ProjectViewID: 4,
	}
	require.NoError(t, p.ReadOne(s, u))
	require.Equal(t, "keep", p.RepeatReturnMode)
	row := &TaskBucket{}
	_, err = s.Where("task_id = ? AND project_view_id = ?", 28, other.ID).Get(row)
	require.NoError(t, err)
	require.Equal(t, bucket.ID, row.BucketID)
}

func TestTaskRepeatBucketFullReturnRollsBack(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	p := &TaskRepeatBucketPolicy{
		TaskID:               28,
		ProjectViewID:        4,
		RepeatReturnMode:     "bucket",
		RepeatReturnBucketID: 2,
	}
	require.NoError(t, p.Update(s, u))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Begin())
	task := &Task{ID: 28}
	require.NoError(t, task.ReadOne(s, u))
	before := task.DueDate
	move := &TaskBucket{
		TaskID:        28,
		ProjectViewID: 4,
		ProjectID:     1,
		BucketID:      3,
	}
	err := move.Update(s, u)
	require.ErrorAs(t, err, &ErrBucketLimitExceeded{})
	require.NoError(t, s.Rollback())
	fresh := &Task{ID: 28}
	require.NoError(t, fresh.ReadOne(s, u))
	require.WithinDuration(t, before, fresh.DueDate, time.Second)
	require.False(t, fresh.Done)
}

func TestTaskRepeatBucketUnmaterializedViewCompletion(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	view := &ProjectView{
		ProjectID:               1,
		Title:                   "Unopened manual board",
		ViewKind:                ProjectViewKindKanban,
		BucketConfigurationMode: BucketConfigurationModeManual,
	}
	_, err := s.Insert(view)
	require.NoError(t, err)
	task := &Task{ID: 28}
	require.NoError(t, task.ReadOne(s, u))
	before := task.DueDate
	task.Done = true
	require.NoError(t, task.Update(s, u), "an unopened empty board must not block recurrence from list or detail")
	require.False(t, task.Done)
	require.True(t, task.DueDate.After(before))
	exists, err := s.Where("task_id = ? AND project_view_id = ?", task.ID, view.ID).Exist(&TaskBucket{})
	require.NoError(t, err)
	require.False(t, exists, "completing elsewhere must not create a placement in an uninitialized board")
	count, err := s.Where("project_view_id = ?", view.ID).Count(&Bucket{})
	require.NoError(t, err)
	require.Zero(t, count)
	// A configured Done bucket still needs a real safe return destination.
	view.DoneBucketID = 999999
	_, err = ResolveTaskRepeatBucket(s, view, &TaskBucket{BucketID: view.DoneBucketID})
	require.ErrorAs(t, err, &ErrCannotRemoveLastBucket{})
}
