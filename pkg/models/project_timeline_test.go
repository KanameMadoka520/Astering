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

func timelineDate(value string) time.Time {
	d, err := time.Parse(time.RFC3339, value)
	if err != nil {
		panic(err)
	}
	return d
}

func TestProjectTimelineCoverage(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	_, err := s.Where("project_id = ?", 1).Delete(new(Task))
	require.NoError(t, err)
	now := timelineDate("2024-03-12T12:00:00Z")
	tasks := []Task{
		{Title: "Started in previous year", ProjectID: 1, StartDate: timelineDate("2023-12-30T12:00:00Z"), EndDate: timelineDate("2024-01-03T12:00:00Z"), PercentDone: .5},
		{Title: "Overlapping schedule", ProjectID: 1, StartDate: timelineDate("2024-01-02T12:00:00Z"), DueDate: timelineDate("2024-01-04T12:00:00Z"), Done: true, DoneAt: timelineDate("2024-01-02T13:00:00Z")},
		{Title: "Future", ProjectID: 1, StartDate: timelineDate("2024-04-01T12:00:00Z"), EndDate: timelineDate("2024-04-02T12:00:00Z")},
		{Title: "Missing start", ProjectID: 1, DueDate: timelineDate("2024-02-01T12:00:00Z")},
		{Title: "Missing end", ProjectID: 1, StartDate: timelineDate("2024-02-01T12:00:00Z")},
		{Title: "Reversed", ProjectID: 1, StartDate: timelineDate("2024-02-02T12:00:00Z"), EndDate: timelineDate("2024-02-01T12:00:00Z")},
		{Title: "End takes precedence", ProjectID: 1, StartDate: timelineDate("2024-03-09T12:00:00Z"), EndDate: timelineDate("2024-03-10T12:00:00Z"), DueDate: timelineDate("2024-03-11T12:00:00Z"), PercentDone: .1},
	}
	for i := range tasks {
		tasks[i].Index = int64(i + 10000)
	}
	_, err = s.Insert(&tasks)
	require.NoError(t, err)
	opts := ProjectTimelineOptions{Year: 2024, Timezone: "America/New_York", ProjectID: 1, Page: 1}
	h, err := getProjectTimelineAt(s, &user.User{ID: 1}, opts, now)
	require.NoError(t, err)
	require.Equal(t, 1, h.ExcludedTasks)
	require.Equal(t, 1, h.InvalidTasks)
	require.Equal(t, 5, h.DatedTasks)
	require.Equal(t, 1, h.DoneTasks)
	require.Equal(t, 2, h.OverdueTasks)
	require.Equal(t, 8, h.ScheduledDays) // Jan 1–4, Mar 9–10, Apr 1–2.
	require.Equal(t, 5, h.ElapsedDays)   // Jan 1–3, Mar 9–10; future and completed tails excluded.
	require.Equal(t, 1, h.Days["2024-01-02"].ScheduledProjects)
	require.Equal(t, 1, h.Days["2024-01-04"].Deadlines)
	require.Zero(t, h.Days["2024-03-11"].ScheduledProjects)
	require.Equal(t, 1, h.Days["2024-03-11"].Deadlines)
	require.Equal(t, 2023, h.FirstYear)
	require.Equal(t, 2024, h.LastYear)
	require.Len(t, h.Items, 1)
	require.InDelta(t, .32, h.Items[0].Progress, .00001)
	require.Equal(t, "2024-02-01", h.Items[0].OverdueSince)
	require.Empty(t, h.Items[0].NextDeadline)
	require.Len(t, h.Items[0].ScheduledSpans, 3)
	require.Equal(t, "2023-12-30", h.Items[0].StartDate)
	opts.Day = "2024-03-11" // A deadline outside its task range must still select the project.
	h, err = getProjectTimelineAt(s, &user.User{ID: 1}, opts, now)
	require.NoError(t, err)
	require.Equal(t, 1, h.Total)
	opts.Day = "2024-02-10"
	h, err = getProjectTimelineAt(s, &user.User{ID: 1}, opts, now)
	require.NoError(t, err)
	require.Empty(t, h.Items)
	require.Equal(t, 8, h.ScheduledDays) // Day selection does not rewrite annual statistics.
	opts.Day = "2024-02-30"
	_, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.Error(t, err)
}

