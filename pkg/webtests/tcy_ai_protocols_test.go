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
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIProtocols(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	oldPath, oldAllow := config.FilesBasePath.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	protocol, mode, calls := "", "", 0
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		calls++
		switch protocol {
		case "anthropic":
			assert.Equal(t, "fixture-secret", r.Header.Get("x-api-key"))
			assert.Equal(t, "2023-06-01", r.Header.Get("anthropic-version"))
			assert.Empty(t, r.Header.Get("Authorization"))
		case "gemini":
			assert.Equal(t, "fixture-secret", r.Header.Get("x-goog-api-key"))
			assert.Empty(t, r.URL.Query().Get("key"))
		default:
			assert.Equal(t, "Bearer fixture-secret", r.Header.Get("Authorization"))
		}
		respond := func(value string) { _, writeErr := io.WriteString(w, value); assert.NoError(t, writeErr) }
		if mode == "models" {
			assert.Equal(t, "GET", r.Method)
			assert.Equal(t, "/custom/v1/models", r.URL.Path)
			switch protocol {
			case "anthropic":
				assert.Equal(t, "100", r.URL.Query().Get("limit"))
				if calls == 1 {
					respond(`{"data":[{"id":"zeta"}],"has_more":true,"last_id":"zeta"}`)
				} else {
					assert.Equal(t, "zeta", r.URL.Query().Get("after_id"))
					respond(`{"data":[{"id":"alpha"},{"id":"zeta"}],"has_more":false}`)
				}
			case "gemini":
				assert.Equal(t, "100", r.URL.Query().Get("pageSize"))
				if calls == 1 {
					respond(`{"models":[{"name":"models/zeta"}],"nextPageToken":"cursor"}`)
				} else {
					assert.Equal(t, "cursor", r.URL.Query().Get("pageToken"))
					respond(`{"models":[{"name":"models/alpha"},{"name":"models/zeta"}]}`)
				}
			default:
				respond(`{"data":[{"id":"zeta"},{"id":"alpha"},{"id":"zeta"}]}`)
			}
			return
		}
		assert.Equal(t, "POST", r.Method)
		raw, readErr := io.ReadAll(r.Body)
		if !assert.NoError(t, readErr) {
			return
		}
		var body map[string]any
		if !assert.NoError(t, json.Unmarshal(raw, &body)) {
			return
		}
		if mode == "audio" {
			switch protocol {
			case "openai-audio":
				assert.Equal(t, "/custom/v1/chat/completions", r.URL.Path)
				assert.Contains(t, string(raw), `"input_audio"`)
				assert.Contains(t, string(raw), `"format":"wav"`)
				assert.Contains(t, string(raw), base64.StdEncoding.EncodeToString([]byte("RIFF test audio")))
				respond(`{"choices":[{"message":{"role":"assistant","content":"Audio transcript"}}]}`)
			case "gemini":
				assert.Equal(t, "/custom/v1/models/task-model:streamGenerateContent", r.URL.Path)
				assert.Contains(t, string(raw), `"mimeType":"audio/wav"`)
				assert.Contains(t, string(raw), base64.StdEncoding.EncodeToString([]byte("RIFF test audio")))
				respond(`{"candidates":[{"content":{"parts":[{"text":"Audio transcript"}]},"finishReason":"STOP"}]}`)
			}
			return
		}
		switch protocol {
		case "openai-chat":
			assert.Equal(t, "/custom/v1/chat/completions", r.URL.Path)
			assert.Contains(t, string(raw), `"tool_choice":"auto"`)
			if calls == 1 {
				respond(`{"choices":[{"message":{"role":"assistant","content":"","tool_calls":[{"id":"call-1","type":"function","function":{"name":"list_projects","arguments":"{}"}}]}}]}`)
			} else {
				assert.Contains(t, string(raw), `"tool_call_id":"call-1"`)
				respond(`{"choices":[{"message":{"role":"assistant","content":"Done"}}]}`)
			}
		case "openai-responses":
			assert.Equal(t, "/custom/v1/responses", r.URL.Path)
			assert.Equal(t, false, body["store"])
			assert.Contains(t, string(raw), `"strict":false`)
			if calls == 1 {
				respond(`{"status":"completed","output":[{"type":"reasoning","id":"r1","encrypted_content":"opaque-reasoning","summary":[]},{"type":"function_call","id":"fc1","call_id":"call-1","name":"list_projects","arguments":"{}"}]}`)
			} else {
				assert.Contains(t, string(raw), `"encrypted_content":"opaque-reasoning"`)
				assert.Contains(t, string(raw), `"type":"function_call_output"`)
				assert.Contains(t, string(raw), `"call_id":"call-1"`)
				respond(`{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Done"}]}]}`)
			}
		case "anthropic":
			assert.Equal(t, "/custom/v1/messages", r.URL.Path)
			assert.InDelta(t, 128000, body["max_tokens"], 0)
			assert.Contains(t, string(raw), `"input_schema"`)
			if calls == 1 {
				respond(`{"content":[{"type":"thinking","thinking":"internal","signature":"opaque-signature"},{"type":"tool_use","id":"call-1","name":"list_projects","input":{}}],"stop_reason":"tool_use"}`)
			} else {
				assert.Contains(t, string(raw), `"signature":"opaque-signature"`)
				assert.Contains(t, string(raw), `"type":"tool_result"`)
				assert.Contains(t, string(raw), `"tool_use_id":"call-1"`)
				respond(`{"content":[{"type":"text","text":"Done"}],"stop_reason":"end_turn"}`)
			}
		case "gemini":
			assert.Equal(t, "/custom/v1/models/task-model:streamGenerateContent", r.URL.Path)
			assert.Equal(t, "sse", r.URL.Query().Get("alt"))
			assert.Contains(t, string(raw), `"parametersJsonSchema"`)
			if calls == 1 {
				respond(`{"candidates":[{"content":{"parts":[{"functionCall":{"id":"call-1","name":"list_projects","args":{}},"thoughtSignature":"opaque-thought"}]},"finishReason":"STOP"}]}`)
			} else {
				assert.Contains(t, string(raw), `"thoughtSignature":"opaque-thought"`)
				assert.Contains(t, string(raw), `"functionResponse"`)
				assert.Contains(t, string(raw), `"id":"call-1"`)
				assert.Contains(t, string(raw), `"name":"list_projects"`)
				respond(`{"candidates":[{"content":{"parts":[{"text":"Do not expose","thought":true},{"text":"Done"}]},"finishReason":"STOP"}]}`)
			}
		}
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	base := provider.URL + "/custom/v1"
	for _, p := range []string{"openai-chat", "openai-responses", "anthropic", "gemini"} {
		t.Run(p, func(t *testing.T) {
			protocol, mode, calls = p, "chat", 0
			settings := fmt.Sprintf(`{"connections":[{"id":"connection","name":"Provider","base_url":%q,"protocol":%q,"model":"task-model","kind":"chat","api_key":"fixture-secret"}],"assistant":"connection","transcription":"","cleanup":""}`, base, p)
			saved := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "")
			require.Equal(t, 200, saved.Code, saved.Body.String())
			assert.NotContains(t, saved.Body.String(), "fixture-secret")
			run := humaRequest(t, e, "POST", "/api/v2/ai/run", fmt.Sprintf(`{"message":"List my projects","history":[],"project_id":0,"mode":"read","allow_delete":false,"request_id":"protocol-%s-001"}`, p), token, "")
			require.Equal(t, 200, run.Code, run.Body.String())
			assert.Contains(t, run.Body.String(), `"reply":"Done"`)
			assert.Contains(t, run.Body.String(), `"success":true`)
			assert.NotContains(t, run.Body.String(), "opaque-")
			if p == "gemini" {
				assert.Contains(t, run.Body.String(), `"reasoning":"Do not expose"`)
			}
			assert.Equal(t, 2, calls)
			mode, calls = "models", 0
			query := fmt.Sprintf(`{"id":"connection","base_url":%q,"protocol":%q,"kind":"chat"}`, base, p)
			models := humaRequest(t, e, "POST", "/api/v2/ai/models", query, token, "")
			require.Equal(t, 200, models.Code, models.Body.String())
			assert.Contains(t, models.Body.String(), `"models":["alpha","zeta"]`)
			assert.Contains(t, models.Body.String(), base+"/models")
			assert.NotContains(t, models.Body.String(), "fixture-secret")
			assert.Equal(t, 401, humaRequest(t, e, "POST", "/api/v2/ai/models", query, "", "").Code)
		})
	}
	for _, p := range []string{"openai-audio", "gemini"} {
		t.Run("transcribe-"+p, func(t *testing.T) {
			protocol, mode, calls = p, "audio", 0
			settings := fmt.Sprintf(`{"connections":[{"id":"speech","name":"Speech","base_url":%q,"protocol":%q,"model":"task-model","kind":"transcription","api_key":"fixture-secret"}],"assistant":"","transcription":"speech","cleanup":""}`, base, p)
			saved := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "")
			require.Equal(t, 200, saved.Code, saved.Body.String())
			audio := fmt.Sprintf(`{"connection_id":"speech","audio":%q,"filename":"voice.wav"}`, base64.StdEncoding.EncodeToString([]byte("RIFF test audio")))
			tested := humaRequest(t, e, "POST", "/api/v2/ai/test", audio, token, "")
			require.Equal(t, 200, tested.Code, tested.Body.String())
			assert.Contains(t, tested.Body.String(), "Audio transcript")
			assert.Contains(t, tested.Body.String(), `"endpoint":"`+base)
			if p == "openai-audio" {
				bad := humaRequest(t, e, "POST", "/api/v2/ai/test", strings.Replace(audio, "voice.wav", "voice.webm", 1), token, "")
				assert.Equal(t, 400, bad.Code)
				assert.Equal(t, 1, calls)
			}
			invalid := strings.Replace(settings, `"protocol":"`+p+`"`, `"protocol":"anthropic"`, 1)
			assert.Equal(t, 400, humaRequest(t, e, "POST", "/api/v2/ai/settings", invalid, token, "").Code)
		})
	}
	// UI language affects validation errors; it must not reveal provider credentials.
	for _, language := range []string{"en", "zh-CN"} {
		req := httptest.NewRequest("POST", "/api/v2/ai/models", strings.NewReader(`{"id":"draft","base_url":"http://invalid.example","protocol":"openai-chat","kind":"chat","api_key":"private-key"}`))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("Accept-Language", language)
		req.Header.Set("Authorization", "Bearer "+token)
		rec := httptest.NewRecorder()
		e.ServeHTTP(rec, req)
		require.Equal(t, 400, rec.Code)
		assert.NotContains(t, rec.Body.String(), "private-key")
		var problem map[string]any
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &problem))
		assert.Equal(t, i18n.T(language, "tcymc.errors.e35"), problem["detail"])
		if language == "en" {
			assert.Contains(t, rec.Body.String(), "HTTPS")
		} else {
			assert.Contains(t, rec.Body.String(), "HTTPS")
			assert.NotContains(t, rec.Body.String(), "must")
		}
	}
}

