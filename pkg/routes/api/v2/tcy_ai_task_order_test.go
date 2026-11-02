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
	"testing"

	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAITaskOrderExecution(t *testing.T) {
	aiBucketFixtures(t)
	writer := aiBucketWriter()
	readArgs := json.RawMessage(`{"project_id":1,"view_id":1}`)
	raw, err := writer.executeTaskOrder(context.Background(), "list_view_tasks", readArgs)
	require.NoError(t, err)
	var page models.TaskOrderPage
	require.NoError(t, json.Unmarshal([]byte(raw), &page))
	require.Greater(t, len(page.Items), 1)
	assert.NotContains(t, raw, `"description"`)
	target := page.Items[len(page.Items)-1].ID
	args, err := json.Marshal(aiTaskOrderArgs{
		TaskOrderChange: models.TaskOrderChange{
			TaskIDs:      []int64{target},
			BeforeTaskID: page.Items[0].ID,
			OrderVersion: page.OrderVersion,
		},
		ProjectID: 1,
		ViewID:    1,
	})
	require.NoError(t, err)
	op, err := writer.prepareTaskOrder(context.Background(), args)
	require.NoError(t, err)
	assert.Equal(t, 1, op.Units)
	assert.Equal(t, []int64{1}, op.ProjectIDs)
	assert.Contains(t, op.Before, `"title"`)
	assert.JSONEq(t, string(args), op.After)
	reader := aiBucketExecutor(tcyai.RunInput{Mode: "read"})
	_, err = reader.prepareTaskOrder(context.Background(), args)
	require.Error(t, err)
	restricted := aiBucketExecutor(tcyai.RunInput{
		Mode:            "write",
		WriteProjectIDs: []int64{2},
	})
	_, err = restricted.prepareTaskOrder(context.Background(), args)
	require.Error(t, err)
	out, err := writer.executeTaskOrder(tcyai.WithOperation(context.Background(), &op), "reorder_view_tasks", args)
	require.NoError(t, err)
	require.True(t, op.Verified)
	var result models.TaskOrderResult
	require.NoError(t, json.Unmarshal([]byte(out), &result))
	assert.Equal(t, []int64{target}, result.TaskIDs)
	assert.NotEmpty(t, result.ChangedPositions)
	_, err = writer.executeTaskOrder(tcyai.WithOperation(context.Background(), &op), "reorder_view_tasks", args)
	require.Error(t, err)
	for _, denied := range []string{
		`{"project_id":2,"view_id":5}`,
		`{"project_id":1,"view_id":5}`,
	} {
		_, err = writer.executeTaskOrder(context.Background(), "list_view_tasks", json.RawMessage(denied))
		require.Error(t, err)
	}
}
