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
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskAllDayCalDAVPartialUpdate(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	actor := &user.User{ID: 15, Username: "user15"}
	const uid = "uid-caldav-test-child-task"
	s := db.NewSession()
	tasks, err := models.GetTasksByUIDs(s, []string{uid}, actor)
	require.NoError(t, err)
	require.Len(t, tasks, 1)
	task := tasks[0]
	_, err = s.ID(task.ID).Cols("all_day", "all_day_start", "all_day_end", "start_date", "end_date").Update(&models.Task{
		AllDay:      true,
		AllDayStart: "2026-11-03",
		AllDayEnd:   "2026-11-05",
		StartDate:   time.Time{},
		EndDate:     time.Time{},
	})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	storage := &VikunjaCaldavProjectStorage{
		project: &models.ProjectWithTasksAndBuckets{Project: models.Project{ID: 36}},
		task:    task,
		user:    actor,
	}
	content := "BEGIN:VCALENDAR\nVERSION:2.0\nBEGIN:VTODO\nUID:" + uid + "\nSUMMARY:Edited civil fixture\nEND:VTODO\nEND:VCALENDAR"
	resource, err := storage.UpdateResource(uid, content)
	require.NoError(t, err)
	body, available := resource.GetContentData()
	require.True(t, available)
	assert.Contains(t, body, "DTSTART;VALUE=DATE:20261103")
	assert.Contains(t, body, "DURATION:P2D")
	read := db.NewSession()
	defer read.Close()
	stored, err := models.GetTaskSimple(read, &models.Task{ID: task.ID})
	require.NoError(t, err)
	assert.True(t, stored.AllDay)
	assert.Equal(t, "2026-11-03", stored.AllDayStart)
	assert.Equal(t, "2026-11-05", stored.AllDayEnd)
}
