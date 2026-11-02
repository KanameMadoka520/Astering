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

	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/web/handler"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTaskRepeatBucketRoutes) }

func RegisterTaskRepeatBucketRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "task-repeat-bucket-read",
		Summary:     "Read a repeating task's return bucket policy",
		Description: "Requires read access to the task and its manual kanban view. Policies are scoped to one task/view pair, including saved-filter membership. Missing policies return default; they do not change the current placement.",
		Method:      http.MethodGet,
		Path:        "/tasks/{task}/repeat-buckets/{view}",
		Tags:        []string{"tasks"},
	}, taskRepeatBucketRead)
	Register(api, huma.Operation{
		OperationID: "task-repeat-bucket-update",
		Summary:     "Configure where a repeating task returns after completion",
		Description: "Requires write access to the task and view. default retains existing behavior; keep preserves the pre-completion bucket; bucket selects a non-done bucket belonging to this view. Does not enable recurrence or move the task immediately. Deleted targets safely fall back to the view default or current non-done bucket.",
		Method:      http.MethodPut,
		Path:        "/tasks/{task}/repeat-buckets/{view}",
		Tags:        []string{"tasks"},
	}, taskRepeatBucketUpdate)
}

func taskRepeatBucketRead(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
	View int64 `path:"view" minimum:"1"`
}) (*singleBody[models.TaskRepeatBucketPolicy], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	policy := &models.TaskRepeatBucketPolicy{
		TaskID:        in.Task,
		ProjectViewID: in.View,
	}
	if _, err = handler.DoReadOne(ctx, policy, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.TaskRepeatBucketPolicy]{Body: policy}, nil
}

func taskRepeatBucketUpdate(ctx context.Context, in *struct {
	Task int64 `path:"task" minimum:"1"`
	View int64 `path:"view" minimum:"1"`
	Body models.TaskRepeatBucketPolicy
}) (*singleBody[models.TaskRepeatBucketPolicy], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	in.Body.TaskID = in.Task
	in.Body.ProjectViewID = in.View
	if err = handler.DoUpdate(ctx, &in.Body, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.TaskRepeatBucketPolicy]{Body: &in.Body}, nil
}
