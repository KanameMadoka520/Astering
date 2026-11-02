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
	"github.com/stretchr/testify/require"
)

func TestRoutinePeriodReminderRollsAndSkipsCompleted(t *testing.T) {
	for _, tt := range []struct {
		period  string
		trigger string
	}{
		{
			"daily",
			"2026-11-02T20:55:00Z",
		},
		{
			"weekly",
			"2026-11-08T20:55:00Z",
		},
		{
			"monthly",
			"2027-02-27T20:55:00Z",
		},
	} {
		t.Run(tt.period, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			u := &user.User{ID: 1}
			r := &TaskRoutine{
				TaskID:    1,
				Enabled:   true,
				Timezone:  "Asia/Shanghai",
				Period:    tt.period,
				ResetHour: 5,
				WeekStart: 1,
				MonthDay:  31,
				Target:    3,
				Unit:      "sessions",
			}
			require.NoError(t, r.Update(s, u))
			now, err := time.Parse(time.RFC3339, tt.trigger)
			require.NoError(t, err)
			// A stale persisted trigger must not prevent future calendar occurrences.
			_, err = s.Insert(&TaskReminder{
				TaskID:         1,
				RelativeTo:     ReminderRelationRoutinePeriodEnd,
				RelativePeriod: -300,
				Reminder:       time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
			})
			require.NoError(t, err)
			due, err := routineRemindersDue(s, now, now.Add(time.Minute))
			require.NoError(t, err)
			require.Len(t, due, 1)
			require.Equal(t, now, due[0].Reminder.UTC())
			require.NoError(t, r.setPeriod(now))
			_, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 2, now)
			require.NoError(t, err)
			due, err = routineRemindersDue(s, now, now.Add(time.Minute))
			require.NoError(t, err)
			require.Len(t, due, 1, "partial quota still needs a reminder")
			_, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 3, now)
			require.NoError(t, err)
			due, err = routineRemindersDue(s, now, now.Add(time.Minute))
			require.NoError(t, err)
			require.Empty(t, due)
			// Only the recorded period is complete; next week's/month's quota starts empty.
			require.NoError(t, r.setPeriod(r.NextResetAt.Add(time.Hour)))
			next := r.NextResetAt.Add(-5 * time.Minute)
			due, err = routineRemindersDue(s, next, next.Add(time.Minute))
			require.NoError(t, err)
			require.Len(t, due, 1)
			for _, column := range []string{
				"paused",
				"enabled",
			} {
				value := column == "paused"
				_, err = s.Table(new(TaskRoutine)).Where("task_id = ?", 1).Cols(column).Update(map[string]any{column: value})
				require.NoError(t, err)
				due, err = routineRemindersDue(s, next, next.Add(time.Minute))
				require.NoError(t, err)
				require.Empty(t, due)
				_, err = s.Table(new(TaskRoutine)).Where("task_id = ?", 1).Cols(column).Update(map[string]any{column: !value})
				require.NoError(t, err)
			}
		})
	}
}

func TestRoutineReminderAtBoundaryUsesPreviousPeriod(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	r := &TaskRoutine{
		TaskID:    1,
		Enabled:   true,
		Timezone:  "UTC",
		ResetHour: 4,
		Target:    2,
	}
	require.NoError(t, r.Update(s, u))
	boundary := time.Date(2026, 11, 3, 4, 0, 0, 0, time.UTC)
	_, err := s.Insert(&TaskReminder{
		TaskID:     1,
		RelativeTo: ReminderRelationRoutinePeriodEnd,
	})
	require.NoError(t, err)
	require.NoError(t, r.setPeriod(boundary.Add(-time.Second)))
	_, err = setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 2, boundary.Add(-time.Second))
	require.NoError(t, err)
	due, err := routineRemindersDue(s, boundary, boundary.Add(time.Minute))
	require.NoError(t, err)
	require.Empty(t, due, "the new period's empty quota must not trigger the old period's reminder")
	due, err = routineRemindersDue(s, boundary.AddDate(0, 0, 1), boundary.AddDate(0, 0, 1).Add(time.Minute))
	require.NoError(t, err)
	require.Len(t, due, 1)
}

