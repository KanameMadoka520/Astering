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
	"sync"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

var aiBucketDatabase sync.Once

// The package TestMain only sets up logging; the bucket executor needs the fixture database.
func aiBucketFixtures(t *testing.T) {
	t.Helper()
	aiBucketDatabase.Do(func() {
		config.InitDefaultConfig()
		i18n.Init()
		files.InitTests()
		user.InitTests()
		models.SetupTests()
		events.Fake()
	})
	db.LoadAndAssertFixtures(t)
}

// User 1 owns project 1 (kanban view 4: buckets 1/2/3, default 1, done 3, bucket 2 full at
// limit 3), reads project 9, writes project 10 and cannot access projects 2 and 20.
func aiBucketExecutor(input tcyai.RunInput) *aiExecution {
	return &aiExecution{auth: &user.User{ID: 1}, input: input}
}

func aiBucketWriter() *aiExecution {
	return aiBucketExecutor(tcyai.RunInput{Mode: "write"})
}

func aiBucketRead(t *testing.T, e *aiExecution, name string, args map[string]any) (map[string]any, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	out, err := e.executeBucket(context.Background(), name, raw)
	if err != nil {
		return nil, err
	}
	result := map[string]any{}
	require.NoError(t, json.Unmarshal([]byte(out), &result))
	return result, nil
}

// aiBucketPrepare builds the preview the runtime shows for review.
func aiBucketPrepare(t *testing.T, e *aiExecution, name string, args map[string]any) (tcyai.Operation, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	op, err := e.prepareBucket(context.Background(), name, raw)
	op.Tool = name
	op.Arguments = string(raw)
	return op, err
}

// aiBucketExecute runs a prepared receipt the way the runtime does after validation and review.
func aiBucketExecute(t *testing.T, e *aiExecution, op *tcyai.Operation) (map[string]any, error) {
	t.Helper()
	out, err := e.executeBucket(tcyai.WithOperation(context.Background(), op), op.Tool, json.RawMessage(op.Arguments))
	if err != nil {
		return nil, err
	}
	result := map[string]any{}
	require.NoError(t, json.Unmarshal([]byte(out), &result))
	return result, nil
}

func requireAIBucketCode(t *testing.T, err error, code string) {
	t.Helper()
	var toolErr *tcyai.ToolError
	require.ErrorAs(t, err, &toolErr)
	assert.Equal(t, code, toolErr.Code, toolErr.Message)
}

// aiBucketEntity decodes the single review entity of a preview.
func aiBucketEntity(t *testing.T, op tcyai.Operation) map[string]any {
	t.Helper()
	rows := []map[string]any{}
	require.NoError(t, json.Unmarshal([]byte(op.Before), &rows))
	require.Len(t, rows, 1)
	return rows[0]
}

func aiBucketIDs(t *testing.T, rows any) []float64 {
	t.Helper()
	ids := []float64{}
	for _, row := range rows.([]any) {
		ids = append(ids, row.(map[string]any)["id"].(float64))
	}
	return ids
}

func aiBucketOrder(t *testing.T, viewID int64) []int64 {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	buckets, err := aiViewBuckets(s, viewID)
	require.NoError(t, err)
	ids := []int64{}
	for _, bucket := range buckets {
		ids = append(ids, bucket.ID)
	}
	return ids
}

func aiBucketTestTask(t *testing.T, id int64) models.Task {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	task, err := models.GetTaskSimple(s, &models.Task{ID: id})
	require.NoError(t, err)
	return task
}

func aiBucketCommit(t *testing.T, change func(s *xorm.Session) error) {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	require.NoError(t, change(s))
	require.NoError(t, s.Commit())
}

