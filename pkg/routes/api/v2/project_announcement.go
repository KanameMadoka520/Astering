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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/web/handler"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/conditional"
)

func init() { AddRouteRegistrar(RegisterProjectAnnouncementRoutes) }
func RegisterProjectAnnouncementRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "project-announcement-read", Summary: "Read a project's pinned announcement", Description: "Requires project read access, including inherited/team/link-share access. An unset announcement returns empty content and revision 0. It is not public outside project permissions.", Method: http.MethodGet, Path: "/projects/{project}/announcement", Tags: []string{"projects"}}, projectAnnouncementRead)
	Register(api, huma.Operation{OperationID: "project-announcement-update", Summary: "Save or clear a project's announcement", Description: "Requires project write access and an unarchived project. Send the last read revision; concurrent changes return 409 without overwriting the draft. Empty title and content clear the notice while preserving its revision. Independent of project.description.", Method: http.MethodPut, Path: "/projects/{project}/announcement", Tags: []string{"projects"}}, projectAnnouncementUpdate)
}

// Explicit DTO keeps model methods out of Huma's reflected schema-link wrapper.
type projectAnnouncementBody struct {
	ProjectID     int64             `json:"project_id" readOnly:"true"`
	Title         string            `json:"title" maxLength:"160"`
	Content       string            `json:"content" maxLength:"65536"`
	Revision      int64             `json:"revision" minimum:"0"`
	Updated       time.Time         `json:"updated" readOnly:"true"`
	UpdatedByID   int64             `json:"updated_by_id" readOnly:"true"`
	MaxPermission models.Permission `json:"max_permission" readOnly:"true" doc:"Current permission: 0 read, 1 write, 2 admin."`
}

func projectAnnouncementRead(ctx context.Context, in *struct {
	Project int64  `path:"project" minimum:"1"`
	Format  string `query:"format" enum:"html,markdown"`
	conditional.Params
}) (*singleReadBody[projectAnnouncementBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	n := &models.ProjectAnnouncement{ProjectID: in.Project}
	permission, err := handler.DoReadOne(ctx, n, a)
	if err != nil {
		return nil, translateDomainError(err)
	}
	convertToMarkdown(ctx, &n.Content)
	return conditionalRepresentationResponse(&in.Params, &projectAnnouncementBody{ProjectID: n.ProjectID, Title: n.Title, Content: n.Content, Revision: n.Revision, Updated: n.Updated, UpdatedByID: n.UpdatedByID, MaxPermission: models.Permission(permission)})
}
func projectAnnouncementUpdate(ctx context.Context, in *struct {
	Project int64  `path:"project" minimum:"1"`
	Format  string `query:"format" enum:"html,markdown"`
	Body    projectAnnouncementBody
}) (*singleBody[models.ProjectAnnouncement], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	n := &models.ProjectAnnouncement{ProjectID: in.Project, Title: in.Body.Title, Content: in.Body.Content, Revision: in.Body.Revision}
	if err = convertToHTML(ctx, &n.Content); err != nil {
		return nil, translateDomainError(err)
	}
	if err = handler.DoUpdate(ctx, n, a); err != nil {
		return nil, translateDomainError(err)
	}
	convertToMarkdown(ctx, &n.Content)
	return &singleBody[models.ProjectAnnouncement]{Body: n}, nil
}
