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
	"net/http/httptest"
	"testing"

	"code.vikunja.io/api/pkg/models"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/humatest"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIAllDayDispatchAndMutation(t *testing.T) {
	cfg := huma.DefaultConfig("All-day dispatch fixture", "test")
	cfg.FieldsOptionalByDefault = true // Match NewAPI, including the real request schema policy.
	_, api := humatest.New(t, cfg)
	Register(api, huma.Operation{
		OperationID: "fixture-create",
		Method:      http.MethodPost,
		Path:        GroupPrefix + "/projects/1/tasks",
	}, func(_ context.Context, in *struct{ Body models.Task }) (*singleBody[models.Task], error) {
		return &singleBody[models.Task]{Body: &in.Body}, nil
	})
	raw := json.RawMessage(`{"project_id":1,"title":"Civil tool","all_day":true,"all_day_start":"2040-11-03","all_day_end":"2040-11-04"}`)
	caller := httptest.NewRequest(http.MethodPost, "/", nil)
	output, err := dispatchAI(context.Background(), api, caller, "create_task", raw)
	require.NoError(t, err)
	assert.Contains(t, output, `"all_day":true`)
	assert.Contains(t, output, `"all_day_start":"2040-11-03"`)
	aiBucketFixtures(t)
	writer := aiBucketWriter()
	preview := calendarMutationPreview(t)
	change := json.RawMessage(`{"id":1,"all_day":true,"all_day_start":"2040-11-03","all_day_end":"2040-11-04","start_date":"0001-01-01T00:00:00Z","end_date":"0001-01-01T00:00:00Z"}`)
	_, err = writer.mutateTasks(context.Background(), "update_task", change, preview)
	require.NoError(t, err)
	saved := aiBucketTestTask(t, 1)
	assert.True(t, saved.AllDay)
	assert.Equal(t, "2040-11-04", saved.AllDayEnd)
	preview = calendarMutationPreview(t)
	_, err = writer.mutateTasks(context.Background(), "update_task", json.RawMessage(`{"id":1,"all_day":false,"all_day_start":"","all_day_end":""}`), preview)
	require.NoError(t, err)
	saved = aiBucketTestTask(t, 1)
	assert.False(t, saved.AllDay)
	assert.Empty(t, saved.AllDayStart)
}
