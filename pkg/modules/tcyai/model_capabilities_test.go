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

package tcyai

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIModelCapabilities(t *testing.T) {
	official := Connection{BaseURL: "https://api.deepseek.com/anthropic", Model: "deepseek-flash", Protocol: "anthropic"}
	assert.Equal(t, int64(393216), official.Capabilities().MaxOutputTokens)
	assert.Equal(t, int64(1048576), official.Capabilities().ContextWindow)
	assert.Equal(t, []string{"text", "image"}, official.Capabilities().InputTypes)
	listed := modelListConnection(official)
	assert.Equal(t, "https://api.deepseek.com", listed.BaseURL)
	assert.Equal(t, "openai-chat", listed.Protocol)
	official.MaxOutputTokens = 250000
	assert.Equal(t, int64(250000), official.Capabilities().MaxOutputTokens)
	official.BaseURL = "https://gateway.example/anthropic"
	official.MaxOutputTokens = 0
	assert.Equal(t, int64(128000), official.Capabilities().MaxOutputTokens)
	assert.Zero(t, official.Capabilities().ContextWindow)
	assert.Equal(t, official, modelListConnection(official))
	official.Protocol = "openai-chat"
	assert.Zero(t, official.Capabilities().MaxOutputTokens)
	for _, c := range []Connection{{ContextWindow: -1}, {MaxOutputTokens: -1}, {InputTypes: []string{"image"}}, {InputTypes: []string{"text", "text"}}, {OutputTokenField: "bogus"}} {
		require.Error(t, c.validateCapabilities())
	}
	assert.NoError(t, (Connection{ContextWindow: 2000000, MaxOutputTokens: 1000000, InputTypes: []string{"text", "image"}}).validateCapabilities())
}

func TestTCYAIConfiguredOutputWire(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, tc := range []struct{ protocol, field, override, response string }{
		{"anthropic", "max_tokens", "", `{"stop_reason":"end_turn","content":[{"type":"text","text":"done"}]}`},
		{"openai-chat", "max_completion_tokens", "", `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`},
		{"openai-chat", "max_tokens", "max_tokens", `{"choices":[{"message":{"role":"assistant","content":"done"},"finish_reason":"stop"}]}`},
		{"openai-responses", "max_output_tokens", "", `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"done"}]}]}`},
		{"gemini", "maxOutputTokens", "", `{"candidates":[{"finishReason":"STOP","content":{"parts":[{"text":"done"}]}}]}`},
	} {
		t.Run(tc.protocol+tc.field, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				if tc.protocol == "gemini" {
					body = object(body, "generationConfig")
				}
				assert.Equal(t, int64(262144), number(body, tc.field))
				w.Header().Set("Content-Type", "application/json")
				_, err := w.Write([]byte(tc.response))
				assert.NoError(t, err)
			}))
			defer server.Close()
			ctx, o := withObservation(context.Background(), 1, "model", nil)
			m, err := Chat(ctx, Connection{BaseURL: server.URL, Model: "model", Protocol: tc.protocol, MaxOutputTokens: 262144, ContextWindow: 1048576, OutputTokenField: tc.override, NonStreaming: true}, []Message{{Role: "user", Content: "Hello"}}, nil)
			require.NoError(t, err)
			assert.Equal(t, "done", m.Content)
			assert.Equal(t, int64(262144), o.step.MaxOutputTokens)
			assert.Equal(t, int64(1048576), o.step.ContextWindow)
		})
	}
}

func TestTCYAIModelDirectoryCapabilities(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, err := w.Write([]byte(`{"data":[{"id":"vision","context_window":1048576,"max_output_tokens":393216,"input_modalities":["text","image"]},{"id":"unknown"}]}`))
		assert.NoError(t, err)
	}))
	defer server.Close()
	list, err := ListModels(context.Background(), Connection{BaseURL: server.URL, Protocol: "openai-chat"})
	require.NoError(t, err)
	require.Len(t, list.Details, 2)
	assert.Zero(t, list.Details[0].ContextWindow)
	assert.Empty(t, list.Details[0].InputTypes)
	assert.Equal(t, int64(393216), list.Details[1].MaxOutputTokens)
	assert.Equal(t, []string{"text", "image"}, list.Details[1].InputTypes)
}