func TestRoutineQuotaCheckinPreservesOverTarget(t *testing.T) {
	for _, period := range []string{
		"daily",
		"weekly",
		"monthly",
	} {
		t.Run(period, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			u := &user.User{ID: 1}
			r := &TaskRoutine{
				TaskID:   1,
				Enabled:  true,
				Timezone: "UTC",
				Period:   period,
				Target:   3,
				Unit:     "sessions",
			}
			require.NoError(t, r.Update(s, u))
			now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
			require.NoError(t, r.setPeriod(now))
			_, err := setTaskRoutineProgressAt(s, u, 1, r.Date, r.Revision, 5, now)
			require.NoError(t, err)
			require.NoError(t, r.readPeriodState(s, now))
			require.Equal(t, int64(5), r.CurrentAmount)
			completedAt := r.CompletedAt
			require.False(t, completedAt.IsZero())
			for range 2 {
				_, err = setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now, r.Revision)
				require.NoError(t, err)
				require.NoError(t, r.readPeriodState(s, now))
				require.Equal(t, int64(5), r.CurrentAmount, "checking in must preserve already recorded excess progress")
				require.True(t, r.CompletedPeriod)
				require.True(t, completedAt.Equal(r.CompletedAt), "retries must preserve the original completion time")
			}
			_, err = setTaskRoutineCheckinAt(s, u, 1, r.Date, false, now, r.Revision)
			require.NoError(t, err)
			require.NoError(t, r.readPeriodState(s, now))
			require.Zero(t, r.CurrentAmount)
			require.False(t, r.CompletedPeriod)
			require.True(t, r.CompletedAt.IsZero())
			_, err = setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now, r.Revision)
			require.NoError(t, err)
			require.NoError(t, r.readPeriodState(s, now))
			require.Equal(t, int64(3), r.CurrentAmount, "checking in after clearing starts from the target, not the old excess amount")
		})
	}
}

func TestRoutineReminderIntegratesExistingRecipients(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	r := &TaskRoutine{
		TaskID:    1,
		Enabled:   true,
		Timezone:  "UTC",
		ResetHour: 5,
	}
	require.NoError(t, r.Update(s, u))
	now := time.Date(2026, 11, 3, 4, 55, 0, 0, time.UTC)
	_, err := s.Insert(&TaskReminder{
		TaskID:         1,
		RelativeTo:     ReminderRelationRoutinePeriodEnd,
		RelativePeriod: -300,
	})
	require.NoError(t, err)
	notifications, err := getTasksWithRemindersDueAndTheirUsers(s, now)
	require.NoError(t, err)
	require.NotEmpty(t, notifications)
	for _, n := range notifications {
		require.Equal(t, int64(1), n.Task.ID)
		require.Equal(t, now, n.TaskReminder.Reminder.UTC())
	}
	require.NoError(t, r.setPeriod(now))
	_, err = setTaskRoutineCheckinAt(s, u, 1, r.Date, true, now, r.Revision)
	require.NoError(t, err)
	notifications, err = getTasksWithRemindersDueAndTheirUsers(s, now)
	require.NoError(t, err)
	require.Empty(t, notifications)
}

func TestRelativeReminderAnchorsSurviveRepeat(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	task := &Task{ID: 28}
	require.NoError(t, task.ReadOne(s, u))
	// Future dates advance exactly one repeat interval instead of catching up
	// independently from the fixture's historical dates to the current clock.
	task.DueDate = time.Now().UTC().Truncate(time.Second).Add(48 * time.Hour)
	task.StartDate = task.DueDate.Add(-time.Hour)
	absolute := task.DueDate.Add(-15 * time.Minute)
	task.Reminders = []*TaskReminder{
		{Reminder: absolute},
		{
			RelativeTo:     ReminderRelationDueDate,
			RelativePeriod: -900,
		},
		{
			RelativeTo:     ReminderRelationStartDate,
			RelativePeriod: 2700,
		},
	}
	require.NoError(t, task.Update(s, u))
	require.Len(t, task.Reminders, 3, "equal current times do not mean equal future anchors")
	for _, reminder := range task.Reminders {
		require.True(t, absolute.Equal(reminder.Reminder))
	}
	// Changing only the due date must change only its relative reminder.
	task.DueDate = task.DueDate.Add(30 * time.Minute)
	require.NoError(t, task.Update(s, u))
	assertReminders := func() {
		t.Helper()
		expected := map[ReminderRelation]time.Time{
			"":                        absolute,
			ReminderRelationDueDate:   task.DueDate.Add(-15 * time.Minute),
			ReminderRelationStartDate: task.StartDate.Add(45 * time.Minute),
		}
		require.Len(t, task.Reminders, len(expected))
		seen := make(map[ReminderRelation]bool, len(expected))
		for _, reminder := range task.Reminders {
			require.Contains(t, expected, reminder.RelativeTo)
			require.False(t, seen[reminder.RelativeTo], "each scheduling identity is retained once")
			seen[reminder.RelativeTo] = true
			require.True(t, expected[reminder.RelativeTo].Equal(reminder.Reminder), "unexpected time for %q", reminder.RelativeTo)
		}
	}
	assertReminders()
	for range 2 {
		task.Done = true
		require.NoError(t, task.Update(s, u))
		require.False(t, task.Done)
		// Existing ordinary-repeat semantics advance absolute reminders too.
		absolute = absolute.Add(time.Duration(task.RepeatAfter) * time.Second)
		assertReminders()
	}
}

