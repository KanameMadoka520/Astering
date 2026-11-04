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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestCalendarTasksHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	s := db.NewSession()
	defer s.Close()
	instant := time.Date(2024, 3, 10, 12, 0, 0, 0, time.UTC)
	rows := []models.Task{
		{
			Title:       "Calendar visible",
			ProjectID:   1,
			Index:       30000,
			DueDate:     instant,
			Description: "Description must not be projected",
		},
		{
			Title:     "Calendar second",
			ProjectID: 1,
			Index:     30001,
			StartDate: instant,
		},
		{
			Title:     "Calendar inaccessible",
			ProjectID: 2,
			Index:     30002,
			DueDate:   instant,
		},
	}
	for index := range rows {
		_, err = s.Insert(&rows[index])
		require.NoError(t, err)
		require.Positive(t, rows[index].ID)
	}
	require.NoError(t, s.Commit())
	path := "/api/v2/tasks/calendar?from=2024-03-10&to=2024-03-11&timezone=America%2FNew_York&per_page=1"
	rec := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
	var response struct {
		Items      []map[string]json.RawMessage `json:"items"`
		Total      int                          `json:"total"`
		Page       int                          `json:"page"`
		PerPage    int                          `json:"per_page"`
		TotalPages int                          `json:"total_pages"`
		Timezone   string                       `json:"timezone"`
		Days       []models.CalendarDayBoundary `json:"days"`
	}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response.Items, 1)
	assert.Equal(t, 2, response.Total)
	assert.Equal(t, 2, response.TotalPages)
	assert.Equal(t, 1, response.Page)
	assert.Equal(t, 1, response.PerPage)
	assert.Equal(t, "America/New_York", response.Timezone)
	require.Len(t, response.Days, 1)
	assert.Equal(t, 23*time.Hour, response.Days[0].EndAt.Sub(response.Days[0].StartAt))
	for _, field := range []string{"description", "attachments", "related_tasks", "assignees", "reminders"} {
		assert.NotContains(t, response.Items[0], field)
	}
	var id int64
	require.NoError(t, json.Unmarshal(response.Items[0]["id"], &id))
	assert.Equal(t, rows[0].ID, id)
	rec = humaRequest(t, e, http.MethodGet, path+"&page=2", "", token, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
	require.Len(t, response.Items, 1)
	require.NoError(t, json.Unmarshal(response.Items[0]["id"], &id))
	assert.Equal(t, rows[1].ID, id)
	for _, project := range []string{"2", "99999999"} {
		rec = humaRequest(t, e, http.MethodGet, path+"&project_id="+project, "", token, "")
		require.Equal(t, http.StatusOK, rec.Code)
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &response))
		assert.Empty(t, response.Items)
		assert.Zero(t, response.Total)
	}
	for _, query := range []string{
		"from=2024-02-30&to=2024-03-01",
		"from=2024-01-01&to=2024-04-01",
		"from=2024-03-11&to=2024-03-10",
		"from=2024-03-10&to=2024-03-11&timezone=Not-A-Timezone",
		"from=2011-12-29&to=2011-12-31&timezone=Pacific%2FApia",
	} {
		rec = humaRequest(t, e, http.MethodGet, "/api/v2/tasks/calendar?"+query, "", token, "")
		assert.Equal(t, http.StatusBadRequest, rec.Code, rec.Body.String())
	}
	for _, query := range []string{"&project_id=-1", "&done=invalid", "&page=0"} {
		rec = humaRequest(t, e, http.MethodGet, path+query, "", token, "")
		assert.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	}
	rec = humaRequest(t, e, http.MethodGet, path, "", "", "")
	assert.Equal(t, http.StatusUnauthorized, rec.Code)
}
