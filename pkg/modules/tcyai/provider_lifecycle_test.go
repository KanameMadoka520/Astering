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
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"

	"github.com/stretchr/testify/require"
)

func allowLocalProvider(t *testing.T) {
	t.Helper()
	previous := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(previous) })
}

func TestTCYAIProviderExplicitEndDoesNotWaitForEOF(t *testing.T) {
	allowLocalProvider(t)
	for _, tc := range []struct {
		protocol string
		frames   string
	}{
		{
			protocol: "openai-chat",
			frames: `data: {"choices":[{"delta":{"content":"Answer"},"finish_reason":"stop"}]}

data: {"choices":[],"usage":{"prompt_tokens":10,"completion_tokens":20}}

data: [DONE]

`,
		},
		{
			protocol: "anthropic",
			frames: `data: {"type":"message_start","message":{"usage":{"input_tokens":10}}}

data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":"Answer"}}

data: {"type":"message_delta","delta":{"stop_reason":"end_turn"},"usage":{"output_tokens":20}}

data: {"type":"message_stop"}

`,
		},
		{
			protocol: "openai-responses",
			frames: `data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Answer"}]}],"usage":{"input_tokens":10,"output_tokens":20}}}

`,
		},
	} {
		t.Run(tc.protocol, func(t *testing.T) {
			disconnected := make(chan struct{})
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = fmt.Fprint(w, tc.frames)
				w.(http.Flusher).Flush()
				<-r.Context().Done()
				close(disconnected)
			}))
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
			defer cancel()
			ctx, observation := withObservation(ctx, 1, "model", nil)
			var result map[string]any
			err := request(ctx, Connection{
				BaseURL:  server.URL,
				Protocol: tc.protocol,
			}, http.MethodPost, "/chat", "application/json", strings.NewReader(`{}`), &result)
			require.NoError(t, err, "a provider's explicit completion must finish without waiting for EOF")
			require.NoError(t, ctx.Err(), "the deadline must not be what ended the successful response")
			require.Equal(t, int64(10), observation.step.Usage.Input)
			require.Equal(t, int64(20), observation.step.Usage.Output)
			select {
			case <-disconnected:
			case <-ctx.Done():
				t.Fatal("completed response body was not closed")
			}
		})
	}
}

func TestTCYAIProviderOneShotClosesIdleTransport(t *testing.T) {
	allowLocalProvider(t)
	closed := make(chan struct{}, 1)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	var result map[string]any
	require.NoError(t, request(ctx, Connection{BaseURL: server.URL}, http.MethodGet, "/models", "application/json", nil, &result))
	require.Equal(t, true, result["ok"])
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("one-shot provider request left its private transport's idle connection open")
	}
}

func TestTCYAIProviderScopeReusesAndOwnsConnections(t *testing.T) {
	allowLocalProvider(t)
	addresses := make(chan string, 8)
	closed := make(chan string, 8)
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case addresses <- r.RemoteAddr:
		default:
		}
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	}))
	server.Config.ConnState = func(c net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- c.RemoteAddr().String():
			default:
			}
		}
	}
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	scope, release := withProviderClient(ctx)
	defer release()
	fetch := func(ctx context.Context) string {
		t.Helper()
		var result map[string]any
		require.NoError(t, request(ctx, Connection{BaseURL: server.URL}, http.MethodGet, "/models", "application/json", nil, &result))
		return <-addresses
	}
	first := fetch(scope)
	nested, releaseNested := withProviderClient(scope)
	require.Equal(t, first, fetch(nested))
	releaseNested()
	require.Equal(t, first, fetch(scope), "a child must not close the parent pool")
	independent, releaseIndependent := withProviderClient(ctx)
	defer releaseIndependent()
	second := fetch(independent)
	require.NotEqual(t, first, second, "independent runs must not share lifecycle or policy snapshots")
	releaseIndependent()
	select {
	case addr := <-closed:
		require.Equal(t, second, addr)
	case <-ctx.Done():
		t.Fatal("independent pool did not close")
	}
	require.Equal(t, first, fetch(scope), "closing another run must not affect this pool")
	release()
	select {
	case addr := <-closed:
		require.Equal(t, first, addr)
	case <-ctx.Done():
		t.Fatal("owning run did not close its idle pool")
	}
}

