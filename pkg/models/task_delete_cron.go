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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/cron"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/log"

	"xorm.io/builder"
)

// TaskDeleteRetention is how long soft-deleted tasks are kept before permanent
// removal. Hard-coded like the user deletion grace period.
const TaskDeleteRetention = 30 * 24 * time.Hour

// RegisterTaskCleanupCron registers the cron job that permanently removes
// tasks which were soft-deleted more than TaskDeleteRetention ago.
func RegisterTaskCleanupCron() {
	err := cron.Schedule("0 * * * *", func() {
		deleteExpiredTasks(time.Now())
	})
	if err != nil {
		log.Errorf("Could not register task cleanup cron: %s", err.Error())
	}
}

func deleteExpiredTasks(now time.Time) {
	s := db.NewSession()
	tasks := []*Task{}
	err := s.Unscoped().
		Where(builder.And(
			builder.NotNull{"deleted_at"},
			builder.Lt{"deleted_at": now.Add(-TaskDeleteRetention)},
		)).
		Find(&tasks)
	s.Close()
	if err != nil {
		log.Errorf("Could not get tasks scheduled for permanent deletion: %s", err)
		return
	}

	if len(tasks) == 0 {
		return
	}

	log.Debugf("Found %d tasks scheduled for permanent deletion", len(tasks))

	for _, task := range tasks {
		func() {
			ts := db.NewSession()
			defer ts.Close()
			defer events.CleanupPending(ts)

			if err = LockProjectsForVersionMutation(ts, task.ProjectID); err != nil {
				log.Errorf("Could not lock task cleanup: %s", err)
				return
			}
			retained, retentionErr := TaskReferencedInProjectVersions(ts, task.ID)
			if retentionErr != nil {
				log.Errorf("Could not check task history retention: %s", retentionErr)
				return
			}
			if retained {
				return
			}
			current := &Task{}
			exists, readErr := routineCurrentRead(ts).Unscoped().ID(task.ID).Get(current)
			if readErr != nil || !exists || current.DeletedAt.IsZero() || !current.DeletedAt.Before(now.Add(-TaskDeleteRetention)) {
				return
			}
			err = hardDeleteTask(ts, current)
			if err != nil {
				_ = ts.Rollback()
				log.Errorf("Could not permanently delete task %d: %s", task.ID, err)
				return
			}

			log.Debugf("Permanently deleted task %d", task.ID)

			err = ts.Commit()
			if err != nil {
				log.Errorf("Could not commit transaction: %s", err)
				return
			}
			events.DispatchPending(context.Background(), ts)
		}()
	}
}
