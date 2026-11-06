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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/web"

	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// TaskBucket represents the relation between a task and a kanban bucket.
// A task can only appear once per project view which is ensured by a
// unique index on the combination of task_id and project_view_id.
type TaskBucket struct {
	BucketID int64   `xorm:"bigint not null index" json:"bucket_id" param:"bucket" doc:"The bucket to move the task into. On /api/v2 this is taken from the URL; a value in the body is ignored."`
	Bucket   *Bucket `xorm:"-" json:"bucket" readOnly:"true" doc:"The resolved target bucket, including its updated task count."`
	// The task which belongs to the bucket. Together with ProjectViewID
	// this field is part of a unique index to prevent duplicates.
	TaskID int64 `xorm:"bigint not null index unique(task_view)" json:"task_id" doc:"The id of the task to place in the bucket."`
	// The view this bucket belongs to. Combined with TaskID this forms a
	// unique index.
	ProjectViewID        int64  `xorm:"bigint not null index unique(task_view)" json:"project_view_id" param:"view" doc:"The view the bucket belongs to. On /api/v2 this is taken from the URL; a value in the body is ignored."`
	RepeatReturnMode     string `xorm:"varchar(10) not null default 'default'" json:"repeat_return_mode" readOnly:"true" doc:"Repeating task return policy for this view: default, keep, or bucket. Configure through the repeat-buckets endpoint."`
	RepeatReturnBucketID int64  `xorm:"bigint not null default 0" json:"repeat_return_bucket_id" readOnly:"true" doc:"Return bucket when repeat_return_mode is bucket; belongs to this view and is not its done bucket."`
	ProjectID            int64  `xorm:"-" json:"-" param:"project"`
	Task                 *Task  `xorm:"-" json:"task" readOnly:"true" doc:"The task as it stands after the move, reflecting any done-state change."`

	web.Permissions `xorm:"-" json:"-"`
	web.CRUDable    `xorm:"-" json:"-"`
}

func (b *TaskBucket) TableName() string {
	return "task_buckets"
}

func (b *TaskBucket) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	bucket := Bucket{
		ID:            b.BucketID,
		ProjectID:     b.ProjectID,
		ProjectViewID: b.ProjectViewID,
	}
	view, err := bucket.getOwnView(s)
	if err != nil {
		return false, err
	}
	can, err := canWriteBucketProject(s, view.ProjectID, a)
	if err != nil || !can {
		return false, err
	}

	// The task comes from the request body and may live in a different
	// project than the bucket, so it needs its own write check.
	task := &Task{ID: b.TaskID}
	can, err = task.CanWrite(s, a)
	if err != nil || !can {
		return false, err
	}

	return taskFitsView(s, a, view, b.TaskID)
}

func (b *TaskBucket) upsert(s *xorm.Session) (err error) {
	// A native upsert moves the task in one atomic statement, without
	// depending on the affected-row count (MySQL/MariaDB report 0 affected
	// rows for an unchanged value).
	onConflict := "ON CONFLICT (task_id, project_view_id) DO UPDATE SET bucket_id = excluded.bucket_id"
	if db.Type() == schemas.MYSQL {
		onConflict = "ON DUPLICATE KEY UPDATE bucket_id = VALUES(bucket_id)"
	}

	// Raw SQL bypasses xorm's bean-based table-name handling, so qualify the
	// table ourselves to honor a configured postgres schema (database.schema).
	table := s.Engine().TableName(b, true)
	query := "INSERT INTO " + table + " (task_id, project_view_id, bucket_id) VALUES (?, ?, ?) " + onConflict
	_, err = s.Exec(query, b.TaskID, b.ProjectViewID, b.BucketID)
	return
}