func TestAIBucketToolsRead(t *testing.T) {
	aiBucketFixtures(t)
	// Reading boards stays available in a read-only run.
	e := aiBucketExecutor(tcyai.RunInput{Mode: "read"})

	views, err := aiBucketRead(t, e, "list_project_views", map[string]any{"project_id": 1})
	require.NoError(t, err)
	byID := map[float64]map[string]any{}
	for _, row := range views["views"].([]any) {
		view := row.(map[string]any)
		byID[view["id"].(float64)] = view
	}
	require.Contains(t, byID, float64(4))
	assert.Equal(t, "kanban", byID[4]["view_kind"])
	assert.Equal(t, "manual", byID[4]["bucket_configuration_mode"])
	assert.InDelta(t, 1, byID[4]["default_bucket_id"], 0)
	assert.InDelta(t, 3, byID[4]["done_bucket_id"], 0)
	assert.InDelta(t, 3, byID[4]["bucket_count"], 0)
	assert.Equal(t, "list", byID[1]["view_kind"])
	assert.NotContains(t, byID[1], "bucket_count")

	board, err := aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 4})
	require.NoError(t, err)
	buckets := board["buckets"].([]any)
	assert.Equal(t, []float64{1, 2, 3}, aiBucketIDs(t, buckets))
	counts := []float64{}
	for _, row := range buckets {
		bucket := row.(map[string]any)
		counts = append(counts, bucket["task_count"].(float64))
		assert.NotContains(t, bucket, "tasks", "metadata must not embed tasks")
	}
	assert.Equal(t, []float64{11, 3, 4}, counts)
	assert.Equal(t, true, buckets[0].(map[string]any)["is_default"])
	assert.Equal(t, true, buckets[1].(map[string]any)["full"])
	assert.Equal(t, true, buckets[2].(map[string]any)["is_done"])

	page, err := aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 2})
	require.NoError(t, err)
	assert.ElementsMatch(t, []float64{3, 4, 5}, aiBucketIDs(t, page["tasks"]))
	assert.InDelta(t, 3, page["total"], 0)
	assert.InDelta(t, 1, page["total_pages"], 0)
	assert.InDelta(t, tcyai.BucketTasksPerPage, page["per_page"], 0)

	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 4, "page": 2})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")
	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 4})
	requireAIBucketCode(t, err, "NOT_FOUND")
	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 1})
	requireAIBucketCode(t, err, "VIEW_NOT_KANBAN")
	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 8})
	requireAIBucketCode(t, err, "NOT_FOUND")
	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 2, "view_id": 8})
	requireAIBucketCode(t, err, "FORBIDDEN")
	_, err = aiBucketRead(t, e, "list_project_views", map[string]any{"project_id": 2})
	requireAIBucketCode(t, err, "FORBIDDEN")
	_, err = aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": models.FavoritesPseudoProjectID, "view_id": 4})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")
}

func TestAIBucketToolsReadOnlyNeverWrites(t *testing.T) {
	aiBucketFixtures(t)
	args := map[string]any{"project_id": 1, "view_id": 4, "title": "Read only"}
	for _, mode := range []string{"read", ""} {
		e := aiBucketExecutor(tcyai.RunInput{Mode: mode})
		_, err := aiBucketPrepare(t, e, "create_bucket", args)
		requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
		raw, err := json.Marshal(args)
		require.NoError(t, err)
		forged := &tcyai.Operation{Tool: "create_bucket", Arguments: string(raw), Version: "forged", Approved: true}
		_, err = aiBucketExecute(t, e, forged)
		requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	}
	db.AssertMissing(t, "buckets", map[string]interface{}{"title": "Read only"})
}

