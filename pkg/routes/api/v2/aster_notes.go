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
	"fmt"
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/KanameMadoka520/Astering/pkg/web/handler"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterAsterNotesRoutes) }

type asterNoteResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.AsterNote
}
type asterNoteListResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         Paginated[*models.AsterNote]
}
type asterNoteSegmentsResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.AsterNoteSegmentPage
}
type asterNoteSegmentResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.AsterNoteSegment
}
type asterNoteEmptyResponse struct {
	CacheControl string `header:"Cache-Control"`
}

func asterNotesAuth(ctx context.Context) (web.Auth, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil {
		return nil, huma.Error401Unauthorized("note_authentication_required")
	}
	(*ec).Response().Header().Set("Cache-Control", "no-store")
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	if (*ec).Get("api_token") != nil || auth.SessionIDFromContext(ec) == "" {
		return nil, huma.Error403Forbidden("note_human_session_required")
	}
	return a, nil
}

func asterNotesOperation(op huma.Operation) huma.Operation {
	op.Middlewares = append(op.Middlewares, func(ctx huma.Context, next func(huma.Context)) {
		ctx.SetHeader("Cache-Control", "no-store")
		next(ctx)
	})
	return op
}

func RegisterAsterNotesRoutes(api huma.API) {
	tags := []string{"notes"}
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "notes-list",
		Method:      http.MethodGet,
		Path:        "/notes",
		Tags:        tags,
		Summary:     "List personal notes",
		Description: "Active human sessions only. Returns only the owner's notes, including pinned notes first, then newest activity and ID. Searches title and editable Markdown; list bodies omit content. Administrator/team/bot-owner roles grant no access.",
	}), asterNotesList)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "notes-read",
		Method:      http.MethodGet,
		Path:        "/notes/{id}",
		Tags:        tags,
		Summary:     "Read a personal note",
		Description: "Owner-only complete editable Markdown and transcript statistics. Transcript text is separately paginated; no audio is stored. Private JSON is never persistently cached.",
	}), asterNotesRead)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID:  "notes-create",
		Method:       http.MethodPost,
		Path:         "/notes",
		Tags:         tags,
		Summary:      "Create a personal note",
		Description:  "Creates an empty-transcript note owned by the current active human. Ownership, counters and editorial revision are set by the server, regardless of request fields.",
		MaxBodyBytes: 10 * 1024 * 1024,
	}), asterNotesCreate)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID:  "notes-update",
		Method:       http.MethodPut,
		Path:         "/notes/{id}",
		Tags:         tags,
		Summary:      "Save personal note Markdown",
		Description:  "Replaces title, content and pinned state. Requires expected_revision from the last read; stale edits return 409 note_revision_conflict without overwriting either draft. No-op saves retain revision. Transcript appends are independent. PATCH is intentionally unavailable so its implicit GET cannot select a fresh revision for a stale draft.",
		Metadata:     map[string]any{"autopatch": false},
		MaxBodyBytes: 10 * 1024 * 1024,
	}), asterNotesUpdate)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "notes-delete",
		Method:      http.MethodDelete,
		Path:        "/notes/{id}",
		Tags:        tags,
		Summary:     "Permanently delete a personal note",
		Description: "Owner-only permanent removal of the editable note and all of its transcript segments in one transaction. Other notes, tasks, chat records and Drive files are unaffected.",
	}), asterNotesDelete)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "note-segments-list",
		Method:      http.MethodGet,
		Path:        "/notes/{id}/segments",
		Tags:        tags,
		Summary:     "Read a forward or latest page of final transcript segments",
		Description: "Owner-only immutable transcript text in ascending server ID order, at most 100 per page. Pass next_cursor as after_id to read forward, or latest=true to read the newest page directly; latest and a positive after_id are mutually exclusive (422). Latest mode returns from_end=true and has_more=false. Independent from editorial revision.",
	}), asterNoteSegmentsList)
	Register(api, asterNotesOperation(huma.Operation{
		OperationID:  "note-segments-append",
		Method:       http.MethodPost,
		Path:         "/notes/{id}/segments",
		Tags:         tags,
		Summary:      "Append a final transcript segment idempotently",
		Description:  "Persists only final text and elapsed recording offsets, never audio. The active owner is rechecked under the write lock. An identical note/client_id/text/time retry returns the original segment; reuse with different content returns 409 note_segment_conflict. Appending does not overwrite editable Markdown or advance its revision.",
		MaxBodyBytes: 256 * 1024,
	}), asterNoteSegmentsAppend)
}

