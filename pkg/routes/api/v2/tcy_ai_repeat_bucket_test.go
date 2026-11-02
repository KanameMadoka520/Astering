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
	"encoding/json"
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/stretchr/testify/require"
)

func TestAIRepeatBucketPolicyExecution(t *testing.T) {
	aiBucketFixtures(t)
	executor := aiBucketWriter()
	args := map[string]any{
		"project_id":              1,
		"view_id":                 4,
		"task_id":                 28,
		"repeat_return_mode":      "keep",
		"repeat_return_bucket_id": 0,
	}
	op, err := aiBucketPrepare(t, executor, "set_task_repeat_bucket", args)
	require.NoError(t, err)
	out, err := aiBucketExecute(t, executor, &op)
	require.NoError(t, err)
	require.True(t, op.Verified)
	require.Equal(t, "keep", out["repeat_bucket"].(map[string]any)["repeat_return_mode"])
	read, err := aiBucketRead(t, executor, "get_task_repeat_bucket", map[string]any{
		"project_id": 1,
		"view_id":    4,
		"task_id":    28,
	})
	require.NoError(t, err)
	require.Equal(t, "keep", read["repeat_return_mode"])
	// A policy change after preparation changes the actual Done destination, even if task timestamps share a second.
	move, err := aiBucketPrepare(t, executor, "move_task_to_bucket", map[string]any{
		"project_id": 1,
		"view_id":    4,
		"task_id":    28,
		"bucket_id":  3,
	})
	require.NoError(t, err)
	s := db.NewSession()
	_, err = s.Where("task_id = ? AND project_view_id = ?", 28, 4).
		Cols("repeat_return_mode").Update(&models.TaskBucket{RepeatReturnMode: "default"})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	_, err = aiBucketExecute(t, executor, &move)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	scoped := aiBucketExecutor(tcyai.RunInput{
		Mode:            "write",
		WriteProjectIDs: []int64{10},
	})
	_, err = aiBucketPrepare(t, scoped, "set_task_repeat_bucket", args)
	requireAIBucketCode(t, err, "SCOPE_DENIED")
	readonly := aiBucketExecutor(tcyai.RunInput{Mode: "read"})
	_, err = aiBucketPrepare(t, readonly, "set_task_repeat_bucket", args)
	requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
}

func TestAIReminderSnapshotIncludesRelativeAnchor(t *testing.T) {
	first := []byte(`{"id":1,"project_id":1,"reminders":[{"reminder":"2026-11-03T04:00:00Z","relative_to":"due_date","relative_period":-60}]}`)
	second := []byte(`{"id":1,"project_id":1,"reminders":[{"reminder":"2026-11-03T04:00:00Z","relative_to":"start_date","relative_period":0}]}`)
	a, err := aiTaskSnapshot(first)
	require.NoError(t, err)
	b, err := aiTaskSnapshot(second)
	require.NoError(t, err)
	_, versionA, err := aiSnapshotVersion([]map[string]any{a})
	require.NoError(t, err)
	_, versionB, err := aiSnapshotVersion([]map[string]any{b})
	require.NoError(t, err)
	require.NotEqual(t, versionA, versionB)
	// Stable field/row ordering still produces the same review version.
	var reordered map[string]any
	require.NoError(t, json.Unmarshal(first, &reordered))
	reordered["reminders"].([]any)[0].(map[string]any)["id"] = 999
	bytes, err := json.Marshal(reordered)
	require.NoError(t, err)
	c, err := aiTaskSnapshot(bytes)
	require.NoError(t, err)
	_, versionC, err := aiSnapshotVersion([]map[string]any{c})
	require.NoError(t, err)
	require.Equal(t, versionA, versionC)
}
