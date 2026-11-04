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

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/modules/personalstorage"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterPersonalStorageRoutes) }

func personalStorageHuman(ctx context.Context) (int64, string, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil || (*ec).Get("api_token") != nil {
		return 0, "", huma.Error403Forbidden("storage_forbidden")
	}
	a, err := authFromCtx(ctx)
	if err != nil {
		return 0, "", err
	}
	u, ok := a.(*user.User)
	if !ok || u.ID <= 0 {
		return 0, "", huma.Error403Forbidden("storage_forbidden")
	}
	if err = personalstorage.Authorize(ctx, u.ID); err != nil {
		return 0, "", personalStorageError(err)
	}
	session := auth.SessionIDFromContext(ec)
	if session == "" {
		return 0, "", huma.Error403Forbidden("storage_forbidden")
	}
	return u.ID, session, nil
}

func personalStorageError(err error) error {
	switch {
	case errors.Is(err, personalstorage.ErrForbidden):
		return huma.Error403Forbidden("storage_forbidden")
	case errors.Is(err, personalstorage.ErrInvalid):
		return huma.Error400BadRequest("storage_invalid_selection")
	default:
		return huma.Error503ServiceUnavailable("storage_unavailable")
	}
}

type personalStorageResponse[T any] struct {
	CacheControl string `header:"Cache-Control"`
	Body         T
}

type storageConversationItem struct {
	tcyai.StorageConversation
	Kind string `json:"kind" enum:"conversation" required:"true"`
	URL  string `json:"url" required:"true" doc:"Private conversation location within this application."`
}

type storageConversationPage struct {
	Items           []storageConversationItem `json:"items" required:"true"`
	Total           int64                     `json:"total" required:"true"`
	Page            int                       `json:"page" required:"true"`
	PerPage         int                       `json:"per_page" required:"true"`
	TotalPages      int64                     `json:"total_pages" required:"true"`
	Complete        bool                      `json:"complete" required:"true" doc:"False means unreadable or unvisited records are omitted, not empty."`
	UnreadableCount int                       `json:"unreadable_count" required:"true"`
}

func storagePageSize(n int) int {
	n = min(n, 100)
	if maximum := config.ServiceMaxItemsPerPage.GetInt(); maximum > 0 {
		n = min(n, maximum)
	}
	return max(n, 1)
}

func RegisterPersonalStorageRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID:     id,
			Method:          method,
			Path:            path,
			Summary:         summary,
			Description:     "Personal storage for the active signed-in human only. API tokens, bots, link shares and inactive accounts are forbidden, including administrators inspecting another user's data. Never exposed over MCP. No-store responses; client-supplied paths are never accepted.",
			Tags:            []string{"personal-storage"},
			DefaultStatus:   http.StatusOK,
			MaxBodyBytes:    512 * 1024,
			BodyReadTimeout: 30 * time.Second,
		}
	}
	Register(api, op("user-storage-summary", "GET", "/user/storage", "Read personal storage categories and accounting limits"), func(ctx context.Context, _ *struct{}) (*personalStorageResponse[*personalstorage.StorageSummary], error) {
		uid, _, err := personalStorageHuman(ctx)
		if err != nil {
			return nil, err
		}
		value, err := personalstorage.ReadSummary(ctx, uid)
		if err != nil {
			return nil, personalStorageError(err)
		}
		return &personalStorageResponse[*personalstorage.StorageSummary]{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
	Register(api, op("user-storage-files", "GET", "/user/storage/files", "Inspect owned original files, thumbnails and recycle-bin state"), func(ctx context.Context, in *struct {
		Page     int    `query:"page" default:"1" minimum:"1" maximum:"1000000"`
		PerPage  int    `query:"per_page" default:"25" minimum:"1" maximum:"100"`
		Q        string `query:"q" maxLength:"255" doc:"Case-insensitive original filename search."`
		Category string `query:"category" default:"all" enum:"all,images,video,audio,documents,other,previews"`
		Scope    string `query:"scope" default:"all" enum:"all,active,trash"`
		SortBy   string `query:"sort_by" default:"bytes" enum:"bytes,created,name,preview_bytes"`
		OrderBy  string `query:"order_by" default:"desc" enum:"asc,desc"`
	}) (*personalStorageResponse[*personalstorage.StorageFilePage], error) {
		uid, _, err := personalStorageHuman(ctx)
		if err != nil {
			return nil, err
		}
		value, err := personalstorage.ListFiles(ctx, uid, personalstorage.FileQuery{
			Page:     in.Page,
			PerPage:  storagePageSize(in.PerPage),
			Q:        in.Q,
			Category: in.Category,
			Scope:    in.Scope,
			SortBy:   in.SortBy,
			OrderBy:  in.OrderBy,
		})
		if err != nil {
			return nil, personalStorageError(err)
		}
		return &personalStorageResponse[*personalstorage.StorageFilePage]{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
	Register(api, op("user-storage-conversations", "GET", "/user/storage/conversations", "Inspect encrypted conversation record sizes without returning messages"), func(ctx context.Context, in *struct {
		Page    int    `query:"page" default:"1" minimum:"1" maximum:"1000000"`
		PerPage int    `query:"per_page" default:"25" minimum:"1" maximum:"100"`
		Q       string `query:"q" maxLength:"255" doc:"Case-insensitive conversation title search; does not search messages."`
		Scope   string `query:"scope" default:"all" enum:"all,active,archived"`
		SortBy  string `query:"sort_by" default:"bytes" enum:"bytes,updated,title"`
		OrderBy string `query:"order_by" default:"desc" enum:"asc,desc"`
		Running string `query:"running" default:"all" enum:"all,running,idle"`
	}) (*personalStorageResponse[storageConversationPage], error) {
		uid, _, err := personalStorageHuman(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.ListStorageConversations(ctx, uid, tcyai.StorageConversationQuery{
			Page:    in.Page,
			PerPage: storagePageSize(in.PerPage),
			Q:       in.Q,
			Scope:   in.Scope,
			SortBy:  in.SortBy,
			OrderBy: in.OrderBy,
			Running: in.Running,
		})
		if err != nil {
			return nil, personalStorageError(err)
		}
		body := storageConversationPage{
			Items:           []storageConversationItem{},
			Total:           value.Total,
			Page:            value.Page,
			PerPage:         value.PerPage,
			TotalPages:      value.TotalPages,
			Complete:        value.Complete,
			UnreadableCount: value.UnreadableCount,
		}
		for _, item := range value.Items {
			body.Items = append(body.Items, storageConversationItem{
				StorageConversation: item,
				Kind:                "conversation",
				URL:                 "/ai?chat=" + item.ID,
			})
		}
		return &personalStorageResponse[storageConversationPage]{
			CacheControl: "no-store",
			Body:         body,
		}, nil
	})
	preview := op("user-storage-cleanup-preview", "POST", "/user/storage/cleanup/preview", "StoragePreview selected cleanup targets and current references")
	preview.Description += " At most 50 distinct targets. Referenced originals are blocked; active conversations cannot be deleted. Returns short-lived confirmations bound to account, login session, target, action, current revision and references. This operation removes nothing. Moving files to trash frees zero bytes. Permanent deletion requires the file already be in the recycle bin."
	Register(api, preview, func(ctx context.Context, in *struct {
		Body struct {
			Items []personalstorage.StorageSelection `json:"items" minItems:"1" maxItems:"50" required:"true"`
		}
	}) (*personalStorageResponse[*personalstorage.StoragePreview], error) {
		uid, session, err := personalStorageHuman(ctx)
		if err != nil {
			return nil, err
		}
		value, err := personalstorage.PreviewCleanup(ctx, uid, session, in.Body.Items)
		if err != nil {
			return nil, personalStorageError(err)
		}
		return &personalStorageResponse[*personalstorage.StoragePreview]{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
	execute := op("user-storage-cleanup-execute", "POST", "/user/storage/cleanup/execute", "StorageExecute confirmed targets with current ownership and reference checks")
	execute.Description += " Explicit confirm=true is required. Each signed token is revalidated independently; results may contain partial successes and retryable failures. Storage removal happens only through the checked Drive lifecycle. Conversations retain Drive originals and settings. Reports verified removed bytes rather than preview estimates; repeated completed tokens return already_done with zero newly freed bytes."
	Register(api, execute, func(ctx context.Context, in *struct {
		Body struct {
			Tokens  []string `json:"tokens" minItems:"1" maxItems:"50" required:"true" doc:"Confirmation tokens from the same account and login session's preview."`
			Confirm bool     `json:"confirm" required:"true" doc:"Explicit acknowledgement of the preview; false never changes data."`
		}
	}) (*personalStorageResponse[*personalstorage.StorageExecute], error) {
		uid, session, err := personalStorageHuman(ctx)
		if err != nil {
			return nil, err
		}
		value, err := personalstorage.ExecuteCleanup(ctx, uid, session, in.Body.Tokens, in.Body.Confirm)
		if err != nil {
			return nil, personalStorageError(err)
		}
		return &personalStorageResponse[*personalstorage.StorageExecute]{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
}
