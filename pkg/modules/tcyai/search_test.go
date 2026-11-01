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
	"strings"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYWebSearchAdapters(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	cases := []struct{ protocol, path, response string }{
		{"deepseek", "/tools/search", `{"results":[{"title":"Docs","url":"https://vikunja.io/docs","summary":"Guide"}]}`},
		{"openai-chat", "/chat/completions", `{"choices":[{"message":{"content":"Found","annotations":[{"type":"url_citation","url_citation":{"url":"https://vikunja.io/docs","title":"Docs"}}]},"finish_reason":"stop"}],"usage":{"prompt_tokens":5,"completion_tokens":3}}`},
		{"openai-responses", "/responses", `{"status":"completed","output":[{"type":"web_search_call","status":"completed","action":{"sources":[{"url":"https://vikunja.io/docs","title":"Docs"}]}},{"type":"message","content":[{"type":"output_text","text":"Found"}]}],"usage":{"input_tokens":5,"output_tokens":3}}`},
		{"anthropic", "/messages", `{"stop_reason":"end_turn","content":[{"type":"web_search_tool_result","content":[{"type":"web_search_result","url":"https://vikunja.io/docs","title":"Docs"}]},{"type":"text","text":"Found"}],"usage":{"input_tokens":5,"output_tokens":3}}`},
		{"gemini", "/models/search-model:generateContent", `{"candidates":[{"content":{"parts":[{"text":"Found"}]},"finishReason":"STOP","groundingMetadata":{"groundingChunks":[{"web":{"uri":"https://vikunja.io/docs","title":"Docs"}}],"searchEntryPoint":{"renderedContent":"<div>Google Search</div>"}}}],"usageMetadata":{"promptTokenCount":5,"candidatesTokenCount":3}}`},
	}
	for _, tc := range cases {
		t.Run(tc.protocol, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, tc.path, r.URL.Path)
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				assert.NotContains(t, body, "api_key")
				switch tc.protocol {
				case "deepseek":
					assert.Equal(t, "Vikunja docs", body["query"])
					assert.Equal(t, "Bearer secret", r.Header.Get("Authorization"))
					assert.NotContains(t, body, "model")
				case "openai-chat":
					assert.Contains(t, body, "web_search_options")
				case "openai-responses":
					assert.Equal(t, "required", body["tool_choice"])
				case "anthropic":
					assert.Equal(t, "secret", r.Header.Get("x-api-key"))
					assert.NotZero(t, body["max_tokens"])
				case "gemini":
					assert.Equal(t, "secret", r.Header.Get("x-goog-api-key"))
					assert.Contains(t, asObject(list(body, "tools")[0]), "google_search")
				}
				if tc.protocol != "deepseek" && tc.protocol != "gemini" {
					assert.Equal(t, "search-model", body["model"])
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = w.Write([]byte(tc.response))
			}))
			defer server.Close()
			c := Connection{Kind: "chat", BaseURL: server.URL, Model: "chat-model", Protocol: "anthropic", APIKey: "secret", NonStreaming: true, WebSearchProtocol: tc.protocol, WebSearchModel: "search-model"}
			result, err := SearchWeb(context.Background(), c, "Vikunja docs")
			require.NoError(t, err)
			assert.True(t, result.Verified)
			require.Len(t, result.Sources, 1)
			assert.Equal(t, "https://vikunja.io/docs", result.Sources[0].URL)
			assert.Equal(t, 200, result.Step.HTTPStatus)
			if tc.protocol != "deepseek" {
				assert.Equal(t, int64(5), result.Step.Usage.Input)
				assert.Equal(t, "Found", result.Summary)
			}
		})
	}
}

func TestTCYWebSearchValidationAndEvidence(t *testing.T) {
	c := Connection{Kind: "chat", BaseURL: "https://api.deepseek.com/anthropic", Model: "deepseek-flash", Protocol: "anthropic", WebSearchProtocol: "deepseek"}
	assert.Equal(t, "https://api.deepseek.com/v1/tools/search", SearchEndpoint(c))
	c.WebSearchBaseURL = "https://evil.example/v1"
	require.Error(t, validateSearch(&c))
	c.WebSearchBaseURL = "https://api.deepseek.com/v1?key=secret"
	require.Error(t, validateSearch(&c))
	c.WebSearchBaseURL = ""
	c.WebSearchProtocol = "guess"
	require.Error(t, validateSearch(&c))
	c.WebSearchProtocol = ""
	_, err := SearchWeb(context.Background(), c, "test")
	require.Error(t, err)
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	raw, err := state.discover(json.RawMessage(`{"query":"web_search"}`))
	require.NoError(t, err)
	assert.NotContains(t, raw, `"name":"web_search"`)
	state.SearchEnabled = true
	raw, err = state.discover(json.RawMessage(`{"query":"web_search"}`))
	require.NoError(t, err)
	assert.Contains(t, raw, `"name":"web_search"`)
	assert.False(t, IsWriteTool("web_search"))
	assert.False(t, NeedsReview("web_search", RunInput{Approval: "review"}))
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, body := range []string{`{"choices":[{"message":{"content":"I searched the web"},"finish_reason":"stop"}]}`, `{"choices":[{"message":{"content":"http://example.org is a source"},"finish_reason":"stop"}]}`} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { _, _ = w.Write([]byte(body)) }))
		result, searchErr := SearchWeb(context.Background(), Connection{Kind: "chat", BaseURL: server.URL, Protocol: "openai-chat", WebSearchProtocol: "openai-chat", NonStreaming: true}, "test")
		require.NoError(t, searchErr)
		assert.False(t, result.Verified)
		server.Close()
	}
}

