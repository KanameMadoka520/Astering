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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/web"
	webfiles "github.com/KanameMadoka520/Astering/pkg/web/files"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
	"github.com/mattn/go-sqlite3"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

func init() { AddRouteRegistrar(RegisterProjectVersionRoutes) }

// RegisterProjectVersionRoutes exposes named, immutable project checkpoints through current project permissions.
func RegisterProjectVersionRoutes(api huma.API) {
	op := func(id, method, path, summary, description string) huma.Operation {
		return huma.Operation{
			OperationID:   id,
			Method:        method,
			Path:          path,
			Summary:       summary,
			Description:   description,
			Tags:          []string{"project versions"},
			DefaultStatus: http.StatusOK,
		}
	}
	base := "/projects/{project}/versions"
	Register(api, op("project-versions-list", http.MethodGet, base, "List saved project checkpoints", "Requires current project read access. Public links cannot read history. Only explicit checkpoints and restore checkpoints are recorded; no automatic expiry."), projectVersionsList)
	Register(api, op("project-versions-create", http.MethodPost, base, "Save a named project checkpoint", "Requires current project write permission. Content objects are compressed and deduplicated within the project; originals are referenced without copying bytes. request_id makes retries idempotent."), projectVersionsCreate)
	Register(api, op("project-versions-read", http.MethodGet, base+"/{version}", "Read checkpoint metadata", "Requires current project read access. Contains counts and storage accounting, never account credentials or historical permissions."), projectVersionsRead)
	Register(api, op("project-versions-preview", http.MethodGet, base+"/{version}/preview", "Preview a complete project restore", "Requires current project read access. Returns a paginated diff and stable current_hash/plan_hash for review; no data is modified. Current project administrators alone may apply a conflict-free preview."), projectVersionsPreview)
	Register(api, op("project-versions-restore", http.MethodPost, base+"/{version}/restore", "Restore reviewed project content atomically", "Requires current project administrator permission and an unarchived project. Revalidates hashes and current access. Saves before/after checkpoints in the same transaction; preserves comments, actual routine facts, time entries and current member permissions. request_id retries return the original receipt."), projectVersionsRestore)
	remove := op("project-versions-delete", http.MethodDelete, base+"/{version}", "Delete one checkpoint after confirming its name", "Requires current project administrator permission and an exact confirm_name. Releases only this checkpoint's references; never automatically deletes original files or retained task facts.")
	remove.DefaultStatus = http.StatusNoContent
	Register(api, remove, projectVersionsDelete)
	Register(api, op("project-version-entities-list", http.MethodGet, base+"/{version}/entities", "Browse checkpoint entity metadata", "Requires current project read access. Lists paginated entity indexes without loading all saved content into an agent or browser."), projectVersionEntitiesList)
	Register(api, op("project-version-entity-read", http.MethodGet, base+"/{version}/entities/{kind}/{entity}", "Read one saved entity and its current content", "Requires current project read access. Returns only the requested whitelisted entity. content is null for a current-only entity; current_content is null if it no longer belongs to this project. Does not disclose moved tasks."), projectVersionEntityRead)
	Register(api, op("project-version-file-read", http.MethodGet, base+"/{version}/files/{file}", "Read an original referenced by a checkpoint", "Rechecks current project read access and the exact checkpoint reference before returning bytes or evaluating browser cache validators. Never transfers original file ownership."), projectVersionFileRead)
}

type projectVersionPath struct {
	Project int64 `path:"project" minimum:"1"`
	Version int64 `path:"version" minimum:"1"`
}

