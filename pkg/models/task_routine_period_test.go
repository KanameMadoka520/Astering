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

func TestTaskRoutinePeriodCalendar(t *testing.T) {
	for _, tc := range []struct {
		name    string
		routine TaskRoutine
		now     string
		start   string
		end     string
	}{
		{
			name:    "daily before custom reset",
			routine: TaskRoutine{Timezone: "Asia/Shanghai", ResetHour: 4},
			now:     "2026-11-02T03:59:00+08:00",
			start:   "2026-11-01T04:00:00+08:00",
			end:     "2026-11-02T04:00:00+08:00",
		},
		{
			name:    "daily exact custom reset",
			routine: TaskRoutine{Timezone: "Asia/Shanghai", ResetHour: 5},
			now:     "2026-11-02T05:00:00+08:00",
			start:   "2026-11-02T05:00:00+08:00",
			end:     "2026-11-03T05:00:00+08:00",
		},
		{
			name:    "weekly Monday before anchor",
			routine: TaskRoutine{Timezone: "Asia/Shanghai", Period: "weekly", WeekStart: 1, ResetHour: 5},
			now:     "2026-11-02T04:59:00+08:00",
			start:   "2026-10-26T05:00:00+08:00",
			end:     "2026-11-02T05:00:00+08:00",
		},
		{
			name:    "weekly crosses year",
			routine: TaskRoutine{Timezone: "UTC", Period: "weekly", WeekStart: 1},
			now:     "2027-01-01T12:00:00Z",
			start:   "2026-12-28T00:00:00Z",
			end:     "2027-01-04T00:00:00Z",
		},
		{
			name:    "monthly short month",
			routine: TaskRoutine{Timezone: "UTC", Period: "monthly", MonthDay: 31, ResetHour: 5},
			now:     "2027-02-28T05:00:00Z",
			start:   "2027-02-28T05:00:00Z",
			end:     "2027-03-31T05:00:00Z",
		},
		{
			name:    "monthly before anchor",
			routine: TaskRoutine{Timezone: "UTC", Period: "monthly", MonthDay: 31, ResetHour: 5},
			now:     "2027-03-30T12:00:00Z",
			start:   "2027-02-28T05:00:00Z",
			end:     "2027-03-31T05:00:00Z",
		},
		{
			name:    "monthly leap February",
			routine: TaskRoutine{Timezone: "UTC", Period: "monthly", MonthDay: 31},
			now:     "2028-02-29T12:00:00Z",
			start:   "2028-02-29T00:00:00Z",
			end:     "2028-03-31T00:00:00Z",
		},
		{
			name:    "DST short day",
			routine: TaskRoutine{Timezone: "America/New_York"},
			now:     "2026-03-08T12:00:00-04:00",
			start:   "2026-03-08T00:00:00-05:00",
			end:     "2026-03-09T00:00:00-04:00",
		},
		{
			name:    "DST missing wall time",
			routine: TaskRoutine{Timezone: "America/New_York", ResetHour: 2, ResetMinute: 30},
			now:     "2026-03-08T03:45:00-04:00",
			start:   "2026-03-08T03:30:00-04:00",
			end:     "2026-03-09T02:30:00-04:00",
		},
		{
			name:    "DST long day",
			routine: TaskRoutine{Timezone: "America/New_York"},
			now:     "2026-11-01T12:00:00-05:00",
			start:   "2026-11-01T00:00:00-04:00",
			end:     "2026-11-02T00:00:00-05:00",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			now, err := time.Parse(time.RFC3339, tc.now)
			require.NoError(t, err)
			require.NoError(t, tc.routine.setPeriod(now))
			require.Equal(t, tc.start, tc.routine.PeriodStartAt.Format(time.RFC3339))
			require.Equal(t, tc.end, tc.routine.NextResetAt.Format(time.RFC3339))
			require.Equal(t, tc.start[:10], tc.routine.Date)
			require.False(t, tc.routine.PeriodStartAt.After(now))
			require.True(t, tc.routine.NextResetAt.After(now))
		})
	}
}

