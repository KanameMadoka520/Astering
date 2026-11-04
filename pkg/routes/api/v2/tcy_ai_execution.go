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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package apiv2

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"slices"
	"sort"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/danielgtaylor/huma/v2"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// aiExecution never retains an Echo context. Business permission checks are repeated for every operation.
type aiExecution struct {
	api    huma.API
	caller *http.Request
	auth   web.Auth
	input  tcyai.RunInput
}

func newAIExecution(ctx context.Context, api huma.API, caller *http.Request, input tcyai.RunInput) (*aiExecution, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	return &aiExecution{api: api, caller: caller, auth: a, input: input}, nil
}
func (e *aiExecution) scope(pid int64) error {
	if len(e.input.WriteProjectIDs) > 0 && !slices.Contains(e.input.WriteProjectIDs, pid) {
		return tcyai.ToolFailure("SCOPE_DENIED", "The target project is outside this run's explicit write scope.")
	}
	return nil
}
func (e *aiExecution) read(ctx context.Context, name string, args any) (string, error) {
	raw, err := json.Marshal(args)
	if err != nil {
		return "", err
	}
	return dispatchAI(ctx, e.api, e.caller, name, raw)
}

type aiChange struct {
	ID      int64                      `json:"id"`
	Changes map[string]json.RawMessage `json:"changes"`
}

func aiChanges(name string, raw json.RawMessage) ([]aiChange, error) {
	if name == "bulk_update_tasks" {
		var a struct {
			Updates []aiChange `json:"updates"`
		}
		err := json.Unmarshal(raw, &a)
		if err != nil {
			return nil, err
		}
		seen := map[int64]bool{}
		for _, u := range a.Updates {
			if seen[u.ID] {
				return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "Bulk targets must have distinct IDs.")
			}
			seen[u.ID] = true
		}
		sort.Slice(a.Updates, func(i, j int) bool { return a.Updates[i].ID < a.Updates[j].ID })
		return a.Updates, nil
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil {
		return nil, err
	}
	var id int64
	_ = json.Unmarshal(args["id"], &id)
	delete(args, "id")
	return []aiChange{{ID: id, Changes: args}}, nil
}

// Use the same stable representation for HTTP previews and locked database reads.
func aiTaskSnapshot(raw []byte) (map[string]any, error) {
	var task map[string]any
	if err := json.Unmarshal(raw, &task); err != nil {
		return nil, err
	}
	out := map[string]any{}
	for _, k := range []string{"id", "project_id", "title", "description", "due_date", "start_date", "end_date", "all_day", "all_day_start", "all_day_end", "priority", "done", "hex_color", "percent_done", "is_favorite", "repeat_after", "repeat_mode", "cover_image_attachment_id", "updated", "routine"} {
		out[k] = task[k]
	}
	// Row IDs may change; an equal trigger time can still have a different rescheduling anchor.
	reminders := []string{}
	if rs, ok := task["reminders"].([]any); ok {
		for _, r := range rs {
			if m, ok := r.(map[string]any); ok {
				anchor, err := json.Marshal([]any{
					m["reminder"],
					m["relative_to"],
					m["relative_period"],
				})
				if err != nil {
					return nil, err
				}
				reminders = append(reminders, string(anchor))
			}
		}
	}
	sort.Strings(reminders)
	out["reminders"] = reminders
	return out, nil
}
func aiSnapshotVersion(before []map[string]any) (string, string, error) {
	raw, err := json.Marshal(before)
	return string(raw), fmt.Sprintf("%x", sha256.Sum256(raw)), err
}
func isAIProjectMutation(name string) bool {
	return name == "update_project" || name == "set_project_completed"
}

// prepareDirectTool validates the current human session before direct model-backed
// tools bypass the internal HTTP dispatcher.
func (e *aiExecution) prepareDirectTool(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	if _, err := serveAITool(ctx, e.api, e.caller, "validate_session", "/user", http.MethodGet, nil, nil); err != nil {
		return tcyai.Operation{}, err
	}
	if tcyai.IsChatImageTool(name) {
		return e.prepareChatImage(ctx, name, raw)
	}
	if tcyai.IsCompassTool(name) {
		return e.prepareCompass(ctx, name, raw)
	}
	if name == "reorder_view_tasks" {
		return e.prepareTaskOrder(ctx, raw)
	}
	if name == "list_view_tasks" {
		return tcyai.Operation{Units: 1}, nil
	}
	return e.prepareBucket(ctx, name, raw)
}

func isAIDirectTool(name string) bool {
	return tcyai.IsCompassTool(name) || tcyai.IsChatImageTool(name) || tcyai.IsBucketTool(name) || tcyai.IsTaskOrderTool(name)
}