func TestProjectTimelineACLAndTimezone(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for _, id := range []int64{1, 2, 6, 9, 43} {
		_, err := s.Insert(&Task{Title: "Dated", ProjectID: id, StartDate: timelineDate("2023-12-31T16:00:00Z"), DueDate: timelineDate("2024-01-01T01:00:00Z")})
		require.NoError(t, err)
	}
	_, err := s.ID(1).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	deleted := &Task{Title: "Deleted schedules must not leak", ProjectID: 1, Index: 99999, StartDate: timelineDate("2099-01-01T12:00:00Z"), EndDate: timelineDate("2099-01-03T12:00:00Z")}
	_, err = s.Insert(deleted)
	require.NoError(t, err)
	_, err = s.ID(deleted.ID).Delete(new(Task))
	require.NoError(t, err)
	opts := ProjectTimelineOptions{Year: 2024, Timezone: "Asia/Shanghai", Page: 1}
	h, err := GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 4, h.Days["2024-01-01"].ScheduledProjects)
	require.Equal(t, 4, h.Days["2024-01-01"].Deadlines)
	require.Less(t, h.LastYear, 2099)
	for _, p := range h.Items {
		require.NotEqualValues(t, 2, p.ID)
	}
	opts.ProjectID = 2
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Zero(t, h.FirstYear)
	require.Zero(t, h.ExcludedTasks)
	require.Zero(t, h.Projects)
	require.Empty(t, h.Days)
	opts.ProjectID = 0
	h, err = GetProjectTimeline(s, &LinkSharing{ProjectID: 1, Permission: PermissionRead}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Projects)
	require.True(t, h.Items[0].IsArchived)
	opts.Status = "archived"
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Projects)
	opts.Status = "active"
	h, err = GetProjectTimeline(s, &LinkSharing{ProjectID: 1, Permission: PermissionRead}, opts)
	require.NoError(t, err)
	require.Empty(t, h.Items)
	opts.Status = "all"
	opts.Timezone = "invalid"
	_, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.Error(t, err)
}

func TestProjectTimelineLeapYearAndPaging(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for i := 0; i < 25; i++ {
		p := &Project{Title: "Timeline pagination", OwnerID: 1}
		require.NoError(t, p.Create(s, &user.User{ID: 1}))
		_, err := s.Insert(&Task{Title: "Leap day", ProjectID: p.ID, StartDate: timelineDate("2024-02-28T12:00:00Z"), EndDate: timelineDate("2024-03-01T12:00:00Z")})
		require.NoError(t, err)
	}
	opts := ProjectTimelineOptions{Year: 2024, Timezone: "UTC", Search: "Timeline pagination", Page: 1}
	h, err := GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 25, h.Projects)
	require.Equal(t, 25, h.Days["2024-02-29"].ScheduledProjects)
	require.Equal(t, 3, h.ScheduledDays)
	require.Equal(t, 2, h.TotalPages)
	require.Len(t, h.Items, 24)
	lastID := h.Items[23].ID
	opts.Page = 2
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, h.Items, 1)
	require.Greater(t, h.Items[0].ID, lastID)
}

func TestProjectTimelineDeadlineNodes(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	_, err := s.Where("project_id = ?", 1).Delete(new(Task))
	require.NoError(t, err)
	tasks := []Task{
		{Title: "Only deadline", ProjectID: 1, DueDate: timelineDate("2024-03-01T01:00:00Z"), Done: true},
		{Title: "Same deadline", ProjectID: 1, DueDate: timelineDate("2024-03-01T10:00:00Z")},
		{Title: "Range is in previous year", ProjectID: 1, StartDate: timelineDate("2023-12-20T12:00:00Z"), EndDate: timelineDate("2023-12-25T12:00:00Z"), DueDate: timelineDate("2024-03-02T12:00:00Z")},
		{Title: "Reversed range with valid deadline", ProjectID: 1, StartDate: timelineDate("2024-04-02T12:00:00Z"), EndDate: timelineDate("2024-04-01T12:00:00Z"), DueDate: timelineDate("2024-03-03T12:00:00Z")},
		{Title: "Missing all dates", ProjectID: 1},
		{Title: "Only start", ProjectID: 1, StartDate: timelineDate("2024-02-01T12:00:00Z")},
		{Title: "Only end", ProjectID: 1, EndDate: timelineDate("2024-02-01T12:00:00Z")},
	}
	for i := range tasks {
		tasks[i].Index = int64(i + 10000)
	}
	_, err = s.Insert(&tasks)
	require.NoError(t, err)
	opts := ProjectTimelineOptions{Year: 2024, Timezone: "UTC", ProjectID: 1, Page: 1}
	h, err := getProjectTimelineAt(s, &user.User{ID: 1}, opts, timelineDate("2024-03-10T12:00:00Z"))
	require.NoError(t, err)
	require.Equal(t, 4, h.DatedTasks)
	require.Equal(t, 4, h.DeadlineOnlyTasks)
	require.Zero(t, h.RangedTasks)
	require.Zero(t, h.ScheduledDays)
	require.Zero(t, h.ElapsedDays)
	require.Equal(t, 1, h.UndatedTasks)
	require.Equal(t, 2, h.IncompleteTasks)
	require.Equal(t, 3, h.ExcludedTasks)
	require.Equal(t, 1, h.InvalidTasks)
	require.Equal(t, 2023, h.FirstYear)
	require.Equal(t, 2024, h.LastYear)
	require.Len(t, h.Items, 1)
	item := h.Items[0]
	require.Empty(t, item.StartDate)
	require.Empty(t, item.EndDate)
	require.Empty(t, item.ScheduledSpans)
	require.Len(t, item.DeadlineDays, 3)
	require.Equal(t, ProjectTimelineDeadline{Date: "2024-03-01", Count: 2, Done: 1, Open: 1}, item.DeadlineDays[0])
	require.Equal(t, 1, h.Days["2024-03-01"].DeadlineProjects)
	require.Equal(t, 2, h.Days["2024-03-01"].Deadlines)
	require.Equal(t, 3, h.OverdueTasks)
	require.InDelta(t, .25, item.Progress, .00001)
	opts.Day = "2024-03-03"
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Total)
	require.Equal(t, 4, h.DatedTasks)
	opts.Day = "2024-04-01" // An invalid range is never coverage.
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Zero(t, h.Total)
	opts.Day = ""
	opts.Year = 2023
	h, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.DatedTasks)
	require.Equal(t, 1, h.RangedTasks)
	require.Zero(t, h.DeadlineOnlyTasks)
	require.Equal(t, 6, h.ScheduledDays)
	require.Empty(t, h.Items[0].DeadlineDays)
}

