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
	"errors"
	"net/http"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/web"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTaskOrderRoutes) }

func RegisterTaskOrderRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "project-view-task-order-list",
		Summary:     "Read a view's saved manual task order",
		Description: "Pure paginated read; missing positions sort as zero then task ID and are not created. Supports real-project list/table and a selected manual-kanban bucket; supports unfiltered and done=true/false views. Complex filters/search, saved filters and Gantt are explicitly unsupported. This is saved manual order, not the browser's current sort choice.",
		Method:      http.MethodGet,
		Path:        "/projects/{project}/views/{view}/task-order",
		Tags:        []string{"tasks"},
	}, taskOrderList)
	Register(api, huma.Operation{
		OperationID:   "project-view-task-order-update",
		Summary:       "Atomically reorder a block of tasks within one view",
		Description:   "Uses real adjacent task IDs and an optimistic order version, never model-guessed float positions. The selected tasks must belong to the same visible scope and bucket. Requires task write access and view read access. Retains unselected relative order, other buckets, task dates, completion and relations. Returns every changed per-view position, including any one-time spacing repair; does not change browser sort settings.",
		Method:        http.MethodPost,
		DefaultStatus: http.StatusOK,
		Path:          "/projects/{project}/views/{view}/task-order",
		Tags:          []string{"tasks"},
	}, taskOrderUpdate)
}

func taskOrderHTTPError(err error) error {
	var orderErr *models.TaskOrderError
	if !errors.As(err, &orderErr) {
		return translateDomainError(err)
	}
	switch orderErr.Code {
	case "STATE_CONFLICT", "VERIFY_FAILED":
		return huma.Error409Conflict(orderErr.Message)
	case "NOT_FOUND":
		return huma.Error404NotFound(orderErr.Message)
	default:
		return huma.Error400BadRequest(orderErr.Message)
	}
}

func taskOrderList(ctx context.Context, in *struct {
	ProjectID int64 `path:"project" minimum:"1"`
	ViewID    int64 `path:"view" minimum:"1"`
	BucketID  int64 `query:"bucket_id" minimum:"0" default:"0" doc:"Positive real bucket ID for manual kanban; zero for list/table."`
	Page      int   `query:"page" minimum:"1" maximum:"10000000" default:"1"`
}) (*struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.TaskOrderPage
}, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	snapshot, err := models.ReadTaskViewOrder(s, a, models.TaskOrderScope{
		ProjectID: in.ProjectID,
		ViewID:    in.ViewID,
		BucketID:  in.BucketID,
	})
	if err != nil {
		return nil, taskOrderHTTPError(err)
	}
	page, err := snapshot.Page(s, in.Page)
	if err != nil {
		return nil, taskOrderHTTPError(err)
	}
	return &struct {
		CacheControl string `header:"Cache-Control"`
		Body         *models.TaskOrderPage
	}{
		CacheControl: "private, no-store",
		Body:         page,
	}, nil
}

func applyTaskOrder(ctx context.Context, a web.Auth, scope models.TaskOrderScope, change models.TaskOrderChange) (*models.TaskOrderResult, error) {
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	result, err := models.ReorderTaskView(ctx, s, a, scope, change)
	if err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = s.Commit(); err != nil {
		return nil, &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "The commit result is uncertain. Read the actual task order before retrying.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	return result, nil
}

func taskOrderUpdate(ctx context.Context, in *struct {
	ProjectID int64 `path:"project" minimum:"1"`
	ViewID    int64 `path:"view" minimum:"1"`
	Body      models.TaskOrderChange
}) (*singleBody[models.TaskOrderResult], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	result, err := applyTaskOrder(ctx, a, models.TaskOrderScope{
		ProjectID: in.ProjectID,
		ViewID:    in.ViewID,
		BucketID:  in.Body.BucketID,
	}, in.Body)
	if err != nil {
		return nil, taskOrderHTTPError(err)
	}
	return &singleBody[models.TaskOrderResult]{Body: result}, nil
}