func TestTaskRoutinePeriodQuotaAndHistoryIsolation(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC"}
	require.NoError(t, r.Update(s, u))
	require.NoError(t, r.setPeriod(now))
	_, err := setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now)
	require.NoError(t, err)
	legacyDate := r.Date
	r.Period, r.WeekStart, r.Target, r.Unit = "weekly", 1, 1800, "ml"
	require.NoError(t, r.Update(s, u))
	require.NoError(t, r.readPeriodState(s, now))
	require.Equal(t, legacyDate, r.Date, "old daily and new weekly deliberately share a date")
	require.False(t, r.CompletedPeriod)
	require.Zero(t, r.CurrentAmount)
	task, err := setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 1200, now)
	require.NoError(t, err)
	require.False(t, task.Done)
	require.Equal(t, int64(1200), task.Routine.CurrentAmount)
	require.False(t, task.Routine.CompletedPeriod)
	require.True(t, task.Routine.CompletedAt.IsZero())
	firstUpdated := task.Updated
	task, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 1200, now.Add(time.Hour))
	require.NoError(t, err)
	require.Equal(t, firstUpdated, task.Updated, "absolute duplicate amount is event-free and idempotent")
	task, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 1800, now.Add(2*time.Hour))
	require.NoError(t, err)
	require.True(t, task.Routine.CompletedPeriod)
	completedAt := task.Routine.CompletedAt
	key := task.Routine.ScheduleKey
	oldRevision := r.Revision
	r.Target, r.Unit = 3, "sessions"
	require.NoError(t, r.Update(s, u))
	require.NoError(t, r.readPeriodState(s, now))
	require.NotEqual(t, key, r.ScheduleKey)
	require.Zero(t, r.CurrentAmount)
	_, err = setTaskRoutineProgressAt(s, u, 1, r.Date, oldRevision, 2, now)
	require.ErrorAs(t, err, &ErrRoutineConflict{})
	task, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 2, now)
	require.NoError(t, err)
	require.Equal(t, int64(2), task.Routine.CurrentAmount)
	require.False(t, task.Routine.CompletedPeriod)
	history, err := GetTaskRoutineHistory(s, u, 1, 2026, 11)
	require.NoError(t, err)
	require.Len(t, history.Items, 1)
	require.Len(t, history.Periods, 2)
	require.Equal(t, 2, history.TotalCheckins, "partial current quota is not a completion")
	require.Equal(t, int64(1800), history.Periods[0].Target)
	require.Equal(t, "ml", history.Periods[0].Unit)
	require.Equal(t, "weekly", history.Periods[0].Period)
	require.NotNil(t, history.Periods[0].CompletedAt)
	require.True(t, completedAt.Equal(*history.Periods[0].CompletedAt))
	require.Nil(t, history.Periods[1].CompletedAt)
	// A skipped sequence of periods creates no rows and requires no catch-up.
	require.NoError(t, r.readPeriodState(s, now.AddDate(0, 0, 28)))
	require.Zero(t, r.CurrentAmount)
	require.False(t, r.CompletedPeriod)
	count, err := s.Where("task_id = ?", 1).Count(&TaskRoutineProgress{})
	require.NoError(t, err)
	require.Equal(t, int64(2), count)
}

