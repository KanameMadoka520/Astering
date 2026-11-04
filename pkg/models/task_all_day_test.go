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
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskAllDayValidation(t *testing.T) {
	valid := Task{
		AllDay:      true,
		AllDayStart: "2026-11-03",
		AllDayEnd:   "2026-11-04",
	}
	require.NoError(t, validateTaskAllDay(&valid))
	for _, change := range []func(*Task){
		func(t *Task) { t.AllDay = false },
		func(t *Task) { t.AllDayStart = "2026-02-30" },
		func(t *Task) { t.AllDayEnd = t.AllDayStart },
		func(t *Task) { t.AllDayEnd = "2026-11-02" },
		func(t *Task) { t.AllDayStart = "2026-11-03Z" },
		func(t *Task) { t.StartDate = time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC) },
		func(t *Task) { t.EndDate = time.Date(2026, 11, 4, 0, 0, 0, 0, time.UTC) },
		func(t *Task) { t.RepeatAfter = 3600 },
	} {
		candidate := valid
		change(&candidate)
		require.Error(t, validateTaskAllDay(&candidate))
	}
	// Midnight remains a timed event unless explicitly represented as all-day.
	require.NoError(t, validateTaskAllDay(&Task{StartDate: time.Date(2026, 11, 3, 0, 0, 0, 0, time.UTC)}))
}

func TestTaskAllDayPersistenceAndPartialUpdates(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	actor := &user.User{ID: 1}
	task := &Task{
		Title:       "Civil date fixture",
		ProjectID:   1,
		AllDay:      true,
		AllDayStart: "2024-03-10",
		AllDayEnd:   "2024-03-12",
	}
	require.NoError(t, task.Create(s, actor))
	stored, err := GetTaskSimple(s, &Task{ID: task.ID})
	require.NoError(t, err)
	assert.True(t, stored.AllDay)
	assert.Equal(t, "2024-03-10", stored.AllDayStart)
	assert.True(t, stored.StartDate.IsZero())
	update := &BulkTask{
		TaskIDs: []int64{task.ID},
		Fields:  []string{"description"},
		Values:  &Task{Description: "Updated notes"},
	}
	can, err := update.CanUpdate(s, actor)
	require.NoError(t, err)
	require.True(t, can)
	require.NoError(t, update.Update(s, actor))
	assert.True(t, update.Tasks[0].AllDay)
	assert.Equal(t, "2024-03-12", update.Tasks[0].AllDayEnd)
	// A false zero value and empty labels survive mergo and column selection.
	update.Fields = []string{"all_day", "all_day_start", "all_day_end", "start_date", "end_date"}
	update.Values = &Task{
		StartDate: time.Date(2024, 3, 10, 9, 0, 0, 0, time.UTC),
		EndDate:   time.Date(2024, 3, 10, 10, 0, 0, 0, time.UTC),
	}
	require.NoError(t, update.Update(s, actor))
	assert.False(t, update.Tasks[0].AllDay)
	assert.Empty(t, update.Tasks[0].AllDayStart)
	assert.Empty(t, update.Tasks[0].AllDayEnd)
	assert.Equal(t, 9, update.Tasks[0].StartDate.Hour())
	denied := &BulkTask{
		TaskIDs: []int64{task.ID},
		Fields:  []string{"all_day"},
		Values:  &Task{AllDay: true},
	}
	can, err = denied.CanUpdate(s, &user.User{ID: 2})
	require.NoError(t, err)
	assert.False(t, can)
}

func TestTaskAllDayCalendarCivilWindows(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	actor := &user.User{ID: 1}
	task := &Task{
		Title:       "Civil window fixture",
		ProjectID:   1,
		AllDay:      true,
		AllDayStart: "2040-03-10",
		AllDayEnd:   "2040-03-12",
	}
	require.NoError(t, task.Create(s, actor))
	for _, zone := range []string{"Pacific/Kiritimati", "America/Los_Angeles", "UTC"} {
		opts := CalendarOptions{
			From:      "2040-03-11",
			To:        "2040-03-12",
			Timezone:  zone,
			ProjectID: 1,
			Done:      "all",
			Page:      1,
			PerPage:   25,
		}
		result, err := GetCalendarTasks(s, actor, opts)
		require.NoError(t, err)
		require.Len(t, result.Items, 1)
		assert.True(t, result.Items[0].AllDay)
		assert.Equal(t, "2040-03-10", result.Items[0].AllDayStart)
		assert.Equal(t, "2040-03-12", result.Items[0].AllDayEnd)
		opts.From, opts.To = "2040-03-12", "2040-03-13"
		result, err = GetCalendarTasks(s, actor, opts)
		require.NoError(t, err)
		assert.Empty(t, result.Items, "exclusive end must not appear on the following day")
	}
}

func TestTaskAllDayCivilRecurrence(t *testing.T) {
	today := time.Date(2024, 3, 10, 23, 0, 0, 0, time.FixedZone("account", -7*3600))
	for _, tc := range []struct {
		name        string
		start       string
		end         string
		mode        TaskRepeatMode
		interval    int64
		expected    string
		expectedEnd string
	}{
		{name: "daily DST", start: "2024-03-09", end: "2024-03-11", interval: 86400, expected: "2024-03-11", expectedEnd: "2024-03-13"},
		{name: "weekly", start: "2024-03-09", end: "2024-03-10", interval: 604800, expected: "2024-03-16", expectedEnd: "2024-03-17"},
		{name: "leap month clamp", start: "2024-01-31", end: "2024-02-02", mode: TaskRepeatModeMonth, expected: "2024-02-29", expectedEnd: "2024-03-02"},
		{name: "completion local date", start: "2024-01-01", end: "2024-01-02", mode: TaskRepeatModeFromCurrentDate, interval: 86400, expected: "2024-03-11", expectedEnd: "2024-03-12"},
		{name: "year rollover", start: "2024-12-31", end: "2025-01-01", interval: 86400, expected: "2025-01-01", expectedEnd: "2025-01-02"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			old := Task{
				AllDay:      true,
				AllDayStart: tc.start,
				AllDayEnd:   tc.end,
				RepeatMode:  tc.mode,
				RepeatAfter: tc.interval,
			}
			next := old
			require.NoError(t, repeatTaskAllDay(&old, &next, today))
			assert.Equal(t, tc.expected, next.AllDayStart)
			assert.Equal(t, tc.expectedEnd, next.AllDayEnd)
		})
	}
	// Actual done-only model update persists the changed civil fields, not just
	// the in-memory result computed by the repeat helper.
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	task := &Task{
		ProjectID:   1,
		Title:       "Recurring civil fixture",
		AllDay:      true,
		AllDayStart: "2040-01-31",
		AllDayEnd:   "2040-02-01",
		RepeatMode:  TaskRepeatModeMonth,
	}
	require.NoError(t, task.Create(s, &user.User{ID: 1}))
	update := &BulkTask{
		TaskIDs: []int64{task.ID},
		Fields:  []string{"done"},
		Values:  &Task{Done: true},
	}
	require.NoError(t, update.Update(s, &user.User{ID: 1}))
	require.False(t, update.Tasks[0].Done)
	require.Equal(t, "2040-02-29", update.Tasks[0].AllDayStart)
	persisted := &Task{}
	found, err := s.ID(task.ID).Get(persisted)
	require.NoError(t, err)
	require.True(t, found)
	assert.Equal(t, "2040-03-01", persisted.AllDayEnd)
}
