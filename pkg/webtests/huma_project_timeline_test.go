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

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"github.com/stretchr/testify/require"
)

func TestProjectTimelineHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	s := db.NewSession()
	defer s.Close()
	for _, id := range []int64{1, 2} {
		_, err = s.Insert(&models.Task{Title: "Timeline HTTP", ProjectID: id, StartDate: time.Date(2024, 2, 28, 12, 0, 0, 0, time.UTC), DueDate: time.Date(2024, 3, 1, 12, 0, 0, 0, time.UTC)})
		require.NoError(t, err)
	}
	_, err = s.Insert(&models.Task{Title: "Deadline-only HTTP", ProjectID: 1, Index: 10001, DueDate: time.Date(2024, 4, 1, 12, 0, 0, 0, time.UTC)})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	path := "/api/v2/projects/timeline?year=2024&project=1&timezone=UTC"
	rec := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	var result models.ProjectTimeline
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	require.Equal(t, 1, result.Projects)
	require.Equal(t, 1, result.Days["2024-02-29"].ScheduledProjects)
	require.Equal(t, 1, result.DeadlineOnlyTasks)
	require.Equal(t, 1, result.Days["2024-04-01"].DeadlineProjects)
	require.Zero(t, result.Days["2024-04-01"].ScheduledProjects)
	rec = humaRequest(t, e, http.MethodGet, path+"&day=2024-04-01", "", token, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	require.Equal(t, 1, result.Total)
	rec = humaRequest(t, e, http.MethodGet, "/api/v2/projects/timeline?year=2024&project=2", "", token, "")
	require.Equal(t, http.StatusOK, rec.Code)
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	require.Zero(t, result.Projects)
	require.Zero(t, result.ExcludedTasks)
	for _, query := range []string{"year=2024&timezone=bad", "year=2024&day=2023-01-01", "year=2024&day=2024-02-30", "year=2024&status=bad", "year=1969", "year=2024&page=0"} {
		rec = humaRequest(t, e, http.MethodGet, "/api/v2/projects/timeline?"+query, "", token, "")
		require.Equal(t, http.StatusUnprocessableEntity, rec.Code, rec.Body.String())
	}
	rec = humaRequest(t, e, http.MethodGet, path, "", "", "")
	require.Equal(t, http.StatusUnauthorized, rec.Code)
}
