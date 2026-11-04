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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/stretchr/testify/require"
)

func TestTaskRoutineLifecycle(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	original := &Task{ID: 1}
	require.NoError(t, original.ReadOne(s, u))
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "Asia/Shanghai"}
	require.NoError(t, r.Update(s, u))
	require.Equal(t, int64(1), r.Revision)
	task, err := SetTaskRoutineCheckin(s, u, 1, r.Date, true)
	require.NoError(t, err)
	require.True(t, task.Routine.CompletedToday)
	require.False(t, task.Done)
	require.Equal(t, original.DueDate, task.DueDate)
	firstAt := task.Updated
	completedAt := task.Routine.CompletedAt
	task, err = SetTaskRoutineCheckin(s, u, 1, r.Date, true)
	require.NoError(t, err)
	require.Equal(t, firstAt, task.Updated)
	require.Equal(t, completedAt, task.Routine.CompletedAt)
	count, err := s.Where("task_id = ?", 1).Count(&TaskRoutineCheckin{})
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
	_, err = SetTaskRoutineCheckin(s, u, 1, "2000-01-01", true)
	require.ErrorAs(t, err, &ErrRoutineConflict{})
	_, err = SetTaskRoutineCheckin(s, &user.User{ID: 2}, 1, r.Date, true)
	require.Error(t, err)
	r.Paused = true
	require.NoError(t, r.Update(s, u))
	_, err = SetTaskRoutineCheckin(s, u, 1, r.Date, false)
	require.ErrorAs(t, err, &ErrRoutineState{})
	r.Paused = false
	require.NoError(t, r.Update(s, u))
	task, err = SetTaskRoutineCheckin(s, u, 1, r.Date, false)
	require.NoError(t, err)
	require.False(t, task.Routine.CompletedToday)
	_, err = SetTaskRoutineCheckin(s, u, 1, r.Date, true)
	require.NoError(t, err)
	r.Enabled = false
	require.NoError(t, r.Update(s, u))
	now, _ := time.Parse(time.DateOnly, r.Date)
	history, err := GetTaskRoutineHistory(s, u, 1, now.Year(), int(now.Month()))
	require.NoError(t, err)
	require.Equal(t, 1, history.TotalCheckins)
	require.Len(t, history.Items, 1)
	require.Equal(t, r.Date, history.Items[0].Date)
	stale := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC"}
	require.ErrorAs(t, stale.Update(s, u), &ErrRoutineConflict{})
	require.NoError(t, duplicateTaskRoutine(s, 1, 2))
	copyCfg := &TaskRoutine{TaskID: 2}
	require.NoError(t, copyCfg.ReadOne(s, u))
	require.False(t, copyCfg.CompletedToday)
	require.Equal(t, r.Timezone, copyCfg.Timezone)
	require.NoError(t, hardDeleteTask(s, &Task{ID: 1}))
	count, err = s.Where("task_id = ?", 1).Count(&TaskRoutineCheckin{})
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestTaskRoutineCalendarAndHistory(t *testing.T) {
	for _, tt := range []struct{ now, zone, date, next string }{
		{"2024-03-10T05:00:00Z", "America/New_York", "2024-03-10", "2024-03-11T04:00:00Z"},
		{"2024-11-03T04:00:00Z", "America/New_York", "2024-11-03", "2024-11-04T05:00:00Z"},
		{"2026-10-31T16:01:00Z", "Asia/Shanghai", "2026-11-01", "2026-11-01T16:00:00Z"},
	} {
		r := &TaskRoutine{Timezone: tt.zone}
		now, _ := time.Parse(time.RFC3339, tt.now)
		require.NoError(t, r.setDate(now))
		require.Equal(t, tt.date, r.Date)
		require.Equal(t, tt.next, r.NextResetAt.UTC().Format(time.RFC3339))
	}
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC"}
	require.NoError(t, r.Update(s, u))
	today, _ := time.Parse(time.DateOnly, r.Date)
	for _, offset := range []int{-6, -5, -4, -2, -1, 0} {
		d := today.AddDate(0, 0, offset)
		_, err := setTaskRoutineCheckinAt(s, u, 1, d.Format(time.DateOnly), true, d.Add(12*time.Hour))
		require.NoError(t, err)
	}
	h, err := GetTaskRoutineHistory(s, u, 1, today.Year(), int(today.Month()))
	require.NoError(t, err)
	require.Equal(t, 6, h.TotalCheckins)
	require.Equal(t, 3, h.CurrentStreak)
	require.Equal(t, 3, h.LongestStreak)
	r.Timezone = "Pacific/Honolulu"
	require.NoError(t, r.Update(s, u))
	records := []TaskRoutineCheckin{}
	require.NoError(t, s.Where("task_id = ?", 1).Find(&records))
	for _, v := range records {
		require.Equal(t, "UTC", v.Timezone)
	}
}

func TestTaskRoutineDoneAndRepeatGuards(t *testing.T) {
	for _, kind := range []string{"done", "repeat", "bucket"} {
		t.Run(kind, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			u := &user.User{ID: 1}
			r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC"}
			require.NoError(t, r.Update(s, u))
			task := &Task{ID: 1}
			require.NoError(t, task.ReadOne(s, u))
			var err error
			switch kind {
			case "done":
				task.Done = true
				err = task.Update(s, u)
			case "repeat":
				task.RepeatAfter = 86400
				err = task.Update(s, u)
			case "bucket":
				err = (&TaskBucket{TaskID: 1, BucketID: 3, ProjectViewID: 4, ProjectID: 1}).Update(s, u)
			}
			require.ErrorAs(t, err, &ErrRoutineState{})
			require.NoError(t, s.Rollback())
		})
	}
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	for _, id := range []int64{2, 28} {
		r := &TaskRoutine{TaskID: id, Enabled: true, Timezone: "UTC"}
		require.Error(t, r.Update(s, u))
	}
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "invalid/timezone"}
	require.Error(t, r.Update(s, u))
}

func TestTaskRoutinePermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for i, tt := range []struct {
		project     int64
		auth        web.Auth
		read, write bool
	}{
		{1, &user.User{ID: 1}, true, true}, {1, &user.User{ID: 2}, false, false},
		{9, &user.User{ID: 1}, true, false}, {10, &user.User{ID: 1}, true, true},
		{6, &user.User{ID: 1}, true, false}, {7, &user.User{ID: 1}, true, true},
		{12, &user.User{ID: 1}, true, false},
		{1, &LinkSharing{ID: 1, ProjectID: 1, Permission: PermissionRead}, true, false},
		{2, &LinkSharing{ID: 2, ProjectID: 2, Permission: PermissionWrite}, true, true},
	} {
		task := &Task{ProjectID: tt.project, Index: int64(9900 + i), Title: "Routine ACL"}
		_, err := s.Insert(task)
		require.NoError(t, err)
		r := &TaskRoutine{TaskID: task.ID}
		read, _, err := r.CanRead(s, tt.auth)
		require.NoError(t, err)
		require.Equal(t, tt.read, read)
		write, err := r.CanUpdate(s, tt.auth)
		require.NoError(t, err)
		require.Equal(t, tt.write, write)
	}
	_, err := s.ID(1).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC"}
	require.Error(t, r.Update(s, &user.User{ID: 1}))
}
