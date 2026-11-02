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
	"testing"

	"code.vikunja.io/api/pkg/models"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTaskAllDayHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	body := `{"title":"All-day HTTP fixture","all_day":true,"all_day_start":"2040-06-01","all_day_end":"2040-06-03"}`
	denied := humaRequest(t, e, http.MethodPost, "/api/v2/projects/2/tasks", body, token, "")
	require.GreaterOrEqual(t, denied.Code, 400)
	rec := humaRequest(t, e, http.MethodPost, "/api/v2/projects/1/tasks", body, token, "")
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var task models.Task
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	require.True(t, task.AllDay)
	path := fmt.Sprintf("/api/v2/tasks/%d", task.ID)
	rec = humaRequest(t, e, http.MethodPatch, path, `{"description":"Preserve civil date"}`, token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	assert.True(t, task.AllDay)
	assert.Equal(t, "2040-06-01", task.AllDayStart)
	before := humaRequest(t, e, http.MethodGet, path, "", token, "")
	for _, bad := range []string{
		`{"all_day_end":"2040-06-01"}`,
		`{"start_date":"2040-06-01T10:00:00Z"}`,
		`{"repeat_after":3600}`,
	} {
		rejected := humaRequest(t, e, http.MethodPatch, path, bad, token, "")
		require.GreaterOrEqual(t, rejected.Code, 400, rejected.Body.String())
		unchanged := humaRequest(t, e, http.MethodGet, path, "", token, "")
		require.JSONEq(t, before.Body.String(), unchanged.Body.String())
	}
	for _, zone := range []string{"Pacific%2FKiritimati", "America%2FLos_Angeles"} {
		rec = humaRequest(t, e, http.MethodGet, "/api/v2/tasks/calendar?from=2040-06-02&to=2040-06-03&timezone="+zone, "", token, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		assert.Contains(t, rec.Body.String(), `"all_day_start":"2040-06-01"`)
		assert.Contains(t, rec.Body.String(), `"all_day_end":"2040-06-03"`)
	}
	rec = humaRequest(t, e, http.MethodPatch, path, `{"all_day":false,"all_day_start":"","all_day_end":"","start_date":"2040-06-01T09:00:00Z","end_date":"2040-06-01T10:00:00Z"}`, token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
	assert.False(t, task.AllDay)
	assert.Empty(t, task.AllDayStart)
	assert.Empty(t, task.AllDayEnd)
	assert.Equal(t, 9, task.StartDate.Hour())
}
