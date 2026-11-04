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
	"net/http"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The committed index 60001 row is also the isolated PostgreSQL runner's proof
// that this HTTP test used its configured database, not an implicit SQLite DB.
func TestTaskOrderHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	s := db.NewSession()
	task := &models.Task{
		Title:     "Task order database proof",
		ProjectID: 1,
		Index:     60001,
	}
	_, err = s.Insert(task)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	path := "/api/v2/projects/1/views/1/task-order"
	rec := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	var page models.TaskOrderPage
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &page))
	require.NotEmpty(t, page.Items)
	require.Len(t, page.OrderVersion, 64)
	assert.NotContains(t, rec.Body.String(), `"description"`)
	// The new missing-position task is not the first row: other zero positions
	// precede it by real ID. Move it before that actual first anchor.
	require.NotEqual(t, task.ID, page.Items[0].ID)
	body, err := json.Marshal(models.TaskOrderChange{
		TaskIDs:      []int64{task.ID},
		BeforeTaskID: page.Items[0].ID,
		OrderVersion: page.OrderVersion,
	})
	require.NoError(t, err)
	for _, foreignToken := range []string{"", humaTokenFor(t, &testuser2)} {
		denied := humaRequest(t, e, http.MethodPost, path, string(body), foreignToken, "")
		require.GreaterOrEqual(t, denied.Code, 400, denied.Body.String())
	}
	rec = humaRequest(t, e, http.MethodPost, path, string(body), token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var result models.TaskOrderResult
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	require.Equal(t, []int64{task.ID}, result.TaskIDs)
	require.True(t, result.ManualOrderSaved)
	require.True(t, result.Verified)
	require.NotEmpty(t, result.ChangedPositions)
	assert.Contains(t, rec.Body.String(), `"view_kind":"list"`)
	read := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &page))
	require.Equal(t, task.ID, page.Items[0].ID)
	require.Equal(t, result.OrderVersion, page.OrderVersion)
	stale := humaRequest(t, e, http.MethodPost, path, string(body), token, "")
	require.Equal(t, http.StatusConflict, stale.Code, stale.Body.String())
	unchanged := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.JSONEq(t, read.Body.String(), unchanged.Body.String())
	db.AssertExists(t, "task_positions", map[string]interface{}{
		"task_id":         task.ID,
		"project_view_id": int64(1),
		"position":        page.Items[0].Position,
	}, false)
}