func TestRoutineReminderValidationAndRetention(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	task := &Task{
		ID:        1,
		Reminders: []*TaskReminder{{RelativeTo: ReminderRelationRoutinePeriodEnd}},
	}
	require.Error(t, updateRoutineReminderDates(s, task, time.Now()))
	u := &user.User{ID: 1}
	r := &TaskRoutine{
		TaskID:   1,
		Enabled:  true,
		Timezone: "UTC",
	}
	require.NoError(t, r.Update(s, u))
	for _, offset := range []int64{
		1,
		-400 * 24 * 3600,
	} {
		task.Reminders[0].RelativePeriod = offset
		require.Error(t, updateRoutineReminderDates(s, task, time.Now()))
	}
	task.Reminders[0].RelativePeriod = -300
	require.NoError(t, updateRoutineReminderDates(s, task, time.Now()))
	r.Enabled = false
	require.NoError(t, r.Update(s, u))
	require.NoError(t, updateRoutineReminderDates(s, task, time.Now()), "disabled routines retain reminders without sending them")
	task.Reminders = []*TaskReminder{{RelativeTo: "unknown"}}
	require.Error(t, updateRelativeReminderDates(task))
	task.Reminders = []*TaskReminder{{
		RelativeTo:     ReminderRelationDueDate,
		RelativePeriod: 1 << 62,
	}}
	require.Error(t, updateRelativeReminderDates(task))
}

func TestRoutineReminderScheduleChangeRejectsIncompatibleOffsets(t *testing.T) {
	for _, period := range []string{
		"weekly",
		"monthly",
	} {
		t.Run(period, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			u := &user.User{ID: 1}
			r := &TaskRoutine{
				TaskID:   1,
				Enabled:  true,
				Timezone: "UTC",
				Period:   period,
			}
			require.NoError(t, r.Update(s, u))
			revision := r.Revision
			reminder := &TaskReminder{
				TaskID:         1,
				RelativeTo:     ReminderRelationRoutinePeriodEnd,
				RelativePeriod: -48 * 3600,
				Reminder:       time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC),
			}
			_, err := s.Insert(reminder)
			require.NoError(t, err)
			r.Period = "daily"
			require.ErrorAs(t, r.Update(s, u), &ErrRoutineReminderSchedule{})
			require.Equal(t, revision, r.Revision, "rejected configuration must not consume a revision")
			stored := &TaskRoutine{}
			exists, err := s.ID(1).Get(stored)
			require.NoError(t, err)
			require.True(t, exists)
			require.Equal(t, period, stored.Period)
			require.Equal(t, revision, stored.Revision)
			storedReminder := &TaskReminder{}
			_, err = s.ID(reminder.ID).Get(storedReminder)
			require.NoError(t, err)
			require.Equal(t, int64(-48*3600), storedReminder.RelativePeriod, "incompatible reminders must never be silently shortened")
			// Explicitly adjusting the reminder allows the new schedule and normal task saves.
			_, err = s.ID(reminder.ID).Cols("relative_period").Update(&TaskReminder{RelativePeriod: -600})
			require.NoError(t, err)
			require.NoError(t, r.Update(s, u))
			task := &Task{ID: 1}
			require.NoError(t, task.ReadOne(s, u))
			task.Title = "Routine reminder still permits normal task edits"
			require.NoError(t, task.Update(s, u))
			require.Len(t, task.Reminders, 1)
			require.Equal(t, int64(-600), task.Reminders[0].RelativePeriod)
			require.True(t, task.Routine.NextResetAt.Add(-10*time.Minute).Equal(task.Reminders[0].Reminder))
		})
	}
}

