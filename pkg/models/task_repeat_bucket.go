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

	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// TaskRepeatBucketPolicy configures a task's existing task/view relation, not a second placement table.
type TaskRepeatBucketPolicy struct {
	TaskID               int64  `xorm:"-" json:"task_id" readOnly:"true" doc:"Task identified by the endpoint path."`
	ProjectViewID        int64  `xorm:"-" json:"project_view_id" readOnly:"true" doc:"Manual kanban view identified by the endpoint path."`
	RepeatReturnMode     string `xorm:"-" json:"repeat_return_mode" enum:"default,keep,bucket" doc:"default follows the view's default bucket; keep preserves the pre-completion bucket; bucket uses repeat_return_bucket_id."`
	RepeatReturnBucketID int64  `xorm:"-" json:"repeat_return_bucket_id" minimum:"0" doc:"A non-done bucket in this view when mode is bucket; otherwise zero."`
	web.CRUDable         `xorm:"-" json:"-"`
	web.Permissions      `xorm:"-" json:"-"`
}

func (p *TaskRepeatBucketPolicy) view(s *xorm.Session) (*ProjectView, error) {
	view := &ProjectView{}
	exists, err := s.ID(p.ProjectViewID).Get(view)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, &ErrProjectViewDoesNotExist{ProjectViewID: p.ProjectViewID}
	}
	if view.ViewKind != ProjectViewKindKanban || view.BucketConfigurationMode != BucketConfigurationModeManual {
		return nil, InvalidFieldErrorWithMessage([]string{"project_view_id"}, "Repeat return policies require a manual kanban view")
	}
	return view, nil
}

func (p *TaskRepeatBucketPolicy) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	can, permission, err := (&Task{ID: p.TaskID}).CanRead(s, a)
	if err != nil || !can {
		return false, permission, err
	}
	view, err := p.view(s)
	if err != nil {
		return false, 0, err
	}
	can, viewPermission, err := view.CanRead(s, a)
	if err != nil || !can {
		return false, 0, err
	}
	can, err = taskFitsView(s, a, view, p.TaskID)
	return can, min(permission, viewPermission), err
}

func (p *TaskRepeatBucketPolicy) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	can, err := (&Task{ID: p.TaskID}).CanWrite(s, a)
	if err != nil || !can {
		return false, err
	}
	view, err := p.view(s)
	if err != nil {
		return false, err
	}
	can, err = canWriteBucketProject(s, view.ProjectID, a)
	if err != nil || !can {
		return false, err
	}
	return taskFitsView(s, a, view, p.TaskID)
}

func (p *TaskRepeatBucketPolicy) ReadOne(s *xorm.Session, _ web.Auth) error {
	row := &TaskBucket{}
	_, err := s.Where("task_id = ? AND project_view_id = ?", p.TaskID, p.ProjectViewID).Get(row)
	if err != nil {
		return err
	}
	p.RepeatReturnMode = row.RepeatReturnMode
	if p.RepeatReturnMode == "" {
		p.RepeatReturnMode = "default"
	}
	p.RepeatReturnBucketID = row.RepeatReturnBucketID
	return nil
}

// Validate checks the proposed policy without changing task placement or timestamps.
func (p *TaskRepeatBucketPolicy) Validate(s *xorm.Session) error {
	view, err := p.view(s)
	if err != nil {
		return err
	}
	if p.RepeatReturnMode != "default" && p.RepeatReturnMode != "keep" && p.RepeatReturnMode != "bucket" {
		return InvalidFieldErrorWithMessage([]string{"repeat_return_mode"}, "Use default, keep, or bucket")
	}
	if p.RepeatReturnMode == "bucket" {
		target := &Bucket{}
		exists, err := s.Where("id = ? AND project_view_id = ?", p.RepeatReturnBucketID, view.ID).Get(target)
		if err != nil {
			return err
		}
		if !exists || target.ID == view.DoneBucketID {
			return InvalidFieldErrorWithMessage([]string{"repeat_return_bucket_id"}, "Use a non-done bucket belonging to this view")
		}
	} else if p.RepeatReturnBucketID != 0 {
		return InvalidFieldErrorWithMessage([]string{"repeat_return_bucket_id"}, "A return bucket is only valid in bucket mode")
	}
	return nil
}