// updateTaskBucket is internally used to actually do the update.
func updateTaskBucket(s *xorm.Session, a web.Auth, b *TaskBucket) (err error) {
	if err := lockAuthorizedTasksForProjectMutation(s, a, []int64{b.TaskID}); err != nil {
		return err
	}

	oldTaskBucket := &TaskBucket{}
	_, err = routineCurrentRead(s).
		Where("task_id = ? AND project_view_id = ?", b.TaskID, b.ProjectViewID).
		Get(oldTaskBucket)
	if err != nil {
		return
	}

	if oldTaskBucket.BucketID == b.BucketID {
		// no need to do anything
		return
	}

	view, err := GetProjectViewByIDAndProject(routineCurrentRead(s), b.ProjectViewID, b.ProjectID)
	if err != nil {
		return err
	}

	bucket, err := getBucketByID(routineCurrentRead(s), b.BucketID)
	if err != nil {
		return err
	}

	// If there is a bucket set, make sure they belong to the same project as the task
	if view.ID != bucket.ProjectViewID {
		return ErrBucketDoesNotBelongToProjectView{
			ProjectViewID: view.ID,
			BucketID:      bucket.ID,
		}
	}

	task := &Task{ID: b.TaskID}
	err = task.ReadOne(s, a)
	if err != nil {
		return err
	}
	// ReadOne hydrates the response's related data, but its ordinary read can
	// come from a MySQL view established before waiting for the project gate.
	// Reload persisted fields for recurrence/Done calculations from current data.
	exists, err := routineCurrentRead(s).ID(task.ID).NoAutoCondition().Get(task)
	if err != nil {
		return err
	}
	if !exists {
		return ErrTaskDoesNotExist{ID: task.ID}
	}

	var updateBucket = true

	// mark task done if moved into or out of the done bucket
	// Only change the done state if the task's done value actually changes
	var doneChanged bool
	if view.DoneBucketID != 0 {
		if view.DoneBucketID == b.BucketID && !task.Done {
			doneChanged = true
			task.Done = true
			if task.isRepeating() {
				oldTask := *task
				oldTask.Done = false
				updateDone(&oldTask, task)
				b.BucketID, err = ResolveTaskRepeatBucket(s, view, oldTaskBucket)
				if err != nil {
					return err
				}
				// The task is already in the correct bucket, so there is
				// nothing to move and no count to bump.
				if b.BucketID == oldTaskBucket.BucketID {
					updateBucket = false
				}
			}
		}

		if oldTaskBucket.BucketID == view.DoneBucketID && task.Done && b.BucketID != view.DoneBucketID {
			doneChanged = true
			task.Done = false
		}
	}

	// Recurrence may redirect a Done move; validate and report its actual destination.
	if bucket.ID != b.BucketID {
		bucket, err = getBucketByID(routineCurrentRead(s), b.BucketID)
		if err != nil {
			return err
		}
	}
	if b.BucketID != 0 && b.BucketID != oldTaskBucket.BucketID {
		taskCount, err := checkBucketLimit(s, a, task, bucket, view, 0)
		if err != nil {
			return err
		}
		bucket.Count = taskCount
	}

	if doneChanged {
		if err = persistTaskBucketDoneState(s, task, view); err != nil {
			return err
		}
	}

	if updateBucket {
		err = b.upsert(s)
		if err != nil {
			return
		}
		bucket.Count++
	}

	b.Task = task
	b.Bucket = bucket

	return
}

func persistTaskBucketDoneState(s *xorm.Session, task *Task, view *ProjectView) (err error) {
	if task.Done {
		task.DoneAt = time.Now()
	} else {
		task.DoneAt = time.Time{}
	}
	_, err = s.Where("id = ?", task.ID).
		Cols(
			"done",
			"due_date",
			"start_date",
			"end_date",
			"done_at",
		).
		Update(task)
	if err != nil {
		return
	}

	if err = validateTaskRoutineState(s, task); err != nil {
		return err
	}

	err = task.updateReminders(s, task)
	if err != nil {
		return
	}

	// Since the done state of the task was changed, we need to move the task into all done buckets everywhere
	if task.Done {
		viewsWithDoneBucket := []*ProjectView{}
		err = routineCurrentRead(s).
			Where("project_id = ? AND view_kind = ? AND bucket_configuration_mode = ? AND id != ? AND done_bucket_id != 0",
				view.ProjectID, ProjectViewKindKanban, BucketConfigurationModeManual, view.ID).
			Find(&viewsWithDoneBucket)
		if err != nil {
			return
		}
		for _, v := range viewsWithDoneBucket {
			newBucket := &TaskBucket{
				TaskID:        task.ID,
				ProjectViewID: v.ID,
				BucketID:      v.DoneBucketID,
			}
			err = newBucket.upsert(s)
			if err != nil {
				return
			}
		}
	}

	return nil
}

// Update is the handler to update a task bucket
// @Summary Update a task bucket
// @Description Updates a task in a bucket
// @tags task
// @Accept json
// @Produce json
// @Security JWTKeyAuth
// @Param project path int true "Project ID"
// @Param view path int true "Project View ID"
// @Param bucket path int true "Bucket ID"
// @Param taskBucket body models.TaskBucket true "The id of the task you want to move into the bucket."
// @Success 200 {object} models.TaskBucket "The updated task bucket."
// @Failure 400 {object} web.HTTPError "Invalid task bucket object provided."
// @Failure 500 {object} models.Message "Internal error"
// @Router /projects/{project}/views/{view}/buckets/{bucket}/tasks [post]
func (b *TaskBucket) Update(s *xorm.Session, a web.Auth) (err error) {
	// Bound from the body; a no-op move would otherwise dispatch the client's task object.
	b.Task = nil
	b.Bucket = nil
	err = updateTaskBucket(s, a, b)
	if err != nil {
		return err
	}

	if b.Task != nil {
		events.DispatchOnCommit(s, &TaskUpdatedEvent{
			Task: b.Task,
			Doer: doerFromAuth(s, a),
		})
	}
	return nil
}
