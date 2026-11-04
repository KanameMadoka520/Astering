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
	"github.com/KanameMadoka520/Astering/pkg/license"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Exercise real JWT authentication, licensed administrator lookups, internal
// HTTP reads and direct database mutations. Admin management authority must not
// become permission for an assistant to read or change unshared user resources.
func TestTCYAIResourcePermissionsLicensedAdmin(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	license.SetForTests([]license.Feature{license.FeatureAdminPanel})
	t.Cleanup(license.ResetForTests)
	token, other := humaTokenFor(t, &testuser1), humaTokenFor(t, &testuser2)
	oldPath, oldAllow := config.FilesBasePath.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })

	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer resource-permissions-fixture", r.Header.Get("Authorization"))
		var body struct {
			Messages []tcyai.Message `json:"messages"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) || !assert.NotEmpty(t, body.Messages) {
			return
		}
		var request struct {
			Tool string          `json:"tool"`
			Args json.RawMessage `json:"args"`
		}
		for _, m := range body.Messages {
			if m.Role == "user" {
				_ = json.Unmarshal([]byte(m.Content), &request)
			}
		}
		last := body.Messages[len(body.Messages)-1]
		name, args := "find_tools", json.RawMessage(fmt.Sprintf(`{"query":%q}`, request.Tool))
		switch {
		case last.Role == "tool" && fixtureDiscoveredTool(last.Content, request.Tool):
			wrapped, encodeErr := json.Marshal(map[string]any{"name": request.Tool, "arguments": request.Args})
			if !assert.NoError(t, encodeErr) {
				return
			}
			name, args = "invoke_tool", wrapped
		case last.Role == "tool" && !strings.Contains(last.Content, `"transport":"invoke_tool_v1"`):
			name = ""
		}
		message := map[string]any{"role": "assistant", "content": "Done"}
		if name != "" {
			message["content"] = ""
			message["tool_calls"] = []any{map[string]any{"id": "call-" + uuid.NewString(), "type": "function", "function": map[string]any{"name": name, "arguments": string(args)}}}
		}
		w.Header().Set("Content-Type", "application/json")
		assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"model": "fixture", "choices": []any{map[string]any{"message": message}}}))
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	settings := fmt.Sprintf(`{"connections":[{"id":"fixture","name":"Fixture","kind":"chat","protocol":"openai-chat","base_url":%q,"model":"fixture","api_key":"resource-permissions-fixture"}],"assistant":"fixture"}`, provider.URL)
	require.Equal(t, http.StatusOK, humaRequest(t, e, http.MethodPost, "/api/v2/ai/settings", settings, token, "").Code)

	type resource struct {
		projectID, taskID, viewID int64
		title                     string
		owner                     string
	}
	create := func(title, owner string, permission int) resource {
		t.Helper()
		created := humaRequest(t, e, http.MethodPost, "/api/v2/projects", fmt.Sprintf(`{"title":%q}`, title), owner, "")
		require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
		var project struct {
			ID int64 `json:"id"`
		}
		require.NoError(t, json.Unmarshal(created.Body.Bytes(), &project))
		created = humaRequest(t, e, http.MethodPost, fmt.Sprintf("/api/v2/projects/%d/tasks", project.ID), fmt.Sprintf(`{"title":%q}`, title+" task"), owner, "")
		require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
		var task struct {
			ID int64 `json:"id"`
		}
		require.NoError(t, json.Unmarshal(created.Body.Bytes(), &task))
		views := humaRequest(t, e, http.MethodGet, fmt.Sprintf("/api/v2/projects/%d/views", project.ID), "", owner, "")
		require.Equal(t, http.StatusOK, views.Code, views.Body.String())
		var choices struct {
			Items []struct {
				ID       int64  `json:"id"`
				ViewKind string `json:"view_kind"`
			} `json:"items"`
		}
		require.NoError(t, json.Unmarshal(views.Body.Bytes(), &choices))
		var viewID int64
		for _, view := range choices.Items {
			if view.ViewKind == "kanban" {
				viewID = view.ID
			}
		}
		require.Positive(t, viewID)
		if permission >= 0 {
			shared := humaRequest(t, e, http.MethodPost, fmt.Sprintf("/api/v2/projects/%d/users", project.ID), fmt.Sprintf(`{"username":"user1","permission":%d}`, permission), owner, "")
			require.Equal(t, http.StatusCreated, shared.Code, shared.Body.String())
		}
		return resource{projectID: project.ID, taskID: task.ID, viewID: viewID, title: title, owner: owner}
	}
	owned := create("Assistant owned", token, -1)
	private := create("Assistant unshared private", other, -1)
	readShared := create("Assistant explicitly read shared", other, 0)
	writeShared := create("Assistant explicitly write shared", other, 1)
	admin := promoteToAdmin(t, testuser1.ID)
	require.True(t, admin.IsAdmin)
	token = humaTokenFor(t, admin)
	// Prove the licensed bypass really exists for the same user's ordinary API.
	ordinary := humaRequest(t, e, http.MethodGet, fmt.Sprintf("/api/v2/tasks/%d", private.taskID), "", token, "")
	require.Equal(t, http.StatusOK, ordinary.Code, ordinary.Body.String())

	input := func(tool string, args any, approval string) string {
		t.Helper()
		prompt, encodeErr := json.Marshal(map[string]any{"tool": tool, "args": args})
		require.NoError(t, encodeErr)
		body, encodeErr := json.Marshal(map[string]any{"message": string(prompt), "mode": "write", "approval": approval, "request_id": uuid.NewString()})
		require.NoError(t, encodeErr)
		return string(body)
	}
	run := func(tool string, args any) tcyai.Action {
		t.Helper()
		response := humaRequest(t, e, http.MethodPost, "/api/v2/ai/run", input(tool, args, "auto"), token, "")
		require.Equal(t, http.StatusOK, response.Code, response.Body.String())
		var result tcyai.RunResult
		require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
		for _, action := range result.Actions {
			if action.Tool == tool {
				return action
			}
		}
		t.Fatalf("tool %s was not attempted: %+v", tool, result.Actions)
		return tcyai.Action{}
	}
	// Model discovery and guessed IDs do not grant a project; collection reads
	// must also filter the private project rather than exposing its metadata.
	listed := run("list_projects", map[string]any{"query": "Assistant"})
	require.True(t, listed.Success, listed.Result)
	var projects struct {
		Items []struct {
			ID int64 `json:"id"`
		} `json:"items"`
	}
	require.NoError(t, json.Unmarshal([]byte(listed.Result), &projects))
	projectIDs := make([]int64, 0, len(projects.Items))
	for _, item := range projects.Items {
		projectIDs = append(projectIDs, item.ID)
	}
	assert.Contains(t, projectIDs, owned.projectID)
	assert.Contains(t, projectIDs, readShared.projectID)
	assert.Contains(t, projectIDs, writeShared.projectID)
	assert.NotContains(t, projectIDs, private.projectID)
	assert.NotContains(t, listed.Result, private.title)
	for _, test := range []struct {
		name  string
		item  resource
		read  bool
		write bool
	}{
		{name: "owner", item: owned, read: true, write: true},
		{name: "unshared", item: private},
		{name: "read share", item: readShared, read: true},
		{name: "write share", item: writeShared, read: true, write: true},
	} {
		t.Run(test.name, func(t *testing.T) {
			read := run("get_task", map[string]any{"id": test.item.taskID})
			assert.Equal(t, test.read, read.Success, read.Result)
			if !test.read {
				assert.NotContains(t, read.Result, test.item.title)
			}
			buckets := run("list_buckets", map[string]any{"project_id": test.item.projectID, "view_id": test.item.viewID})
			assert.Equal(t, test.read, buckets.Success, buckets.Result)
			updated := run("update_task", map[string]any{"id": test.item.taskID, "title": test.item.title + " changed"})
			assert.Equal(t, test.write, updated.Success, updated.Result)
			bucket := run("create_bucket", map[string]any{"project_id": test.item.projectID, "view_id": test.item.viewID, "title": "Assistant created bucket"})
			assert.Equal(t, test.write, bucket.Success, bucket.Result)
			actual := humaRequest(t, e, http.MethodGet, fmt.Sprintf("/api/v2/tasks/%d", test.item.taskID), "", test.item.owner, "")
			require.Equal(t, http.StatusOK, actual.Code, actual.Body.String())
			expected := test.item.title + " task"
			if test.write {
				expected = test.item.title + " changed"
			}
			assert.Contains(t, actual.Body.String(), fmt.Sprintf(`"title":%q`, expected))
		})
	}

	// The durable review route constructs another execution. Revoking the share
	// after preview must invalidate approval even though the account remains admin.
	created := humaRequest(t, e, http.MethodPost, "/api/v2/ai/conversations", `{"title":"Permission revocation"}`, token, "")
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var conversation tcyai.Conversation
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &conversation))
	path := "/api/v2/ai/conversations/" + conversation.ID
	wait := func() tcyai.Conversation {
		t.Helper()
		var result tcyai.Conversation
		require.Eventually(t, func() bool {
			response := humaRequest(t, e, http.MethodGet, path, "", token, "")
			return response.Code == http.StatusOK && json.Unmarshal(response.Body.Bytes(), &result) == nil && len(result.Turns) > 0 && result.Turns[0].Status != "running"
		}, 5*time.Second, 10*time.Millisecond)
		return result
	}
	started := humaRequest(t, e, http.MethodPost, path+"/messages", input("update_task", map[string]any{"id": writeShared.taskID, "title": "Must not survive revocation"}, "review"), token, "")
	require.Equal(t, http.StatusCreated, started.Code, started.Body.String())
	conversation = wait()
	require.Equal(t, "awaiting_approval", conversation.Turns[0].Status)
	require.NotNil(t, conversation.Turns[0].Result.Pending)
	revoked := humaRequest(t, e, http.MethodDelete, fmt.Sprintf("/api/v2/projects/%d/users/user1", writeShared.projectID), "", other, "")
	require.Equal(t, http.StatusNoContent, revoked.Code, revoked.Body.String())
	review, err := json.Marshal(tcyai.ReviewInput{TurnID: conversation.Turns[0].ID, OperationID: conversation.Turns[0].Result.Pending.ID, Decision: "approve"})
	require.NoError(t, err)
	denied := humaRequest(t, e, http.MethodPost, path+"/review", string(review), token, "")
	require.Equal(t, http.StatusCreated, denied.Code, denied.Body.String())
	conversation = wait()
	var attempted bool
	for _, action := range conversation.Turns[0].Result.Actions {
		if action.Tool == "update_task" {
			attempted = true
			assert.False(t, action.Success, action.Result)
		}
	}
	assert.True(t, attempted, "the approved operation must be revalidated before execution")
	actual := humaRequest(t, e, http.MethodGet, fmt.Sprintf("/api/v2/tasks/%d", writeShared.taskID), "", other, "")
	require.Equal(t, http.StatusOK, actual.Code, actual.Body.String())
	assert.Contains(t, actual.Body.String(), fmt.Sprintf(`"title":%q`, writeShared.title+" changed"))
	assert.NotContains(t, actual.Body.String(), "Must not survive revocation")
	assert.Equal(t, http.StatusOK, humaRequest(t, e, http.MethodGet, fmt.Sprintf("/api/v2/tasks/%d", private.taskID), "", token, "").Code, "assistant restriction must not mutate the ordinary admin session")
}
