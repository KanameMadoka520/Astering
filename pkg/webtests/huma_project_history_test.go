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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/stretchr/testify/require"
)

func TestProjectHistoryHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	for _, id := range []int{1, 1} {
		rec := humaRequest(t, e, http.MethodPost, fmt.Sprintf("/api/v2/projects/%d/completion", id), `{"completed":true}`, token, "")
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var p models.Project
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &p))
		require.True(t, p.IsCompleted)
	}
	for _, id := range []int{2, 9, 10} {
		rec := humaRequest(t, e, http.MethodPost, fmt.Sprintf("/api/v2/projects/%d/completion", id), `{"completed":true}`, token, "")
		require.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	}
	path := fmt.Sprintf("/api/v2/projects/history?year=%d&project=1", time.Now().UTC().Year())
	rec := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var history models.ProjectHistory
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &history))
	require.EqualValues(t, 1, history.Total)
	require.Equal(t, &models.ProjectHistoryScope{Projects: 1, Completed: 1}, history.Scope)
	rec = humaRequest(t, e, http.MethodPost, "/api/v2/projects/1/completion", `{"completed":false}`, token, "")
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	rec = humaRequest(t, e, http.MethodGet, path+"&kind=all", "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &history))
	require.EqualValues(t, 2, history.Total)
	require.Equal(t, &models.ProjectHistoryScope{Projects: 1}, history.Scope)
	rec = humaRequest(t, e, http.MethodDelete, "/api/v2/projects/1", "", token, "")
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	rec = humaRequest(t, e, http.MethodGet, path+"&kind=all", "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &history))
	require.Zero(t, history.Total)
	require.Equal(t, &models.ProjectHistoryScope{}, history.Scope)
	rec = humaRequest(t, e, http.MethodGet, path+"&timezone=invalid", "", token, "")
	require.Equal(t, http.StatusUnprocessableEntity, rec.Code)
	rec = humaRequest(t, e, http.MethodGet, path, "", "", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
