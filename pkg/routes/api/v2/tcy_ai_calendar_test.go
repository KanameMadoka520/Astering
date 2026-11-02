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
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAICalendarRouting(t *testing.T) {
	var args map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(`{"from":"2024-03-10","to":"2024-03-11","timezone":"America/New_York","project_id":2,"include_archived":true,"done":"all","page":2,"per_page":10}`), &args))
	query := url.Values{}
	path, method, err := aiExtendedRoute("list_calendar_events", args, nil, query)
	require.NoError(t, err)
	assert.Equal(t, "/tasks/calendar", path)
	assert.Equal(t, http.MethodGet, method)
	assert.Empty(t, args, "read filters belong to URL, not a synthetic task write body")
	expected := url.Values{
		"from":             {"2024-03-10"},
		"to":               {"2024-03-11"},
		"timezone":         {"America/New_York"},
		"project_id":       {"2"},
		"include_archived": {"true"},
		"done":             {"all"},
		"page":             {"2"},
		"per_page":         {"10"},
	}
	assert.Equal(t, expected, query)
	query = url.Values{}
	require.NoError(t, aiCalendarQuery(nil, query))
	assert.Equal(t, "25", query.Get("per_page"))
}

func calendarMutationPreview(t *testing.T, id int64) tcyai.Operation {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	task := &models.Task{ID: id}
	require.NoError(t, task.ReadOne(s, &user.User{ID: 1}))
	data, err := json.Marshal(task)
	require.NoError(t, err)
	snapshot, err := aiTaskSnapshot(data)
	require.NoError(t, err)
	before, version, err := aiSnapshotVersion([]map[string]any{snapshot})
	require.NoError(t, err)
	return tcyai.Operation{
		Before:     before,
		Version:    version,
		ProjectIDs: []int64{task.ProjectID},
	}
}

func TestTCYAICalendarExistingScheduleWrites(t *testing.T) {
	aiBucketFixtures(t)
	ctx := context.Background()
	writer := aiBucketWriter()
	raw := json.RawMessage(`{"id":1,"start_date":"2024-03-10T09:00:00+08:00","end_date":"2024-03-10T10:00:00+08:00","due_date":"2024-03-11T12:00:00+08:00"}`)
	preview := calendarMutationPreview(t, 1)
	_, err := writer.mutateTasks(ctx, "update_task", raw, preview)
	require.NoError(t, err)
	saved := aiBucketTestTask(t, 1)
	assert.Equal(t, "2024-03-10T01:00:00Z", saved.StartDate.UTC().Format(time.RFC3339))
	assert.Equal(t, time.Hour, saved.EndDate.Sub(saved.StartDate))
	assert.Equal(t, "2024-03-11T04:00:00Z", saved.DueDate.UTC().Format(time.RFC3339))
	// Scheduling retains normal write scope and permissions; listing a task does
	// not authorize a write, including through a previously prepared receipt.
	restricted := aiBucketExecutor(tcyai.RunInput{
		Mode:            "write",
		WriteProjectIDs: []int64{10},
	})
	preview = calendarMutationPreview(t, 1)
	_, err = restricted.mutateTasks(ctx, "update_task", raw, preview)
	requireAIBucketCode(t, err, "SCOPE_DENIED")
	forbidden := &aiExecution{
		auth:  &user.User{ID: 2},
		input: tcyai.RunInput{Mode: "write"},
	}
	_, err = forbidden.mutateTasks(ctx, "update_task", raw, preview)
	requireAIBucketCode(t, err, "FORBIDDEN")
	_, err = writer.mutateTasks(ctx, "update_task", json.RawMessage(`{"id":1,"end_date":"2024-03-09T10:00:00Z"}`), preview)
	requireAIBucketCode(t, err, "INVALID_DATE_RANGE")
	// Clearing the calendar placement keeps the task and its separate deadline.
	_, err = writer.mutateTasks(ctx, "update_task", json.RawMessage(`{"id":1,"start_date":"0001-01-01T00:00:00Z","end_date":"0001-01-01T00:00:00Z"}`), preview)
	require.NoError(t, err)
	saved = aiBucketTestTask(t, 1)
	assert.True(t, saved.StartDate.IsZero())
	assert.True(t, saved.EndDate.IsZero())
	assert.Equal(t, "2024-03-11T04:00:00Z", saved.DueDate.UTC().Format(time.RFC3339))
	assert.False(t, saved.Done)
	assert.True(t, saved.DeletedAt.IsZero())
}
