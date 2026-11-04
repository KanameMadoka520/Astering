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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterProjectHistoryRoutes) }
func RegisterProjectHistoryRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "project-history", Summary: "Browse yearly project milestones", Description: "Project-level completion and archive history, including archived projects, restricted to currently accessible projects. Statistics use the requested timezone. Reopening preserves previous milestones. Legacy archives have an unknown date. Detail records are paginated, 24 per page. Scope counts describe the current accessible projects matching project/search filters, independently of year, event kind and pagination. Task completion does not implicitly complete a project.", Method: http.MethodGet, Path: "/projects/history", Tags: []string{"projects"}}, projectHistory)
	Register(api, huma.Operation{OperationID: "project-completion", Summary: "Complete or reopen a project", Description: "Requires project administration. Sets project completion independently from archive state, tasks and child projects. Records an immutable milestone in the same transaction. Repeating the same state is idempotent.", Method: http.MethodPost, Path: "/projects/{project}/completion", Tags: []string{"projects"}}, projectCompletion)
}

func projectHistory(ctx context.Context, in *struct {
	Year     int    `query:"year" minimum:"1970" maximum:"9998" required:"true"`
	Timezone string `query:"timezone" default:"UTC" doc:"IANA timezone for calendar boundaries."`
	Project  int64  `query:"project" minimum:"0" default:"0"`
	Kind     string `query:"kind" enum:"milestones,all,completed,archived,reopened,unarchived" default:"milestones"`
	Day      string `query:"day" doc:"Optional YYYY-MM-DD within the selected year."`
	Unknown  bool   `query:"unknown" default:"false" doc:"Show legacy undated records instead of the selected year."`
	Q        string `query:"q" maxLength:"250" doc:"Search project titles."`
	Page     int    `query:"page" minimum:"1" maximum:"10000000" default:"1"`
}) (*singleBody[models.ProjectHistory], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	result, err := models.GetProjectHistory(s, a, models.ProjectHistoryOptions{Year: in.Year, Timezone: in.Timezone, ProjectID: in.Project, Kind: in.Kind, Day: in.Day, Unknown: in.Unknown, Search: in.Q, Page: in.Page})
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.ProjectHistory]{Body: result}, nil
}

func projectCompletion(ctx context.Context, in *struct {
	ID   int64 `path:"project" minimum:"1"`
	Body struct {
		Completed bool `json:"completed" doc:"True marks the project complete; false reopens it. Task states remain unchanged."`
	}
}) (*singleBody[models.Project], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	if err = s.Begin(); err != nil {
		return nil, err
	}
	result, err := models.SetProjectCompleted(s, a, in.ID, in.Body.Completed)
	if err != nil {
		_ = s.Rollback()
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.Project]{Body: result}, nil
}
