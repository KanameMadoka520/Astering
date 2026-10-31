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

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The fixture provider asks for the tool named in the user message: it loads the tool with
// find_tools, calls it through invoke_tool, then answers once the tool result is back.
func TestTCYAIBucketAgent(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	oldPath, oldAllow := config.FilesBasePath.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body struct {
			Messages []tcyai.Message `json:"messages"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
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
			wrapped, err := json.Marshal(map[string]any{"name": request.Tool, "arguments": request.Args})
			if !assert.NoError(t, err) {
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

	wait := func(path string) tcyai.Conversation {
		var result tcyai.Conversation
		require.Eventually(t, func() bool {
			rec := humaRequest(t, e, "GET", path, "", token, "")
			if rec.Code != 200 || json.Unmarshal(rec.Body.Bytes(), &result) != nil || len(result.Turns) == 0 {
				return false
			}
			return result.Turns[len(result.Turns)-1].Status != "running"
		}, 5*time.Second, 10*time.Millisecond)
		return result
	}
	// allow_delete stays off: it authorizes task deletion and has no say over buckets.
	start := func(tool string, args any, approval string) (string, tcyai.Conversation) {
		rec := humaRequest(t, e, "POST", "/api/v2/ai/conversations", `{"title":"Bucket tools"}`, token, "")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		var conv tcyai.Conversation
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &conv))
		path := "/api/v2/ai/conversations/" + conv.ID
		prompt, err := json.Marshal(map[string]any{"tool": tool, "args": args})
		require.NoError(t, err)
		body, err := json.Marshal(map[string]any{"message": string(prompt), "mode": "write", "approval": approval, "request_id": uuid.NewString(), "allow_delete": false})
		require.NoError(t, err)
		rec = humaRequest(t, e, "POST", path+"/messages", string(body), token, "")
		require.Equal(t, 201, rec.Code, rec.Body.String())
		return path, wait(path)
	}

	_, conv := start("list_buckets", map[string]any{"project_id": 1, "view_id": 4}, "smart")
	require.Equal(t, "completed", conv.Turns[0].Status)
	require.Len(t, conv.Turns[0].Result.Actions, 2)
	read := conv.Turns[0].Result.Actions[1]
	require.True(t, read.Success, read.Result)
	assert.Contains(t, read.Result, `"title":"testbucket2"`)
	assert.Contains(t, read.Result, `"task_count":11`)
	assert.NotContains(t, read.Result, "task #1", "bucket metadata must not embed tasks")

	_, conv = start("move_task_to_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 3, "task_id": 1}, "smart")
	require.Equal(t, "completed", conv.Turns[0].Status)
	require.Len(t, conv.Turns[0].Result.Actions, 2)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.True(t, conv.Turns[0].Result.Operations[1].Verified)
	db.AssertExists(t, "tasks", map[string]interface{}{"id": 1, "done": true}, false)
	db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": 1, "project_view_id": 4, "bucket_id": 3}, false)

	// Even in auto mode a bucket delete waits for the user, who sees where the tasks go.
	path, conv := start("delete_bucket", map[string]any{"project_id": 1, "view_id": 4, "bucket_id": 2}, "auto")
	require.Equal(t, "awaiting_approval", conv.Turns[0].Status)
	require.NotNil(t, conv.Turns[0].Result.Pending)
	assert.Contains(t, conv.Turns[0].Result.Pending.Before, `"tasks_moved":3`)
	assert.Contains(t, conv.Turns[0].Result.Pending.Before, `"move_to_bucket_title":"testbucket1"`)
	db.AssertExists(t, "buckets", map[string]interface{}{"id": 2}, false)
	review, err := json.Marshal(tcyai.ReviewInput{TurnID: conv.Turns[0].ID, OperationID: conv.Turns[0].Result.Pending.ID, Decision: "approve"})
	require.NoError(t, err)
	rec := humaRequest(t, e, "POST", path+"/review", string(review), token, "")
	require.Equal(t, 201, rec.Code, rec.Body.String())
	conv = wait(path)
	require.Equal(t, "completed", conv.Turns[0].Status)
	require.Len(t, conv.Turns[0].Result.Actions, 2)
	require.True(t, conv.Turns[0].Result.Actions[1].Success, conv.Turns[0].Result.Actions[1].Result)
	assert.True(t, conv.Turns[0].Result.Operations[1].Verified)
	db.AssertMissing(t, "buckets", map[string]interface{}{"id": 2})
	for _, task := range []int64{3, 4, 5} {
		db.AssertExists(t, "task_buckets", map[string]interface{}{"task_id": task, "project_view_id": 4, "bucket_id": 1}, false)
	}
}