func TestTaskRoutinePeriodResetChangeAndStaleBoundary(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	now := time.Date(2026, 11, 2, 12, 0, 0, 0, time.UTC)
	r := &TaskRoutine{TaskID: 1, Enabled: true, Timezone: "UTC", ResetHour: 4}
	require.NoError(t, r.Update(s, u))
	require.NoError(t, r.setPeriod(now))
	_, err := setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now)
	require.ErrorAs(t, err, &ErrRoutineConflict{}, "nonlegacy check-in needs configuration revision")
	_, err = setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now, r.Revision)
	require.NoError(t, err)
	oldDate, oldKey := r.Date, r.ScheduleKey
	r.ResetHour = 5
	require.NoError(t, r.Update(s, u))
	require.NoError(t, r.readPeriodState(s, now))
	require.Equal(t, oldDate, r.Date)
	require.NotEqual(t, oldKey, r.ScheduleKey)
	require.False(t, r.CompletedPeriod)
	_, err = setTaskRoutineProgressAt(s, u, 1, oldDate, r.Revision, 1, time.Date(2026, 11, 3, 5, 0, 0, 0, time.UTC))
	require.ErrorAs(t, err, &ErrRoutineConflict{})
	_, err = setTaskRoutineProgressAt(s, u, 1, oldDate, r.Revision, -1, now)
	require.Error(t, err)
	require.NoError(t, duplicateTaskRoutine(s, 1, 2))
	copied := &TaskRoutine{TaskID: 2}
	require.NoError(t, copied.ReadOne(s, u))
	require.Equal(t, 5, copied.ResetHour)
	require.Zero(t, copied.CurrentAmount)
	count, err := s.Where("task_id = ?", 2).Count(&TaskRoutineProgress{})
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestTaskRoutinePeriodProgressPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for i, tc := range []struct {
		project int64
		auth    web.Auth
		allowed bool
	}{
		{project: 1, auth: &user.User{ID: 1}, allowed: true},
		{project: 1, auth: &user.User{ID: 2}, allowed: false},
		{project: 10, auth: &user.User{ID: 1}, allowed: true},
		{project: 9, auth: &user.User{ID: 1}, allowed: false},
		{project: 7, auth: &user.User{ID: 1}, allowed: true},
		{project: 1, auth: &LinkSharing{ID: 1, ProjectID: 1, Permission: PermissionRead}, allowed: false},
		{project: 2, auth: &LinkSharing{ID: 2, ProjectID: 2, Permission: PermissionWrite}, allowed: true},
	} {
		task := &Task{ProjectID: tc.project, Index: int64(9900 + i), Title: "Period permission fixture"}
		_, err := s.Insert(task)
		require.NoError(t, err)
		r := &TaskRoutine{TaskID: task.ID, Enabled: true, Timezone: "UTC", Period: "weekly", Target: 3}
		require.NoError(t, r.setPeriod(time.Now()))
		_, err = s.Insert(r)
		require.NoError(t, err)
		_, err = SetTaskRoutineProgress(s, tc.auth, task.ID, r.Date, r.Revision, 2)
		if tc.allowed {
			require.NoError(t, err)
		} else {
			require.Error(t, err)
		}
	}
}

func TestTaskRoutinePeriodProgressRollbackAndUndo(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	r := &TaskRoutine{
		TaskID:   1,
		Enabled:  true,
		Timezone: "UTC",
		Period:   "monthly",
		MonthDay: 15,
		Target:   3,
		Unit:     "sessions",
	}
	require.NoError(t, r.Update(s, u))
	task, err := SetTaskRoutineProgress(s, u, 1, r.Date, r.Revision, 3)
	require.NoError(t, err)
	require.True(t, task.Routine.CompletedPeriod)
	require.False(t, task.Routine.CompletedAt.IsZero())
	task, err = SetTaskRoutineProgress(s, u, 1, r.Date, r.Revision, 2)
	require.NoError(t, err)
	require.False(t, task.Routine.CompletedPeriod)
	require.True(t, task.Routine.CompletedAt.IsZero())
	stored := &TaskRoutineProgress{}
	exists, err := s.Where("task_id = ?", 1).Get(stored)
	require.NoError(t, err)
	require.True(t, exists)
	require.Nil(t, stored.CompletedAt, "falling below target clears the stored completion, not only the response")
	require.Zero(t, stored.CompletedByID)
	require.NoError(t, s.Rollback())
	fresh := db.NewSession()
	defer fresh.Close()
	count, err := fresh.Where("task_id = ?", 1).Count(&TaskRoutineProgress{})
	require.NoError(t, err)
	require.Zero(t, count)
}