func (e *aiExecution) prepare(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	if _, err := tcyai.ValidateTool(name, raw, e.input); err != nil {
		return tcyai.Operation{}, err
	}
	if isAIDirectTool(name) {
		return e.prepareDirectTool(ctx, name, raw)
	}
	op := tcyai.Operation{Units: 1, ProjectIDs: []int64{}, After: string(raw)}
	if !tcyai.IsWriteTool(name) {
		return op, nil
	}
	if name == "update_project_announcement" {
		return e.prepareAnnouncement(ctx, raw)
	}
	if isAIProjectMutation(name) {
		return e.prepareProject(ctx, raw, op)
	}
	if name == "create_project" || name == "create_label" {
		if len(e.input.WriteProjectIDs) > 0 {
			return op, tcyai.ToolFailure("SCOPE_DENIED", "Account-wide creation is unavailable while a project write scope is selected.")
		}
		op.Before = "null"
		return op, nil
	}
	if name == "create_task" {
		var a struct {
			ProjectID int64 `json:"project_id"`
		}
		_ = json.Unmarshal(raw, &a)
		if err := e.scope(a.ProjectID); err != nil {
			return op, err
		}
		data, err := e.read(ctx, "get_project", map[string]any{"id": a.ProjectID})
		if err != nil {
			return op, err
		}
		var p map[string]any
		_ = json.Unmarshal([]byte(data), &p)
		op.Before, _ = marshalAI(map[string]any{"project_id": a.ProjectID, "project_title": p["title"]})
		op.ProjectIDs = []int64{a.ProjectID}
		return op, nil
	}
	changes, err := aiChanges(name, raw)
	if err != nil {
		return op, err
	}
	before := []map[string]any{}
	for _, change := range changes {
		data, err := e.read(ctx, "get_task", map[string]any{"id": change.ID})
		if err != nil {
			return op, err
		}
		task, err := aiTaskSnapshot([]byte(data))
		if err != nil {
			return op, err
		}
		pid := int64(task["project_id"].(float64))
		if err = e.scope(pid); err != nil {
			return op, err
		}
		if destination, ok := change.Changes["project_id"]; ok {
			var target int64
			if err = json.Unmarshal(destination, &target); err != nil {
				return op, err
			}
			if err = e.scope(target); err != nil {
				return op, err
			}
			if _, err = e.read(ctx, "get_project", map[string]any{"id": target}); err != nil {
				return op, err
			}
			if !slices.Contains(op.ProjectIDs, target) {
				op.ProjectIDs = append(op.ProjectIDs, target)
			}
		}
		before = append(before, task)
		if !slices.Contains(op.ProjectIDs, pid) {
			op.ProjectIDs = append(op.ProjectIDs, pid)
		}
	}
	// Relations affect both ends, so both projects must fall in the explicit scope and be readable.
	if name == "relate_tasks" || name == "unrelate_tasks" {
		var a struct {
			Other int64 `json:"other_task_id"`
		}
		_ = json.Unmarshal(raw, &a)
		data, err := e.read(ctx, "get_task", map[string]any{"id": a.Other})
		if err != nil {
			return op, err
		}
		task, err := aiTaskSnapshot([]byte(data))
		if err != nil {
			return op, err
		}
		pid := int64(task["project_id"].(float64))
		if err = e.scope(pid); err != nil {
			return op, err
		}
		before = append(before, task)
		if !slices.Contains(op.ProjectIDs, pid) {
			op.ProjectIDs = append(op.ProjectIDs, pid)
		}
	}
	op.Units = len(changes)
	op.Before, op.Version, err = aiSnapshotVersion(before)
	return op, err
}
func marshalAI(value any) (string, error) { raw, err := json.Marshal(value); return string(raw), err }
func (e *aiExecution) execute(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	if _, err := tcyai.ValidateTool(name, raw, e.input); err != nil {
		return "", err
	}
	if tcyai.IsCompassTool(name) {
		if _, err := serveAITool(ctx, e.api, e.caller, "validate_session", "/user", http.MethodGet, nil, nil); err != nil {
			return "", err
		}
		return e.executeCompass(ctx, name, raw)
	}
	if tcyai.IsTaskOrderTool(name) {
		if _, err := serveAITool(ctx, e.api, e.caller, "validate_session", "/user", http.MethodGet, nil, nil); err != nil {
			return "", err
		}
		return e.executeTaskOrder(ctx, name, raw)
	}

	if tcyai.IsChatImageTool(name) {
		if _, err := serveAITool(ctx, e.api, e.caller, "validate_session", "/user", http.MethodGet, nil, nil); err != nil {
			return "", err
		}
		return e.executeChatImage(ctx, name, raw)
	}
	if tcyai.IsBucketTool(name) {
		if _, err := serveAITool(ctx, e.api, e.caller, "validate_session", "/user", http.MethodGet, nil, nil); err != nil {
			return "", err
		}
		return e.executeBucket(ctx, name, raw)
	}
	if !tcyai.IsWriteTool(name) {
		return dispatchAI(ctx, e.api, e.caller, name, raw)
	}
	// Revalidate the current JWT and project scope even for a resumed operation.
	preview, err := e.prepare(ctx, name, raw)
	if err != nil {
		return "", err
	}
	op := tcyai.CurrentOperation(ctx)
	if op != nil && op.Version != "" && preview.Version != op.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The task changed after preparation. Read the current task and prepare a fresh operation.")
	}
	if name == "configure_task_routine" || name == "check_in_task_routine" || name == "set_task_routine_progress" {
		return e.mutateRoutine(ctx, name, raw, preview)
	}
	if name == "update_project_announcement" {
		return e.mutateAnnouncement(ctx, raw)
	}
	if isAIProjectMutation(name) {
		return e.mutateProject(ctx, name, raw, preview)
	}
	if name == "update_task" || name == "bulk_update_tasks" || name == "delete_task" {
		return e.mutateTasks(ctx, name, raw, preview)
	}
	return dispatchAI(ctx, e.api, e.caller, name, raw)
}
func (e *aiExecution) mutateTasks(ctx context.Context, name string, raw json.RawMessage, preview tcyai.Operation) (string, error) {
	changes, err := aiChanges(name, raw)
	if err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	tasks, err := e.lockTasks(ctx, s, changes, name, preview)
	if err != nil {
		return "", err
	}
	output := []*models.Task{}
	for _, change := range changes {
		if name == "delete_task" {
			if err = tasks[change.ID].Delete(s, e.auth); err != nil {
				return "", err
			}
			continue
		}
		data, err := json.Marshal(change.Changes)
		if err != nil {
			return "", err
		}
		values := &models.Task{}
		if err = json.Unmarshal(data, values); err != nil {
			return "", err
		}
		old := tasks[change.ID]
		start, end := old.StartDate, old.EndDate
		if _, ok := change.Changes["start_date"]; ok {
			start = values.StartDate
		}
		if _, ok := change.Changes["end_date"]; ok {
			end = values.EndDate
		}
		if !start.IsZero() && !end.IsZero() && end.Before(start) {
			return "", tcyai.ToolFailure("INVALID_DATE_RANGE", "End time must be at or after start time.")
		}
		fields := []string{}
		for field := range change.Changes {
			fields = append(fields, field)
		}
		sort.Strings(fields)
		bulk := &models.BulkTask{TaskIDs: []int64{change.ID}, Fields: fields, Values: values}
		can, err := bulk.CanUpdate(s, e.auth)
		if err != nil {
			return "", err
		}
		if !can {
			return "", tcyai.ToolFailure("FORBIDDEN", "Current project permissions deny this change.")
		}
		if err = bulk.Update(s, e.auth); err != nil {
			return "", err
		}
		// Return the actual business-model result, including recurring-task normalization, rather than echoing the proposal.
		output = append(output, bulk.Tasks...)
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Database commit failed; check actual task state before retrying.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	if op := tcyai.CurrentOperation(ctx); op != nil {
		op.Verified = true
	}
	if name == "delete_task" {
		return `{"success":true,"deleted":true}`, nil
	}
	if len(output) == 1 && name == "update_task" {
		return marshalAI(output[0])
	}
	return marshalAI(output)
}

func (e *aiExecution) lockTasks(ctx context.Context, s *xorm.Session, changes []aiChange, name string, preview tcyai.Operation) (map[int64]*models.Task, error) {
	var expected []struct {
		ID        int64 `json:"id"`
		ProjectID int64 `json:"project_id"`
	}
	if json.Unmarshal([]byte(preview.Before), &expected) != nil {
		return nil, tcyai.ToolFailure("STATE_CONFLICT", "The task preview is unavailable. Read the tasks again.")
	}
	sourceProjects := make(map[int64]int64, len(expected))
	for _, item := range expected {
		sourceProjects[item.ID] = item.ProjectID
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := models.LockProjectViewsForTaskMutation(s, preview.ProjectIDs...); err != nil {
		return nil, err
	}
	var err error
	before := []map[string]any{}
	tasks := map[int64]*models.Task{}
	for _, change := range changes {
		if err = ctx.Err(); err != nil {
			return nil, err
		}
		if db.Type() == schemas.SQLITE {
			if _, err = s.NoAutoTime().ID(change.ID).Cols("id").Update(&models.Task{ID: change.ID}); err != nil {
				return nil, err
			}
		}
		locking := s
		if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
			locking = s.ForUpdate()
		}
		task, err := models.GetTaskSimple(locking, &models.Task{ID: change.ID})
		if err != nil {
			return nil, err
		}
		if expectedPID, ok := sourceProjects[task.ID]; !ok || expectedPID != task.ProjectID {
			return nil, tcyai.ToolFailure("STATE_CONFLICT", "The task moved before its lock was acquired. Read the current task again.")
		}
		if err = e.scope(task.ProjectID); err != nil {
			return nil, err
		}
		can, err := task.CanUpdate(s, e.auth)
		if name == "delete_task" {
			can, err = task.CanDelete(s, e.auth)
		}
		if err != nil {
			return nil, err
		}
		if !can {
			return nil, tcyai.ToolFailure("FORBIDDEN", "Current project permissions deny this operation.")
		}
		currentTask := task
		if err = task.ReadOne(s, e.auth); err != nil {
			return nil, err
		}
		// Hydration may use an older RR snapshot. Keep the locked task columns authoritative.
		currentTask.Reminders = task.Reminders
		currentTask.Routine = task.Routine
		currentTask.IsFavorite = task.IsFavorite
		task = currentTask
		data, err := json.Marshal(task)
		if err != nil {
			return nil, err
		}
		snapshot, err := aiTaskSnapshot(data)
		if err != nil {
			return nil, err
		}
		before = append(before, snapshot)
		tasks[change.ID] = &task
	}
	_, version, err := aiSnapshotVersion(before)
	if err != nil {
		return nil, err
	}
	if version != preview.Version {
		return nil, tcyai.ToolFailure("STATE_CONFLICT", "The task changed before the transaction obtained its lock. Read the current state before retrying.")
	}
	return tasks, nil
}

func aiProjectSnapshot(raw []byte) (map[string]any, error) {
	var project map[string]any
	if err := json.Unmarshal(raw, &project); err != nil {
		return nil, err
	}
	out := map[string]any{}
	for _, key := range []string{"id", "title", "description", "hex_color", "is_favorite", "identifier", "parent_project_id", "is_archived", "is_completed", "completed_at", "updated"} {
		out[key] = project[key]
	}
	return out, nil
}

// Lock, merge and recheck business permissions in one transaction, preserving unrelated fields.
func (e *aiExecution) mutateProject(ctx context.Context, name string, raw json.RawMessage, preview tcyai.Operation) (string, error) {
	var args struct {
		ID        int64 `json:"id"`
		Completed bool  `json:"completed"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	locking := s
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		locking = s.ForUpdate()
	}
	project := &models.Project{ID: args.ID}
	exists, err := locking.ID(args.ID).Get(project)
	if err != nil {
		return "", err
	}
	if !exists {
		return "", tcyai.ToolFailure("NOT_FOUND", "Project no longer exists.")
	}
	if err = project.ReadOne(s, e.auth); err != nil {
		return "", err
	}
	data, err := json.Marshal(project)
	if err != nil {
		return "", err
	}
	snapshot, err := aiProjectSnapshot(data)
	if err != nil {
		return "", err
	}
	_, version, err := aiSnapshotVersion([]map[string]any{snapshot})
	if err != nil {
		return "", err
	}
	if version != preview.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "Project changed; read it and prepare a fresh operation.")
	}
	if name == "set_project_completed" {
		project, err = models.SetProjectCompleted(s, e.auth, args.ID, args.Completed)
		if err != nil {
			return "", err
		}
	} else {
		if err = json.Unmarshal(raw, project); err != nil {
			return "", err
		}
		can, err := project.CanUpdate(s, e.auth)
		if err != nil {
			return "", err
		}
		if !can {
			return "", tcyai.ToolFailure("FORBIDDEN", "Current project permissions deny this change.")
		}
		if err = project.Update(s, e.auth); err != nil {
			return "", err
		}
		if err = project.ReadOne(s, e.auth); err != nil {
			return "", err
		}
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Database commit failed; inspect project before retrying.", Uncertain: true}
	}
	if op := tcyai.CurrentOperation(ctx); op != nil {
		op.Verified = true
	}
	return marshalAI(project)
}

func (e *aiExecution) prepareProject(ctx context.Context, raw json.RawMessage, op tcyai.Operation) (tcyai.Operation, error) {
	var a struct {
		ID int64 `json:"id"`
	}
	if err := json.Unmarshal(raw, &a); err != nil {
		return op, err
	}
	if err := e.scope(a.ID); err != nil {
		return op, err
	}
	data, err := e.read(ctx, "get_project", map[string]any{"id": a.ID})
	if err != nil {
		return op, err
	}
	project, err := aiProjectSnapshot([]byte(data))
	if err != nil {
		return op, err
	}
	op.ProjectIDs = []int64{a.ID}
	op.Before, op.Version, err = aiSnapshotVersion([]map[string]any{project})
	return op, err

}