func TestAIBucketToolsCreateAndUpdate(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()

	op, err := aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 1, "view_id": 4, "title": "Review"})
	require.NoError(t, err)
	assert.Equal(t, []int64{1}, op.ProjectIDs)
	assert.NotEmpty(t, op.Version)
	assert.Contains(t, op.Before, `"title":"testbucket3"`)
	assert.Contains(t, op.After, `"after_bucket_id":3`)
	result, err := aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	assert.True(t, op.Verified)
	assert.Equal(t, true, result["verified"])
	assert.InDelta(t, 4, result["bucket"].(map[string]any)["order"], 0)
	db.AssertExists(t, "buckets", map[string]interface{}{"title": "Review", "project_view_id": 4, "position": 3 + 65536}, false)

	op, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 1, "view_id": 4, "title": "Inbox", "after_bucket_id": 0, "limit": 2})
	require.NoError(t, err)
	result, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	inbox := int64(result["bucket"].(map[string]any)["id"].(float64))
	assert.Equal(t, inbox, aiBucketOrder(t, 4)[0])
	db.AssertExists(t, "buckets", map[string]interface{}{"id": inbox, "limit": 2}, false)

	op, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 3, "title": "Finished", "limit": 5, "after_bucket_id": 0})
	require.NoError(t, err)
	entity := aiBucketEntity(t, op)
	assert.Equal(t, "testbucket3", entity["title"])
	assert.InDelta(t, 0, entity["limit"], 0)
	assert.InDelta(t, 2, entity["after_bucket_id"], 0)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	assert.True(t, op.Verified)
	assert.Equal(t, int64(3), aiBucketOrder(t, 4)[0])
	db.AssertExists(t, "buckets", map[string]interface{}{"id": 3, "title": "Finished", "limit": 5}, false)

	op, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "limit": 2})
	require.NoError(t, err)
	assert.Contains(t, op.After, "limit_below_task_count")

	_, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")
	_, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "after_bucket_id": 1})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")
	_, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "after_bucket_id": 4})
	requireAIBucketCode(t, err, "NOT_FOUND")
	_, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 1, "view_id": 1, "title": "List view"})
	requireAIBucketCode(t, err, "VIEW_NOT_KANBAN")

	_, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 9, "view_id": 36, "title": "Read share"})
	requireAIBucketCode(t, err, "FORBIDDEN")
	op, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 10, "view_id": 40, "title": "Write share"})
	require.NoError(t, err)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	// Buckets 10 and 26 share position 0, so there is no room in front of them.
	_, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 10, "view_id": 40, "title": "Squeezed", "after_bucket_id": 0})
	requireAIBucketCode(t, err, "POSITION_UNAVAILABLE")

	scoped := aiBucketExecutor(tcyai.RunInput{Mode: "write", WriteProjectIDs: []int64{10}})
	_, err = aiBucketPrepare(t, scoped, "create_bucket", map[string]any{"project_id": 1, "view_id": 4, "title": "Out of scope"})
	requireAIBucketCode(t, err, "SCOPE_DENIED")

	op, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 1, "view_id": 4, "title": "Stale"})
	require.NoError(t, err)
	aiBucketCommit(t, func(s *xorm.Session) error {
		_, err := s.Where("id = ?", 2).Cols("title").Update(&models.Bucket{Title: "renamed meanwhile"})
		return err
	})
	_, err = aiBucketExecute(t, e, &op)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	assert.False(t, op.Verified)
	db.AssertMissing(t, "buckets", map[string]interface{}{"title": "Stale"})

	_, err = e.executeBucket(context.Background(), "create_bucket", json.RawMessage(`{"project_id":1,"view_id":4,"title":"Unprepared"}`))
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	db.AssertMissing(t, "buckets", map[string]interface{}{"title": "Unprepared"})
}