func projectVersionAPIError(err error) error {
	if errors.Is(err, context.Canceled) {
		return huma.NewError(499, "Request canceled")
	}
	var versionErr *models.ProjectVersionError
	if errors.As(err, &versionErr) {
		problem := huma.NewError(versionErr.HTTPError().HTTPCode, versionErr.Code)
		if vm, ok := problem.(*vikunjaErrorModel); ok {
			vm.Code = versionErr.HTTPError().Code
		}
		return problem
	}
	return translateDomainError(err)
}
func withProjectVersionSession[T any](ctx context.Context, fn func(*xorm.Session, web.Auth) (*T, error)) (*T, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	out, err := runProjectVersionSessions(ctx, a, db.NewAutocommitSession, fn)
	if err != nil {
		return nil, projectVersionAPIError(err)
	}
	return out, nil
}

// SQLite WAL cannot upgrade an old read snapshot after another request commits.
// Retry only failures inside the callback, with a new transaction and memo each
// time. A commit error is never replayed because its outcome may be uncertain.
// The session factory keeps the same behavior testable against an isolated WAL DB.
func runProjectVersionSessions[T any](ctx context.Context, a web.Auth, newSession func() *xorm.Session, fn func(*xorm.Session, web.Auth) (*T, error)) (*T, error) {
	for attempt := 0; ; attempt++ {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		out, retry, err := projectVersionSessionAttempt(ctx, a, newSession, fn)
		if err == nil {
			return out, nil
		}
		var sqliteErr sqlite3.Error
		if !retry || attempt >= 3 || db.Type() != schemas.SQLITE || !errors.As(err, &sqliteErr) || sqliteErr.Code != sqlite3.ErrBusy {
			return nil, err
		}
		timer := time.NewTimer((25 * time.Millisecond) << attempt)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}

func projectVersionSessionAttempt[T any](ctx context.Context, a web.Auth, newSession func() *xorm.Session, fn func(*xorm.Session, web.Auth) (*T, error)) (*T, bool, error) {
	s := newSession()
	defer func() {
		_ = s.Rollback()
		events.CleanupPending(s)
		_ = s.Close()
	}()
	db.SetSessionContext(ctx, s)
	if err := s.Begin(); err != nil {
		return nil, false, err
	}
	out, err := fn(s, a)
	if err != nil {
		return nil, true, err
	}
	if err := ctx.Err(); err != nil {
		return nil, false, err
	}
	if err = s.Commit(); err != nil {
		return nil, false, err
	}
	events.DispatchPending(ctx, s)
	return out, false, nil
}
func projectVersionsList(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Page    int   `query:"page" default:"1" minimum:"1" maximum:"10000000"`
	PerPage int   `query:"per_page" default:"24" minimum:"1" maximum:"100"`
}) (*singleBody[Paginated[*models.ProjectVersionSummary]], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*Paginated[*models.ProjectVersionSummary], error) {
		items, total, err := models.ListProjectVersions(s, a, in.Project, in.Page, in.PerPage)
		if err != nil {
			return nil, err
		}
		p := NewPaginated(items, total, in.Page, in.PerPage)
		return &p, nil
	})
	return &singleBody[Paginated[*models.ProjectVersionSummary]]{Body: result}, err
}
func projectVersionsCreate(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Body    struct {
		Name      string `json:"name" minLength:"1" maxLength:"160"`
		RequestID string `json:"request_id" minLength:"16" maxLength:"80"`
	}
}) (*singleBody[models.ProjectVersionSummary], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionSummary, error) {
		return models.CreateProjectVersion(s, a, in.Project, in.Body.Name, in.Body.RequestID)
	})
	return &singleBody[models.ProjectVersionSummary]{Body: result}, err
}
func projectVersionsRead(ctx context.Context, in *projectVersionPath) (*singleBody[models.ProjectVersionSummary], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionSummary, error) {
		return models.ReadProjectVersion(s, a, in.Project, in.Version)
	})
	return &singleBody[models.ProjectVersionSummary]{Body: result}, err
}
func projectVersionsPreview(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Version int64 `path:"version" minimum:"1"`
	Page    int   `query:"page" default:"1" minimum:"1" maximum:"10000000"`
	PerPage int   `query:"per_page" default:"50" minimum:"1" maximum:"100"`
}) (*singleBody[models.ProjectVersionPreview], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionPreview, error) {
		return models.PreviewProjectVersion(s, a, in.Project, in.Version, in.Page, in.PerPage)
	})
	return &singleBody[models.ProjectVersionPreview]{Body: result}, err
}
func projectVersionsRestore(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Version int64 `path:"version" minimum:"1"`
	Body    models.ProjectVersionRestoreInput
}) (*singleBody[models.ProjectVersionRestoreResult], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionRestoreResult, error) {
		return models.RestoreProjectVersion(s, a, in.Project, in.Version, in.Body)
	})
	return &singleBody[models.ProjectVersionRestoreResult]{Body: result}, err
}
func projectVersionsDelete(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Version int64 `path:"version" minimum:"1"`
	Body    struct {
		ConfirmName string `json:"confirm_name" minLength:"1" maxLength:"160"`
	}
}) (*emptyBody, error) {
	_, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*struct{}, error) {
		return nil, models.DeleteProjectVersion(s, a, in.Project, in.Version, in.Body.ConfirmName)
	})
	return nil, err
}
func projectVersionEntitiesList(ctx context.Context, in *struct {
	Project int64  `path:"project" minimum:"1"`
	Version int64  `path:"version" minimum:"1"`
	Kind    string `query:"kind" enum:",project,task,view,bucket,attachment,position,announcement,routine,assignee,label,reminder,relation"`
	Page    int    `query:"page" default:"1" minimum:"1" maximum:"10000000"`
	PerPage int    `query:"per_page" default:"50" minimum:"1" maximum:"100"`
}) (*singleBody[Paginated[models.ProjectVersionEntityIndex]], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*Paginated[models.ProjectVersionEntityIndex], error) {
		items, total, err := models.ListProjectVersionEntities(s, a, in.Project, in.Version, in.Kind, in.Page, in.PerPage)
		if err != nil {
			return nil, err
		}
		p := NewPaginated(items, total, in.Page, in.PerPage)
		return &p, nil
	})
	return &singleBody[Paginated[models.ProjectVersionEntityIndex]]{Body: result}, err
}
func projectVersionEntityRead(ctx context.Context, in *struct {
	Project int64  `path:"project" minimum:"1"`
	Version int64  `path:"version" minimum:"1"`
	Kind    string `path:"kind" enum:"project,task,view,bucket,attachment,position,announcement,routine,assignee,label,reminder,relation"`
	Entity  string `path:"entity" minLength:"1" maxLength:"100"`
}) (*singleBody[models.ProjectVersionEntityContent], error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionEntityContent, error) {
		return models.ReadProjectVersionEntity(s, a, in.Project, in.Version, in.Kind, in.Entity)
	})
	return &singleBody[models.ProjectVersionEntityContent]{Body: result}, err
}
func projectVersionFileRead(ctx context.Context, in *struct {
	Project int64 `path:"project" minimum:"1"`
	Version int64 `path:"version" minimum:"1"`
	File    int64 `path:"file" minimum:"1"`
}) (*huma.StreamResponse, error) {
	result, err := withProjectVersionSession(ctx, func(s *xorm.Session, a web.Auth) (*models.ProjectVersionFileDownload, error) {
		return models.ReadProjectVersionFile(s, a, in.Project, in.Version, in.File)
	})
	if err != nil {
		return nil, err
	}
	if err = result.File.LoadFileByID(); err != nil {
		return nil, projectVersionAPIError(err)
	}
	return &huma.StreamResponse{Body: func(hctx huma.Context) {
		defer func() { _ = result.File.File.Close() }()
		ec := humaecho.Unwrap(hctx)
		if webfiles.IsCacheableImage(result.File.Mime) {
			webfiles.PrivateImageCache((*ec).Response())
		}
		webfiles.WriteFileDownload((*ec).Response(), (*ec).Request(), result.File)
	}}, nil
}