func TestRoutineReminderReadProjectsCurrentPeriod(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	r := &TaskRoutine{
		TaskID:   1,
		Enabled:  true,
		Timezone: "UTC",
		Period:   "weekly",
	}
	require.NoError(t, r.Update(s, u))
	stale := time.Date(2000, 1, 1, 0, 0, 0, 0, time.UTC)
	reminder := &TaskReminder{
		TaskID:         1,
		RelativeTo:     ReminderRelationRoutinePeriodEnd,
		RelativePeriod: -300,
		Reminder:       stale,
	}
	_, err := s.Insert(reminder)
	require.NoError(t, err)
	task := &Task{ID: 1}
	require.NoError(t, task.ReadOne(s, u))
	require.Len(t, task.Reminders, 1)
	require.True(t, task.Routine.NextResetAt.Add(-5*time.Minute).Equal(task.Reminders[0].Reminder))
	require.Equal(t, ReminderRelationRoutinePeriodEnd, task.Reminders[0].RelativeTo)
	stored := &TaskReminder{}
	_, err = s.ID(reminder.ID).Get(stored)
	require.NoError(t, err)
	require.True(t, stale.Equal(stored.Reminder), "read projection must not write the database")
	future := task.Routine.NextResetAt.Add(time.Hour)
	require.NoError(t, r.setPeriod(future))
	require.NoError(t, projectRoutineReminderDates(s, task.Reminders, future))
	require.True(t, r.NextResetAt.Add(-5*time.Minute).Equal(task.Reminders[0].Reminder), "next period is projected without any task write")
	// Historical invalid offsets stay visible for repair, never as old valid-looking dates.
	_, err = s.ID(reminder.ID).Cols("relative_period").Update(&TaskReminder{RelativePeriod: -40 * 24 * 3600})
	require.NoError(t, err)
	require.NoError(t, task.ReadOne(s, u))
	require.Len(t, task.Reminders, 1)
	require.True(t, task.Reminders[0].Reminder.IsZero())
	require.Equal(t, int64(-40*24*3600), task.Reminders[0].RelativePeriod)
}

func TestRoutineReminderShortestPeriodValidation(t *testing.T) {
	for _, tc := range []struct {
		name     string
		period   string
		timezone string
		offset   int64
		valid    bool
	}{
		{
			name:     "monthly rejects thirty-day offset before February",
			period:   "monthly",
			timezone: "UTC",
			offset:   -30 * 24 * 3600,
		},
		{
			name:     "monthly accepts its shortest month",
			period:   "monthly",
			timezone: "UTC",
			offset:   -28 * 24 * 3600,
			valid:    true,
		},
		{
			name:     "daily rejects full day across spring clock change",
			period:   "daily",
			timezone: "America/New_York",
			offset:   -24 * 3600,
		},
		{
			name:     "daily accepts twenty-three hours across spring clock change",
			period:   "daily",
			timezone: "America/New_York",
			offset:   -23 * 3600,
			valid:    true,
		},
		{
			name:     "half-hour clock change rejects full day",
			period:   "daily",
			timezone: "Australia/Lord_Howe",
			offset:   -24 * 3600,
		},
		{
			name:     "half-hour clock change accepts its shortest day",
			period:   "daily",
			timezone: "Australia/Lord_Howe",
			offset:   -23*3600 - 30*60,
			valid:    true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			r := &TaskRoutine{
				Timezone: tc.timezone,
				Period:   tc.period,
			}
			now := time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC)
			require.NoError(t, r.setPeriod(now))
			shortest, err := shortestRoutineReminderPeriod(r, now)
			require.NoError(t, err)
			err = validateRoutineReminderOffset(&TaskReminder{RelativePeriod: tc.offset}, shortest)
			if tc.valid {
				require.NoError(t, err)
			} else {
				require.ErrorAs(t, err, &ErrRoutineReminderSchedule{})
			}
		})
	}
}