func (p *TaskRepeatBucketPolicy) Update(s *xorm.Session, a web.Auth) error {
	if _, err := GetTaskSimple(lockingSession(s), &Task{ID: p.TaskID}); err != nil {
		return err
	}
	view, err := p.view(s)
	if err != nil {
		return err
	}
	if _, err = lockProjectViewsForPositionUpdate(s, view.ProjectID); err != nil {
		return err
	}
	can, err := p.CanUpdate(s, a)
	if err != nil {
		return err
	}
	if !can {
		return ErrGenericForbidden{}
	}
	if err = p.Validate(s); err != nil {
		return err
	}
	row := &TaskBucket{}
	exists, err := s.Where("task_id = ? AND project_view_id = ?", p.TaskID, view.ID).Get(row)
	if err != nil {
		return err
	}
	if !exists {
		var bucketID int64
		bucketID, err = getDefaultBucketID(s, view)
		if err != nil {
			return err
		}
		row = &TaskBucket{
			TaskID:               p.TaskID,
			ProjectViewID:        view.ID,
			BucketID:             bucketID,
			RepeatReturnMode:     p.RepeatReturnMode,
			RepeatReturnBucketID: p.RepeatReturnBucketID,
		}
		_, err = s.Insert(row)
	} else {
		_, err = s.Where("task_id = ? AND project_view_id = ?", p.TaskID, view.ID).
			Cols("repeat_return_mode", "repeat_return_bucket_id").
			Update(&TaskBucket{
				RepeatReturnMode:     p.RepeatReturnMode,
				RepeatReturnBucketID: p.RepeatReturnBucketID,
			})
	}
	if err != nil {
		return err
	}
	task := &Task{
		ID:      p.TaskID,
		Updated: time.Now(),
	}
	if err = updateTaskLastUpdated(s, task); err != nil {
		return err
	}
	if err = task.ReadOne(s, a); err != nil {
		return err
	}
	events.DispatchOnCommit(s, &TaskUpdatedEvent{
		Task: task,
		Doer: doerFromAuth(s, a),
	})
	return nil
}

// ResolveTaskRepeatBucket also serves agent previews, so verification uses the same fallback as writes.
func ResolveTaskRepeatBucket(s *xorm.Session, view *ProjectView, row *TaskBucket) (int64, error) {
	if row.RepeatReturnMode == "keep" && row.BucketID > 0 && row.BucketID != view.DoneBucketID {
		return row.BucketID, nil
	}
	if row.RepeatReturnMode == "bucket" && row.RepeatReturnBucketID != view.DoneBucketID {
		exists, err := s.Where("id = ? AND project_view_id = ?", row.RepeatReturnBucketID, view.ID).Exist(&Bucket{})
		if err != nil {
			return 0, err
		}
		if exists {
			return row.RepeatReturnBucketID, nil
		}
	}
	if view.DefaultBucketID != 0 && view.DefaultBucketID != view.DoneBucketID {
		return view.DefaultBucketID, nil
	}
	if row.BucketID > 0 && row.BucketID != view.DoneBucketID {
		return row.BucketID, nil
	}
	// A historic task may already be in Done, or its return bucket was deleted.
	bucket := &Bucket{}
	exists, err := s.Where("project_view_id = ? AND id != ?", view.ID, view.DoneBucketID).
		OrderBy("COALESCE(position, 0) asc, id asc").Get(bucket)
	if err != nil {
		return 0, err
	}
	if !exists {
		// A manual view is initially empty until its first kanban read creates
		// buckets. Completing a repeat from another view must not initialize it.
		if row.BucketID == 0 && view.DefaultBucketID == 0 && view.DoneBucketID == 0 {
			return 0, nil
		}
		return 0, ErrCannotRemoveLastBucket{ProjectViewID: view.ID}
	}
	return bucket.ID, nil
}
