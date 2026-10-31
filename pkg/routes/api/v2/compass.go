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
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/web/handler"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/conditional"
)

type compassSpaceBody struct {
	BackgroundFileID int64  `json:"background_file_id" minimum:"0" doc:"Drive image reference; 0 uses theme sky."`
	BackgroundFocusX int    `json:"background_focus_x" minimum:"0" maximum:"100" default:"50" doc:"Horizontal crop focal point, percent."`
	BackgroundFocusY int    `json:"background_focus_y" minimum:"0" maximum:"100" default:"50" doc:"Vertical crop focal point, percent."`
	BackgroundScrim  string `json:"background_scrim" enum:"soft,medium,strong" default:"medium" doc:"Background readability overlay strength."`

	ID            int64     `json:"id" readOnly:"true" doc:"Space identifier, assigned by the server."`
	OwnerID       int64     `json:"owner_id" readOnly:"true" doc:"Creator; owns a personal space, but cannot retain access after leaving a team space."`
	TeamID        int64     `json:"team_id" minimum:"0" doc:"0 for private. On creation only, select a team you administer. Immutable thereafter."`
	Title         string    `json:"title" minLength:"1" maxLength:"80" doc:"User-defined name, not a fixed product label."`
	Motto         string    `json:"motto" maxLength:"600" doc:"Plain-text guiding sentence."`
	Introduction  string    `json:"introduction" maxLength:"65536" doc:"Basic rich text without embeds or images, up to 64 KiB."`
	Theme         string    `json:"theme" enum:"aurora,solar,nebula,ink" doc:"Built-in visual atmosphere."`
	Revision      int64     `json:"revision" minimum:"0" doc:"Expected revision on save; stale edits return 409."`
	Created       time.Time `json:"created" readOnly:"true" doc:"Creation time."`
	Updated       time.Time `json:"updated" readOnly:"true" doc:"Settings or entry update time."`
	MaxPermission int       `json:"max_permission" readOnly:"true" doc:"0 read, 1 write entries, 2 manage space and permanently delete entries."`
	EntryCount    int64     `json:"entry_count" readOnly:"true" doc:"Entries outside trash, including archived writings."`
	PinnedCount   int64     `json:"pinned_count" readOnly:"true" doc:"Pinned active entries."`
}

func compassSpaceBodyFrom(m *models.CompassSpace) *compassSpaceBody {
	return &compassSpaceBody{ID: m.ID, OwnerID: m.OwnerID, TeamID: m.TeamID, Title: m.Title, Motto: m.Motto, Introduction: m.Introduction, Theme: m.Theme, BackgroundFileID: m.BackgroundFileID, BackgroundFocusX: m.BackgroundFocusX, BackgroundFocusY: m.BackgroundFocusY, BackgroundScrim: m.BackgroundScrim, Revision: m.Revision, Created: m.Created, Updated: m.Updated, MaxPermission: m.MaxPermission, EntryCount: m.EntryCount, PinnedCount: m.PinnedCount}
}
func (b compassSpaceBody) model() *models.CompassSpace {
	return &models.CompassSpace{ID: b.ID, OwnerID: b.OwnerID, TeamID: b.TeamID, Title: b.Title, Motto: b.Motto, Introduction: b.Introduction, Theme: b.Theme, BackgroundFileID: b.BackgroundFileID, BackgroundFocusX: b.BackgroundFocusX, BackgroundFocusY: b.BackgroundFocusY, BackgroundScrim: b.BackgroundScrim, Revision: b.Revision, Created: b.Created, Updated: b.Updated, MaxPermission: b.MaxPermission, EntryCount: b.EntryCount, PinnedCount: b.PinnedCount}
}

