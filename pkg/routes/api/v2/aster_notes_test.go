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
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/personalstorage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"
)

func asterNotesFixture(t *testing.T) (*echo.Echo, huma.API) {
	t.Helper()
	aiBucketFixtures(t)
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			id, err := strconv.ParseInt(c.Request().Header.Get("X-Test-User"), 10, 64)
			if err == nil && id > 0 {
				sid := fmt.Sprintf("test-session-%d", id)
				c.Set("api_user", user.WithSessionCredential(&user.User{ID: id}, sid))
				if c.Request().Header.Get("X-Test-No-Session") != "true" {
					c.Set("user", &jwt.Token{Claims: jwt.MapClaims{"sid": sid}})
				}
				if c.Request().Header.Get("X-Test-Token") == "true" {
					c.Set("api_token", &models.APIToken{
						ID:      123,
						OwnerID: id,
					})
				}
			}
			return next(c)
		}
	})
	api := NewAPI(e, e.Group(GroupPrefix))
	RegisterAsterNotesRoutes(api)
	EnableAutoPatch(api)
	return e, api
}

func asterNotesRequest(t *testing.T, e *echo.Echo, uid int64, method, path string, body any, token, noSession bool) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	if body != nil {
		var err error
		data, err = json.Marshal(body)
		require.NoError(t, err)
	}
	req := httptest.NewRequest(method, GroupPrefix+path, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	if uid > 0 {
		req.Header.Set("X-Test-User", strconv.FormatInt(uid, 10))
	}
	if token {
		req.Header.Set("X-Test-Token", "true")
	}
	if noSession {
		req.Header.Set("X-Test-No-Session", "true")
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func asterNotesDecode[T any](t *testing.T, rec *httptest.ResponseRecorder, expectedStatus int) T {
	t.Helper()
	require.Equal(t, expectedStatus, rec.Code, rec.Body.String())
	require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
	var result T
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	return result
}

func TestAsterNotesHTTPBodyRevisionAndFinalTranscript(t *testing.T) {
	e, api := asterNotesFixture(t)
	request := func(method, path string, body any) *httptest.ResponseRecorder {
		return asterNotesRequest(t, e, 1, method, path, body, false, false)
	}
	note := asterNotesDecode[models.AsterNote](t, request(http.MethodPost, "/notes", map[string]any{
		"title":            "Personal meeting notes",
		"content":          "# Editable draft\nOriginal text",
		"revision":         999,
		"transcript_bytes": 1234,
	}), http.StatusCreated)
	require.EqualValues(t, 1, note.Revision)
	require.Zero(t, note.TranscriptBytes)
	path := fmt.Sprintf("/notes/%d", note.ID)
	require.Nil(t, api.OpenAPI().Paths["/notes/{id}"].Patch, "an implicit fresh-GET merge must not bypass explicit editorial revision")
	list := asterNotesDecode[Paginated[models.AsterNote]](t, request(http.MethodGet, "/notes?per_page=1", nil), http.StatusOK)
	require.EqualValues(t, 1, list.Total)
	require.Len(t, list.Items, 1)
	require.Empty(t, list.Items[0].Content)
	rawList := asterNotesDecode[struct {
		Items []map[string]json.RawMessage `json:"items"`
	}](t, request(http.MethodGet, "/notes", nil), http.StatusOK)
	require.Len(t, rawList.Items, 1)
	require.NotContains(t, rawList.Items[0], "content", "list previews must not transfer full editable Markdown")
	require.Contains(t, string(rawList.Items[0]["excerpt"]), "Original text")
	read := asterNotesDecode[models.AsterNote](t, request(http.MethodGet, path, nil), http.StatusOK)
	require.Equal(t, note.Content, read.Content)
	segmentInput := map[string]any{
		"client_id":        uuid.NewString(),
		"text":             "Original final transcript",
		"start_ms":         0,
		"end_ms":           5000,
		"note_id":          999999,
		"timing_estimated": true,
	}
	segment := asterNotesDecode[models.AsterNoteSegment](t, request(http.MethodPost, path+"/segments", segmentInput), http.StatusCreated)
	require.Equal(t, note.ID, segment.NoteID)
	retry := asterNotesDecode[models.AsterNoteSegment](t, request(http.MethodPost, path+"/segments", segmentInput), http.StatusCreated)
	require.Equal(t, segment.ID, retry.ID)
	require.Equal(t, segment.Created, retry.Created)
	require.True(t, segment.TimingEstimated)
	require.True(t, retry.TimingEstimated)
	edited := asterNotesDecode[models.AsterNote](t, request(http.MethodPut, path, map[string]any{
		"id":                99999,
		"title":             "Edited heading",
		"content":           "# Keep my considered rewrite",
		"pinned":            true,
		"expected_revision": 1,
	}), http.StatusOK)
	require.Equal(t, note.ID, edited.ID)
	require.EqualValues(t, 2, edited.Revision)
	require.EqualValues(t, 1, edited.SegmentCount)
	require.EqualValues(t, len("Original final transcript"), edited.TranscriptBytes)
	conflict := request(http.MethodPut, path, map[string]any{
		"title":             "Stale draft",
		"content":           "Must not overwrite",
		"pinned":            false,
		"expected_revision": 1,
	})
	require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
	require.Contains(t, conflict.Body.String(), "note_revision_conflict")
	require.Equal(t, "no-store", conflict.Header().Get("Cache-Control"))
	segmentInput["text"] = "A changed retry must not silently rewrite history"
	conflict = request(http.MethodPost, path+"/segments", segmentInput)
	require.Equal(t, http.StatusConflict, conflict.Code, conflict.Body.String())
	require.Contains(t, conflict.Body.String(), "note_segment_conflict")
	page := asterNotesDecode[models.AsterNoteSegmentPage](t, request(http.MethodGet, path+"/segments?per_page=1", nil), http.StatusOK)
	require.EqualValues(t, 1, page.Total)
	require.Len(t, page.Items, 1)
	require.Equal(t, "Original final transcript", page.Items[0].Text)
	require.Equal(t, segment.ID, page.NextCursor)
	next := asterNotesDecode[models.AsterNoteSegmentPage](t, request(http.MethodGet, path+"/segments?after_id="+strconv.FormatInt(page.NextCursor, 10), nil), http.StatusOK)
	require.Empty(t, next.Items)
	require.False(t, next.HasMore)
	require.Equal(t, page.NextCursor, next.NextCursor)
	pinned := asterNotesDecode[Paginated[models.AsterNote]](t, request(http.MethodGet, "/notes?pinned=true", nil), http.StatusOK)
	require.EqualValues(t, 1, pinned.Total)
	unpinned := asterNotesDecode[Paginated[models.AsterNote]](t, request(http.MethodGet, "/notes?pinned=false", nil), http.StatusOK)
	require.Zero(t, unpinned.Total)
	reread := asterNotesDecode[models.AsterNote](t, request(http.MethodGet, path, nil), http.StatusOK)
	require.Equal(t, edited.Content, reread.Content)
	require.Equal(t, edited.Revision, reread.Revision)
	deleted := request(http.MethodDelete, path, nil)
	require.Equal(t, http.StatusNoContent, deleted.Code, deleted.Body.String())
	require.Equal(t, http.StatusNotFound, request(http.MethodGet, path, nil).Code)
	require.Equal(t, http.StatusNotFound, request(http.MethodGet, path+"/segments", nil).Code)
	empty := asterNotesDecode[Paginated[models.AsterNote]](t, request(http.MethodGet, "/notes", nil), http.StatusOK)
	require.Zero(t, empty.Total)
}

func TestAsterNotesHTTPPersonalSessionBoundaries(t *testing.T) {
	e, _ := asterNotesFixture(t)
	note := asterNotesDecode[models.AsterNote](t, asterNotesRequest(t, e, 1, http.MethodPost, "/notes", map[string]any{
		"title":   "Private title",
		"content": "Private body must never leak",
	}, false, false), http.StatusCreated)
	s := db.NewSession()
	_, err := s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	t.Setenv("ASTERING_SUPERADMIN_IDS", "2")
	path := fmt.Sprintf("/notes/%d", note.ID)
	for _, operation := range []struct {
		method string
		path   string
		body   any
	}{
		{
			method: http.MethodGet,
			path:   path,
		},
		{
			method: http.MethodPut,
			path:   path,
			body: map[string]any{
				"title":             "Changed",
				"content":           "Wrong owner",
				"expected_revision": 1,
			},
		},
		{
			method: http.MethodDelete,
			path:   path,
		},
		{
			method: http.MethodGet,
			path:   path + "/segments",
		},
		{
			method: http.MethodGet,
			path:   path + "/segments?latest=true",
		},
		{
			method: http.MethodPost,
			path:   path + "/segments",
			body: map[string]any{
				"client_id": uuid.NewString(),
				"text":      "Wrong owner",
				"start_ms":  0,
				"end_ms":    1,
			},
		},
	} {
		rec := asterNotesRequest(t, e, 2, operation.method, operation.path, operation.body, false, false)
		require.Equal(t, http.StatusNotFound, rec.Code, rec.Body.String())
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		require.NotContains(t, rec.Body.String(), "Private title")
		require.NotContains(t, rec.Body.String(), "Private body")
	}
	other := asterNotesDecode[Paginated[models.AsterNote]](t, asterNotesRequest(t, e, 2, http.MethodGet, "/notes?q=Private", nil, false, false), http.StatusOK)
	require.Zero(t, other.Total)
	for _, denied := range []struct {
		uid       int64
		token     bool
		noSession bool
		status    int
	}{
		{
			uid:    0,
			status: http.StatusUnauthorized,
		},
		{
			uid:    1,
			token:  true,
			status: http.StatusForbidden,
		},
		{
			uid:       1,
			noSession: true,
			status:    http.StatusForbidden,
		},
		{
			uid:    4,
			status: http.StatusForbidden,
		},
		{
			uid:    18,
			status: http.StatusForbidden,
		},
		{
			uid:    23,
			status: http.StatusForbidden,
		},
	} {
		for _, operation := range []struct {
			method string
			path   string
			body   any
		}{
			{
				method: http.MethodGet,
				path:   "/notes",
			},
			{
				method: http.MethodGet,
				path:   path,
			},
			{
				method: http.MethodPost,
				path:   "/notes",
				body:   map[string]any{"title": "Forbidden new note"},
			},
		} {
			rec := asterNotesRequest(t, e, denied.uid, operation.method, operation.path, operation.body, denied.token, denied.noSession)
			require.Equal(t, denied.status, rec.Code, rec.Body.String())
			require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		}
	}
}

//nolint:gosmopolitan // Logical storage counts must measure UTF-8 bytes, not code points.
func TestAsterNotesHTTPStorageIsOwnerScopedAndSeparateFromFileBytes(t *testing.T) {
	e, api := asterNotesFixture(t)
	originalPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(originalPath) })
	RegisterPersonalStorageRoutes(api)
	readStorage := func(uid int64) personalstorage.StorageSummary {
		return asterNotesDecode[personalstorage.StorageSummary](t, asterNotesRequest(t, e, uid, http.MethodGet, "/user/storage", nil, false, false), http.StatusOK)
	}
	before := readStorage(1)
	beforeOther := readStorage(2)
	note := asterNotesDecode[models.AsterNote](t, asterNotesRequest(t, e, 1, http.MethodPost, "/notes", map[string]any{
		"title":   "个人记录",
		"content": "# 自由与创造\n保留完整记录",
	}, false, false), http.StatusCreated)
	path := fmt.Sprintf("/notes/%d", note.ID)
	segment := asterNotesDecode[models.AsterNoteSegment](t, asterNotesRequest(t, e, 1, http.MethodPost, path+"/segments", map[string]any{
		"client_id": uuid.NewString(),
		"text":      "这是语音识别的最终记录。",
		"start_ms":  0,
		"end_ms":    4000,
	}, false, false), http.StatusCreated)
	after := readStorage(1)
	require.Equal(t, before.NoteCount+1, after.NoteCount)
	require.EqualValues(t, len(note.Content), after.NoteContentBytes-before.NoteContentBytes)
	require.EqualValues(t, len(segment.Text), after.NoteTranscriptBytes-before.NoteTranscriptBytes)
	require.EqualValues(t, len(note.Title)+len(note.Content)+len(segment.Text), after.NoteTextBytes-before.NoteTextBytes)
	require.Equal(t, before.TotalBytes, after.TotalBytes, "database text is not a claim of file bytes or immediately reclaimable disk")
	other := readStorage(2)
	require.Equal(t, beforeOther.NoteCount, other.NoteCount)
	require.Equal(t, beforeOther.NoteTextBytes, other.NoteTextBytes)
	deleted := asterNotesRequest(t, e, 1, http.MethodDelete, path, nil, false, false)
	require.Equal(t, http.StatusNoContent, deleted.Code)
	removed := readStorage(1)
	require.Equal(t, before.NoteCount, removed.NoteCount)
	require.Equal(t, before.NoteTextBytes, removed.NoteTextBytes)
	require.Equal(t, before.TotalBytes, removed.TotalBytes)
}