func asterNotesList(ctx context.Context, in *struct {
	ListParams
	Pinned string `query:"pinned" enum:"true,false" doc:"Optional pin filter. Omit to return pinned and unpinned notes."`
}) (*asterNoteListResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	var filterPinned *bool
	if in.Pinned != "" {
		pinned := in.Pinned == "true"
		filterPinned = &pinned
	}
	result, _, total, err := handler.DoReadAll(ctx, &models.AsterNote{FilterPinned: filterPinned}, a, in.Q, in.Page, in.PerPage)
	if err != nil {
		return nil, translateDomainError(err)
	}
	items, ok := result.([]*models.AsterNote)
	if !ok {
		return nil, fmt.Errorf("notes.ReadAll returned unexpected type %T", result)
	}
	return &asterNoteListResponse{
		CacheControl: "no-store",
		Body:         NewPaginated(items, total, in.Page, in.PerPage),
	}, nil
}

func asterNotesRead(ctx context.Context, in *struct {
	ID int64 `path:"id" minimum:"1"`
}) (*asterNoteResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	note := &models.AsterNote{ID: in.ID}
	if _, err := handler.DoReadOne(ctx, note, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteResponse{
		CacheControl: "no-store",
		Body:         note,
	}, nil
}

func asterNotesCreate(ctx context.Context, in *struct{ Body models.AsterNote }) (*asterNoteResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	if err := handler.DoCreate(ctx, &in.Body, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteResponse{
		CacheControl: "no-store",
		Body:         &in.Body,
	}, nil
}

func asterNotesUpdate(ctx context.Context, in *struct {
	ID   int64 `path:"id" minimum:"1"`
	Body models.AsterNote
}) (*asterNoteResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	in.Body.ID = in.ID
	if err := handler.DoUpdate(ctx, &in.Body, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteResponse{
		CacheControl: "no-store",
		Body:         &in.Body,
	}, nil
}

func asterNotesDelete(ctx context.Context, in *struct {
	ID int64 `path:"id" minimum:"1"`
}) (*asterNoteEmptyResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	if err := handler.DoDelete(ctx, &models.AsterNote{ID: in.ID}, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteEmptyResponse{CacheControl: "no-store"}, nil
}

func asterNoteSegmentsList(ctx context.Context, in *struct {
	ID      int64 `path:"id" minimum:"1"`
	AfterID int64 `query:"after_id" default:"0" minimum:"0" doc:"Exclusive forward cursor from next_cursor, initially 0."`
	PerPage int   `query:"per_page" default:"100" minimum:"1" maximum:"100" doc:"At most 100 final segments per page."`
	Latest  bool  `query:"latest" default:"false" doc:"Read the newest bounded page directly, ordered ascending. Cannot be combined with after_id greater than zero."`
}) (*asterNoteSegmentsResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	page, err := models.ListAsterNoteSegments(s, a, in.ID, in.AfterID, in.PerPage, in.Latest)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteSegmentsResponse{
		CacheControl: "no-store",
		Body:         page,
	}, nil
}

func asterNoteSegmentsAppend(ctx context.Context, in *struct {
	ID   int64 `path:"id" minimum:"1"`
	Body models.AsterNoteSegment
}) (*asterNoteSegmentResponse, error) {
	a, err := asterNotesAuth(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	if err := models.AppendAsterNoteSegment(s, a, in.ID, &in.Body); err != nil {
		return nil, translateDomainError(err)
	}
	if err := s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	return &asterNoteSegmentResponse{
		CacheControl: "no-store",
		Body:         &in.Body,
	}, nil
}