type compassEntryBody struct {
	ImageCount    int       `json:"image_count" readOnly:"true" doc:"Distinct current body images."`
	ID            int64     `json:"id" readOnly:"true" doc:"Entry identifier."`
	SpaceID       int64     `json:"space_id" readOnly:"true" doc:"Immutable containing space, taken from creation URL."`
	Kind          string    `json:"kind" enum:"principle,vision,action,memory,note" doc:"Principle, vision, action guidance, memory, or a free-form note."`
	Title         string    `json:"title" minLength:"1" maxLength:"200" doc:"Entry title."`
	Subtitle      string    `json:"subtitle" maxLength:"600" doc:"Plain-text short introduction."`
	Content       string    `json:"content,omitempty" maxLength:"2097152" doc:"Sanitized rich text with data-compass-image Drive references, up to 2 MiB. Omitted from lists; load the entry to read or edit."`
	Quote         string    `json:"quote" maxLength:"1000" doc:"Optional highlighted plain-text passage, explicitly selected by the author."`
	Category      string    `json:"category" maxLength:"80" doc:"User-defined topic; empty means uncategorized."`
	Tags          []string  `json:"tags" maxItems:"24" doc:"Up to 24 unique single-line tags, each at most 40 Unicode characters."`
	Theme         string    `json:"theme" enum:"inherit,aurora,solar,nebula,ink" doc:"Inherit space atmosphere or select an entry atmosphere."`
	Pinned        bool      `json:"pinned" doc:"Shown before other entries; trash removes pinning."`
	State         string    `json:"state" enum:"active,archived,trashed" doc:"Trash retains content and history until an explicit permanent delete."`
	Revision      int64     `json:"revision" minimum:"0" doc:"Expected revision on save; current version in responses."`
	Created       time.Time `json:"created" readOnly:"true" doc:"Original creation time."`
	Updated       time.Time `json:"updated" readOnly:"true" doc:"Last real change; unchanged saves create no new revision."`
	CreatedByID   int64     `json:"created_by_id" readOnly:"true" doc:"Creator's user ID."`
	UpdatedByID   int64     `json:"updated_by_id" readOnly:"true" doc:"User who saved this revision."`
	Excerpt       string    `json:"excerpt" readOnly:"true" doc:"Server-derived plain-text preview, up to 360 Unicode characters."`
	ContentBytes  int64     `json:"content_bytes" readOnly:"true" doc:"UTF-8 content size of this version, not total database disk usage."`
	MaxPermission int       `json:"max_permission" readOnly:"true" doc:"Permission inherited from the containing space."`
}

func compassEntryBodyFrom(m *models.CompassEntry) *compassEntryBody {
	return &compassEntryBody{ID: m.ID, SpaceID: m.SpaceID, Kind: m.Kind, Title: m.Title, Subtitle: m.Subtitle, Content: m.Content, Quote: m.Quote, Category: m.Category, Tags: m.Tags, Theme: m.Theme, Pinned: m.Pinned, State: m.State, Revision: m.Revision, Created: m.Created, Updated: m.Updated, CreatedByID: m.CreatedByID, UpdatedByID: m.UpdatedByID, Excerpt: m.Excerpt, ContentBytes: m.ContentBytes, ImageCount: m.ImageCount, MaxPermission: m.MaxPermission}
}
func (b compassEntryBody) model() *models.CompassEntry {
	return &models.CompassEntry{ID: b.ID, SpaceID: b.SpaceID, Kind: b.Kind, Title: b.Title, Subtitle: b.Subtitle, Content: b.Content, Quote: b.Quote, Category: b.Category, Tags: b.Tags, Theme: b.Theme, Pinned: b.Pinned, State: b.State, Revision: b.Revision, Created: b.Created, Updated: b.Updated, CreatedByID: b.CreatedByID, UpdatedByID: b.UpdatedByID, Excerpt: b.Excerpt, ContentBytes: b.ContentBytes, ImageCount: b.ImageCount, MaxPermission: b.MaxPermission}
}

