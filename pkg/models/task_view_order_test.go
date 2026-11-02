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
	"context"
	"encoding/json"
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func taskOrderFixture(t *testing.T, count int, positions bool) (TaskOrderScope, []Task, map[ProjectViewKind]int64) {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	project := &Project{Title: "Task order fixture"}
	require.NoError(t, project.Create(s, &user.User{ID: 1}))
	views, err := getViewsForProject(s, project.ID)
	require.NoError(t, err)
	kinds := map[ProjectViewKind]int64{}
	for _, view := range views {
		kinds[view.ViewKind] = view.ID
	}
	tasks := make([]Task, count)
	for i := range tasks {
		tasks[i] = Task{
			Title:     "Ordering sample",
			ProjectID: project.ID,
			Index:     int64(i + 1),
		}
		_, err = s.Insert(&tasks[i])
		require.NoError(t, err)
		require.Positive(t, tasks[i].ID)
		if positions {
			for _, view := range views {
				_, err = s.Insert(&TaskPosition{
					TaskID:        tasks[i].ID,
					ProjectViewID: view.ID,
					Position:      float64(i+1) * 65536,
				})
				require.NoError(t, err)
			}
		}
	}
	require.NoError(t, s.Commit())
	return TaskOrderScope{
		ProjectID: project.ID,
		ViewID:    kinds[ProjectViewKindList],
	}, tasks, kinds
}

func taskOrderRead(t *testing.T, scope TaskOrderScope) *TaskOrderSnapshot {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	result, err := ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	require.NoError(t, err)
	return result
}

func taskOrderWrite(t *testing.T, scope TaskOrderScope, change TaskOrderChange) (*TaskOrderResult, error) {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	result, err := ReorderTaskView(context.Background(), s, &user.User{ID: 1}, scope, change)
	if err == nil {
		err = s.Commit()
	}
	return result, err
}

