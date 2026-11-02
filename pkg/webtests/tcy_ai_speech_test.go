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
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAISpeechCatalogAndConnectionIsolation(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath) })
	catalog := "/api/v2/ai/speech/providers"
	require.Equal(t, 401, humaRequest(t, e, "GET", catalog, "", "", "").Code)
	got := humaRequest(t, e, "GET", catalog, "", token, "")
	require.Equal(t, 200, got.Code, got.Body.String())
	require.Equal(t, "no-store", got.Header().Get("Cache-Control"))
	var providers []tcyai.SpeechProvider
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &providers))
	require.Len(t, providers, 7)
	require.Equal(t, "qwen-audio-3.1-asr-flash-streaming", providers[0].Models[0].ID)
	require.Equal(t, "dashscope-asr", providers[0].Models[0].Protocol)
	require.Equal(t, "wss://dashscope.aliyuncs.com/api-ws/v1/inference", providers[0].Models[0].BaseURL)
	require.NotContains(t, got.Body.String(), "api_key")
	// A disabled connection is stored, but cannot be invoked or assigned as default.
	settings := `{"connections":[{"id":"private-speech","name":"Speech","kind":"transcription","protocol":"openai-realtime","base_url":"https://api.openai.com/v1","model":"gpt-live-transcribe","api_key":"fixture-private-secret","speech":{"disabled":true,"provider":"openai"}}],"assistant":"","cleanup":"","transcription":""}`
	saved := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	require.NotContains(t, saved.Body.String(), "fixture-private-secret")
	request := fmt.Sprintf(`{"connection_id":"private-speech","audio":%q,"filename":"voice.wav"}`, base64.StdEncoding.EncodeToString([]byte("not-PCM")))
	for _, route := range []string{"/api/v2/ai/transcribe", "/api/v2/ai/test"} {
		for _, identity := range []string{token, other} {
			response := humaRequest(t, e, "POST", route, request, identity, "")
			require.Contains(t, []int{400, 404}, response.Code, response.Body.String())
			require.NotContains(t, response.Body.String(), "fixture-private-secret")
		}
	}
	// A workspace placeholder cannot be saved without the workspace ID.
	bad := `{"connections":[{"id":"workspace","name":"Ali","kind":"transcription","protocol":"dashscope-asr","base_url":"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference","model":"qwen-audio-3.1-asr-flash-streaming","api_key":"fixture-secret"}],"assistant":"","cleanup":"","transcription":"workspace"}`
	require.Equal(t, 400, humaRequest(t, e, "POST", "/api/v2/ai/settings", bad, token, "").Code)
}

func TestTCYAISpeechConnectionProbeHTTP(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow)
	})
	var probeCalls, fileCalls atomic.Int32
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "Bearer fixture-private-secret", r.Header.Get("Authorization"))
		if r.URL.Path == "/v1/audio/transcriptions" {
			fileCalls.Add(1)
			r.Body = http.MaxBytesReader(w, r.Body, 1024*1024)
			if !assert.NoError(t, r.ParseMultipartForm(1024*1024)) { //nolint:gosec // The request is bounded above.
				return
			}
			defer func() { assert.NoError(t, r.MultipartForm.RemoveAll()) }()
			assert.Equal(t, "whisper-1", r.FormValue("model"))
			w.Header().Set("Content-Type", "application/json")
			_, writeErr := w.Write([]byte(`{"text":"fixture transcription"}`))
			assert.NoError(t, writeErr)
			return
		}
		probeCalls.Add(1)
		socket, acceptErr := websocket.Accept(w, r, nil)
		if !assert.NoError(t, acceptErr) {
			return
		}
		defer func() { _ = socket.CloseNow() }()
		ctx, cancel := context.WithTimeout(r.Context(), time.Second*5)
		defer cancel()
		var command struct {
			Header struct {
				Action string `json:"action"`
				TaskID string `json:"task_id"`
			} `json:"header"`
			Payload struct {
				Model string `json:"model"`
			} `json:"payload"`
		}
		if !assert.NoError(t, wsjson.Read(ctx, socket, &command)) {
			return
		}
		assert.Equal(t, "run-task", command.Header.Action)
		assert.Equal(t, "qwen-audio-3.1-asr-flash-streaming", command.Payload.Model)
		event := func(name string) error {
			return wsjson.Write(ctx, socket, map[string]any{
				"header": map[string]string{
					"event":   name,
					"task_id": command.Header.TaskID,
				},
			})
		}
		if !assert.NoError(t, event("task-started")) {
			return
		}
		var finish struct {
			Header struct {
				Action string `json:"action"`
				TaskID string `json:"task_id"`
			} `json:"header"`
		}
		if !assert.NoError(t, wsjson.Read(ctx, socket, &finish)) {
			return
		}
		assert.Equal(t, "finish-task", finish.Header.Action)
		assert.Equal(t, command.Header.TaskID, finish.Header.TaskID)
		assert.NoError(t, event("task-finished"))
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	oldTransport := http.DefaultTransport
	transport := oldTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() {
		http.DefaultTransport = oldTransport
		transport.CloseIdleConnections()
	})
	settings := fmt.Sprintf(`{"connections":[{"id":"ali-probe","name":"Ali","kind":"transcription","protocol":"dashscope-asr","base_url":%q,"model":"qwen-audio-3.1-asr-flash-streaming","api_key":"fixture-private-secret"},{"id":"file-test","name":"File","kind":"transcription","protocol":"openai-transcription","base_url":%q,"model":"whisper-1","api_key":"fixture-private-secret"}],"assistant":"","cleanup":"","transcription":""}`, provider.URL, provider.URL+"/v1")
	saved := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	request := `{"connection_id":"ali-probe","audio":"","filename":""}`
	require.Equal(t, 401, humaRequest(t, e, "POST", "/api/v2/ai/test", request, "", "").Code)
	require.Equal(t, 404, humaRequest(t, e, "POST", "/api/v2/ai/test", request, other, "").Code)
	require.Zero(t, probeCalls.Load())
	response := humaRequest(t, e, "POST", "/api/v2/ai/test", request, token, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	require.NotContains(t, response.Body.String(), "fixture-private-secret")
	var result struct {
		Text            string `json:"text"`
		Warning         string `json:"warning"`
		Endpoint        string `json:"endpoint"`
		AudioDurationMS int64  `json:"audio_duration_ms"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	require.Empty(t, result.Text)
	require.Contains(t, result.Warning, "No audio was submitted")
	require.Contains(t, result.Endpoint, "/api-ws/v1/inference")
	require.Zero(t, result.AudioDurationMS)
	require.EqualValues(t, 1, probeCalls.Load())
	noAudio := humaRequest(t, e, "POST", "/api/v2/ai/test", `{"connection_id":"file-test","audio":"","filename":""}`, token, "")
	require.Equal(t, 400, noAudio.Code, noAudio.Body.String())
	require.Contains(t, noAudio.Body.String(), "needs an audio file")
	require.Zero(t, fileCalls.Load())
	withAudio := fmt.Sprintf(`{"connection_id":"file-test","audio":%q,"filename":"voice.wav"}`, base64.StdEncoding.EncodeToString([]byte("fixture audio bytes")))
	response = humaRequest(t, e, "POST", "/api/v2/ai/test", withAudio, token, "")
	require.Equal(t, 200, response.Code, response.Body.String())
	require.Contains(t, response.Body.String(), "fixture transcription")
	require.EqualValues(t, 1, fileCalls.Load())
}
