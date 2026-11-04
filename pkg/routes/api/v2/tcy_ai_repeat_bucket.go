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

package apiv2

import (
	"fmt"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"xorm.io/xorm"
)

func (e *aiExecution) readRepeatBucket(s *xorm.Session, a aiBucketArgs) (any, error) {
	board, err := e.loadBoard(s, a, false)
	if err != nil {
		return nil, err
	}
	policy := &models.TaskRepeatBucketPolicy{
		TaskID:        a.TaskID,
		ProjectViewID: board.view.ID,
	}
	can, _, err := policy.CanRead(s, e.auth)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, tcyai.ToolFailure("FORBIDDEN", "Read access to both the task and its board is required.")
	}
	if err = policy.ReadOne(s, e.auth); err != nil {
		return nil, err
	}
	return policy, nil
}

func (e *aiExecution) planRepeatBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan, preview bool) error {
	current := &models.TaskRepeatBucketPolicy{
		TaskID:        a.TaskID,
		ProjectViewID: plan.board.view.ID,
	}
	can, err := current.CanUpdate(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "This policy requires write access to the task and its board, and the task must belong to the view.")
	}
	if err = current.ReadOne(s, e.auth); err != nil {
		return err
	}
	task, err := models.GetTaskSimple(aiLocking(s, !preview), &models.Task{ID: a.TaskID})
	if err != nil {
		return err
	}
	if err = e.scope(task.ProjectID); err != nil {
		return err
	}
	policy := &models.TaskRepeatBucketPolicy{
		TaskID:               a.TaskID,
		ProjectViewID:        plan.board.view.ID,
		RepeatReturnMode:     a.RepeatReturnMode,
		RepeatReturnBucketID: a.RepeatReturnBucketID,
	}
	if err = policy.Validate(s); err != nil {
		return err
	}
	plan.task = &task
	plan.addProject(task.ProjectID)
	plan.repeatPolicy = policy
	plan.state["policy"] = current
	plan.state["task"] = map[string]any{
		"id":         task.ID,
		"project_id": task.ProjectID,
		"updated":    task.Updated,
	}
	plan.before = []map[string]any{{
		"task_id":                 task.ID,
		"project_id":              task.ProjectID,
		"view_id":                 plan.board.view.ID,
		"repeat_return_mode":      current.RepeatReturnMode,
		"repeat_return_bucket_id": current.RepeatReturnBucketID,
	}}
	plan.after = map[string]any{
		"task_id":                 task.ID,
		"view_id":                 plan.board.view.ID,
		"repeat_return_mode":      policy.RepeatReturnMode,
		"repeat_return_bucket_id": policy.RepeatReturnBucketID,
	}
	return nil
}

func (e *aiExecution) applyRepeatBucket(s *xorm.Session, plan *aiBucketPlan) (map[string]any, error) {
	policy := plan.repeatPolicy
	if err := policy.Update(s, e.auth); err != nil {
		return nil, err
	}
	actual := &models.TaskRepeatBucketPolicy{
		TaskID:        policy.TaskID,
		ProjectViewID: policy.ProjectViewID,
	}
	if err := actual.ReadOne(s, e.auth); err != nil {
		return nil, err
	}
	if actual.RepeatReturnMode != policy.RepeatReturnMode || actual.RepeatReturnBucketID != policy.RepeatReturnBucketID {
		return nil, aiVerifyFailed(fmt.Sprintf("The repeat return policy for task %d did not match its prepared settings.", policy.TaskID))
	}
	task := &models.Task{ID: policy.TaskID}
	if err := task.ReadOne(s, e.auth); err != nil {
		return nil, err
	}
	return map[string]any{
		"task":          task,
		"repeat_bucket": actual,
	}, nil
}
