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

//nolint:gosmopolitan // Exercise Chinese user content and messages of the fork.
package webtests

import (
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIIntegration(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	path := t.TempDir()
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(path)
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	mode := "create"
	modelCalls := 0
	projectResponse := humaRequest(t, e, "POST", "/api/v2/projects", `{"title":"AI integration private project"}`, token, "")
	require.Equal(t, 201, projectResponse.Code, projectResponse.Body.String())
	var project struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(projectResponse.Body.Bytes(), &project))
	var createdID int64
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer test-secret-never-return", r.Header.Get("Authorization"))
		w.Header().Set("Content-Type", "application/json")
		if r.URL.Path == "/v1/audio/transcriptions" {
			r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
			if !assert.NoError(t, r.ParseMultipartForm(1024*1024)) { //nolint:gosec // Body is bounded by MaxBytesReader immediately above.
				return
			}
			defer func() { assert.NoError(t, r.MultipartForm.RemoveAll()) }()
			assert.Equal(t, "asr-model", r.FormValue("model"))
			_, err := fmt.Fprint(w, `{"text":"明天下午整理文档"}`)
			assert.NoError(t, err)
			return
		}
		assert.Equal(t, "/v1/chat/completions", r.URL.Path)
		var input struct {
			Model    string           `json:"model"`
			Tools    []map[string]any `json:"tools"`
			Messages []struct {
				Role    string `json:"role"`
				Content string `json:"content"`
			} `json:"messages"`
		}
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&input)) {
			return
		}
		modelCalls++
		last := input.Messages[len(input.Messages)-1]
		if (last.Role == "tool" && !strings.Contains(last.Content, `"note":"These tools`) && !strings.Contains(last.Content, `"transport":"invoke_tool_v1"`)) || mode == "text" {
			_, err := fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"已完成处理"}}]}`)
			assert.NoError(t, err)
			return
		}
		name, args := "create_task", fmt.Sprintf(`{"project_id":%d,"title":"AI 中文任务","description":"保留这个描述"}`, project.ID)
		if mode == "update" {
			name = "update_task"
			args = fmt.Sprintf(`{"id":%d,"done":true}`, createdID)
		}
		if mode == "read-other" {
			name = "get_task"
			args = fmt.Sprintf(`{"id":%d}`, createdID)
		}
		if mode == "escalate" {
			name = "delete_task"
			args = fmt.Sprintf(`{"id":%d}`, createdID)
		}
		if mode == "create" || mode == "update" {
			loaded := false
			for _, tool := range input.Tools {
				fn, _ := tool["function"].(map[string]any)
				if fn["name"] == name {
					loaded = true
				}
			}
			if !loaded && last.Role == "tool" && fixtureDiscoveredTool(last.Content, name) {
				loaded = true
				wrapped, err := json.Marshal(map[string]any{"name": name, "arguments": json.RawMessage(args)})
				if !assert.NoError(t, err) {
					return
				}
				name = "invoke_tool"
				args = string(wrapped)
			}
			if !loaded {
				args = fmt.Sprintf(`{"query":%q}`, name)
				name = "find_tools"
			}
		}
		response := map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": "", "tool_calls": []any{map[string]any{"id": "call-1", "type": "function", "function": map[string]string{"name": name, "arguments": args}}}}}}}
		assert.NoError(t, json.NewEncoder(w).Encode(response))
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	oldTransport := http.DefaultTransport
	transport := oldTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = oldTransport; transport.CloseIdleConnections() })
	settings := fmt.Sprintf(`{"connections":[{"id":"chat","name":"Chat","base_url":%q,"model":"chat-model","kind":"chat","api_key":"test-secret-never-return"},{"id":"asr","name":"ASR","base_url":%q,"model":"asr-model","kind":"transcription","api_key":"test-secret-never-return"}],"assistant":"chat","transcription":"asr","cleanup":"chat"}`, provider.URL+"/v1", provider.URL+"/v1")
	for _, tok := range []string{token, other} {
		rec := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, tok, "")
		require.Equal(t, 200, rec.Code, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "test-secret-never-return")
		assert.Contains(t, rec.Body.String(), `"has_key":true`)
	}
	encrypted, err := os.ReadFile(filepath.Join(path, ".tcymc-ai", "1.enc"))
	require.NoError(t, err)
	assert.NotContains(t, string(encrypted), "test-secret-never-return")
	info, err := os.Stat(filepath.Join(path, ".tcymc-ai", "1.enc"))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
	assert.Equal(t, 401, humaRequest(t, e, "GET", "/api/v2/ai/settings", "", "", "").Code)
	// A second user's saved connection must never alter this user's settings.
	otherSettings := strings.ReplaceAll(settings, "Chat", "Other connection")
	require.Equal(t, 200, humaRequest(t, e, "POST", "/api/v2/ai/settings", otherSettings, other, "").Code)
	assert.NotContains(t, humaRequest(t, e, "GET", "/api/v2/ai/settings", "", token, "").Body.String(), "Other connection")
	changed := strings.ReplaceAll(settings, provider.URL, "https://another.example.com")
	changed = strings.ReplaceAll(changed, "test-secret-never-return", "")
	assert.Equal(t, 400, humaRequest(t, e, "POST", "/api/v2/ai/settings", changed, token, "").Code)
	run := func(id, runMode, tok string) *httptest.ResponseRecorder {
		return humaRequest(t, e, "POST", "/api/v2/ai/run", fmt.Sprintf(`{"message":"执行测试","history":[],"project_id":%d,"mode":%q,"allow_delete":false,"request_id":%q}`, project.ID, runMode, id), tok, "")
	}
	first := run("create-once-001", "write", token)
	require.Equal(t, 200, first.Code, first.Body.String())
	var result struct {
		Reply   string `json:"reply"`
		Actions []struct {
			Success bool   `json:"success"`
			Result  string `json:"result"`
		} `json:"actions"`
	}
	require.NoError(t, json.Unmarshal(first.Body.Bytes(), &result))
	require.Len(t, result.Actions, 2)
	require.True(t, result.Actions[1].Success, result.Actions[1].Result)
	var task struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal([]byte(result.Actions[1].Result), &task))
	createdID = task.ID
	require.Positive(t, createdID)
	calls := modelCalls
	again := run("create-once-001", "write", token)
	assert.Equal(t, first.Body.String(), again.Body.String())
	assert.Equal(t, calls, modelCalls)
	mode = "update"
	updated := run("update-once-001", "write", token)
	require.Equal(t, 200, updated.Code, updated.Body.String())
	assert.Contains(t, updated.Body.String(), `"success":true`)
	read := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d", createdID), "", token, "")
	assert.Contains(t, read.Body.String(), `"done":true`)
	assert.Contains(t, read.Body.String(), "保留这个描述")
	mode = "read-other"
	denied := run("other-user-001", "read", other)
	assert.Contains(t, denied.Body.String(), `"success":false`)
	mode = "escalate"
	escalation := run("escalate-001", "read", token)
	assert.Contains(t, escalation.Body.String(), "TOOL_NOT_ALLOWED")
	assert.Equal(t, 200, humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d", createdID), "", token, "").Code)
	mode = "text"
	audio := fmt.Sprintf(`{"audio":%q,"filename":"test.wav","cleanup":true}`, base64.StdEncoding.EncodeToString([]byte("RIFF test audio")))
	transcript := humaRequest(t, e, "POST", "/api/v2/ai/transcribe", audio, token, "")
	require.Equal(t, 200, transcript.Code, transcript.Body.String())
	assert.Contains(t, transcript.Body.String(), "明天下午整理文档")
	assert.Contains(t, transcript.Body.String(), "已完成处理")
	assert.Equal(t, 400, humaRequest(t, e, "POST", "/api/v2/ai/transcribe", `{"audio":"not base64","filename":"test.wav","cleanup":false}`, token, "").Code)
}
