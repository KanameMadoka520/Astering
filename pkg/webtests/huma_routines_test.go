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
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

func TestProjectAnnouncementHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	path := "/api/v2/projects/1/announcement"
	read := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, read.Code, read.Body.String())
	require.Contains(t, read.Body.String(), `"revision":0`)
	require.Contains(t, read.Body.String(), `"max_permission":2`)
	saved := humaRequest(t, e, "PUT", path, `{"title":"Notice","content":"<p>Hello</p>","revision":0}`, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	conditional := func(etag string) *httptest.ResponseRecorder {
		req := httptest.NewRequest("GET", path, nil)
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("If-None-Match", etag)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		return rec
	}
	current := conditional(read.Header().Get("ETag"))
	require.Equal(t, 200, current.Code)
	require.Equal(t, 304, conditional(current.Header().Get("ETag")).Code)
	conflict := humaRequest(t, e, "PUT", path, `{"title":"Stale","content":"","revision":0}`, token, "")
	require.Equal(t, 409, conflict.Code, conflict.Body.String())
	saved = humaRequest(t, e, "PATCH", path, `{"title":"Patched","revision":1}`, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	require.Contains(t, saved.Body.String(), "Hello")
	require.Equal(t, 403, humaRequest(t, e, "PUT", path, `{"title":"x","content":"","revision":2}`, other, "").Code)
	require.Equal(t, 403, humaRequest(t, e, "GET", path, "", other, "").Code)
	require.Equal(t, 401, humaRequest(t, e, "GET", path, "", "", "").Code)
}

func TestTaskRoutineHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	// Every setup must clear quota snapshots left by preceding HTTP tests.
	s := db.NewSession()
	progressCount, countErr := s.Count(&models.TaskRoutineProgress{})
	s.Close()
	require.NoError(t, countErr)
	require.Zero(t, progressCount)
	token := humaTokenFor(t, &testuser1)
	path := "/api/v2/tasks/1/routine"
	rec := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	rec = humaRequest(t, e, "PUT", path, `{"enabled":true,"paused":false,"timezone":"Asia/Shanghai","revision":0}`, token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var task models.Task
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.NotNil(t, task.Routine)
	date := task.Routine.Date
	require.Equal(t, 422, humaRequest(t, e, "POST", path+"/check-in", fmt.Sprintf(`{"date":%q}`, date), token, "").Code)
	before := humaRequest(t, e, "GET", "/api/v2/tasks/1", "", token, "")
	require.Equal(t, 200, before.Code)
	for range 2 {
		rec = humaRequest(t, e, "POST", path+"/check-in", fmt.Sprintf(`{"date":%q,"completed":true}`, date), token, "")
		require.Equal(t, 200, rec.Code, rec.Body.String())
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
		require.True(t, task.Routine.CompletedToday)
		require.False(t, task.Done)
	}
	req := httptest.NewRequest("GET", "/api/v2/tasks/1", nil)
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("If-None-Match", before.Header().Get("ETag"))
	etagRead := httptest.NewRecorder()
	e.ServeHTTP(etagRead, req)
	require.Equal(t, 200, etagRead.Code)
	rec = humaRequest(t, e, "POST", path+"/check-in", `{"date":"2000-01-01","completed":true}`, token, "")
	require.Equal(t, 409, rec.Code)
	for _, body := range []string{`{"done":true}`, `{"repeat_after":86400}`} {
		rec = humaRequest(t, e, "PATCH", "/api/v2/tasks/1", body, token, "")
		require.Equal(t, 400, rec.Code, rec.Body.String())
	}
	d, _ := time.Parse(time.DateOnly, date)
	rec = humaRequest(t, e, "GET", fmt.Sprintf("%s/history?year=%d&month=%d", path, d.Year(), d.Month()), "", token, "")
	require.Equal(t, 200, rec.Code)
	var h models.TaskRoutineHistory
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &h))
	require.Equal(t, 1, h.TotalCheckins)
	require.Len(t, h.Items, 1)
	rec = humaRequest(t, e, "PATCH", path, `{"paused":true,"revision":1}`, token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.True(t, task.Routine.Enabled)
	require.True(t, task.Routine.Paused)
	rec = humaRequest(t, e, "POST", path+"/check-in", fmt.Sprintf(`{"date":%q,"completed":false}`, date), token, "")
	require.Equal(t, 400, rec.Code)
	rec = humaRequest(t, e, "PUT", path, `{"enabled":false,"paused":false,"timezone":"UTC","revision":2}`, token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	rec = humaRequest(t, e, "PATCH", "/api/v2/tasks/1", `{"done":true}`, token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	require.Contains(t, rec.Body.String(), `"done":true`)
	rec = humaRequest(t, e, "GET", fmt.Sprintf("%s/history?year=%d&month=%d", path, d.Year(), d.Month()), "", token, "")
	require.Equal(t, 200, rec.Code)
	require.Contains(t, rec.Body.String(), `"total_checkins":1`)
	other := humaTokenFor(t, &testuser2)
	require.Equal(t, 403, humaRequest(t, e, "GET", path, "", other, "").Code)
	require.Equal(t, 403, humaRequest(t, e, "POST", path+"/check-in", fmt.Sprintf(`{"date":%q,"completed":true}`, date), other, "").Code)
}

func TestTaskRoutineConcurrentHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	if db.Type() != schemas.POSTGRES {
		t.Skip("Row-lock concurrency is checked against isolated PostgreSQL")
	}
	token := humaTokenFor(t, &testuser1)
	rec := humaRequest(t, e, "PUT", "/api/v2/tasks/1/routine", `{"enabled":true,"paused":false,"timezone":"UTC","revision":0}`, token, "")
	require.Equal(t, 200, rec.Code, rec.Body.String())
	var task models.Task
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	statuses := make(chan int, 12)
	var wg sync.WaitGroup
	for range 12 {
		wg.Go(func() {
			req := httptest.NewRequest("POST", "/api/v2/tasks/1/routine/check-in", strings.NewReader(fmt.Sprintf(`{"date":%q,"completed":true}`, task.Routine.Date)))
			req.Header.Set("Authorization", "Bearer "+token)
			req.Header.Set("Content-Type", "application/json")
			out := httptest.NewRecorder()
			e.ServeHTTP(out, req)
			statuses <- out.Code
		})
	}
	wg.Wait()
	close(statuses)
	for status := range statuses {
		require.Equal(t, http.StatusOK, status)
	}
	s := db.NewSession()
	defer s.Close()
	count, err := s.Where("task_id = ?", 1).Count(&models.TaskRoutineCheckin{})
	require.NoError(t, err)
	require.Equal(t, int64(1), count)
}