func TestTCYAIProviderRunReusesConnectionAcrossToolRounds(t *testing.T) {
	allowLocalProvider(t)
	addresses := make(chan string, 2)
	closed := make(chan struct{}, 2)
	var rounds atomic.Int32
	server := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		select {
		case addresses <- r.RemoteAddr:
		default:
		}
		w.Header().Set("Content-Type", "application/json")
		if rounds.Add(1) == 1 {
			_, _ = fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","tool_calls":[{"id":"call-1","type":"function","function":{"name":"get_task","arguments":"{\"id\":1}"}}]},"finish_reason":"tool_calls"}]}`)
			return
		}
		_, _ = fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"Done"},"finish_reason":"stop"}]}`)
	}))
	server.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateClosed {
			select {
			case closed <- struct{}{}:
			default:
			}
		}
	}
	server.Start()
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	connection := Connection{
		BaseURL:      server.URL,
		Protocol:     "openai-chat",
		Model:        "test",
		NonStreaming: true,
	}
	state := NewAgentState(ctx, connection, RunInput{
		Message: "Read task one",
		Mode:    "read",
	})
	state.Available = append(state.Available, "get_task")
	var calls int
	result, err := RunAgent(ctx, connection, state, func(context.Context, string, json.RawMessage) (string, error) {
		calls++
		return `{"id":1,"title":"Task"}`, nil
	}, nil, nil)
	require.NoError(t, err)
	require.Equal(t, "Done", result.Reply)
	require.Equal(t, 1, calls)
	require.EqualValues(t, 2, rounds.Load())
	firstAddress, secondAddress := <-addresses, <-addresses
	require.Equal(t, firstAddress, secondAddress, "tool rounds should reuse the same provider connection")
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("finished agent did not release its idle transport")
	}
}

func TestTCYAIProviderScopeRetainsSSRFAndRedirectProtection(t *testing.T) {
	allowLocalProvider(t)
	var redirected atomic.Int32
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		redirected.Add(1)
		_, _ = fmt.Fprint(w, `{"ok":true}`)
	}))
	defer target.Close()
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusFound)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	scope, release := withProviderClient(ctx)
	defer release()
	var result map[string]any
	require.Error(t, request(scope, Connection{BaseURL: server.URL}, http.MethodGet, "/redirect", "application/json", nil, &result))
	require.Zero(t, redirected.Load(), "redirects must never be followed")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(false)
	guarded, releaseGuarded := withProviderClient(ctx)
	defer releaseGuarded()
	require.Error(t, request(guarded, Connection{BaseURL: target.URL}, http.MethodGet, "/models", "application/json", nil, &result))
	require.Zero(t, redirected.Load(), "a new scope must apply its own SSRF policy, not reuse a previous pool")
}

func TestTCYAIProviderScopeCancellationClosesActiveResponse(t *testing.T) {
	allowLocalProvider(t)
	started := make(chan struct{})
	disconnected := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
		close(disconnected)
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	scope, release := withProviderClient(ctx)
	defer release()
	finished := make(chan error, 1)
	go func() {
		var result map[string]any
		finished <- request(scope, Connection{
			BaseURL:  server.URL,
			Protocol: "openai-chat",
		}, http.MethodPost, "/chat", "application/json", strings.NewReader(`{}`), &result)
	}()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("provider request never started")
	}
	cancel()
	timeout := time.NewTimer(2 * time.Second)
	defer timeout.Stop()
	select {
	case err := <-finished:
		require.Error(t, err)
	case <-timeout.C:
		t.Fatal("canceled request did not return")
	}
	select {
	case <-disconnected:
	case <-timeout.C:
		t.Fatal("canceled response was not closed")
	}
}

func TestTCYAIProviderGeminiFinishPreservesTrailingUsage(t *testing.T) {
	_, observation := withObservation(context.Background(), 1, "model", nil)
	raw, err := readStream(strings.NewReader(`data: {"candidates":[{"content":{"parts":[{"text":"Answer","thoughtSignature":"signed"}]},"finishReason":"STOP"}]}

data: {"usageMetadata":{"promptTokenCount":10,"candidatesTokenCount":20}}

`), "gemini", observation)
	require.NoError(t, err)
	captureResponse(observation, "gemini", raw)
	require.Equal(t, int64(10), observation.step.Usage.Input)
	require.Equal(t, int64(20), observation.step.Usage.Output)
	require.Contains(t, string(raw), "signed")
	require.Equal(t, "Answer", observation.step.Text)
}
