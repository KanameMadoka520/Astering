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
	"mime"
	"net/http"
	"time"

	"code.vikunja.io/api/pkg/modules/humabridge"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/modules/tcylocale"
	webfiles "code.vikunja.io/api/pkg/web/files"

	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTCYAttachmentRoutes) }

type chatFileInput struct {
	ID   string `path:"id" format:"uuid" doc:"Private conversation owned by this human account."`
	File string `path:"file" minLength:"64" maxLength:"64" doc:"Attachment hash referenced in this conversation."`
}
type chatBinaryResponse struct {
	Status             int
	ContentType        string `header:"Content-Type"`
	ContentDisposition string `header:"Content-Disposition"`
	CacheControl       string `header:"Cache-Control"`
	NoSniff            string `header:"X-Content-Type-Options"`
	Body               []byte
}

func chatFileError(ctx context.Context, err error) error {
	if errors.Is(err, tcyai.ErrAttachmentMissing) {
		return huma.Error404NotFound(tcylocale.Render(ctx, tcylocale.Error("chatAttachmentMissing")))
	}
	if errors.Is(err, tcyai.ErrAttachmentInvalid) || errors.Is(err, tcyai.ErrImageModel) {
		return huma.Error422UnprocessableEntity(tcylocale.Render(ctx, tcylocale.Error(err.Error())))
	}
	if errors.Is(err, tcyai.ErrAttachmentTrashed) {
		return huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error(err.Error())))
	}
	return conversationError(ctx, err)
}

type chatDriveInput struct {
	ID   string `path:"id" format:"uuid" doc:"Private conversation owned by this human account."`
	Body struct {
		FileID int64 `json:"file_id" minimum:"1" doc:"A file in your own drive, not in the recycle bin, of at most 32 MiB."`
	}
}

func RegisterTCYAttachmentRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Description: "Private account-owned conversation attachments. Human sessions only; no API-token, link-share or MCP access to conversations. New files are stored once in your personal drive (where drive API tokens can reach them like any drive file) and conversations, including branches, keep references; older encrypted chat files stay readable. Removing an attachment never deletes a drive file. Downloads never expose a public URL.", Tags: []string{"tcymc-ai"}, MaxBodyBytes: tcyai.MaxChatAttachmentBytes + 1024*1024, BodyReadTimeout: 2 * time.Minute}
	}
	Register(api, op("tcy-ai-attachments-upload", "POST", "/ai/conversations/{id}/attachments", "Upload a private conversation attachment"), func(ctx context.Context, in *struct {
		ID      string `path:"id" format:"uuid"`
		RawBody huma.MultipartFormFiles[struct {
			File huma.FormFile `form:"file" required:"true"`
		}]
	}) (*struct{ Body tcyai.ChatAttachment }, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		form := in.RawBody.Data()
		if form == nil || form.File.File == nil {
			return nil, huma.Error400BadRequest("Missing file")
		}
		defer form.File.Close()
		value, err := tcyai.UploadChatAttachment(uid, in.ID, form.File.Filename, form.File)
		if err != nil {
			return nil, chatFileError(ctx, err)
		}
		return &struct{ Body tcyai.ChatAttachment }{Body: value}, nil
	})
	fromDrive := op("tcy-ai-attachments-from-drive", "POST", "/ai/conversations/{id}/attachments/from-drive", "Attach a file from your drive without copying it")
	fromDrive.Description = "Adds one of your own drive files to the unsent draft as a reference, with the same checks as an upload: at most 32 MiB, at most 16 draft files, media type detected from the bytes and images fully decoded. Choosing a file, or identical bytes, already in the draft returns the existing attachment unchanged: its drive_file_id may then be another drive file, or absent for an older encrypted chat file. Files in the recycle bin are rejected with 409; drive files of other accounts are not found. The drive lists this conversation as a usage until no saved message or draft references the file. Human sessions only."
	fromDrive.MaxBodyBytes = 4 * 1024
	fromDrive.BodyReadTimeout = 30 * time.Second
	Register(api, fromDrive, func(ctx context.Context, in *chatDriveInput) (*struct{ Body tcyai.ChatAttachment }, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.AttachDriveFileToConversation(uid, in.ID, in.Body.FileID)
		if err != nil {
			return nil, chatFileError(ctx, err)
		}
		return &struct{ Body tcyai.ChatAttachment }{Body: value}, nil
	})
	Register(api, op("tcy-ai-attachments-download", "GET", "/ai/conversations/{id}/attachments/{file}", "Download a referenced conversation attachment"), func(ctx context.Context, in *chatFileInput) (*chatBinaryResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		item, data, err := tcyai.DownloadChatAttachment(uid, in.ID, in.File)
		if err != nil {
			return nil, chatFileError(ctx, err)
		}
		response := &chatBinaryResponse{
			Status:             http.StatusOK,
			ContentType:        item.MIME,
			ContentDisposition: mime.FormatMediaType("attachment", map[string]string{"filename": item.Name}),
			CacheControl:       "no-store",
			NoSniff:            "nosniff",
			Body:               data,
		}
		if webfiles.IsCacheableImage(item.MIME) {
			if ec := humabridge.EchoContextFrom(ctx); ec != nil {
				webfiles.PrivateImageCache((*ec).Response())
				response.CacheControl = "private, no-cache"
				etag := webfiles.ImageETag(data)
				(*ec).Response().Header().Set("ETag", etag)
				if webfiles.ImageNotModified((*ec).Request(), etag, time.Time{}) {
					response.Status = http.StatusNotModified
					response.Body = nil
				}
			}
		}
		return response, nil
	})
	Register(api, op("tcy-ai-attachments-remove", "DELETE", "/ai/conversations/{id}/attachments/{file}", "Remove an unsent attachment; drive files and files referenced elsewhere are kept"), func(ctx context.Context, in *chatFileInput) (*emptyBody, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if err = tcyai.RemoveChatDraftAttachment(uid, in.ID, in.File); err != nil {
			return nil, chatFileError(ctx, err)
		}
		return &emptyBody{}, nil
	})
	Register(api, op("tcy-ai-conversations-export", "GET", "/ai/conversations/{id}/export", "Export the transcript as JSON, Markdown, or Markdown with attachments in a ZIP"), func(ctx context.Context, in *struct {
		ID     string `path:"id" format:"uuid"`
		Format string `query:"format" enum:"json,md,zip" default:"zip" doc:"ZIP includes relative attachment references and original files. Missing attachments are marked in place."`
	}) (*chatBinaryResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		data, kind, err := tcyai.ExportConversation(uid, in.ID, in.Format)
		if err != nil {
			return nil, chatFileError(ctx, err)
		}
		return &chatBinaryResponse{
			Status:             http.StatusOK,
			ContentType:        kind,
			ContentDisposition: mime.FormatMediaType("attachment", map[string]string{"filename": "conversation-" + in.ID + "." + in.Format}),
			CacheControl:       "no-store",
			NoSniff:            "nosniff",
			Body:               data,
		}, nil
	})
}