func init() { AddRouteRegistrar(RegisterCompassRoutes) }
func RegisterCompassRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "compass-spaces-list", Summary: "List personal and joined team writing spaces", Description: "Only owner-private spaces and current team memberships; no automatic creation or public visibility.", Method: http.MethodGet, Path: "/compass/spaces", Tags: []string{"compass"}}, compassSpacesList)
	Register(api, huma.Operation{OperationID: "compass-spaces-create", Summary: "Create a writing space", Description: "Defaults to personal ownership. Creating a team space requires current team admin membership; visibility cannot later be changed.", Method: http.MethodPost, Path: "/compass/spaces", Tags: []string{"compass"}}, compassSpacesCreate)
	Register(api, huma.Operation{OperationID: "compass-spaces-read", Summary: "Read a writing space", Description: "Membership is checked on every read; unrelated instance administrators cannot read private writing.", Method: http.MethodGet, Path: "/compass/spaces/{space}", Tags: []string{"compass"}}, compassSpacesRead)
	Register(api, huma.Operation{OperationID: "compass-spaces-update", Summary: "Update space identity and atmosphere", Description: "Owner/team admins only. Revision conflict returns 409. Cannot change ownership or team.", Method: http.MethodPut, Path: "/compass/spaces/{space}", Tags: []string{"compass"}}, compassSpacesUpdate)
	Register(api, huma.Operation{OperationID: "compass-entries-list", Summary: "Search a space writing library", Description: "Paginated metadata without long-form bodies. Literal full-text search, filters, pinning and stable ordering; trash excluded by default.", Method: http.MethodGet, Path: "/compass/spaces/{space}/entries", Tags: []string{"compass"}}, compassEntriesList)
	Register(api, huma.Operation{OperationID: "compass-entries-create", Summary: "Create a writing", Description: "Current space members may write. Stores first revision; validates and sanitizes rich text.", Method: http.MethodPost, Path: "/compass/spaces/{space}/entries", Tags: []string{"compass"}}, compassEntriesCreate)
	Register(api, huma.Operation{OperationID: "compass-entries-read", Summary: "Read a complete writing", Description: "Returns full content and current permission, including entries in trash.", Method: http.MethodGet, Path: "/compass/entries/{entry}", Tags: []string{"compass"}}, compassEntriesRead)
	Register(api, huma.Operation{OperationID: "compass-entries-update", Summary: "Save or change writing state", Description: "Requires current revision. Meaningful changes append a snapshot. State active/archived/trashed; trash retains history. Immutable space and authorship.", Method: http.MethodPut, Path: "/compass/entries/{entry}", Tags: []string{"compass"}}, compassEntriesUpdate)
	Register(api, huma.Operation{OperationID: "compass-entries-delete", Summary: "Permanently delete a trashed writing", Description: "Only owner/team admins; must already be trashed and revision must match. Deletes all snapshots irreversibly.", Method: http.MethodDelete, Path: "/compass/entries/{entry}", Tags: []string{"compass"}}, compassEntriesDelete)
	Register(api, huma.Operation{OperationID: "compass-revisions-list", Summary: "Browse revision metadata", Description: "Paginated saved versions without bodies; requires current space access.", Method: http.MethodGet, Path: "/compass/entries/{entry}/revisions", Tags: []string{"compass"}}, compassRevisionsList)
	Register(api, huma.Operation{OperationID: "compass-revisions-read", Summary: "Read a saved revision", Description: "Permission follows current membership, never historical access.", Method: http.MethodGet, Path: "/compass/entries/{entry}/revisions/{revision}", Tags: []string{"compass"}}, compassRevisionsRead)
	Register(api, huma.Operation{OperationID: "compass-revisions-restore", Summary: "Restore text from a saved revision", Description: "Requires expected_revision. Copies text and categorization into a new current version, preserving current state and pinning.", Method: http.MethodPost, Path: "/compass/entries/{entry}/revisions/{revision}/restore", Tags: []string{"compass"}, DefaultStatus: http.StatusOK}, compassRevisionsRestore)
	Register(api, huma.Operation{OperationID: "compass-topics-list", Summary: "Browse topics and tags", Description: "Counts active and archived entries in this space; excludes trash and does not load body text.", Method: http.MethodGet, Path: "/compass/spaces/{space}/topics", Tags: []string{"compass"}}, compassTopicsList)
}

