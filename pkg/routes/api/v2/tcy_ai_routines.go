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
	"context"
	"encoding/json"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
)

func (e *aiExecution) prepareAnnouncement(ctx context.Context, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{Units: 1, After: string(raw)}
	var a struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return op, err
	}
	if err := e.scope(a.ID); err != nil {
		return op, err
	}
	data, err := e.read(ctx, "get_project_announcement", map[string]any{"id": a.ID})
	if err != nil {
		return op, err
	}
	var before map[string]any
	if err = json.Unmarshal([]byte(data), &before); err != nil {
		return op, err
	}
	op.ProjectIDs = []int64{a.ID}
	op.Before, op.Version, err = aiSnapshotVersion([]map[string]any{before})
	return op, err
}

func (e *aiExecution) mutateAnnouncement(ctx context.Context, raw json.RawMessage) (string, error) {
	var a struct {
		ID       int64  `json:"id"`
		Title    string `json:"title"`
		Content  string `json:"content"`
		Revision int64  `json:"revision"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return "", err
	}
	if err := e.scope(a.ID); err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	n := &models.ProjectAnnouncement{ProjectID: a.ID, Title: a.Title, Content: a.Content, Revision: a.Revision}
	// The model locks the parent, rechecks write access/archive, and compares revision atomically.
	if err := n.Update(s, e.auth); err != nil {
		return "", err
	}
	if err := ctx.Err(); err != nil {
		return "", err
	}
	if err := s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Database commit failed; read the announcement before retrying.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	if op := tcyai.CurrentOperation(ctx); op != nil {
		op.Verified = true
	}
	return marshalAI(n)
}

func (e *aiExecution) mutateRoutine(ctx context.Context, name string, raw json.RawMessage, preview tcyai.Operation) (string, error) {
	changes, err := aiChanges(name, raw)
	if err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	if _, err = e.lockTasks(ctx, s, changes, name, preview); err != nil {
		return "", err
	}
	id := changes[0].ID
	var task *models.Task
	switch name {
	case "configure_task_routine":
		var r models.TaskRoutine
		if err = json.Unmarshal(raw, &r); err != nil {
			return "", err
		}
		r.TaskID = id
		if err = r.Update(s, e.auth); err != nil {
			return "", err
		}
		task = &models.Task{ID: id}
		if err = task.ReadOne(s, e.auth); err != nil {
			return "", err
		}
	case "check_in_task_routine":
		var a struct {
			Date      string `json:"date"`
			Revision  int64  `json:"revision"`
			Completed bool   `json:"completed"`
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return "", err
		}
		task, err = models.SetTaskRoutineCheckin(s, e.auth, id, a.Date, a.Completed, a.Revision)
		if err != nil {
			return "", err
		}
	default:
		var a struct {
			Date     string `json:"date"`
			Revision int64  `json:"revision"`
			Amount   int64  `json:"amount"`
		}
		if err = json.Unmarshal(raw, &a); err != nil {
			return "", err
		}
		task, err = models.SetTaskRoutineProgress(s, e.auth, id, a.Date, a.Revision, a.Amount)
		if err != nil {
			return "", err
		}
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Database commit failed; check the routine before retrying.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	if op := tcyai.CurrentOperation(ctx); op != nil {
		op.Verified = true
	}
	return marshalAI(task)
}
