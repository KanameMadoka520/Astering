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

package webtests

import (
	"bytes"
	"encoding/json"
	"fmt"
	"image"
	"image/png"
	"net/http/httptest"
	"strings"
	"testing"

	"code.vikunja.io/api/pkg/files"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

//nolint:gosmopolitan // Verify Unicode writing is preserved through real HTTP requests.
func TestCompassHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	request := func(method, path, body string) *httptest.ResponseRecorder {
		return humaRequest(t, e, method, path, body, token, "")
	}
	created := request("POST", "/api/v2/compass/spaces", `{"title":"星图","motto":"自由与创造","theme":"aurora","team_id":0}`)
	require.Equal(t, 201, created.Code, created.Body.String())
	var space models.CompassSpace
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &space))
	require.EqualValues(t, 1, space.Revision)
	path := fmt.Sprintf("/api/v2/compass/spaces/%d", space.ID)
	require.Equal(t, 403, humaRequest(t, e, "GET", path, "", other, "").Code)
	require.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
	list := request("GET", "/api/v2/compass/spaces", "")
	require.Equal(t, 200, list.Code, list.Body.String())
	require.Contains(t, list.Body.String(), `"total":1`)
	latest := request("GET", path, "")
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("If-None-Match", latest.Header().Get("ETag"))
	cached := httptest.NewRecorder()
	e.ServeHTTP(cached, req)
	require.Equal(t, 304, cached.Code)
	edited := request("PATCH", path, `{"motto":"记住方向","revision":1}`)
	require.Equal(t, 200, edited.Code, edited.Body.String())
	require.Contains(t, edited.Body.String(), `"title":"星图"`)
	require.Equal(t, 409, request("PATCH", path, `{"motto":"stale","revision":1}`).Code)
	entries := path + "/entries"
	created = request("POST", entries, `{"kind":"vision","title":"创造的自由","content":"<p>One <strong>step</strong> at a time.</p>","category":"方向","tags":["长期"],"theme":"inherit","state":"active","pinned":true}`)
	require.Equal(t, 201, created.Code, created.Body.String())
	var entry models.CompassEntry
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &entry))
	require.Equal(t, space.ID, entry.SpaceID)
	ep := fmt.Sprintf("/api/v2/compass/entries/%d", entry.ID)
	list = request("GET", entries+"?pinned=true", "")
	require.Equal(t, 200, list.Code, list.Body.String())
	require.Contains(t, list.Body.String(), `"total":1`)
	require.NotContains(t, list.Body.String(), `"content":`)
	list = request("GET", entries+"?pinned=false", "")
	require.Contains(t, list.Body.String(), `"total":0`)
	list = request("GET", entries+"?kind=memory", "")
	require.Contains(t, list.Body.String(), `"total":0`)
	require.Equal(t, 200, request("GET", path+"/topics", "").Code)
	require.Equal(t, 403, humaRequest(t, e, "GET", ep, "", other, "").Code)
	edited = request("PATCH", ep, `{"content":"<p>Revised</p>","revision":1}`)
	require.Equal(t, 200, edited.Code, edited.Body.String())
	require.Contains(t, edited.Body.String(), "创造的自由")
	require.Equal(t, 409, request("PATCH", ep, `{"quote":"stale","revision":1}`).Code)
	history := request("GET", ep+"/revisions", "")
	require.Equal(t, 200, history.Code, history.Body.String())
	require.Contains(t, history.Body.String(), `"total":2`)
	require.NotContains(t, history.Body.String(), "Revised")
	require.Equal(t, 403, humaRequest(t, e, "GET", ep+"/revisions/1", "", other, "").Code)
	restored := request("POST", ep+"/revisions/1/restore", `{"expected_revision":2}`)
	require.Equal(t, 200, restored.Code, restored.Body.String())
	require.Contains(t, restored.Body.String(), "One ")
	require.Contains(t, restored.Body.String(), `"revision":3`)
	require.Equal(t, 400, request("DELETE", ep+"?revision=3", "").Code)
	trashed := request("PATCH", ep, `{"state":"trashed","revision":3}`)
	require.Equal(t, 200, trashed.Code, trashed.Body.String())
	require.Contains(t, trashed.Body.String(), `"pinned":false`)
	require.Contains(t, request("GET", entries, "").Body.String(), `"total":0`)
	require.Contains(t, request("GET", entries+"?state=trashed", "").Body.String(), `"total":1`)
	require.Equal(t, 409, request("DELETE", ep+"?revision=3", "").Code)
	require.Equal(t, 204, request("DELETE", ep+"?revision=4", "").Code)
	require.Equal(t, 404, request("GET", ep, "").Code)
}

