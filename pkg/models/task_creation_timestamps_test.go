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
	"context"
	"fmt"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskCreationReturnsPersistedTimestamps(t *testing.T) {
	customCreated := time.Date(2020, time.June, 15, 10, 20, 30, 987654321, time.UTC)
	// Import uses the same creation path without the HTTP bulk endpoint's
	// 100-task cap, so this exercises a second timestamp query chunk.
	importedTasks := make([]*Task, 103)
	for i := range importedTasks {
		importedTasks[i] = &Task{
			Title:       fmt.Sprintf("imported task %d", i),
			Description: fmt.Sprintf("preserved description %d", i),
		}
	}
	importedTasks[len(importedTasks)-1].BucketID = 3
	for _, tc := range []struct {
		name        string
		batch       bool
		importBatch bool
		tasks       []*Task
	}{
		{
			name:  "single creation followed immediately by update",
			tasks: []*Task{{Title: "create then edit", Description: "keep response metadata", IsFavorite: true}},
		},
		{
			name:  "caller supplied creation timestamp",
			tasks: []*Task{{Title: "historical creation", Created: customCreated}},
		},
		{
			name:  "batch includes a task changed by done bucket assignment",
			batch: true,
			tasks: []*Task{{Title: "ordinary batch task"}, {Title: "done on creation", BucketID: 3}},
		},
		{
			name:        "import crosses timestamp query chunk boundary with final done task",
			importBatch: true,
			tasks:       importedTasks,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			events.ClearDispatchedEvents()
			s := db.NewSession()
			defer s.Close()
			actor := &user.User{ID: 1}
			switch {
			case tc.importBatch:
				require.NoError(t, CreateTasksForImport(s, 1, tc.tasks, actor))
			case tc.batch:
				batch := &BulkTaskCreation{ProjectID: 1, Tasks: tc.tasks}
				require.NoError(t, batch.Create(s, actor))
			default:
				tc.tasks[0].ProjectID = 1
				require.NoError(t, tc.tasks[0].Create(s, actor))
			}
			require.NoError(t, s.Commit())
			events.DispatchPending(context.Background(), s)

			read := db.NewReadSession()
			defer read.Close()
			persisted := make(map[int64]*Task, len(tc.tasks))
			for _, created := range tc.tasks {
				stored := &Task{}
				found, err := read.ID(created.ID).Get(stored)
				require.NoError(t, err)
				require.True(t, found)
				persisted[created.ID] = stored
				assert.True(t, created.Created.Equal(stored.Created), "creation response must use persisted Created")
				assert.True(t, created.Updated.Equal(stored.Updated), "creation response must use persisted Updated")
				assert.Equal(t, stored.Done, created.Done)
				assert.Equal(t, stored.Description, created.Description)
				require.NotNil(t, created.CreatedBy)
				assert.Equal(t, actor.ID, created.CreatedBy.ID)
				assert.NotEmpty(t, created.Identifier)
				assert.NotEmpty(t, created.UID)
			}
			switch {
			case tc.batch || tc.importBatch:
				assert.True(t, tc.tasks[len(tc.tasks)-1].Done, "fixture bucket 3 marks a newly created task done")
			case tc.tasks[0].Title == "historical creation":
				assert.NotEqual(t, customCreated.Unix(), tc.tasks[0].Created.Unix(), "Created remains server-managed, ignoring caller input")
			default:
				assert.True(t, tc.tasks[0].IsFavorite, "timestamp refresh must retain response-only metadata")
			}

			// Event pointers must carry the same normalized timestamps as the API
			// response; otherwise event consumers can poison the cache as well.
			createdEvents := events.GetDispatchedEvents((&TaskCreatedEvent{}).Name())
			require.Len(t, createdEvents, len(tc.tasks))
			for _, event := range createdEvents {
				createdEvent, ok := event.(*TaskCreatedEvent)
				require.True(t, ok)
				stored := persisted[createdEvent.Task.ID]
				require.NotNil(t, stored)
				assert.True(t, stored.Created.Equal(createdEvent.Task.Created))
				assert.True(t, stored.Updated.Equal(createdEvent.Task.Updated))
			}

			// No sleep or artificial frontend tolerance: the very next write must
			// not look stale relative to the creation response.
			created := tc.tasks[0]
			creationUpdated := created.Updated
			update := db.NewSession()
			defer update.Close()
			created.Title += " edited immediately"
			require.NoError(t, created.Update(update, actor))
			assert.False(t, created.Updated.Before(creationUpdated), "a subsequent write must not be discarded as stale")
			require.NoError(t, update.Commit())
		})
	}
}