func TestTCYAIStreamingDefaultAndOptOut(t *testing.T) {
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	protocol := ""
	nonStreaming := false
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			return
		}
		if protocol == "gemini" {
			if nonStreaming {
				assert.True(t, strings.HasSuffix(r.URL.Path, ":generateContent"))
				assert.Empty(t, r.URL.Query().Get("alt"))
			} else {
				assert.True(t, strings.HasSuffix(r.URL.Path, ":streamGenerateContent"))
				assert.Equal(t, "sse", r.URL.Query().Get("alt"))
			}
		} else {
			assert.Equal(t, !nonStreaming, body["stream"] == true)
		}
		if nonStreaming {
			w.Header().Set("Content-Type", "application/json")
			responses := map[string]string{
				"openai-chat":      `{"choices":[{"message":{"role":"assistant","content":"Hello"}}]}`,
				"openai-responses": `{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}`,
				"anthropic":        `{"content":[{"type":"text","text":"Hello"}],"stop_reason":"end_turn"}`,
				"gemini":           `{"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}`,
			}
			_, err := io.WriteString(w, responses[protocol])
			assert.NoError(t, err)
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		responses := map[string]string{
			"openai-chat":      `data: {"choices":[{"index":0,"delta":{"content":"Hello"},"finish_reason":"stop"}]}` + "\n\n",
			"openai-responses": `event: response.output_text.delta` + "\n" + `data: {"type":"response.output_text.delta","delta":"Hello","output_index":0}` + "\n\n" + `event: response.completed` + "\n" + `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Hello"}]}]}}` + "\n\n",
			"anthropic":        `data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}` + "\n\n" + `data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}` + "\n\n" + `data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}` + "\n\n" + `data: {"type":"message_stop"}` + "\n\n",
			"gemini":           `data: {"candidates":[{"content":{"parts":[{"text":"Hello"}]},"finishReason":"STOP"}]}` + "\n\n",
		}
		_, err := io.WriteString(w, responses[protocol])
		assert.NoError(t, err)
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	for _, p := range []string{"openai-chat", "openai-responses", "anthropic", "gemini"} {
		for _, disabled := range []bool{false, true} {
			protocol, nonStreaming = p, disabled
			t.Run(fmt.Sprintf("%s/non_streaming=%t", p, disabled), func(t *testing.T) {
				result, err := tcyai.Chat(context.Background(), tcyai.Connection{BaseURL: provider.URL + "/v1", Model: "fixture", Protocol: p, NonStreaming: disabled}, []tcyai.Message{{Role: "user", Content: "Hello"}}, nil)
				require.NoError(t, err)
				assert.Equal(t, "Hello", result.Content)
			})
		}
	}
}
