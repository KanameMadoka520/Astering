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

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"github.com/stretchr/testify/require"
)

func TestTaskRepeatBucketHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	path := "/api/v2/tasks/28/repeat-buckets/4"
	read := humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, 200, read.Code, read.Body.String())
	require.Contains(t, read.Body.String(), `"repeat_return_mode":"default"`)
	update := humaRequest(t, e, http.MethodPut, path, `{"repeat_return_mode":"keep","repeat_return_bucket_id":0,"task_id":34,"project_view_id":8}`, token, "")
	require.Equal(t, 200, update.Code, update.Body.String())
	require.Contains(t, update.Body.String(), `"task_id":28`)
	require.Contains(t, update.Body.String(), `"project_view_id":4`)
	read = humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, 200, read.Code, read.Body.String())
	require.Contains(t, read.Body.String(), `"repeat_return_mode":"keep"`)
	require.Equal(t, 403, humaRequest(t, e, http.MethodGet, path, "", other, "").Code)
	require.Equal(t, 403, humaRequest(t, e, http.MethodPut, path, `{"repeat_return_mode":"default","repeat_return_bucket_id":0}`, other, "").Code)
	require.Equal(t, 401, humaRequest(t, e, http.MethodGet, path, "", "", "").Code)
	for _, body := range []string{
		`{"repeat_return_mode":"invalid","repeat_return_bucket_id":0}`,
		`{"repeat_return_mode":"bucket","repeat_return_bucket_id":3}`,
		`{"repeat_return_mode":"bucket","repeat_return_bucket_id":4}`,
		`{"repeat_return_mode":"keep","repeat_return_bucket_id":2}`,
	} {
		rejected := humaRequest(t, e, http.MethodPut, path, body, token, "")
		require.Equal(t, http.StatusUnprocessableEntity, rejected.Code, rejected.Body.String())
	}
	read = humaRequest(t, e, http.MethodGet, path, "", token, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var policy models.TaskRepeatBucketPolicy
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &policy))
	require.Equal(t, "keep", policy.RepeatReturnMode, "invalid policies must not change the stored policy")
	require.Zero(t, policy.RepeatReturnBucketID)
	// Keep survives a real Done move and a subsequent fresh read.
	moved := humaRequest(t, e, http.MethodPut, "/api/v2/projects/1/views/4/buckets/3/tasks", `{"task_id":28}`, token, "")
	require.Equal(t, 200, moved.Code, moved.Body.String())
	var response models.TaskBucket
	require.NoError(t, json.Unmarshal(moved.Body.Bytes(), &response))
	require.Equal(t, int64(1), response.BucketID)
	require.Equal(t, int64(1), response.Bucket.ID)
	require.False(t, response.Task.Done)
	db.AssertExists(t, "task_buckets", map[string]any{
		"task_id":            28,
		"project_view_id":    4,
		"bucket_id":          1,
		"repeat_return_mode": "keep",
	}, false)
}