func TestProjectTimelineDeadlineOrderingAndScope(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	var projects []*Project
	for _, title := range []string{"Timeline nodes later", "Timeline nodes earlier", "Timeline nodes tied"} {
		p := &Project{Title: title}
		require.NoError(t, p.Create(s, u))
		projects = append(projects, p)
	}
	for i, day := range []string{"2024-03-02T12:00:00Z", "2024-03-01T12:00:00Z", "2024-03-02T12:00:00Z"} {
		_, err := s.Insert(&Task{Title: "Deadline", ProjectID: projects[i].ID, DueDate: timelineDate(day)})
		require.NoError(t, err)
	}
	_, err := s.ID(projects[0].ID).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	_, err = s.ID(projects[1].ID).Cols("is_completed").Update(&Project{IsCompleted: true})
	require.NoError(t, err)
	_, err = s.Insert(&Task{Title: "Private future node", ProjectID: 2, DueDate: timelineDate("2099-01-01T12:00:00Z")})
	require.NoError(t, err)
	opts := ProjectTimelineOptions{Year: 2024, Timezone: "UTC", Search: "Timeline nodes", Page: 1}
	h, err := GetProjectTimeline(s, u, opts)
	require.NoError(t, err)
	require.Len(t, h.Items, 3)
	require.Equal(t, projects[1].ID, h.Items[0].ID)
	require.Equal(t, projects[0].ID, h.Items[1].ID)
	require.Equal(t, projects[2].ID, h.Items[2].ID)
	require.Equal(t, 2, h.Days["2024-03-02"].DeadlineProjects)
	require.Equal(t, 3, h.DeadlineOnlyTasks)
	for _, status := range []string{"active", "completed", "archived"} {
		opts.Status = status
		h, err = GetProjectTimeline(s, u, opts)
		require.NoError(t, err)
		require.Equal(t, 1, h.Projects)
		require.Equal(t, 1, h.DatedTasks)
	}
	opts.Status, opts.Search, opts.ProjectID = "all", "", 2
	h, err = GetProjectTimeline(s, u, opts)
	require.NoError(t, err)
	require.Zero(t, h.FirstYear)
	require.Zero(t, h.LastYear)
	require.Zero(t, h.DeadlineOnlyTasks)
	require.Zero(t, h.UndatedTasks)
	require.Empty(t, h.Items)
	opts.ProjectID = projects[0].ID
	h, err = GetProjectTimeline(s, &LinkSharing{ProjectID: projects[0].ID, Permission: PermissionRead}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Projects)
	require.Equal(t, 1, h.DeadlineOnlyTasks)
}

func TestProjectTimelineProductionDateShape(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	_, err := s.Where("project_id = ?", 1).Delete(new(Task))
	require.NoError(t, err)
	tasks := make([]Task, 130)
	for i := range tasks {
		tasks[i] = Task{Title: "Date shape regression", ProjectID: 1, Index: int64(i + 10000)}
		switch {
		case i < 9:
			tasks[i].StartDate = timelineDate("2026-10-26T12:00:00Z")
			tasks[i].EndDate = timelineDate("2026-10-29T12:00:00Z")
			tasks[i].Done = i < 8
		case i < 26:
			tasks[i].DueDate = timelineDate("2026-11-06T12:00:00Z")
		}
	}
	_, err = s.Insert(&tasks)
	require.NoError(t, err)
	h, err := GetProjectTimeline(s, &user.User{ID: 1}, ProjectTimelineOptions{Year: 2026, Timezone: "Asia/Shanghai", ProjectID: 1, Page: 1})
	require.NoError(t, err)
	require.Equal(t, 26, h.DatedTasks)
	require.Equal(t, 9, h.RangedTasks)
	require.Equal(t, 17, h.DeadlineOnlyTasks)
	require.Equal(t, 104, h.UndatedTasks)
	require.Equal(t, 104, h.ExcludedTasks)
	require.Equal(t, 8, h.DoneTasks)
	require.Equal(t, 4, h.ScheduledDays)
	require.Equal(t, 17, h.Days["2026-11-06"].Deadlines)
}

