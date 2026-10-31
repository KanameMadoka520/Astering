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
	"code.vikunja.io/api/pkg/models"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterProjectTimelineRoutes) }

func RegisterProjectTimelineRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "project-timeline", Summary: "Review scheduled project coverage and current progress", Description: "Read-only rollup of explicit task start and end/due dates, grouped by direct project. Explicit due dates also appear as independent nodes, even without a complete range; no start date or duration is invented. Invalid ranges are excluded from coverage but do not hide valid due nodes. Undated and incomplete tasks are counted separately. Created/updated dates are never substituted. Accessible archived projects are included by default. Year-wide statistics are independent of day selection and pagination; rows are 24 projects per page. Elapsed scheduled days do not represent work logs; progress is the current mean of eligible task progress, not historical progress.", Method: http.MethodGet, Path: "/projects/timeline", Tags: []string{"projects"}}, projectTimeline)
}

func projectTimeline(ctx context.Context, in *struct {
	Year     int    `query:"year" minimum:"1970" maximum:"9998" required:"true"`
	Timezone string `query:"timezone" default:"UTC" doc:"IANA timezone for all inclusive calendar boundaries."`
	Project  int64  `query:"project" minimum:"0" default:"0"`
	Status   string `query:"status" enum:"all,active,completed,archived" default:"all"`
	Q        string `query:"q" maxLength:"250" doc:"Search project titles."`
	Day      string `query:"day" doc:"Filter project rows by a covered date or due-date node in the selected year; statistics remain year-wide."`
	Page     int    `query:"page" minimum:"1" maximum:"10000000" default:"1"`
}) (*singleBody[models.ProjectTimeline], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	result, err := models.GetProjectTimeline(s, a, models.ProjectTimelineOptions{Year: in.Year, Timezone: in.Timezone, ProjectID: in.Project, Status: in.Status, Search: in.Q, Day: in.Day, Page: in.Page})
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.ProjectTimeline]{Body: result}, nil
}
