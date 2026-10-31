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

func TestProjectCompletionHistory(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	p, err := SetProjectCompleted(s, u, 1, true)
	require.NoError(t, err)
	require.True(t, p.IsCompleted)
	require.False(t, p.CompletedAt.IsZero())
	_, err = SetProjectCompleted(s, u, 1, true)
	require.NoError(t, err)
	n, err := s.Where("project_id = ?", 1).Count(new(ProjectLifecycleEvent))
	require.NoError(t, err)
	require.EqualValues(t, 1, n)
	p, err = SetProjectCompleted(s, u, 1, false)
	require.NoError(t, err)
	require.False(t, p.IsCompleted)
	require.True(t, p.CompletedAt.IsZero())
	n, err = s.Where("project_id = ?", 1).Count(new(ProjectLifecycleEvent))
	require.NoError(t, err)
	require.EqualValues(t, 2, n)
	for _, id := range []int64{2, 9, 10, 43} {
		_, err = SetProjectCompleted(s, u, id, true)
		require.Error(t, err)
	}
	for _, id := range []int64{8, 11} {
		_, err = SetProjectCompleted(s, u, id, true)
		require.NoError(t, err)
	}
	_, err = SetProjectCompleted(s, &LinkSharing{ProjectID: 1, Permission: PermissionRead}, 1, true)
	require.Error(t, err)
	_, err = SetProjectCompleted(s, &LinkSharing{ProjectID: 1, Permission: PermissionAdmin}, 1, true)
	require.NoError(t, err)
}

func TestProjectHistoryCalendar(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	stamp := time.Date(2023, 12, 31, 16, 0, 0, 0, time.UTC)
	for _, id := range []int64{1, 2, 6, 9, 43} {
		_, err := s.Insert(&ProjectLifecycleEvent{ProjectID: id, Kind: "completed", OccurredAt: stamp})
		require.NoError(t, err)
	}
	_, err := s.Insert(&ProjectLifecycleEvent{ProjectID: 1, Kind: "archived"})
	require.NoError(t, err)
	_, err = s.ID(1).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	opts := ProjectHistoryOptions{Year: 2024, Timezone: "Asia/Shanghai", Page: 1}
	h, err := GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Equal(t, 4, h.Days["2024-01-01"])
	require.Equal(t, 4, h.Projects)
	require.Equal(t, 1, h.Unknown)
	require.Len(t, h.Items, 4)
	for _, item := range h.Items {
		require.NotEqualValues(t, 2, item.ProjectID)
		require.NotEmpty(t, item.Title)
	}
	opts.Timezone = "UTC"
	h, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Zero(t, h.Milestones)
	opts.Timezone = "Asia/Shanghai"
	opts.Unknown = true
	h, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, h.Items, 1)
	require.True(t, h.Items[0].IsArchived)
	opts.Unknown = false
	opts.ProjectID = 2
	h, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Empty(t, h.Items)
	require.Empty(t, h.Years)
	opts.ProjectID = 0
	h, err = GetProjectHistory(s, &LinkSharing{ProjectID: 1, Permission: PermissionRead}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Projects)
	opts.Day = "2024-02-30"
	_, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.Error(t, err)
	opts.Day = "2023-12-31"
	_, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.Error(t, err)
	opts.Day = ""
	opts.Timezone = "bad"
	_, err = GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.Error(t, err)
}

func TestProjectArchiveHistoryCascade(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	require.NoError(t, SetArchiveStateForProjectDescendants(s, 41, true))
	var events []ProjectLifecycleEvent
	require.NoError(t, s.Find(&events))
	for _, e := range events {
		require.Equal(t, "archived", e.Kind)
		require.False(t, e.OccurredAt.IsZero())
	}
	require.NotEmpty(t, events)
	count := len(events)
	require.NoError(t, SetArchiveStateForProjectDescendants(s, 41, true))
	total, err := s.Count(new(ProjectLifecycleEvent))
	require.NoError(t, err)
	require.EqualValues(t, count, total)
}

func TestProjectHistoryPagination(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for i := 0; i < 25; i++ {
		_, err := s.Insert(&ProjectLifecycleEvent{ProjectID: 1, Kind: "completed", OccurredAt: time.Date(2024, 2, 29, 12, 0, 0, 0, time.UTC)})
		require.NoError(t, err)
	}
	opts := ProjectHistoryOptions{Year: 2024, Timezone: "UTC", Page: 1}
	first, err := GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, first.Items, 24)
	require.Equal(t, 2, first.TotalPages)
	require.Equal(t, 25, first.Days["2024-02-29"])
	opts.Page = 2
	second, err := GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Len(t, second.Items, 1)
	require.Less(t, second.Items[0].ID, first.Items[23].ID)
	opts.Page = 3
	last, err := GetProjectHistory(s, &user.User{ID: 1}, opts)
	require.NoError(t, err)
	require.Empty(t, last.Items)
	require.EqualValues(t, 25, last.Total)
}

func TestProjectHistoryScopeWithoutMilestones(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	for _, p := range []*Project{
		{Title: "History scope active"},
		{Title: "History scope completed", IsCompleted: true},
		{Title: "History scope archived", IsArchived: true},
		{Title: "History scope both", IsCompleted: true, IsArchived: true},
	} {
		completed, archived := p.IsCompleted, p.IsArchived
		require.NoError(t, p.Create(s, u))
		_, err := s.ID(p.ID).Cols("is_completed", "is_archived").Update(&Project{IsCompleted: completed, IsArchived: archived})
		require.NoError(t, err)
	}
	// Project state counts are independent of events and selected year/kind/page.
	opts := ProjectHistoryOptions{Year: 2030, Timezone: "UTC", Page: 2, Kind: "reopened", Search: "History scope"}
	h, err := GetProjectHistory(s, u, opts)
	require.NoError(t, err)
	require.Equal(t, &ProjectHistoryScope{Projects: 4, Completed: 2, Archived: 2}, h.Scope)
	require.Empty(t, h.Items)
	require.Empty(t, h.Days)
	require.Zero(t, h.Milestones)
	opts.Unknown = true
	h, err = GetProjectHistory(s, u, opts)
	require.NoError(t, err)
	require.Equal(t, &ProjectHistoryScope{Projects: 4, Completed: 2, Archived: 2}, h.Scope)
	opts.Search = "History scope completed"
	h, err = GetProjectHistory(s, u, opts)
	require.NoError(t, err)
	require.Equal(t, &ProjectHistoryScope{Projects: 1, Completed: 1}, h.Scope)
	opts.ProjectID, opts.Search = 2, ""
	h, err = GetProjectHistory(s, u, opts)
	require.NoError(t, err)
	require.Equal(t, &ProjectHistoryScope{}, h.Scope)
	opts.ProjectID = 1
	h, err = GetProjectHistory(s, &LinkSharing{ProjectID: 1, Permission: PermissionRead}, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Scope.Projects)
	opts.ProjectID = 9 // User 1 inherits readable team project access in fixtures.
	h, err = GetProjectHistory(s, u, opts)
	require.NoError(t, err)
	require.Equal(t, 1, h.Scope.Projects)
}