func TestAIBucketToolsMoveTask(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()
	events.ClearDispatchedEvents()

	op, err := aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 3, "task_id": 1})
	require.NoError(t, err)
	entity := aiBucketEntity(t, op)
	assert.InDelta(t, 1, entity["bucket_id"], 0)
	assert.Equal(t, false, entity["done"])
	assert.Contains(t, op.Before, "marks_task_done")
	assert.Equal(t, []int64{1}, op.ProjectIDs)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	assert.True(t, op.Verified)
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 1, "done": true}, false)
	db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": 1, "project_view_id": 4, "bucket_id": 3}, false)
	events.AssertDispatched(t, &models.TaskUpdatedEvent{})

	op, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "task_id": 2})
	require.NoError(t, err)
	assert.Contains(t, op.Before, "reopens_task")
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 2, "done": false}, false)

	// A repeating task advances its dates instead of being done and stays out of the done bucket.
	repeating := aiBucketTestTask(t, 28)
	op, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 3, "task_id": 28})
	require.NoError(t, err)
	assert.Contains(t, op.Before, "repeating_task_advances_dates")
	assert.Contains(t, op.Before, "stays_in_current_bucket")
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	advanced := aiBucketTestTask(t, 28)
	assert.False(t, advanced.Done)
	assert.True(t, advanced.DueDate.After(repeating.DueDate))
	db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": 28, "project_view_id": 4, "bucket_id": 1}, false)

	op, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "task_id": 28})
	require.NoError(t, err)
	assert.Contains(t, op.Before, "already_in_bucket")
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)

	_, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 2, "task_id": 1})
	requireAIBucketCode(t, err, "BUCKET_LIMIT_EXCEEDED")
	// Task 34 is in a project user 1 cannot access; task 19 lives in another project than this board.
	_, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "task_id": 34})
	requireAIBucketCode(t, err, "FORBIDDEN")
	_, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "task_id": 19})
	requireAIBucketCode(t, err, "FORBIDDEN")
	scoped := aiBucketExecutor(tcyai.RunInput{Mode: "write", WriteProjectIDs: []int64{10}})
	_, err = aiBucketPrepare(t, scoped, "move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1, "task_id": 1})
	requireAIBucketCode(t, err, "SCOPE_DENIED")
}

func TestAIBucketToolsSavedFilterBoard(t *testing.T) {
	aiBucketFixtures(t)
	var projectID int64
	view := &models.ProjectView{}
	aiBucketCommit(t, func(s *xorm.Session) error {
		filter := &models.SavedFilter{Title: "open work", Filters: &models.TaskCollection{Filter: "done = false"}}
		if err := filter.Create(s, &user.User{ID: 1}); err != nil {
			return err
		}
		projectID = -filter.ID - 1
		exists, err := s.Where("project_id = ? AND view_kind = ?", projectID, models.ProjectViewKindKanban).Get(view)
		if err != nil {
			return err
		}
		require.True(t, exists, "saved filters get a kanban view")
		return nil
	})
	e := aiBucketWriter()

	views, err := aiBucketRead(t, e, "list_project_views", map[string]any{"project_id": projectID})
	require.NoError(t, err)
	assert.Contains(t, views, "saved_filter")
	board, err := aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": projectID, "view_id": view.ID})
	require.NoError(t, err)
	buckets := aiBucketIDs(t, board["buckets"])
	require.Len(t, buckets, 3)

	op, err := aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": projectID, "view_id": view.ID, "bucket_id": buckets[1], "task_id": 1})
	require.NoError(t, err)
	// The pseudo project is not a project; the task's own project is what the move affects.
	assert.Equal(t, []int64{1}, op.ProjectIDs)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": 1, "project_view_id": view.ID, "bucket_id": int64(buckets[1])}, false)

	// Task 2 is done, so it does not match the filter and is not part of this board.
	_, err = aiBucketPrepare(t, e, "move_task_to_bucket", map[string]any{"project_id": projectID, "view_id": view.ID, "bucket_id": buckets[0], "task_id": 2})
	requireAIBucketCode(t, err, "FORBIDDEN")

	// A project write scope cannot be widened through a board that spans projects.
	scoped := aiBucketExecutor(tcyai.RunInput{Mode: "write", WriteProjectIDs: []int64{1}})
	_, err = aiBucketPrepare(t, scoped, "move_task_to_bucket", map[string]any{"project_id": projectID, "view_id": view.ID, "bucket_id": buckets[0], "task_id": 1})
	requireAIBucketCode(t, err, "SCOPE_DENIED")
	_, err = aiBucketPrepare(t, scoped, "create_bucket", map[string]any{"project_id": projectID, "view_id": view.ID, "title": "Scoped"})
	requireAIBucketCode(t, err, "SCOPE_DENIED")
}

