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
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/stretchr/testify/require"
)

func TestTaskRoutinePeriodHTTP(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	path := "/api/v2/tasks/1/routine"
	saved := humaRequest(t, e, "PUT", path, `{"enabled":true,"timezone":"UTC","revision":0,"period":"weekly","reset_hour":5,"week_start":1,"target":1800,"unit":"ml"}`, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	var task models.Task
	require.NoError(t, json.Unmarshal(saved.Body.Bytes(), &task))
	require.NotNil(t, task.Routine)
	body := fmt.Sprintf(`{"date":%q,"revision":%d,"amount":1200}`, task.Routine.Date, task.Routine.Revision)
	require.Equal(t, 401, humaRequest(t, e, "POST", path+"/progress", body, "", "").Code)
	require.Equal(t, 403, humaRequest(t, e, "POST", path+"/progress", body, other, "").Code)
	for range 2 {
		response := humaRequest(t, e, "POST", path+"/progress", body, token, "")
		require.Equal(t, 200, response.Code, response.Body.String())
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &task))
		require.Equal(t, int64(1200), task.Routine.CurrentAmount)
		require.False(t, task.Routine.CompletedPeriod)
		require.False(t, task.Done)
	}
	body = fmt.Sprintf(`{"date":%q,"revision":%d,"amount":1800}`, task.Routine.Date, task.Routine.Revision)
	response := humaRequest(t, e, "POST", path+"/progress", body, token, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	read := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, read.Code)
	var routine models.TaskRoutine
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &routine))
	require.True(t, routine.CompletedPeriod)
	require.Equal(t, int64(1800), routine.CurrentAmount)
	require.False(t, routine.PeriodStartAt.IsZero())
	require.True(t, routine.NextResetAt.After(routine.PeriodStartAt))
	require.Equal(t, 409, humaRequest(t, e, "POST", path+"/progress", fmt.Sprintf(`{"date":%q,"revision":0,"amount":2}`, routine.Date), token, "").Code)
	require.Equal(t, 409, humaRequest(t, e, "POST", path+"/progress", fmt.Sprintf(`{"date":"2000-01-01","revision":%d,"amount":2}`, routine.Revision), token, "").Code)
	require.Equal(t, 422, humaRequest(t, e, "POST", path+"/progress", fmt.Sprintf(`{"date":%q,"revision":%d,"amount":-1}`, routine.Date, routine.Revision), token, "").Code)
	require.Equal(t, 422, humaRequest(t, e, "POST", path+"/progress", fmt.Sprintf(`{"date":%q,"amount":2}`, routine.Date), token, "").Code)
	paused := humaRequest(t, e, "PATCH", path, fmt.Sprintf(`{"paused":true,"revision":%d}`, routine.Revision), token, "")
	require.Equal(t, 200, paused.Code, paused.Body.String())
	require.Equal(t, 400, humaRequest(t, e, "POST", path+"/progress", body, token, "").Code)
}
