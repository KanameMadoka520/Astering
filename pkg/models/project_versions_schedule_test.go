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
	"fmt"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestProjectVersionSchedulePermissions(t *testing.T) {
	s, owner, project, _ := projectVersionAuditFixture(t)
	status, err := ReadProjectVersionSchedule(s, owner, project.ID)
	require.NoError(t, err)
	require.False(t, status.Enabled)
	require.Nil(t, status.NextRunAt)

	member := &user.User{ID: 2}
	_, err = ReadProjectVersionSchedule(s, member, project.ID)
	require.Error(t, err)
	_, err = s.Insert(&ProjectUser{ProjectID: project.ID, UserID: member.ID, Permission: PermissionWrite})
	require.NoError(t, err)
	_, err = UpdateProjectVersionSchedule(s, member, project.ID, true)
	require.ErrorIs(t, err, ErrGenericForbidden{})
	_, err = ReadProjectVersionSchedule(s, &LinkSharing{ProjectID: project.ID}, project.ID)
	require.ErrorIs(t, err, ErrGenericForbidden{})

	status, err = UpdateProjectVersionSchedule(s, owner, project.ID, true)
	require.NoError(t, err)
	require.True(t, status.Enabled)
	again, err := UpdateProjectVersionSchedule(s, owner, project.ID, true)
	require.NoError(t, err)
	require.Equal(t, status, again)

	_, err = s.ID(project.ID).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	require.NoError(t, saveScheduledProjectVersion(s, project.ID, status.NextRunAt.Add(time.Minute), config.GetTimeZone()))
	_, total, err := ListProjectVersions(s, owner, project.ID, 1, 100)
	require.NoError(t, err)
	require.Zero(t, total)
	advanced, err := ReadProjectVersionSchedule(s, owner, project.ID)
	require.NoError(t, err)
	require.True(t, advanced.NextRunAt.After(*status.NextRunAt))
	status, err = UpdateProjectVersionSchedule(s, owner, project.ID, false)
	require.NoError(t, err)
	require.False(t, status.Enabled)
	_, err = UpdateProjectVersionSchedule(s, owner, project.ID, true)
	require.ErrorIs(t, err, ErrProjectIsArchived{ProjectID: project.ID})
}

func TestProjectVersionScheduleRetentionAndRestore(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	location := config.GetTimeZone()
	manual, err := CreateProjectVersion(s, owner, project.ID, "Keep indefinitely", "keep-scheduled-test")
	require.NoError(t, err)
	status, err := UpdateProjectVersionSchedule(s, owner, project.ID, true)
	require.NoError(t, err)

	// The first due check finds a matching named point and advances without
	// creating another. Subsequent retries are serialized by the same project lock.
	due := *status.NextRunAt
	require.NoError(t, saveScheduledProjectVersion(s, project.ID, due, location))
	_, total, err := ListProjectVersions(s, owner, project.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	due = nextProjectVersionRun(due, location, true)

	for day := 0; day <= dailyProjectVersionLimit; day++ {
		_, err = s.ID(task.ID).Cols("title").Update(&Task{Title: fmt.Sprintf("Revision %d", day)})
		require.NoError(t, err)
		require.NoError(t, saveScheduledProjectVersion(s, project.ID, due, location))
		require.NoError(t, saveScheduledProjectVersion(s, project.ID, due.Add(time.Minute), location))
		due = nextProjectVersionRun(due, location, true)
	}
	versions, total, err := ListProjectVersions(s, owner, project.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, dailyProjectVersionLimit+1, total)
	require.Equal(t, manual.ID, versions[len(versions)-1].ID)
	require.EqualValues(t, 3, versions[len(versions)-2].Sequence)
	require.Equal(t, dailyProjectVersionKind, versions[0].Kind)
	require.Zero(t, versions[0].CreatedBy.ID)
	used, err := TaskReferencedInProjectVersions(s, task.ID)
	require.NoError(t, err)
	require.True(t, used)

	target := versions[len(versions)-2]
	restored := projectVersionAuditRestore(t, s, owner, project.ID, target.ID, "restore-daily-point")
	require.Equal(t, target.ID, restored.Version.RestoredFromVersionID)
	require.Equal(t, "Revision 1", projectVersionAuditTask(t, s, task.ID).Title)
	_, err = UpdateProjectVersionSchedule(s, owner, project.ID, false)
	require.NoError(t, err)
	require.NoError(t, saveScheduledProjectVersion(s, project.ID, due, location))
	_, total, err = ListProjectVersions(s, owner, project.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, dailyProjectVersionLimit+3, total)
}

func TestProjectVersionScheduleLocalDay(t *testing.T) {
	location := time.FixedZone("UTC+8", 8*60*60)
	before := time.Date(2026, 11, 24, 1, 10, 0, 0, location)
	today := time.Date(2026, 11, 24, 3, 0, 0, 0, location).UTC()
	tomorrow := today.Add(24 * time.Hour)
	require.Equal(t, today, nextProjectVersionRun(before, location, false))
	require.Equal(t, tomorrow, nextProjectVersionRun(before, location, true))
	require.Equal(t, tomorrow, nextProjectVersionRun(today, location, false))
}