func TestProjectTimelineDateFactsIndependent(t *testing.T) {
	loc, err := time.LoadLocation("Asia/Shanghai")
	require.NoError(t, err)
	for _, tc := range []struct {
		name     string
		task     timelineTask
		ranged   bool
		validDue bool
		invalid  int
	}{
		{name: "deadline local year", task: timelineTask{DueDate: timelineDate("2023-12-31T16:00:00Z")}, validDue: true},
		{name: "range survives unsupported deadline", task: timelineTask{StartDate: timelineDate("2024-01-01T12:00:00Z"), EndDate: timelineDate("2024-01-03T12:00:00Z"), DueDate: timelineDate("1960-01-01T12:00:00Z")}, ranged: true, invalid: 1},
		{name: "deadline survives unsupported range", task: timelineTask{StartDate: timelineDate("1960-01-01T12:00:00Z"), EndDate: timelineDate("2024-01-03T12:00:00Z"), DueDate: timelineDate("2024-02-01T12:00:00Z")}, validDue: true, invalid: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			result := &ProjectTimeline{}
			start, end, ranged, validDue, eligible := timelineDates(&tc.task, result, 2024, loc)
			require.True(t, eligible)
			require.Equal(t, tc.ranged, ranged)
			require.Equal(t, tc.validDue, validDue)
			require.Equal(t, tc.invalid, result.InvalidTasks)
			require.Equal(t, 2024, result.FirstYear)
			require.Equal(t, 2024, result.LastYear)
			if !ranged {
				require.True(t, start.IsZero())
				require.True(t, end.IsZero())
			}
		})
	}
}

func TestProjectTimelineAllDayCivilCoverage(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	_, err := s.Where("project_id = ?", 1).Delete(new(Task))
	require.NoError(t, err)
	rows := []Task{
		{Title: "Civil across year", ProjectID: 1, Index: 60047, AllDay: true, AllDayStart: "2023-12-31", AllDayEnd: "2024-01-03"},
		{Title: "Civil DST", ProjectID: 1, Index: 60048, AllDay: true, AllDayStart: "2024-03-09", AllDayEnd: "2024-03-12", DueDate: timelineDate("2024-03-15T12:00:00Z")},
		{Title: "Must remain private", ProjectID: 2, Index: 60047, AllDay: true, AllDayStart: "2090-01-01", AllDayEnd: "2090-12-31"},
	}
	_, err = s.Insert(&rows)
	require.NoError(t, err)
	for _, timezone := range []string{"America/New_York", "Pacific/Kiritimati"} {
		opts := ProjectTimelineOptions{Year: 2024, Timezone: timezone, ProjectID: 1, Page: 1}
		result, err := getProjectTimelineAt(s, &user.User{ID: 1}, opts, timelineDate("2024-03-11T12:00:00Z"))
		require.NoError(t, err)
		require.Equal(t, 2, result.DatedTasks)
		require.Equal(t, 2, result.RangedTasks)
		require.Zero(t, result.UndatedTasks)
		require.Equal(t, 5, result.ScheduledDays)
		require.Equal(t, 5, result.ElapsedDays)
		require.Nil(t, result.Days["2024-01-03"])
		require.Nil(t, result.Days["2024-03-12"])
		loc, err := time.LoadLocation(timezone)
		require.NoError(t, err)
		require.Equal(t, 1, result.Days[rows[1].DueDate.In(loc).Format(time.DateOnly)].Deadlines)
		require.Equal(t, 2023, result.FirstYear)
		require.Equal(t, 2024, result.LastYear)
		require.Len(t, result.Items, 1)
		require.Equal(t, "2023-12-31", result.Items[0].StartDate)
		require.Equal(t, "2024-03-11", result.Items[0].EndDate)
		opts.Day = "2024-03-10"
		result, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
		require.NoError(t, err)
		require.Len(t, result.Items, 1)
		opts.ProjectID = 2
		result, err = GetProjectTimeline(s, &user.User{ID: 1}, opts)
		require.NoError(t, err)
		require.Empty(t, result.Items)
		require.Zero(t, result.DatedTasks)
		require.Zero(t, result.FirstYear)
	}
}
