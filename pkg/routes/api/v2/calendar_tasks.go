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
	"code.vikunja.io/api/pkg/models"
	"github.com/danielgtaylor/huma/v2"
)

// CalendarTasksResponse is the standard pagination envelope plus authoritative day boundaries.
type CalendarTasksResponse struct {
	Paginated[models.CalendarTask]
	Timezone string                       `json:"timezone" doc:"Effective IANA timezone, defaulting to the authenticated user's stored timezone."`
	From     string                       `json:"from" doc:"Inclusive civil YYYY-MM-DD date."`
	To       string                       `json:"to" doc:"Exclusive civil YYYY-MM-DD date."`
	Days     []models.CalendarDayBoundary `json:"days" doc:"All requested local days and exact instant boundaries, independent of pagination."`
}

func init() { AddRouteRegistrar(RegisterCalendarTaskRoutes) }

func RegisterCalendarTaskRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "tasks-calendar",
		Summary:     "List tasks with actual dates in a calendar window",
		Description: "Read-only minimal projection of accessible tasks. The interval is 1–62 civil days in the selected IANA timezone, with an exclusive to date. A valid explicit start/end span overlapping the window or any start/end/due point within it qualifies, including reversed ranges' valid points. No durations, all-day intent or future recurring instances are invented. Archived projects are excluded by default. Unauthorized project filters return an empty page. Each task appears once in stable ID order; day boundaries remain complete on every page. Skipped civil dates are rejected.",
		Method:      http.MethodGet,
		Path:        "/tasks/calendar",
		Tags:        []string{"tasks"},
	}, calendarTasks)
}

func calendarTasks(ctx context.Context, in *struct {
	ListParams
	From            string `query:"from" required:"true" doc:"Inclusive civil YYYY-MM-DD, not an ISO timestamp."`
	To              string `query:"to" required:"true" doc:"Exclusive civil YYYY-MM-DD, at most 62 calendar days after from."`
	Timezone        string `query:"timezone" doc:"IANA timezone; omitted uses the account's timezone (server timezone for a link share)."`
	ProjectID       int64  `query:"project_id" minimum:"0" default:"0" doc:"0 or omitted means all accessible projects; a positive ID selects one project without expanding subprojects."`
	Done            string `query:"done" enum:"all,open,done" default:"open"`
	IncludeArchived bool   `query:"include_archived" default:"false"`
}) (*struct {
	CacheControl string `header:"Cache-Control"`
	Body         CalendarTasksResponse
}, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	projection, err := models.GetCalendarTasks(s, a, models.CalendarOptions{
		From:            in.From,
		To:              in.To,
		Timezone:        in.Timezone,
		ProjectID:       in.ProjectID,
		Done:            in.Done,
		IncludeArchived: in.IncludeArchived,
		Page:            in.Page,
		PerPage:         in.PerPage,
	})
	if err != nil {
		var invalid *models.CalendarInputError
		if errors.As(err, &invalid) {
			return nil, huma.Error400BadRequest(invalid.Error())
		}
		return nil, translateDomainError(err)
	}
	return &struct {
		CacheControl string `header:"Cache-Control"`
		Body         CalendarTasksResponse
	}{
		CacheControl: "private, no-store",
		Body: CalendarTasksResponse{
			Paginated: NewPaginated(projection.Items, projection.Total, in.Page, in.PerPage),
			Timezone:  projection.Timezone,
			From:      projection.From,
			To:        projection.To,
			Days:      projection.Days,
		},
	}, nil
}