func TestAsterNotesHTTPLatestTranscriptPageIsBoundedOrderedAndPrivate(t *testing.T) {
	e, _ := asterNotesFixture(t)
	create := func(uid int64) models.AsterNote {
		return asterNotesDecode[models.AsterNote](t, asterNotesRequest(t, e, uid, http.MethodPost, "/notes", map[string]any{
			"title": "Long personal recording",
		}, false, false), http.StatusCreated)
	}
	note := create(1)
	other := create(2)
	const count = 137
	rows := make([]*models.AsterNoteSegment, 0, count*2)
	var ownBytes int64
	for index := 0; index < count; index++ {
		text := fmt.Sprintf("Own HTTP record %03d", index)
		ownBytes += int64(len(text))
		rows = append(rows,
			&models.AsterNoteSegment{
				NoteID:   note.ID,
				ClientID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index*2+1),
				Text:     text,
				StartMS:  int64(index) * 1000,
				EndMS:    int64(index+1) * 1000,
			},
			&models.AsterNoteSegment{
				NoteID:   other.ID,
				ClientID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index*2+2),
				Text:     "Another account's hidden words",
			},
		)
	}
	seed := db.NewSession()
	defer seed.Close()
	for start := 0; start < len(rows); start += 100 {
		end := min(start+100, len(rows))
		_, err := seed.Insert(rows[start:end])
		require.NoError(t, err)
	}
	_, err := seed.ID(note.ID).Cols("segment_count", "transcript_bytes").Update(&models.AsterNote{
		SegmentCount:    count,
		TranscriptBytes: ownBytes,
	})
	require.NoError(t, err)
	_, err = seed.ID(other.ID).Cols("segment_count", "transcript_bytes").Update(&models.AsterNote{
		SegmentCount:    count,
		TranscriptBytes: int64(count * len("Another account's hidden words")),
	})
	require.NoError(t, err)
	require.NoError(t, seed.Commit())
	path := fmt.Sprintf("/notes/%d/segments", note.ID)
	request := func(query string) *httptest.ResponseRecorder {
		return asterNotesRequest(t, e, 1, http.MethodGet, path+query, nil, false, false)
	}
	page := asterNotesDecode[models.AsterNoteSegmentPage](t, request("?latest=true"), http.StatusOK)
	require.True(t, page.FromEnd)
	require.False(t, page.HasMore)
	require.EqualValues(t, count, page.Total)
	require.Len(t, page.Items, 100)
	for index, segment := range page.Items {
		require.Equal(t, note.ID, segment.NoteID)
		require.Equal(t, fmt.Sprintf("Own HTTP record %03d", count-100+index), segment.Text)
		if index > 0 {
			require.Greater(t, segment.ID, page.Items[index-1].ID+1)
		}
	}
	require.Equal(t, page.Items[99].ID, page.NextCursor)
	first := asterNotesDecode[models.AsterNoteSegmentPage](t, request("?per_page=2"), http.StatusOK)
	require.False(t, first.FromEnd)
	require.True(t, first.HasMore)
	require.Equal(t, "Own HTTP record 000", first.Items[0].Text)
	require.Equal(t, "Own HTTP record 001", first.Items[1].Text)
	tail := asterNotesDecode[models.AsterNoteSegmentPage](t, request("?latest=true&per_page=2"), http.StatusOK)
	require.True(t, tail.FromEnd)
	require.False(t, tail.HasMore)
	require.Len(t, tail.Items, 2)
	require.Equal(t, "Own HTTP record 135", tail.Items[0].Text)
	require.Equal(t, "Own HTTP record 136", tail.Items[1].Text)
	invalid := request("?latest=true&after_id=1")
	require.Equal(t, http.StatusUnprocessableEntity, invalid.Code, invalid.Body.String())
	require.Equal(t, "no-store", invalid.Header().Get("Cache-Control"))
	require.Contains(t, invalid.Body.String(), "note_invalid_cursor")
	forbidden := asterNotesRequest(t, e, 2, http.MethodGet, path+"?latest=true", nil, false, false)
	require.Equal(t, http.StatusNotFound, forbidden.Code, forbidden.Body.String())
	require.Equal(t, "no-store", forbidden.Header().Get("Cache-Control"))
	require.NotContains(t, forbidden.Body.String(), "Own HTTP record")
	forbidden = asterNotesRequest(t, e, 1, http.MethodGet, path+"?latest=true", nil, true, false)
	require.Equal(t, http.StatusForbidden, forbidden.Code, forbidden.Body.String())
}
