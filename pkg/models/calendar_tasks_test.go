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
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCalendarCivilBoundaries(t *testing.T) {
	tests := []struct {
		name  string
		zone  string
		from  string
		to    string
		hours time.Duration
		first string
	}{
		{
			name:  "spring DST",
			zone:  "America/New_York",
			from:  "2024-03-10",
			to:    "2024-03-11",
			hours: 23,
			first: "2024-03-10T05:00:00Z",
		},
		{
			name:  "fall DST",
			zone:  "America/New_York",
			from:  "2024-11-03",
			to:    "2024-11-04",
			hours: 25,
			first: "2024-11-03T04:00:00Z",
		},
		{
			name:  "Shanghai midnight",
			zone:  "Asia/Shanghai",
			from:  "2024-02-29",
			to:    "2024-03-01",
			hours: 24,
			first: "2024-02-28T16:00:00Z",
		},
		{
			name:  "skipped midnight",
			zone:  "America/Santiago",
			from:  "2024-09-08",
			to:    "2024-09-09",
			hours: 23,
			first: "2024-09-08T04:00:00Z",
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			loc, err := time.LoadLocation(test.zone)
			require.NoError(t, err)
			days, err := calendarDays(test.from, test.to, loc)
			require.NoError(t, err)
			require.Len(t, days, 1)
			assert.Equal(t, test.from, days[0].Date)
			assert.Equal(t, test.first, days[0].StartAt.Format(time.RFC3339))
			assert.Equal(t, test.hours*time.Hour, days[0].EndAt.Sub(days[0].StartAt))
		})
	}
	days, err := calendarDays("2023-12-31", "2024-03-02", time.UTC)
	require.NoError(t, err)
	require.Len(t, days, 62)
	assert.Equal(t, "2024-02-29", days[60].Date)
	for _, dates := range [][2]string{{"2024-01-01", "2024-03-04"}, {"2024-02-30", "2024-03-01"}, {"2024-03-01", "2024-03-01"}, {"2024-03-02", "2024-03-01"}, {"2024-3-01", "2024-03-02"}} {
		_, err = calendarDays(dates[0], dates[1], time.UTC)
		require.Error(t, err)
	}
	apia, err := time.LoadLocation("Pacific/Apia")
	require.NoError(t, err)
	_, err = calendarDays("2011-12-29", "2011-12-31", apia)
	require.ErrorContains(t, err, "does not exist")
}

func TestCalendarTasksProjectionAndPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	at := func(value string) time.Time {
		parsed, err := time.Parse(time.RFC3339, value)
		require.NoError(t, err)
		return parsed
	}
	instant := at("2024-03-10T12:00:00Z")
	rows := []Task{
		{
			Title:     "start point",
			ProjectID: 1,
			StartDate: instant,
		},
		{
			Title:     "end point",
			ProjectID: 1,
			EndDate:   instant,
		},
		{
			Title:     "due point",
			ProjectID: 1,
			DueDate:   instant,
		},
		{
			Title:     "spanning",
			ProjectID: 1,
			StartDate: at("2024-03-01T00:00:00Z"),
			EndDate:   at("2024-04-01T00:00:00Z"),
		},
		{
			Title:     "reversed valid point",
			ProjectID: 1,
			StartDate: at("2024-04-01T00:00:00Z"),
			EndDate:   instant,
		},
		{
			Title:     "inclusive left",
			ProjectID: 1,
			DueDate:   at("2024-03-10T05:00:00Z"),
		},
		{
			Title:     "exclusive right",
			ProjectID: 1,
			DueDate:   at("2024-03-11T04:00:00Z"),
		},
		{
			Title:     "undated",
			ProjectID: 1,
		},
		{
			Title:     "completed",
			ProjectID: 1,
			DueDate:   instant,
			Done:      true,
		},
		{
			Title:     "private project",
			ProjectID: 2,
			DueDate:   instant,
		},
		{
			Title:     "soft deleted",
			ProjectID: 1,
			DueDate:   instant,
		},
	}
	for index := range rows {
		rows[index].Index = int64(index + 20000)
		_, err := s.Insert(&rows[index])
		require.NoError(t, err)
		require.Positive(t, rows[index].ID)
	}
	deleted, err := s.ID(rows[10].ID).Delete(&Task{})
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)
	opts := CalendarOptions{
		From:     "2024-03-10",
		To:       "2024-03-11",
		Timezone: "America/New_York",
		Page:     1,
		PerPage:  2,
	}
	// The six qualifying rows are three standalone date points, a covering
	// span, the valid end of a reversed range, and the exact inclusive edge.
	// The right edge must not substitute for the left edge even if total=6.
	completeOptions := opts
	completeOptions.PerPage = 10
	complete, err := GetCalendarTasks(s, &user.User{ID: 1}, completeOptions)
	require.NoError(t, err)
	actualIDs := make([]int64, 0, len(complete.Items))
	for _, item := range complete.Items {
		actualIDs = append(actualIDs, item.ID)
	}
	require.Equal(t, []int64{
		rows[0].ID,
		rows[1].ID,
		rows[2].ID,
		rows[3].ID,
		rows[4].ID,
		rows[5].ID,
	}, actualIDs)
	assert.NotContains(t, actualIDs, rows[6].ID, "to is an exclusive instant")
	result, err := GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.EqualValues(t, 6, result.Total)
	require.Len(t, result.Items, 2)
	assert.Equal(t, rows[0].ID, result.Items[0].ID)
	assert.Equal(t, rows[1].ID, result.Items[1].ID)
	assert.True(t, result.Items[0].StartDate.Equal(instant))
	assert.True(t, result.Items[0].EndDate.IsZero(), "do not invent an end for a start-only task")
	opts.Page = 3
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, result.Items, 2)
	assert.Equal(t, rows[4].ID, result.Items[0].ID)
	assert.Equal(t, rows[5].ID, result.Items[1].ID)
	opts.Page = 1
	opts.Done = "all"
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	assert.EqualValues(t, 7, result.Total)
	opts.Done = "done"
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	assert.Equal(t, rows[8].ID, result.Items[0].ID)
	opts.ProjectID = 2
	opts.Done = "all"
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	assert.Zero(t, result.Total)
	assert.Empty(t, result.Items)
	// A share may only see its own project, even with another explicit project filter.
	opts.ProjectID = 1
	result, err = GetCalendarTasks(s, &LinkSharing{ProjectID: 2}, opts)
	require.NoError(t, err)
	assert.Zero(t, result.Total)
	opts.ProjectID = 0
	result, err = GetCalendarTasks(s, &LinkSharing{ProjectID: 2}, opts)
	require.NoError(t, err)
	require.Len(t, result.Items, 1)
	assert.Equal(t, rows[9].ID, result.Items[0].ID)
	// Archived inclusion is explicit; defaults do not silently retain old projects.
	_, err = s.ID(1).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	assert.Zero(t, result.Total)
	opts.IncludeArchived = true
	result, err = GetCalendarTasks(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	assert.EqualValues(t, 7, result.Total)
}

func TestCalendarDefaultsToStoredUserTimezone(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	_, err := s.ID(1).Cols("timezone").Update(&user.User{Timezone: "Asia/Shanghai"})
	require.NoError(t, err)
	result, err := GetCalendarTasks(s, &user.User{ID: 1}, CalendarOptions{
		From:    "2024-02-29",
		To:      "2024-03-01",
		Page:    1,
		PerPage: 10,
	})
	require.NoError(t, err)
	assert.Equal(t, "Asia/Shanghai", result.Timezone)
	require.Len(t, result.Days, 1)
	assert.Equal(t, "2024-02-28T16:00:00Z", result.Days[0].StartAt.Format(time.RFC3339))
}