func compassSpacesList(ctx context.Context, in *ListParams) (*struct{ Body Paginated[*compassSpaceBody] }, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	result, _, total, err := handler.DoReadAll(ctx, &models.CompassSpace{}, a, in.Q, in.Page, in.PerPage)
	if err != nil {
		return nil, translateDomainError(err)
	}
	items, ok := result.([]*models.CompassSpace)
	if !ok {
		return nil, fmt.Errorf("unexpected compass spaces result %T", result)
	}
	out := make([]*compassSpaceBody, 0, len(items))
	for _, v := range items {
		out = append(out, compassSpaceBodyFrom(v))
	}
	return &struct{ Body Paginated[*compassSpaceBody] }{Body: NewPaginated(out, total, in.Page, in.PerPage)}, nil
}
func compassSpacesCreate(ctx context.Context, in *struct{ Body compassSpaceBody }) (*singleBody[compassSpaceBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := in.Body.model()
	if err = handler.DoCreate(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassSpaceBody]{Body: compassSpaceBodyFrom(m)}, nil
}
func compassSpacesRead(ctx context.Context, in *struct {
	Space int64 `path:"space" minimum:"1"`
	conditional.Params
}) (*singleReadBody[compassSpaceBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := &models.CompassSpace{ID: in.Space}
	if _, err = handler.DoReadOne(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return conditionalRepresentationResponse(&in.Params, compassSpaceBodyFrom(m))
}
func compassSpacesUpdate(ctx context.Context, in *struct {
	Space int64 `path:"space" minimum:"1"`
	Body  compassSpaceBody
}) (*singleBody[compassSpaceBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := in.Body.model()
	m.ID = in.Space
	if err = handler.DoUpdate(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassSpaceBody]{Body: compassSpaceBodyFrom(m)}, nil
}
func compassEntriesList(ctx context.Context, in *struct {
	Space int64 `path:"space" minimum:"1"`
	ListParams
	Kind     string `query:"kind" enum:"principle,vision,action,memory,note"`
	Category string `query:"category" maxLength:"80"`
	Tag      string `query:"tag" maxLength:"40"`
	State    string `query:"state" default:"active" enum:"active,archived,trashed,all"`
	Pinned   string `query:"pinned" enum:"true,false"`
	Sort     string `query:"sort" default:"updated" enum:"updated,created,title"`
}) (*struct{ Body Paginated[*compassEntryBody] }, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := &models.CompassEntry{SpaceID: in.Space, FilterKind: in.Kind, FilterCategory: in.Category, FilterTag: in.Tag, FilterState: in.State, FilterPinned: compassPinnedFilter(in.Pinned), Sort: in.Sort}
	result, _, total, err := handler.DoReadAll(ctx, m, a, in.Q, in.Page, in.PerPage)
	if err != nil {
		return nil, translateDomainError(err)
	}
	items, ok := result.([]*models.CompassEntry)
	if !ok {
		return nil, fmt.Errorf("unexpected compass entries result %T", result)
	}
	out := make([]*compassEntryBody, 0, len(items))
	for _, v := range items {
		out = append(out, compassEntryBodyFrom(v))
	}
	return &struct{ Body Paginated[*compassEntryBody] }{Body: NewPaginated(out, total, in.Page, in.PerPage)}, nil
}
func compassEntriesCreate(ctx context.Context, in *struct {
	Space int64 `path:"space" minimum:"1"`
	Body  compassEntryBody
}) (*singleBody[compassEntryBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := in.Body.model()
	m.SpaceID = in.Space
	if err = handler.DoCreate(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassEntryBody]{Body: compassEntryBodyFrom(m)}, nil
}
func compassEntriesRead(ctx context.Context, in *struct {
	Entry int64 `path:"entry" minimum:"1"`
	conditional.Params
}) (*singleReadBody[compassEntryBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := &models.CompassEntry{ID: in.Entry}
	if _, err = handler.DoReadOne(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return conditionalRepresentationResponse(&in.Params, compassEntryBodyFrom(m))
}
func compassEntriesUpdate(ctx context.Context, in *struct {
	Entry int64 `path:"entry" minimum:"1"`
	Body  compassEntryBody
}) (*singleBody[compassEntryBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := in.Body.model()
	m.ID = in.Entry
	if err = handler.DoUpdate(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassEntryBody]{Body: compassEntryBodyFrom(m)}, nil
}
func compassEntriesDelete(ctx context.Context, in *struct {
	Entry    int64 `path:"entry" minimum:"1"`
	Revision int64 `query:"revision" minimum:"1" required:"true"`
}) (*emptyBody, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	m := &models.CompassEntry{ID: in.Entry, Revision: in.Revision}
	if err = handler.DoDelete(ctx, m, a); err != nil {
		return nil, translateDomainError(err)
	}
	return nil, nil
}
func compassRevisionsList(ctx context.Context, in *struct {
	Entry int64 `path:"entry" minimum:"1"`
	ListParams
}) (*struct {
	Body Paginated[*models.CompassRevision]
}, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	items, total, err := models.ListCompassRevisions(s, a, in.Entry, in.Page, in.PerPage)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &struct {
		Body Paginated[*models.CompassRevision]
	}{Body: NewPaginated(items, total, in.Page, in.PerPage)}, nil
}
func compassRevisionsRead(ctx context.Context, in *struct {
	Entry    int64 `path:"entry" minimum:"1"`
	Revision int64 `path:"revision" minimum:"1"`
}) (*singleBody[compassEntryBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	m, err := models.ReadCompassRevision(s, a, in.Entry, in.Revision)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassEntryBody]{Body: compassEntryBodyFrom(m)}, nil
}
func compassRevisionsRestore(ctx context.Context, in *struct {
	Entry    int64 `path:"entry" minimum:"1"`
	Revision int64 `path:"revision" minimum:"1"`
	Body     struct {
		ExpectedRevision int64 `json:"expected_revision" minimum:"1" required:"true"`
	}
}) (*singleBody[compassEntryBody], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	m, err := models.RestoreCompassRevision(s, a, in.Entry, in.Revision, in.Body.ExpectedRevision)
	if err != nil {
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[compassEntryBody]{Body: compassEntryBodyFrom(m)}, nil
}
func compassTopicsList(ctx context.Context, in *struct {
	Space int64 `path:"space" minimum:"1"`
}) (*singleBody[models.CompassTopics], error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	m, err := models.ReadCompassTopics(s, a, in.Space)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &singleBody[models.CompassTopics]{Body: m}, nil
}

func compassPinnedFilter(raw string) *bool {
	if raw == "" {
		return nil
	}
	value := raw == "true"
	return &value
}