func TestAIBucketToolsSetViewBuckets(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()

	op, err := aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 1, "view_id": 4, "done_bucket_id": 2})
	require.NoError(t, err)
	entity := aiBucketEntity(t, op)
	assert.InDelta(t, 1, entity["default_bucket_id"], 0)
	assert.InDelta(t, 3, entity["done_bucket_id"], 0)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	assert.True(t, op.Verified)
	// Only the requested id changes; title, kind, mode and the default bucket stay.
	db.AssertExists(t, "project_views", map[string]interface{}{
		"id":                        4,
		"title":                     "Kanban",
		"view_kind":                 models.ProjectViewKindKanban,
		"bucket_configuration_mode": models.BucketConfigurationModeManual,
		"default_bucket_id":         1,
		"done_bucket_id":            2,
	}, false)
	// Existing tasks keep their done state.
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 3, "done": false}, false)

	_, err = aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 1, "view_id": 4, "default_bucket_id": 2})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")
	_, err = aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 1, "view_id": 4, "done_bucket_id": 4})
	requireAIBucketCode(t, err, "NOT_FOUND")
	_, err = aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 1, "view_id": 4})
	requireAIBucketCode(t, err, "INVALID_ARGUMENTS")

	op, err = aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 1, "view_id": 4, "done_bucket_id": 0})
	require.NoError(t, err)
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	db.AssertExists(t, "project_views", map[string]interface{}{"id": 4, "default_bucket_id": 1, "done_bucket_id": 0}, false)

	// Write access is enough for buckets but not for view settings, which need admin.
	_, err = aiBucketPrepare(t, e, "set_view_buckets", map[string]any{"project_id": 10, "view_id": 40, "default_bucket_id": 26})
	requireAIBucketCode(t, err, "FORBIDDEN")
	_, err = aiBucketPrepare(t, e, "update_bucket", map[string]any{"project_id": 10, "view_id": 40, "bucket_id": 26, "title": "Doing"})
	require.NoError(t, err)
}

