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

package caldav

import (
	"strings"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/models"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskAllDayCalDAVRoundtrip(t *testing.T) {
	serialized := ParseTodos(&Config{Name: "Calendar", ProdID: "fixture"}, []*Todo{{
		UID:         "civil-fixture",
		Summary:     "All-day fixture",
		AllDay:      true,
		AllDayStart: "2024-03-10",
		AllDayEnd:   "2024-03-12",
		DueDate:     time.Date(2024, 3, 11, 12, 30, 0, 0, time.UTC),
	}})
	assert.Contains(t, serialized, "DTSTART;VALUE=DATE:20240310")
	assert.Contains(t, serialized, "DURATION:P2D")
	assert.NotContains(t, serialized, "\nDTEND")
	assert.NotContains(t, serialized, "\nDUE:")
	assert.Contains(t, serialized, "X-VIKUNJA-DUE:20240311T123000Z")
	assert.NotContains(t, serialized, "DTSTART:20240310T")
	task, props, err := ParseTaskFromVTODO(serialized)
	require.NoError(t, err)
	require.True(t, props.AllDay)
	assert.True(t, props.StartDate)
	assert.True(t, props.EndDate)
	assert.True(t, task.AllDay)
	assert.Equal(t, "2024-03-10", task.AllDayStart)
	assert.Equal(t, "2024-03-12", task.AllDayEnd)
	assert.True(t, task.StartDate.IsZero())
	assert.True(t, task.EndDate.IsZero())
	assert.Equal(t, "2024-03-11T12:30:00Z", task.DueDate.UTC().Format(time.RFC3339))
	assert.True(t, props.DueDate)
	for _, bad := range []string{
		"DTSTART;VALUE=DATE:20240230\nDTEND;VALUE=DATE:20240302",
		"DTSTART;VALUE=DATE:20240310\nDTEND:20240311T000000Z",
		"DTSTART;VALUE=DATE:20240310\nDTEND;VALUE=DATE:20240310",
		"DTSTART;VALUE=DATE:20240310\nDURATION:PT2H",
		"DTSTART;VALUE=DATE:20240310\nDUE:20240311T000000Z",
		"DTSTART;VALUE=DATE:20240310\nDUE;VALUE=DATE:20240312\nDURATION:P1D",
	} {
		_, _, err = ParseTaskFromVTODO("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:bad\n" + bad + "\nEND:VTODO\nEND:VCALENDAR")
		require.Error(t, err)
	}
	task, props, err = ParseTaskFromVTODO("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:single\nDTSTART;VALUE=DATE:20240310\nEND:VTODO\nEND:VCALENDAR")
	require.NoError(t, err)
	assert.True(t, props.AllDay)
	assert.Equal(t, "2024-03-11", task.AllDayEnd)
	task, props, err = ParseTaskFromVTODO("BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:due-date\nDTSTART;VALUE=DATE:20240310\nDUE;VALUE=DATE:20240312\nEND:VTODO\nEND:VCALENDAR")
	require.NoError(t, err)
	assert.Equal(t, "2024-03-12", task.AllDayEnd)
	assert.True(t, task.DueDate.IsZero())
	assert.False(t, props.DueDate)

}

func TestTaskAllDayCalDAVRoutineReminders(t *testing.T) {
	instant := time.Date(2026, 11, 3, 9, 0, 0, 0, time.UTC)
	serialized := GetCaldavTodosForTasks(&models.ProjectWithTasksAndBuckets{Project: models.Project{Title: "Fixture"}}, []*models.TaskWithComments{{Task: models.Task{
		UID:         "civil-reminder-fixture",
		AllDay:      true,
		AllDayStart: "2026-11-03",
		AllDayEnd:   "2026-11-04",
		Reminders: []*models.TaskReminder{
			{RelativeTo: models.ReminderRelationRoutinePeriodEnd, Reminder: instant.Add(time.Hour)},
			{RelativeTo: models.ReminderRelationDueDate, Reminder: instant},
			{RelativeTo: models.ReminderRelationStartDate, RelativePeriod: -900},
			{RelativeTo: models.ReminderRelationEndDate, RelativePeriod: -900},
		},
	}}})
	assert.Contains(t, serialized, "TRIGGER;VALUE=DATE-TIME:20261103T090000Z")
	assert.NotContains(t, serialized, "20261103T100000Z")
	assert.NotContains(t, serialized, "RELATED=END")
	assert.NotContains(t, serialized, "TRIGGER;VALUE=DATE-TIME:00010101")
	assert.Equal(t, 1, strings.Count(serialized, "BEGIN:VALARM"))
}

func TestTaskAllDayCalDAVLongCivilDuration(t *testing.T) {
	serialized := ParseTodos(&Config{Name: "Calendar", ProdID: "fixture"}, []*Todo{{
		UID:         "long-civil-fixture",
		AllDay:      true,
		AllDayStart: "1970-01-01",
		AllDayEnd:   "9998-12-31",
	}})
	task, _, err := ParseTaskFromVTODO(serialized)
	require.NoError(t, err)
	require.Equal(t, "1970-01-01", task.AllDayStart)
	require.Equal(t, "9998-12-31", task.AllDayEnd)
	for _, value := range []string{"P0D", "-P1D", "P99999999999D", "PT24H", "P1DT1H", "P4000000D", "P-1D"} {
		_, valid := civilDurationDays(value)
		require.False(t, valid, value)
	}
	days, valid := civilDurationDays("+P2W")
	require.True(t, valid)
	require.Equal(t, 14, days)
}
