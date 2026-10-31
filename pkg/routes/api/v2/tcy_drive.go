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
	"bytes"
	"context"
	"errors"
	"io"
	"net/http"
	"strings"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/models"
	backgroundHandler "code.vikunja.io/api/pkg/modules/background/handler"
	"code.vikunja.io/api/pkg/modules/humabridge"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	webfiles "code.vikunja.io/api/pkg/web/files"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
	"xorm.io/xorm"
)

func init() { AddRouteRegistrar(RegisterDriveRoutes) }

type driveBody struct{ Body *files.DriveFile }
type driveListBody struct {
	Body struct {
		Files      []*files.DriveFile `json:"files"`
		Total      int64              `json:"total"`
		Bytes      int64              `json:"bytes"`
		Categories []string           `json:"categories"`
	}
}
type DriveID struct {
	ID int64 `path:"file"`
}

func driveAuth(ctx context.Context) (web.Auth, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	u, err := user.GetFromAuth(a)
	if err != nil || u.ID <= 0 {
		return nil, huma.Error403Forbidden("forbidden")
	}
	return a, nil
}
func driveError(err error) error {
	if errors.Is(err, models.ErrDriveMissing) {
		return huma.Error404NotFound(err.Error())
	}
	if errors.Is(err, models.ErrDriveChanged) || errors.Is(err, models.ErrDriveTrashed) || errors.Is(err, models.ErrDriveInUse) || errors.Is(err, models.ErrDriveChatUnreadable) || errors.Is(err, models.ErrDriveConfirm) {
		return huma.Error409Conflict(err.Error())
	}
	return translateDomainError(err)
}
func driveCommit(ctx context.Context, s *xorm.Session) error {
	if err := s.Commit(); err != nil {
		return err
	}
	events.DispatchPending(ctx, s)
	return nil
}
func RegisterDriveRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Tags: []string{"drive"}, DefaultStatus: http.StatusOK}
	}
	Register(api, op("drive-list", "GET", "/drive/files", "List files owned by the current user"), driveList)
	Register(api, withUploadLimits(op("drive-upload", "POST", "/drive/files", "Upload a reusable personal file")), driveUpload)
	Register(api, op("drive-usages", "GET", "/drive/files/{file}/usages", "List usages without disclosing inaccessible tasks or projects"), func(ctx context.Context, in *DriveID) (*struct{ Body []models.DriveUsage }, error) {
		a, err := driveAuth(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewReadSession()
		defer s.Close()
		if _, err = models.GetDriveItem(s, a, in.ID); err != nil {
			return nil, driveError(err)
		}
		list := models.DriveUsages
		// AI conversations are for human sessions only; tokens see them as restricted.
		if ec := humabridge.EchoContextFrom(ctx); ec == nil || (*ec).Get("api_token") != nil {
			list = models.DriveUsagesForAPIToken
		}
		usages, err := list(s, a, in.ID)
		if err != nil {
			return nil, driveError(err)
		}
		return &struct{ Body []models.DriveUsage }{Body: usages}, nil
	})
	Register(api, op("drive-change", "PATCH", "/drive/files/{file}", "Edit, trash, restore or permanently delete an unreferenced recycled file"), func(ctx context.Context, in *struct {
		DriveID
		Body models.DriveChange
	}) (*driveBody, error) {
		a, err := driveAuth(ctx)
		if err != nil {
			return nil, err
		}
		// Before the transaction: a purge may scan AI conversations for a while.
		models.PrepareDriveChange(a, in.ID, &in.Body)
		s := db.NewSession()
		defer s.Close()
		defer events.CleanupPending(s)
		d, err := models.ChangeDriveItem(s, a, in.ID, in.Body)
		if err != nil {
			return nil, driveError(err)
		}
		if err = driveCommit(ctx, s); err != nil {
			return nil, driveError(err)
		}
		if d.Purging {
			if err = files.FinishDrivePurge(d.FileID); err != nil {
				return nil, huma.Error500InternalServerError("drive_purge_retry")
			}
		}
		return &driveBody{Body: d}, nil
	})
	Register(api, op("drive-attach", "POST", "/drive/files/{file}/attach", "Attach an active owned file to a writable task without copying its blob"), func(ctx context.Context, in *struct {
		DriveID
		Body struct {
			Revision int64 `json:"revision" minimum:"1"`
			TaskID   int64 `json:"task_id" minimum:"1"`
		}
	}) (*singleBody[models.TaskAttachment], error) {
		a, err := driveAuth(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewSession()
		defer s.Close()
		defer events.CleanupPending(s)
		ta, err := models.AttachDriveFile(s, a, in.ID, in.Body.Revision, in.Body.TaskID)
		if err != nil {
			return nil, driveError(err)
		}
		if err = driveCommit(ctx, s); err != nil {
			return nil, driveError(err)
		}
		return &singleBody[models.TaskAttachment]{Body: ta}, nil
	})
	Register(api, op("drive-cover", "POST", "/drive/files/{file}/cover", "Use an owned raster image as a project background without copying it"), driveCover)
	download := op("drive-download", "GET", "/drive/files/{file}/download", "Download an owned file including recycled files")
	download.Responses = map[string]*huma.Response{"200": {Description: "File bytes", Content: map[string]*huma.MediaType{"application/octet-stream": {Schema: &huma.Schema{Type: huma.TypeString, Format: "binary"}}}}}
	preview := op("drive-preview", "GET", "/drive/files/{file}/preview", "Render a bounded raster thumbnail of an owned image")
	preview.Responses = download.Responses
	Register(api, preview, func(ctx context.Context, in *DriveID) (*huma.StreamResponse, error) {
		a, err := driveAuth(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewReadSession()
		defer s.Close()
		d, err := models.GetDriveItem(s, a, in.ID)
		if err != nil {
			return nil, driveError(err)
		}
		preview, err := (&models.TaskAttachment{File: d.File}).GetPreview(ctx, files.PreviewSmall)
		if err != nil {
			return nil, translateDomainError(err)
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			defer preview.Close()
			c := humaecho.Unwrap(hctx)
			webfiles.WriteAttachmentPreview((*c).Response(), preview)
		}}, nil
	})
	Register(api, download, func(ctx context.Context, in *DriveID) (*huma.StreamResponse, error) {
		a, err := driveAuth(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewReadSession()
		defer s.Close()
		d, err := models.GetDriveItem(s, a, in.ID)
		if err != nil {
			return nil, driveError(err)
		}
		if err = d.File.LoadFileByID(); err != nil {
			return nil, driveError(err)
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			defer d.File.File.Close()
			c := humaecho.Unwrap(hctx)
			(*c).Response().Header().Set("Cache-Control", "private, no-store")
			(*c).Response().Header().Set("X-Content-Type-Options", "nosniff")
			webfiles.WriteFileDownload((*c).Response(), (*c).Request(), d.File)
		}}, nil
	})
}
func driveList(ctx context.Context, in *struct {
	Page     int    `query:"page" default:"1" minimum:"1"`
	Search   string `query:"search" maxLength:"255"`
	Category string `query:"category" maxLength:"120"`
	Trash    bool   `query:"trash"`
	Pinned   bool   `query:"pinned"`
	Images   bool   `query:"images"`
}) (*driveListBody, error) {
	a, err := driveAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	result := &driveListBody{}
	result.Body.Files = []*files.DriveFile{}
	result.Body.Categories = []string{}
	q := s.Table("drive_files").Join("INNER", "files", "files.id = drive_files.file_id").Where("drive_files.owner_id = ?", a.GetID())
	if in.Trash {
		q = q.Where("drive_files.trashed_at IS NOT NULL AND drive_files.trashed_at > ?", "1971-01-01")
	} else {
		q = q.Where("drive_files.trashed_at IS NULL OR drive_files.trashed_at < ?", "1971-01-01")
	}
	if in.Search != "" {
		q = q.Where("LOWER(files.name) LIKE ?", "%"+strings.ToLower(in.Search)+"%")
	}
	if in.Category != "" {
		q = q.Where("drive_files.category = ?", in.Category)
	}
	if in.Pinned {
		q = q.Where("drive_files.pinned = ?", true)
	}
	if in.Images {
		q = q.Where("files.mime LIKE ?", "image/%")
	}
	result.Body.Total, err = q.Select("drive_files.*").OrderBy("drive_files.pinned DESC, drive_files.file_id DESC").Limit(60, (in.Page-1)*60).FindAndCount(&result.Body.Files)
	if err != nil {
		return nil, driveError(err)
	}
	for _, d := range result.Body.Files {
		d.File = &files.File{ID: d.FileID}
		if err = d.File.LoadFileMetaByID(s); err != nil {
			return nil, driveError(err)
		}
	}
	if err = s.Table("drive_files").Where("owner_id = ? AND category <> ?", a.GetID(), "").Distinct("category").Find(&result.Body.Categories); err != nil {
		return nil, driveError(err)
	}
	sum, err := s.Table("files").Join("INNER", "drive_files", "files.id = drive_files.file_id").Where("drive_files.owner_id = ?", a.GetID()).SumInt(&files.File{}, "files.size")
	if err != nil {
		return nil, driveError(err)
	}
	result.Body.Bytes = sum
	return result, nil
}

type driveUploadInput struct {
	RawBody huma.MultipartFormFiles[struct {
		File huma.FormFile `form:"file" required:"true"`
	}]
}

func driveUpload(ctx context.Context, in *driveUploadInput) (*driveBody, error) {
	a, err := driveAuth(ctx)
	if err != nil {
		return nil, err
	}
	upload := in.RawBody.Data().File
	defer upload.Close()
	s := db.NewSession()
	defer s.Close()
	f, err := files.CreateWithSession(s, upload, upload.Filename, uint64(upload.Size), a)
	if err != nil {
		return nil, driveError(err)
	}
	committed := false
	defer func() {
		if !committed {
			_ = files.DeleteBlob(f.ID)
		}
	}()
	if err = files.AddToDrive(s, f); err != nil {
		return nil, driveError(err)
	}
	d, err := models.GetDriveItem(s, a, f.ID)
	if err != nil {
		return nil, driveError(err)
	}
	if err = driveCommit(ctx, s); err != nil {
		return nil, driveError(err)
	}
	committed = true
	return &driveBody{Body: d}, nil
}
func driveCover(ctx context.Context, in *struct {
	DriveID
	Body struct {
		Revision  int64 `json:"revision" minimum:"1"`
		ProjectID int64 `json:"project_id" minimum:"1"`
	}
}) (*singleBody[models.Project], error) {
	a, err := driveAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	d, err := models.LockDriveItem(s, a, in.ID, in.Body.Revision)
	if err != nil {
		return nil, driveError(err)
	}
	if !d.TrashedAt.IsZero() || d.Purging {
		return nil, driveError(models.ErrDriveTrashed)
	}
	// Chat uploads may exceed files.maxsize; project backgrounds may not.
	if files.ExceedsUploadLimit(d.File.Size) {
		return nil, translateDomainError(files.ErrFileIsTooLarge{Size: d.File.Size})
	}
	p, err := writableProjectForBackground(s, a, in.Body.ProjectID)
	if err != nil {
		return nil, err
	}
	if err = d.File.LoadFileByID(); err != nil {
		return nil, driveError(err)
	}
	defer d.File.File.Close()
	// Validate actual decoded raster bytes; SVG/HTML must never become an executable background.
	raw, err := io.ReadAll(io.LimitReader(d.File.File, 50*1024*1024+1))
	if err != nil {
		return nil, driveError(err)
	}
	if len(raw) > 50*1024*1024 {
		return nil, huma.Error413RequestEntityTooLarge("image exceeds 50 MiB")
	}
	if _, err = backgroundHandler.PreparePreservedBackground(ctx, bytes.NewReader(raw), d.File.Name); err != nil {
		return nil, translateBackgroundUploadError(err)
	}
	if err = p.DeleteBackgroundFileIfExists(s); err != nil {
		return nil, driveError(err)
	}
	if err = models.SetProjectBackground(s, p.ID, d.File, ""); err != nil {
		return nil, driveError(err)
	}
	if err = p.ReadOne(s, a); err != nil {
		return nil, driveError(err)
	}
	if err = driveCommit(ctx, s); err != nil {
		return nil, driveError(err)
	}
	return &singleBody[models.Project]{Body: p}, nil
}