func TestAIBucketToolsDeleteBucket(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()

	// The default/leftmost column now has a surviving destination.
	defaultOp, err := aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1})
	require.NoError(t, err)
	assert.InDelta(t, 2, aiBucketEntity(t, defaultOp)["move_to_bucket_id"], 0)

	op, err := aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 2})
	require.NoError(t, err)
	entity := aiBucketEntity(t, op)
	assert.InDelta(t, 3, entity["tasks_moved"], 0)
	assert.InDelta(t, 0, entity["tasks_deleted"], 0)
	assert.InDelta(t, 1, entity["move_to_bucket_id"], 0)
	assert.Equal(t, "testbucket1", entity["move_to_bucket_title"])
	assert.Len(t, entity["sample_tasks"], 3)

	// Never without the user's approval, whatever the approval mode.
	_, err = aiBucketExecute(t, e, &op)
	requireAIBucketCode(t, err, "REVIEW_REQUIRED")
	db.AssertExists(t, "buckets", map[string]interface{}{"id": 2}, false)
	op.Approved = true
	result, err := aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	assert.True(t, op.Verified)
	assert.InDelta(t, 3, result["tasks_moved"], 0)
	db.AssertMissing(t, "buckets", map[string]interface{}{"id": 2})
	for _, task := range []int64{3, 4, 5} {
		db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": task, "project_view_id": 4, "bucket_id": 1}, false)
		db.AssertExists(t, "tasks", map[string]interface{}{"id": task}, false)
	}

	op, err = aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 3})
	require.NoError(t, err)
	entity = aiBucketEntity(t, op)
	assert.Equal(t, []any{"done_bucket_id"}, entity["clears"])
	assert.InDelta(t, 1, entity["done_tasks_moved"], 0)
	op.Approved = true
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	db.AssertExists(t, "project_views", map[string]interface{}{"id": 4, "default_bucket_id": 1, "done_bucket_id": 0}, false)
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 2, "done": true}, false)

	_, err = aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1})
	requireAIBucketCode(t, err, "LAST_BUCKET")
	_, err = aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 33, "view_id": 132, "bucket_id": 36})
	requireAIBucketCode(t, err, "LAST_BUCKET")

	// Without an explicit default, deletion chooses the next surviving column.
	defaultOp, err = aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 10, "view_id": 40, "bucket_id": 10})
	require.NoError(t, err)
	assert.InDelta(t, 26, aiBucketEntity(t, defaultOp)["move_to_bucket_id"], 0)
	op, err = aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 10, "view_id": 40, "bucket_id": 26})
	require.NoError(t, err)
	assert.InDelta(t, 0, aiBucketEntity(t, op)["tasks_moved"], 0)
	aiBucketCommit(t, func(s *xorm.Session) error {
		_, err := s.Where("id = ?", 10).Cols("title").Update(&models.Bucket{Title: "renamed meanwhile"})
		return err
	})
	op.Approved = true
	_, err = aiBucketExecute(t, e, &op)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	db.AssertExists(t, "buckets", map[string]interface{}{"id": 26}, false)
}

func TestAIBucketToolsFilterModeView(t *testing.T) {
	aiBucketFixtures(t)
	aiBucketCommit(t, func(s *xorm.Session) error {
		view := &models.ProjectView{
			ID:                      1,
			ProjectID:               1,
			Title:                   "Open work",
			ViewKind:                models.ProjectViewKindKanban,
			BucketConfigurationMode: models.BucketConfigurationModeFilter,
			BucketConfiguration: []*models.ProjectViewBucketConfiguration{
				{
					Title:  "Open",
					Filter: &models.TaskCollection{Filter: "done = false"},
				},
			},
		}
		return view.Update(s, &user.User{ID: 1})
	})
	e := aiBucketWriter()

	board, err := aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 1})
	require.NoError(t, err)
	buckets := board["buckets"].([]any)
	require.Len(t, buckets, 1)
	open := buckets[0].(map[string]any)
	assert.InDelta(t, 0, open["id"], 0)
	assert.Equal(t, "Open", open["title"])
	assert.Equal(t, "done = false", open["filter"])
	assert.Positive(t, open["task_count"].(float64))

	page, err := aiBucketRead(t, e, "list_buckets", map[string]any{"project_id": 1, "view_id": 1, "bucket_id": 0})
	require.NoError(t, err)
	tasks := page["tasks"].([]any)
	require.NotEmpty(t, tasks)
	for _, row := range tasks {
		assert.Equal(t, false, row.(map[string]any)["done"])
	}

	_, err = aiBucketPrepare(t, e, "create_bucket", map[string]any{"project_id": 1, "view_id": 1, "title": "Manual"})
	requireAIBucketCode(t, err, "VIEW_NOT_MANUAL")
}

func TestAIBucketToolsDeleteDefaultKeepsTasks(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()
	op, err := aiBucketPrepare(t, e, "delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 1})
	require.NoError(t, err)
	assert.InDelta(t, 2, aiBucketEntity(t, op)["move_to_bucket_id"], 0)
	op.Approved = true
	_, err = aiBucketExecute(t, e, &op)
	require.NoError(t, err)
	db.AssertMissing(t, "task_buckets", map[string]interface{}{"bucket_id": 1})
	db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": 1, "bucket_id": 2, "project_view_id": 4}, false)
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 1, "done": false}, false)
}
