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

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAICompactionRecovery(t *testing.T) {
	i18n.Init()
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, streaming := range []bool{false, true} {
		for _, failAlways := range []bool{false, true} {
			t.Run(strings.Join([]string{map[bool]string{true: "stream", false: "json"}[streaming], map[bool]string{true: "failure", false: "recovered"}[failAlways]}, "-"), func(t *testing.T) {
				calls := 0
				server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
					calls++
					var request map[string]any
					if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&request)) {
						return
					}
					assert.NotContains(t, request, "tools")
					assert.Equal(t, int64(4096), number(request, "max_tokens"))
					messages := list(request, "messages")
					raw, _ := json.Marshal(messages)
					assert.Contains(t, string(raw), "previous-successful-checkpoint")
					assert.NotContains(t, string(raw), "old-original-already-compacted")
					assert.NotContains(t, string(raw), "truncated-draft")
					if calls == 2 {
						assert.Contains(t, textValue(request, "system"), "6000 characters")
					}
					stop, text := "end_turn", "Project 7, task 42: confirmed complete; do not replay."
					if calls == 1 || failAlways {
						stop, text = "max_tokens", "truncated-draft"
					}
					if streaming {
						w.Header().Set("Content-Type", "text/event-stream")
						frames := []any{
							map[string]any{"type": "message_start", "message": map[string]any{"model": "actual", "usage": map[string]int{"input_tokens": 100}}},
							map[string]any{"type": "content_block_start", "index": 0, "content_block": map[string]string{"type": "text", "text": ""}},
							map[string]any{"type": "content_block_delta", "index": 0, "delta": map[string]string{"type": "text_delta", "text": text}},
							map[string]any{"type": "message_delta", "delta": map[string]string{"stop_reason": stop}, "usage": map[string]int{"output_tokens": 20}},
							map[string]any{"type": "message_stop"},
						}
						for _, frame := range frames {
							raw, _ := json.Marshal(frame)
							_, err := w.Write(append(append([]byte("data: "), raw...), []byte("\n\n")...))
							assert.NoError(t, err)
						}
					} else {
						w.Header().Set("Content-Type", "application/json")
						assert.NoError(t, json.NewEncoder(w).Encode(map[string]any{"model": "actual", "stop_reason": stop, "content": []any{map[string]string{"type": "text", "text": text}}, "usage": map[string]int{"input_tokens": 100, "output_tokens": 20}}))
					}
				}))
				defer server.Close()
				record := &conversationFile{Conversation: Conversation{Turns: []ChatTurn{{Prompt: "old-original-already-compacted"}, {Prompt: "new task 42 request", Status: "completed"}}, Compactions: []Compaction{{Through: 1, Summary: "previous-successful-checkpoint"}}}}
				var last *CompactProgress
				summary, usage, model, err := summarizeConversation(context.Background(), record, Connection{Protocol: "anthropic", MaxOutputTokens: 4096, BaseURL: server.URL, Model: "requested", NonStreaming: !streaming}, 2, func(_ string, p CompactProgress) { last = cloneCompactProgress(&p) })
				assert.Equal(t, 2, calls)
				assert.Equal(t, int64(200), usage.Input)
				assert.Equal(t, int64(40), usage.Output)
				require.NotNil(t, last)
				assert.Equal(t, usage, last.Usage)
				assert.Equal(t, "actual", model)
				require.Len(t, last.Steps, 2)
				assert.Equal(t, "max_tokens", last.Steps[0].StopReason)
				assert.Empty(t, last.Steps[0].Text)
				assert.Empty(t, last.Steps[0].Reasoning)
				assert.Equal(t, 2, last.Attempt)
				assert.Len(t, record.Turns, 2)
				assert.Equal(t, "previous-successful-checkpoint", record.Compactions[0].Summary)
				if failAlways {
					require.Error(t, err)
					assert.Equal(t, "MODEL_OUTPUT_LIMIT", failureCode(err))
					assert.Empty(t, summary)
				} else {
					require.NoError(t, err)
					assert.Contains(t, summary, "task 42")
				}
			})
		}
	}
}