func TestTCYWebSearchStreamingCitations(t *testing.T) {
	cases := []struct{ protocol, stream, needle string }{
		{"openai-chat", "data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"Found\",\"annotations\":[{\"type\":\"url_citation\",\"url_citation\":{\"url\":\"https://example.com\"}}]},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n", "url_citation"},
		{"gemini", "data: {\"candidates\":[{\"content\":{\"parts\":[{\"text\":\"Found\"}]},\"groundingMetadata\":{\"groundingChunks\":[{\"web\":{\"uri\":\"https://example.com\"}}]},\"finishReason\":\"STOP\"}]}\n\n", "groundingChunks"},
		{"anthropic", "data: {\"type\":\"message_start\",\"message\":{}}\n\ndata: {\"type\":\"content_block_start\",\"index\":0,\"content_block\":{\"type\":\"text\",\"text\":\"Found\"}}\n\ndata: {\"type\":\"content_block_delta\",\"index\":0,\"delta\":{\"type\":\"citations_delta\",\"citation\":{\"type\":\"web_search_result_location\",\"url\":\"https://example.com\"}}}\n\ndata: {\"type\":\"message_stop\"}\n\n", "web_search_result_location"},
	}
	for _, tc := range cases {
		t.Run(tc.protocol, func(t *testing.T) {
			_, o := withObservation(context.Background(), 1, "fixture", nil)
			raw, err := readStream(strings.NewReader(tc.stream), tc.protocol, o)
			require.NoError(t, err)
			assert.Contains(t, string(raw), tc.needle)
			assert.Contains(t, string(raw), "https://example.com")
		})
	}
}

func TestTCYWebSearchTurnPolicy(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, mode := range []string{"auto", "off", "required"} {
		t.Run(mode, func(t *testing.T) {
			chatCalls, searchCalls := 0, 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				if r.URL.Path == "/tools/search" {
					searchCalls++
					_, _ = w.Write([]byte(`{"results":[{"title":"Source","url":"https://example.com","summary":"fact"}]}`))
					return
				}
				chatCalls++
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					return
				}
				raw, _ := json.Marshal(body["tools"])
				assert.Contains(t, string(raw), `"name":"web_search"`, "stable entry points do not change with policy; backend enforces off")
				messages, _ := json.Marshal(body["messages"])
				assert.Contains(t, string(messages), `\"search_mode\":\"`+mode+`\"`)

				if mode == "required" && chatCalls == 1 {
					assert.Equal(t, "auto", body["tool_choice"])
					requireTools := list(body, "tools")
					names := make([]string, 0, len(requireTools))
					for _, entry := range requireTools {
						entryTool, _ := entry.(map[string]any)
						names = append(names, toolName(entryTool))
					}
					assert.ElementsMatch(t, []string{"list_projects", "list_tasks", "get_task", "read_tool_result", "find_tools", "ask_user", "web_search", "invoke_tool"}, names)
					_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"","tool_calls":[{"id":"s1","type":"function","function":{"name":"web_search","arguments":"{\"query\":\"Vikunja docs\"}"}}]},"finish_reason":"tool_calls"}]}`))
					return
				}
				assert.Equal(t, "auto", body["tool_choice"])
				_, _ = w.Write([]byte(`{"choices":[{"message":{"content":"done"},"finish_reason":"stop"}]}`))
			}))
			defer server.Close()
			c := Connection{Kind: "chat", Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", WebSearchProtocol: "deepseek", NonStreaming: true}
			state := NewAgentState(context.Background(), c, RunInput{Mode: "read", SearchMode: mode, Message: "test"})
			result, err := RunAgent(context.Background(), c, state, func(context.Context, string, json.RawMessage) (string, error) {
				t.Error("search must not reach app executor")
				return "", nil
			}, nil, nil)
			require.NoError(t, err)
			assert.Equal(t, "completed", result.Stage)
			if mode == "required" {
				assert.Equal(t, 1, searchCalls)
				require.Len(t, result.Actions, 1)
				assert.True(t, result.Actions[0].Search.Verified)
			} else {
				assert.Zero(t, searchCalls)
			}
		})
	}
	c := Connection{Kind: "chat"}
	state := NewAgentState(context.Background(), c, RunInput{SearchMode: "required"})
	_, err := RunAgent(context.Background(), c, state, nil, nil, nil)
	require.Error(t, err)
}
