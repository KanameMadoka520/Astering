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
	"net/http"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/web/handler"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTaskRoutineRoutes) }
func RegisterTaskRoutineRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "task-routine-read", Summary: "Read period configuration and current progress", Description: "Requires task read access. Calendar state uses the routine's IANA timezone. An unconfigured task returns enabled=false and the reader's effective timezone. This response is time-dependent and is not conditionally cached by task.updated.", Method: http.MethodGet, Path: "/tasks/{task}/routine", Tags: []string{"tasks"}}, taskRoutineRead)
	Register(api, huma.Operation{OperationID: "task-routine-update", Summary: "Configure a shared calendar routine", Description: "Requires task write access and an unarchived project. Supply the current revision. Enabling requires an open task without ordinary repeats; settings never silently modify done/repeat/date fields. Disabling or pausing retains check-in history. Returns the complete updated task.", Method: http.MethodPut, Path: "/tasks/{task}/routine", Tags: []string{"tasks"}}, taskRoutineUpdate)
	Register(api, huma.Operation{OperationID: "task-routine-check-in", Summary: "Complete or undo the current shared period", Description: "Idempotent per task/current calendar period. Requires write access, an enabled/unpaused routine and date equal to the server's current period start date. Nonlegacy schedules also require the current configuration revision. Stale-period or stale-revision requests return 409. completed=false undoes the current period only; task.done, dates and reminders are unchanged. Returns the complete task and current period state.", Method: http.MethodPost, Path: "/tasks/{task}/routine/check-in", DefaultStatus: http.StatusOK, Tags: []string{"tasks"}}, taskRoutineCheckin)
	Register(api, huma.Operation{OperationID: "task-routine-history", Summary: "Browse recorded routine completions and quota periods", Description: "Requires task read access. Returns the selected calendar month's actual check-ins, total check-ins and calendar-day streaks. Each entry keeps its recorded timezone and actor. No past completions are inferred from task.done or repeat_after; disabling retains history.", Method: http.MethodGet, Path: "/tasks/{task}/routine/history", Tags: []string{"tasks"}}, taskRoutineHistory)
	Register(api, huma.Operation{
		OperationID:   "task-routine-progress",
		Summary:       "Set the current routine period's absolute progress",
		Description:   "Requires task write access and an enabled, unpaused routine in an unarchived project. date and revision must match the current server period and configuration. Amount is absolute, so retries never increment twice. Calendar rollover is computed without modifying past periods or task.done.",
		Method:        http.MethodPost,
		Path:          "/tasks/{task}/routine/progress",
		DefaultStatus: http.StatusOK,
		Tags:          []string{"tasks"},
	}, taskRoutineProgress)

}
func taskRoutineRead(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
}) (*singleBody[models.TaskRoutine], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	r := &models.TaskRoutine{TaskID: in.Task}
	if _, err = handler.DoReadOne(ctx, r, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.TaskRoutine]{Body: r}, nil
}
func taskRoutineUpdate(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
	Body models.TaskRoutine
}) (*singleBody[models.Task], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	in.Body.TaskID = in.Task
	if err = handler.DoUpdate(ctx, &in.Body, a); err != nil {
		return nil, translateDomainError(err)
	}
	t := &models.Task{ID: in.Task}
	if _, err = handler.DoReadOne(ctx, t, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.Task]{Body: t}, nil
}
func taskRoutineCheckin(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
	Body struct {
		Date      string `json:"date" required:"true" pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}$" doc:"The current date returned by task.routine; do not compute it in the browser's timezone."`
		Revision  *int64 `json:"revision,omitempty" minimum:"0" doc:"Expected configuration revision; required for non-default calendars or quotas."`
		Completed bool   `json:"completed" required:"true" doc:"True completes the current period; false undoes its completion."`
	}
}) (*singleBody[models.Task], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	var revision []int64
	if in.Body.Revision != nil {
		revision = append(revision, *in.Body.Revision)
	}
	t, err := models.SetTaskRoutineCheckin(s, a, in.Task, in.Body.Date, in.Body.Completed, revision...)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	events.DispatchPending(ctx, s)
	return &singleBody[models.Task]{Body: t}, nil
}
func taskRoutineHistory(ctx context.Context, in *struct {
	Task  int64 `path:"task" minimum:"1"`
	Year  int   `query:"year" minimum:"1970" maximum:"9998" required:"true"`
	Month int   `query:"month" minimum:"1" maximum:"12" required:"true"`
}) (*singleBody[models.TaskRoutineHistory], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	h, err := models.GetTaskRoutineHistory(s, a, in.Task, in.Year, in.Month)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.TaskRoutineHistory]{Body: h}, nil
}

func taskRoutineProgress(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
	Body struct {
		Date     string `json:"date" required:"true" pattern:"^[0-9]{4}-[0-9]{2}-[0-9]{2}$" doc:"Current period date returned by the server, not the browser calendar date."`
		Revision int64  `json:"revision" required:"true" minimum:"0" doc:"Configuration revision read with the current period."`
		Amount   int64  `json:"amount" required:"true" minimum:"0" maximum:"9007199254740991" doc:"Absolute quantity for this period; it is not an increment."`
	}
}) (*singleBody[models.Task], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	t, err := models.SetTaskRoutineProgress(s, a, in.Task, in.Body.Date, in.Body.Revision, in.Body.Amount)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	events.DispatchPending(ctx, s)
	return &singleBody[models.Task]{Body: t}, nil
}
