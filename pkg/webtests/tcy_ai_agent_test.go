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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package webtests

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIAgentExecution(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token, other := humaTokenFor(t, &testuser1), humaTokenFor(t, &testuser2)
	oldPath, oldAllow := config.FilesBasePath.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []tcyai.Message  `json:"messages"`
			Tools    []map[string]any `json:"tools"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		last := body.Messages[len(body.Messages)-1]
		var request struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		for _, m := range body.Messages {
			if m.Role == "user" {
				_ = json.Unmarshal([]byte(m.Content), &request)
			}
		}
		name, args := request.Tool, request.Args
		if last.Role == "tool" && !strings.Contains(last.Content, `"note":"These tools`) && !strings.Contains(last.Content, `"transport":"invoke_tool_v1"`) {
			name = ""
		}
		loaded := false
		for _, tool := range body.Tools {
			fn, _ := tool["function"].(map[string]any)
			if fn["name"] == request.Tool {
				loaded = true
			}
		}
		if !loaded && last.Role == "tool" && fixtureDiscoveredTool(last.Content, request.Tool) {
			loaded = true
			if name != "" {
				wrapped, err := json.Marshal(map[string]any{"name": name, "arguments": args})
				if !assert.NoError(t, err) {
					return
				}
				name = "invoke_tool"
				args = wrapped
			}
		}
		if name != "" && !loaded {
			name = "find_tools"
			args = json.RawMessage(fmt.Sprintf(`{"query":%q}`, request.Tool))
		}
		message := map[string]any{"role": "assistant", "content": "Done"}
		if name != "" {
			message["content"] = ""
			message["tool_calls"] = []any{map[string]any{"id": "call-" + uuid.NewString(), "type": "function", "function": map[string]any{"name": name, "arguments": string(args)}}}
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("X-Request-ID", "fixture-provider-request")
		_ = json.NewEncoder(w).Encode(map[string]any{"model": "fixture-actual", "choices": []any{map[string]any{"message": message}}, "usage": map[string]int{"prompt_tokens": 10, "completion_tokens": 5}})
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	settings := fmt.Sprintf(`{"connections":[{"id":"fixture","name":"fixture","kind":"chat","protocol":"openai-chat","base_url":%q,"model":"requested","api_key":"never-export-private"}],"assistant":"fixture"}`, provider.URL)
	require.Equal(t, 200, humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "").Code)
	var project struct {
		ID int64 `json:"id"`
	}
	rec := humaRequest(t, e, "POST", "/api/v2/projects", `{"title":"Agent transaction fixture"}`, token, "")
	require.Equal(t, 201, rec.Code, rec.Body.String())
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &project))
	createTask := func(title string) int64 {
		rec := humaRequest(t, e, "POST", fmt.Sprintf("/api/v2/projects/%d/tasks", project.ID), fmt.Sprintf(`{"title":%q,"description":"preserve this description","priority":3}`, title), token, "")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		var task struct {
			ID int64 `json:"id"`
		}
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &task))
		return task.ID
	}
	one, two := createTask("one"), createTask("two")
	readTask := func(id int64) string {
		rec := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d", id), "", token, "")
		require.Equal(t, 200, rec.Code, rec.Body.String())
		return rec.Body.String()
	}
	wait := func(path string) tcyai.Conversation {
		var result tcyai.Conversation
		require.Eventually(t, func() bool {
			rec := humaRequest(t, e, "GET", path, "", token, "")
			if rec.Code != 200 {
				return false
			}
			if json.Unmarshal(rec.Body.Bytes(), &result) != nil || len(result.Turns) == 0 {
				return false
			}
			return result.Turns[len(result.Turns)-1].Status != "running"
		}, 5*time.Second, 10*time.Millisecond)
		return result
	}
	start := func(tool string, args any, policy string, scope []int64, budget int) (string, tcyai.Conversation) {
		rec := humaRequest(t, e, "POST", "/api/v2/ai/conversations", `{"title":"Agent review"}`, token, "")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		var conv tcyai.Conversation
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &conv))
		path := "/api/v2/ai/conversations/" + conv.ID
		prompt, encodeErr := json.Marshal(map[string]any{"tool": tool, "args": args})
		require.NoError(t, encodeErr)
		body, encodeErr := json.Marshal(map[string]any{"message": string(prompt), "mode": "write", "approval": policy, "request_id": uuid.NewString(), "write_project_ids": scope, "max_operations": budget, "stop_at_segment_limit": budget > 0, "allow_delete": true})
		require.NoError(t, encodeErr)
		rec = humaRequest(t, e, "POST", path+"/messages", string(body), token, "")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		return path, wait(path)
	}
	review := func(path string, conv tcyai.Conversation, decision, args string) *httptest.ResponseRecorder {
		last := conv.Turns[len(conv.Turns)-1]
		op := ""
		if last.Result.Pending != nil {
			op = last.Result.Pending.ID
		}
		body, encodeErr := json.Marshal(tcyai.ReviewInput{TurnID: last.ID, OperationID: op, Decision: decision, Arguments: args})
		require.NoError(t, encodeErr)
		return humaRequest(t, e, "POST", path+"/review", string(body), token, "")
	}
	path, conv := start("update_task", map[string]any{"id": one, "title": "proposed"}, "review", nil, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	require.NotNil(t, conv.Turns[0].Result.Pending)
	assert.Contains(t, readTask(one), `"title":"one"`)
	require.Equal(t, 404, humaRequest(t, e, "POST", path+"/review", fmt.Sprintf(`{"turn_id":%q,"decision":"approve"}`, conv.Turns[0].ID), other, "").Code)
	edited := review(path, conv, "edit", fmt.Sprintf(`{"id":%d,"title":"edited"}`, one))
	require.Equal(t, 201, edited.Code, edited.Body.String())
	var edit tcyai.Conversation
	require.NoError(t, json.Unmarshal(edited.Body.Bytes(), &edit))
	assert.NotEqual(t, conv.Turns[0].Result.Pending.ID, edit.Turns[0].Result.Pending.ID)
	assert.Equal(t, 409, review(path, conv, "approve", "").Code)
	require.Equal(t, 201, review(path, edit, "approve", "").Code)
	finished := wait(path)
	require.Equal(t, "completed", finished.Turns[0].Status)
	assert.True(t, finished.Turns[0].Result.Operations[1].Verified)
	assert.Equal(t, 200, finished.Turns[0].Result.Steps[0].HTTPStatus)
	assert.Equal(t, "fixture-provider-request", finished.Turns[0].Result.Steps[0].RequestID)
	assert.Contains(t, readTask(one), `"title":"edited"`)
	assert.Contains(t, readTask(one), "preserve this description")
	assert.Contains(t, readTask(one), `"priority":3`)
	assert.Equal(t, 409, review(path, edit, "approve", "").Code)
	// Changes made during review regenerate the preview, invalidating the old approval.
	path, conv = start("update_task", map[string]any{"id": one, "title": "after conflict"}, "review", nil, 0)
	changed := humaRequest(t, e, "PATCH", fmt.Sprintf("/api/v2/tasks/%d", one), `{"title":"external edit"}`, token, "")
	require.Equal(t, 200, changed.Code, changed.Body.String())
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	fresh := wait(path)
	require.Equal(t, "awaiting_approval", fresh.Turns[0].Status)
	assert.NotEqual(t, conv.Turns[0].Result.Pending.ID, fresh.Turns[0].Result.Pending.ID)
	assert.Contains(t, fresh.Turns[0].Result.Pending.Before, "external edit")
	assert.Contains(t, readTask(one), "external edit")
	require.Equal(t, 201, review(path, fresh, "reject", "").Code)
	finished = wait(path)
	assert.Equal(t, "rejected", finished.Turns[0].Result.Operations[1].Status)
	assert.Contains(t, readTask(one), "external edit")
	// A selected project is an enforced write boundary, not just a prompt suggestion.
	_, denied := start("update_task", map[string]any{"id": one, "title": "must not write"}, "auto", []int64{project.ID + 9999}, 0)
	assert.Contains(t, denied.Turns[0].Result.Actions[1].Result, "SCOPE_DENIED")
	assert.Contains(t, readTask(one), "external edit")
	// Bulk writes are one transaction. A later invalid date rolls back earlier valid changes.
	_, bulk := start("bulk_update_tasks", map[string]any{"updates": []any{map[string]any{"id": one, "changes": map[string]any{"title": "must roll back"}}, map[string]any{"id": two, "changes": map[string]any{"start_date": "2026-11-01T12:00:00+08:00", "end_date": "2026-11-01T10:00:00+08:00"}}}}, "auto", nil, 0)
	require.Len(t, bulk.Turns[0].Result.Actions, 2)
	assert.False(t, bulk.Turns[0].Result.Actions[1].Success)
	assert.Contains(t, readTask(one), "external edit")
	assert.Contains(t, readTask(two), `"title":"two"`)
	// Budget continuation resumes pending tools and does not repeat discovery or already completed operations.
	path, conv = start("bulk_update_tasks", map[string]any{"updates": []any{map[string]any{"id": one, "changes": map[string]any{"title": "bulk one"}}, map[string]any{"id": two, "changes": map[string]any{"title": "bulk two"}}}}, "auto", nil, 1)
	require.Equal(t, "paused", conv.Turns[0].Status)
	require.Equal(t, 201, review(path, conv, "continue", "").Code)
	conv = wait(path)
	require.Equal(t, "paused", conv.Turns[0].Status)
	require.Equal(t, 201, review(path, conv, "continue", "").Code)
	conv = wait(path)
	if conv.Turns[0].Status == "paused" {
		require.Equal(t, 201, review(path, conv, "continue", "").Code)
		conv = wait(path)
	}
	require.Equal(t, "completed", conv.Turns[0].Status)
	assert.Len(t, conv.Turns[0].Result.Actions, 2)
	assert.Contains(t, readTask(one), "bulk one")
	assert.Contains(t, readTask(two), "bulk two")
	path, conv = start("ask_user", map[string]any{"question": "Which day?", "choices": []string{"Monday", "Tuesday"}}, "smart", nil, 0)
	require.Equal(t, "awaiting_input", conv.Turns[0].Status)
	body, encodeErr := json.Marshal(tcyai.ReviewInput{TurnID: conv.Turns[0].ID, Decision: "answer", Answer: "Tuesday"})
	require.NoError(t, encodeErr)
	rec = humaRequest(t, e, "POST", path+"/review", string(body), token, "")
	require.Equal(t, 201, rec.Code, rec.Body.String())
	assert.Equal(t, "completed", wait(path).Turns[0].Status)
	// Exercise the extended catalog against actual business routes, not only schemas.
	_, conv = start("create_label", map[string]any{"title": "Agent fixture label", "hex_color": "aabbcc"}, "smart", nil, 0)
	require.Equal(t, "completed", conv.Turns[0].Status)
	var label struct {
		ID int64 `json:"id"`
	}
	require.Len(t, conv.Turns[0].Result.Actions, 2)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	require.NoError(t, json.Unmarshal([]byte(conv.Turns[0].Result.Actions[1].Result), &label))
	require.Positive(t, label.ID)
	_, conv = start("add_task_label", map[string]any{"id": one, "label_id": label.ID}, "smart", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, readTask(one), "Agent fixture label")
	_, conv = start("remove_task_label", map[string]any{"id": one, "label_id": label.ID}, "smart", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.NotContains(t, readTask(one), "Agent fixture label")
	path, conv = start("add_comment", map[string]any{"id": one, "comment": "Agent fixture comment"}, "auto", nil, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	before := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d/comments", one), "", token, "")
	assert.NotContains(t, before.Body.String(), "Agent fixture comment")
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	conv = wait(path)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	_, conv = start("list_comments", map[string]any{"id": one}, "smart", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, "Agent fixture comment")
	for _, name := range []string{"assign_task", "unassign_task"} {
		path, conv = start(name, map[string]any{"id": one, "user_id": testuser1.ID}, "auto", nil, 0)
		require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
		require.Equal(t, 201, review(path, conv, "approve", "").Code)
		conv = wait(path)
		require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
		var actual struct {
			Assignees []json.RawMessage `json:"assignees"`
		}
		require.NoError(t, json.Unmarshal([]byte(readTask(one)), &actual))
		if name == "assign_task" {
			assert.Len(t, actual.Assignees, 1)
		} else {
			assert.Empty(t, actual.Assignees)
		}
	}
	for _, name := range []string{"relate_tasks", "unrelate_tasks"} {
		_, conv = start(name, map[string]any{"id": one, "other_task_id": two, "relation_kind": "related"}, "smart", nil, 0)
		require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
		var actual struct {
			Related map[string][]json.RawMessage `json:"related_tasks"`
		}
		require.NoError(t, json.Unmarshal([]byte(readTask(one)), &actual))
		if name == "relate_tasks" {
			assert.Len(t, actual.Related["related"], 1)
		} else {
			assert.Empty(t, actual.Related["related"])
		}
	}
	_, conv = start("update_task", map[string]any{"id": one, "reminders": []any{map[string]any{"reminder": "2026-11-01T09:00:00+08:00"}}}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[0].Success, conv.Turns[0].Result.Actions[0].Result)
	var actual struct {
		Reminders []struct {
			Reminder time.Time `json:"reminder"`
		} `json:"reminders"`
	}
	require.NoError(t, json.Unmarshal([]byte(readTask(one)), &actual))
	require.Len(t, actual.Reminders, 1)
	expected, err := time.Parse(time.RFC3339, "2026-11-01T09:00:00+08:00")
	require.NoError(t, err)
	assert.True(t, actual.Reminders[0].Reminder.Equal(expected))
	// Color and progress are partial writes, including explicit clearing; review uses actual snapshots.
	path, conv = start("bulk_update_tasks", map[string]any{"updates": []any{map[string]any{"id": one, "changes": map[string]any{"hex_color": "aabbcc", "percent_done": 0.75, "is_favorite": true}}, map[string]any{"id": two, "changes": map[string]any{"hex_color": "123456"}}}}, "smart", []int64{project.ID}, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	assert.Contains(t, conv.Turns[0].Result.Pending.Before, `"hex_color":""`)
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	conv = wait(path)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, readTask(one), `"hex_color":"aabbcc"`)
	assert.Contains(t, readTask(one), `"percent_done":0.75`)
	assert.Contains(t, readTask(one), `"is_favorite":true`)
	assert.Contains(t, readTask(one), "preserve this description")
	assert.Contains(t, readTask(two), `"hex_color":"123456"`)
	_, conv = start("update_task", map[string]any{"id": one, "hex_color": "", "percent_done": 0, "is_favorite": false, "repeat_after": 86400, "repeat_mode": 2}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, readTask(one), `"hex_color":""`)
	assert.Contains(t, readTask(one), `"percent_done":0`)
	assert.Contains(t, readTask(one), `"repeat_after":86400`)
	assert.Contains(t, readTask(one), `"repeat_mode":2`)
	_, conv = start("update_task", map[string]any{"id": one, "project_id": project.ID + 9999}, "auto", []int64{project.ID}, 0)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, "SCOPE_DENIED")
	_, conv = start("update_project", map[string]any{"id": project.ID, "hex_color": "abcdef", "is_favorite": true}, "auto", []int64{project.ID}, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	projectResult := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/projects/%d", project.ID), "", token, "")
	assert.Contains(t, projectResult.Body.String(), `"hex_color":"abcdef"`)
	assert.Contains(t, projectResult.Body.String(), `"is_favorite":true`)
	assert.Contains(t, projectResult.Body.String(), "Agent transaction fixture")
	// Project completion is independent of tasks, preserves history, and obeys scope and review.
	tasksBeforeCompletion := readTask(one)
	_, conv = start("set_project_completed", map[string]any{
		"id":        project.ID,
		"completed": true,
	}, "auto", []int64{project.ID + 9999}, 0)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, "SCOPE_DENIED")
	path, conv = start("set_project_completed", map[string]any{
		"id":        project.ID,
		"completed": true,
	}, "review", []int64{project.ID}, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	projectResult = humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/projects/%d", project.ID), "", token, "")
	assert.Contains(t, projectResult.Body.String(), `"is_completed":false`)
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	finished = wait(path)
	require.True(t, finished.Turns[0].Result.Actions[1].Success, finished.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, finished.Turns[0].Result.Actions[1].Result, `"is_completed":true`)
	assert.Equal(t, tasksBeforeCompletion, readTask(one))
	_, conv = start("set_project_completed", map[string]any{
		"id":        project.ID,
		"completed": true,
	}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	_, conv = start("list_project_history", map[string]any{
		"year":       time.Now().Year(),
		"timezone":   "UTC",
		"project_id": project.ID,
		"kind":       "all",
	}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"milestones":1`)
	_, conv = start("list_project_timeline", map[string]any{
		"year":       time.Now().Year(),
		"timezone":   "Asia/Shanghai",
		"project_id": project.ID,
	}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"excluded_tasks":`)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"timezone":"Asia/Shanghai"`)
	_, conv = start("set_project_completed", map[string]any{
		"id":        project.ID,
		"completed": false,
	}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"is_completed":false`)
	_, conv = start("list_project_history", map[string]any{
		"year":       time.Now().Year(),
		"project_id": project.ID,
		"kind":       "all",
	}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"milestones":2`)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"kind":"reopened"`)
	_, conv = start("update_project", map[string]any{"id": project.ID, "title": "forbidden change"}, "auto", []int64{project.ID + 9999}, 0)
	assert.Contains(t, conv.Turns[0].Result.Actions[1].Result, "SCOPE_DENIED")
	// Move checks both projects and actually persists the destination; an unrelated cover cannot be assigned.
	secondProject := humaRequest(t, e, "POST", "/api/v2/projects", `{"title":"Agent move destination"}`, token, "")
	require.Equal(t, 201, secondProject.Code)
	var destination struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(secondProject.Body.Bytes(), &destination))
	_, conv = start("update_task", map[string]any{"id": two, "project_id": destination.ID}, "auto", []int64{project.ID, destination.ID}, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.Contains(t, readTask(two), fmt.Sprintf(`"project_id":%d`, destination.ID))
	assert.Contains(t, readTask(two), `"hex_color":"123456"`)
	_, conv = start("update_task", map[string]any{"id": two, "cover_image_attachment_id": 999999}, "auto", nil, 0)
	require.False(t, conv.Turns[0].Result.Actions[1].Success)
	assert.Contains(t, readTask(two), `"cover_image_attachment_id":0`)
	// New deferred tools obey the same scope/review layer and return actual daily state.
	daily := createTask("Daily routine")
	_, conv = start("configure_task_routine", map[string]any{
		"id":           daily,
		"enabled":      true,
		"paused":       false,
		"timezone":     "UTC",
		"revision":     0,
		"period":       "daily",
		"reset_hour":   0,
		"reset_minute": 0,
		"week_start":   0,
		"month_day":    1,
		"target":       1,
		"unit":         "",
	}, "auto", []int64{project.ID}, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	var dailyTask struct {
		Routine struct {
			Date           string `json:"date"`
			Revision       int64  `json:"revision"`
			CompletedToday bool   `json:"completed_today"`
			CurrentAmount  int64  `json:"current_amount"`
		} `json:"routine"`
	}
	require.NoError(t, json.Unmarshal([]byte(readTask(daily)), &dailyTask))
	_, conv = start("check_in_task_routine", map[string]any{
		"id":        daily,
		"date":      dailyTask.Routine.Date,
		"revision":  dailyTask.Routine.Revision,
		"completed": true,
	}, "auto", []int64{project.ID}, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	require.NoError(t, json.Unmarshal([]byte(readTask(daily)), &dailyTask))
	require.True(t, dailyTask.Routine.CompletedToday)
	_, conv = start("check_in_task_routine", map[string]any{
		"id":        daily,
		"date":      dailyTask.Routine.Date,
		"revision":  dailyTask.Routine.Revision,
		"completed": false,
	}, "auto", []int64{project.ID + 9999}, 0)
	require.Contains(t, conv.Turns[0].Result.Actions[1].Result, "SCOPE_DENIED")
	_, conv = start("configure_task_routine", map[string]any{
		"id":           daily,
		"enabled":      true,
		"paused":       false,
		"timezone":     "UTC",
		"revision":     dailyTask.Routine.Revision,
		"period":       "weekly",
		"reset_hour":   5,
		"reset_minute": 0,
		"week_start":   1,
		"month_day":    1,
		"target":       3,
		"unit":         "sessions",
	}, "auto", []int64{project.ID}, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	require.NoError(t, json.Unmarshal([]byte(readTask(daily)), &dailyTask))
	for range 2 {
		_, conv = start("set_task_routine_progress", map[string]any{
			"id":       daily,
			"date":     dailyTask.Routine.Date,
			"revision": dailyTask.Routine.Revision,
			"amount":   2,
		}, "auto", []int64{project.ID}, 0)
		require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	}
	require.NoError(t, json.Unmarshal([]byte(readTask(daily)), &dailyTask))
	require.Equal(t, int64(2), dailyTask.Routine.CurrentAmount, "retrying an absolute quota must not add it twice")
	require.False(t, dailyTask.Routine.CompletedToday)
	path, conv = start("update_project_announcement", map[string]any{"id": project.ID, "title": "Notice", "content": "<p>Daily briefing</p>", "revision": 0}, "auto", []int64{project.ID}, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	conv = wait(path)
	require.True(t, conv.Turns[0].Result.Actions[0].Success, conv.Turns[0].Result.Actions[0].Result)
	announcement := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/projects/%d/announcement", project.ID), "", token, "")
	require.Equal(t, 200, announcement.Code)
	require.Contains(t, announcement.Body.String(), "Daily briefing")
	_, conv = start("get_task_routine_history", map[string]any{"id": daily, "year": time.Now().UTC().Year(), "month": int(time.Now().UTC().Month())}, "auto", nil, 0)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	require.Contains(t, conv.Turns[0].Result.Actions[1].Result, `"total_checkins":1`)

	doomed := createTask("delete after review")
	path, conv = start("delete_task", map[string]any{"id": doomed}, "auto", nil, 0)
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	assert.Contains(t, readTask(doomed), "delete after review")
	require.Equal(t, 201, review(path, conv, "approve", "").Code)
	conv = wait(path)
	require.True(t, conv.Turns[0].Result.Actions[0].Success, conv.Turns[0].Result.Actions[0].Result)
	assert.Equal(t, 404, humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d", doomed), "", token, "").Code)

}

func fixtureDiscoveredTool(content, name string) bool {
	var result struct {
		Transport string `json:"transport"`
		Tools     []struct {
			Name string `json:"name"`
		} `json:"tools"`
	}
	if json.Unmarshal([]byte(content), &result) != nil || result.Transport != "invoke_tool_v1" {
		return false
	}
	for _, tool := range result.Tools {
		if tool.Name == name {
			return true
		}
	}
	return false
}