func taskOrderIDs(items []TaskOrderItem) []int64 {
	ids := make([]int64, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	return ids
}

func requireTaskOrderCode(t *testing.T, err error, code string) {
	t.Helper()
	var orderErr *TaskOrderError
	require.ErrorAs(t, err, &orderErr)
	assert.Equal(t, code, orderErr.Code)
}

func TestTaskViewOrderReadPureAndDefaultFilter(t *testing.T) {
	scope, tasks, kinds := taskOrderFixture(t, 30, false)
	s := db.NewSession()
	defer s.Close()
	_, err := s.ID(tasks[0].ID).Cols("done").Update(&Task{Done: true})
	require.NoError(t, err)
	before, err := s.Count(&TaskPosition{})
	require.NoError(t, err)
	snapshot, err := ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	require.NoError(t, err)
	require.Len(t, snapshot.Items, 29, "default done=false must be respected")
	assert.NotContains(t, taskOrderIDs(snapshot.Items), tasks[0].ID)
	page, err := snapshot.Page(s, 1)
	require.NoError(t, err)
	require.Len(t, page.Items, 25)
	assert.Equal(t, tasks[26].ID, page.NextTaskID)
	assert.Zero(t, page.PreviousTaskID)
	assert.Equal(t, "Ordering sample", page.Items[0].Title)
	assert.Zero(t, page.Items[0].Position)
	next, err := snapshot.Page(s, 2)
	require.NoError(t, err)
	require.Len(t, next.Items, 4)
	assert.Equal(t, tasks[25].ID, next.PreviousTaskID)
	after, err := s.Count(&TaskPosition{})
	require.NoError(t, err)
	assert.Equal(t, before, after, "reading cannot initialize positions")
	encoded, err := json.Marshal(page)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"view_kind":"list"`)
	assert.NotContains(t, string(encoded), `"description"`)
	// A title edit doesn't invalidate an order token.
	_, err = s.ID(tasks[1].ID).Cols("title").Update(&Task{Title: "Renamed sample"})
	require.NoError(t, err)
	same, err := ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	require.NoError(t, err)
	assert.Equal(t, snapshot.Version, same.Version)
	scope.ViewID = kinds[ProjectViewKindTable]
	table, err := ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	require.NoError(t, err)
	assert.Len(t, table.Items, 30)
	_, err = ReadTaskViewOrder(s, &user.User{ID: 2}, scope)
	require.Error(t, err)
	_, err = ReadTaskViewOrder(s, &LinkSharing{ProjectID: 2, Permission: PermissionRead}, scope)
	require.Error(t, err)
	scope.ViewID = kinds[ProjectViewKindGantt]
	_, err = ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	requireTaskOrderCode(t, err, "UNSUPPORTED_VIEW")
	scope.ViewID = kinds[ProjectViewKindList]
	_, err = s.ID(scope.ViewID).Cols("filter").Update(&ProjectView{Filter: &TaskCollection{Filter: "priority > 0"}})
	require.NoError(t, err)
	_, err = ReadTaskViewOrder(s, &user.User{ID: 1}, scope)
	requireTaskOrderCode(t, err, "UNSUPPORTED_VIEW")
}

func TestTaskViewOrderFastBlockAndStaleRollback(t *testing.T) {
	scope, tasks, _ := taskOrderFixture(t, 60, true)
	before := taskOrderRead(t, scope)
	change := TaskOrderChange{
		TaskIDs:      []int64{tasks[59].ID},
		BeforeTaskID: tasks[0].ID,
		OrderVersion: before.Version,
	}
	result, err := taskOrderWrite(t, scope, change)
	require.NoError(t, err)
	require.Len(t, result.ChangedPositions, 1, "moving task 60 to first must not rewrite 60 rows")
	assert.False(t, result.PositionRecalculated)
	assert.Equal(t, tasks[59].ID, result.ChangedPositions[0].TaskID)
	encoded, err := json.Marshal(result)
	require.NoError(t, err)
	assert.Contains(t, string(encoded), `"view_kind":"list"`)
	current := taskOrderRead(t, scope)
	assert.Equal(t, tasks[59].ID, current.Items[0].ID)
	assert.Equal(t, before.Items[:59], current.Items[1:])
	_, err = taskOrderWrite(t, scope, change)
	requireTaskOrderCode(t, err, "STATE_CONFLICT")
	assert.Equal(t, current.Version, taskOrderRead(t, scope).Version)
	// An exact non-contiguous selection is moved as one block in requested order.
	block := TaskOrderChange{
		TaskIDs:      []int64{tasks[4].ID, tasks[2].ID},
		AfterTaskID:  tasks[0].ID,
		BeforeTaskID: tasks[1].ID,
		OrderVersion: current.Version,
	}
	result, err = taskOrderWrite(t, scope, block)
	require.NoError(t, err)
	require.Len(t, result.ChangedPositions, 2)
	assert.Equal(t, []int64{tasks[59].ID, tasks[0].ID, tasks[4].ID, tasks[2].ID, tasks[1].ID}, taskOrderIDs(taskOrderRead(t, scope).Items[:5]))
	// Invalid adjacency/duplicate/foreign targets must make no partial changes.
	stable := taskOrderRead(t, scope)
	invalid := []TaskOrderChange{
		{TaskIDs: []int64{tasks[3].ID}, BeforeTaskID: tasks[1].ID, OrderVersion: stable.Version},
		{TaskIDs: []int64{tasks[3].ID, tasks[3].ID}, BeforeTaskID: tasks[59].ID, OrderVersion: stable.Version},
		{TaskIDs: []int64{1}, BeforeTaskID: tasks[59].ID, OrderVersion: stable.Version},
	}
	for _, bad := range invalid {
		_, err = taskOrderWrite(t, scope, bad)
		require.Error(t, err)
		assert.Equal(t, stable.Version, taskOrderRead(t, scope).Version)
	}
}

func TestTaskViewOrderHealingPreservesHiddenAndBuckets(t *testing.T) {
	scope, tasks, kinds := taskOrderFixture(t, 6, false)
	s := db.NewSession()
	_, err := s.ID(tasks[1].ID).Cols("done").Update(&Task{Done: true})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	initial := taskOrderRead(t, scope)
	result, err := taskOrderWrite(t, scope, TaskOrderChange{
		TaskIDs:      []int64{tasks[5].ID},
		BeforeTaskID: tasks[0].ID,
		OrderVersion: initial.Version,
	})
	require.NoError(t, err)
	assert.True(t, result.PositionRecalculated)
	require.Len(t, result.ChangedPositions, 6, "healing includes the hidden completed task")
	scope.ViewID = kinds[ProjectViewKindTable]
	// Board fixture: same underlying tasks split into two real buckets.
	scope.ViewID = kinds[ProjectViewKindKanban]
	s = db.NewSession()
	defer s.Close()
	buckets := []*Bucket{
		{Title: "First", ProjectID: scope.ProjectID, ProjectViewID: scope.ViewID},
		{Title: "Second", ProjectID: scope.ProjectID, ProjectViewID: scope.ViewID},
	}
	for _, bucket := range buckets {
		_, err = s.Insert(bucket)
		require.NoError(t, err)
	}
	for i, task := range tasks {
		_, err = s.Insert(&TaskBucket{
			TaskID:        task.ID,
			ProjectViewID: scope.ViewID,
			BucketID:      buckets[i%2].ID,
		})
		require.NoError(t, err)
	}
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	scope.BucketID = buckets[0].ID
	initial = taskOrderRead(t, scope)
	require.Equal(t, []int64{tasks[0].ID, tasks[2].ID, tasks[4].ID}, taskOrderIDs(initial.Items))
	_, err = taskOrderWrite(t, scope, TaskOrderChange{
		TaskIDs:      []int64{tasks[1].ID},
		BeforeTaskID: tasks[0].ID,
		BucketID:     scope.BucketID,
		OrderVersion: initial.Version,
	})
	requireTaskOrderCode(t, err, "STATE_CONFLICT")
	result, err = taskOrderWrite(t, scope, TaskOrderChange{
		TaskIDs:      []int64{tasks[4].ID},
		BeforeTaskID: tasks[0].ID,
		BucketID:     scope.BucketID,
		OrderVersion: initial.Version,
	})
	require.NoError(t, err)
	assert.True(t, result.PositionRecalculated)
	require.Len(t, result.ChangedPositions, 6)
	scope.BucketID = buckets[1].ID
	assert.Equal(t, []int64{tasks[1].ID, tasks[3].ID, tasks[5].ID}, taskOrderIDs(taskOrderRead(t, scope).Items))
}

func TestTaskViewOrderPermissionsAndCancellation(t *testing.T) {
	scope, tasks, _ := taskOrderFixture(t, 3, true)
	initial := taskOrderRead(t, scope)
	change := TaskOrderChange{
		TaskIDs:      []int64{tasks[2].ID},
		BeforeTaskID: tasks[0].ID,
		OrderVersion: initial.Version,
	}
	for _, auth := range []web.Auth{&user.User{ID: 2}, &LinkSharing{ProjectID: scope.ProjectID, Permission: PermissionRead}} {
		s := db.NewSession()
		_, err := ReorderTaskView(context.Background(), s, auth, scope, change)
		require.Error(t, err)
		require.NoError(t, s.Close())
	}
	s := db.NewSession()
	defer s.Close()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	db.SetSessionContext(ctx, s)
	_, err := ReorderTaskView(ctx, s, &user.User{ID: 1}, scope, change)
	require.Error(t, err)
	require.NoError(t, s.Close())
	assert.Equal(t, initial.Version, taskOrderRead(t, scope).Version)
}

func TestTaskViewOrderGapFloatBoundaries(t *testing.T) {
	for _, input := range []struct {
		at    int
		count int
	}{
		{at: -1, count: 1},
		{at: 2, count: 1},
		{at: 0, count: 0},
		{at: 0, count: -1},
	} {
		positions, valid := taskOrderGap([]taskOrderRow{{Position: 65536}}, input.at, input.count)
		assert.False(t, valid)
		assert.Nil(t, positions)
	}
	positions, valid := taskOrderGap(nil, 1, 1)
	assert.False(t, valid)
	assert.Nil(t, positions)
	_, ok := taskOrderGap([]taskOrderRow{{Position: 0.001}}, 0, 2)
	assert.False(t, ok)
	_, ok = taskOrderGap([]taskOrderRow{{Position: 1e300}, {Position: 1e300}}, 1, 1)
	assert.False(t, ok)
	positions, ok = taskOrderGap([]taskOrderRow{{Position: 65536}}, 0, 2)
	require.True(t, ok)
	assert.Less(t, positions[0], positions[1])
	assert.Less(t, positions[1], float64(65536))
}