//nolint:gosmopolitan // Verify Unicode writing is preserved through real HTTP requests.
func TestCompassHTTPTeamAccess(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	admin := humaTokenFor(t, &testuser1)
	member := humaTokenFor(t, &testuser2)
	create := func(token string) *httptest.ResponseRecorder {
		return humaRequest(t, e, "POST", "/api/v2/compass/spaces", `{"title":"共同纲领","theme":"solar","team_id":1}`, token, "")
	}
	require.Equal(t, 403, create(member).Code)
	r := create(admin)
	require.Equal(t, 201, r.Code, r.Body.String())
	var space models.CompassSpace
	require.NoError(t, json.Unmarshal(r.Body.Bytes(), &space))
	path := fmt.Sprintf("/api/v2/compass/spaces/%d", space.ID)
	r = humaRequest(t, e, "GET", path, "", member, "")
	require.Equal(t, 200, r.Code, r.Body.String())
	require.Contains(t, r.Body.String(), `"max_permission":1`)
	require.Equal(t, 403, humaRequest(t, e, "PATCH", path, `{"title":"Not admin","revision":1}`, member, "").Code)
	r = humaRequest(t, e, "POST", path+"/entries", `{"kind":"note","title":"Member note","theme":"inherit","state":"active"}`, member, "")
	require.Equal(t, 201, r.Code, r.Body.String())
	var entry models.CompassEntry
	require.NoError(t, json.Unmarshal(r.Body.Bytes(), &entry))
	ep := fmt.Sprintf("/api/v2/compass/entries/%d", entry.ID)
	require.Equal(t, 200, humaRequest(t, e, "PATCH", ep, `{"state":"trashed","revision":1}`, member, "").Code)
	require.Equal(t, 403, humaRequest(t, e, "DELETE", ep+"?revision=2", "", member, "").Code)
	require.Equal(t, 204, humaRequest(t, e, "DELETE", ep+"?revision=2", "", admin, "").Code)
}

//nolint:gosmopolitan // Verify Unicode writing is preserved through real HTTP requests.
func TestCompassConcurrentHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	if db.Type() != schemas.POSTGRES {
		t.Skip("Concurrent row locks are verified against isolated PostgreSQL")
	}
	token := humaTokenFor(t, &testuser1)
	r := humaRequest(t, e, "POST", "/api/v2/compass/spaces", `{"title":"Concurrent","theme":"ink"}`, token, "")
	require.Equal(t, 201, r.Code, r.Body.String())
	var space models.CompassSpace
	require.NoError(t, json.Unmarshal(r.Body.Bytes(), &space))
	r = humaRequest(t, e, "POST", fmt.Sprintf("/api/v2/compass/spaces/%d/entries", space.ID), `{"title":"Original","kind":"note","theme":"inherit","state":"active"}`, token, "")
	require.Equal(t, 201, r.Code, r.Body.String())
	var entry models.CompassEntry
	require.NoError(t, json.Unmarshal(r.Body.Bytes(), &entry))
	path := fmt.Sprintf("/api/v2/compass/entries/%d", entry.ID)
	// Separate full PUT requests share the same revision. At most one may win.
	statuses := make(chan int, 6)
	for i := range 6 {
		go func(n int) {
			body := fmt.Sprintf(`{"title":"Writer %d","kind":"note","theme":"inherit","state":"active","revision":1}`, n)
			req := httptest.NewRequest("PUT", path, strings.NewReader(body))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			rec := httptest.NewRecorder()
			e.ServeHTTP(rec, req)
			statuses <- rec.Code
		}(i)
	}
	successes := 0
	for range 6 {
		status := <-statuses
		if status == 200 {
			successes++
		} else {
			require.Equal(t, 409, status)
		}
	}
	require.Equal(t, 1, successes)
	r = humaRequest(t, e, "GET", path+"/revisions", "", token, "")
	require.Equal(t, 200, r.Code, r.Body.String())
	require.Contains(t, r.Body.String(), `"total":2`)
}

func TestCompassImagesHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	files.InitTestFileFixtures(t)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	s := db.NewSession()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))))
	f, err := files.CreateWithSession(s, bytes.NewReader(b.Bytes()), "photo.png", 0, &testuser1)
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	space := &models.CompassSpace{Title: "Images", Theme: "aurora"}
	require.NoError(t, space.Create(s, &testuser1))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	path := fmt.Sprintf("/api/v2/compass/spaces/%d/images/%d", space.ID, f.ID)
	response := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Equal(t, b.Bytes(), response.Body.Bytes())
	require.Equal(t, "image/png", response.Header().Get("Content-Type"))
	require.Equal(t, "nosniff", response.Header().Get("X-Content-Type-Options"))
	require.Equal(t, "private, no-cache", response.Header().Get("Cache-Control"))
	require.Contains(t, strings.Join(response.Header().Values("Vary"), ","), "Authorization")
	require.Contains(t, strings.Join(response.Header().Values("Vary"), ","), "Cookie")
	require.Contains(t, response.Header().Get("Content-Disposition"), "inline")
	req := httptest.NewRequest("GET", path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("If-None-Match", response.Header().Get("ETag"))
	cached := httptest.NewRecorder()
	e.ServeHTTP(cached, req)
	require.Equal(t, 304, cached.Code)
	req.Header.Set("Authorization", "Bearer "+other)
	denied := httptest.NewRecorder()
	e.ServeHTTP(denied, req)
	require.Equal(t, 404, denied.Code)
	require.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
	payload, err := json.Marshal(map[string]any{"title": "Illustrated", "kind": "note", "theme": "inherit", "state": "active", "content": fmt.Sprintf(`<p>Caption</p><img data-compass-image="%d" src="https://example.invalid/tracker">`, f.ID)})
	require.NoError(t, err)
	created := humaRequest(t, e, "POST", fmt.Sprintf("/api/v2/compass/spaces/%d/entries", space.ID), string(payload), token, "")
	require.Equal(t, 201, created.Code, created.Body.String())
	require.Contains(t, created.Body.String(), `"image_count":1`)
	require.NotContains(t, created.Body.String(), "tracker")
}
