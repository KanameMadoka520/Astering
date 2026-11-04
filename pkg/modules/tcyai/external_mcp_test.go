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
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type mcpFixturePeer struct {
	Connection          MCPConnection
	Server              *mcp.Server
	Calls               atomic.Int64
	Requests            atomic.Int64
	BadAuth             atomic.Bool
	ListGate            atomic.Pointer[mcpFixtureListGate]
	LiteralHTMLResponse atomic.Bool
}

type mcpFixtureListGate struct {
	Started chan struct{}
	Release chan struct{}
	once    sync.Once
}

// The real SDK peer exercises initialization, JSON-RPC framing and HTTP lifecycle.
// Root harness tests can replace/add tools on Server before the first Discover.
func newMCPFixture(t *testing.T, transport string) *mcpFixturePeer {
	t.Helper()
	speechSettingsFixture(t)
	allowLocalProvider(t)
	peer := &mcpFixturePeer{}
	peer.Server = mcp.NewServer(&mcp.Implementation{Name: "fixture", Version: "1"}, nil)
	for _, name := range []string{"read_fixture", "write_fixture", "delete_fixture"} {
		peer.Server.AddTool(&mcp.Tool{
			Name:        name,
			Description: "Fixture tool",
			InputSchema: map[string]any{
				"type":                 "object",
				"properties":           map[string]any{"value": map[string]any{"type": "string"}},
				"required":             []string{"value"},
				"additionalProperties": false,
			},
		}, func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			peer.Calls.Add(1)
			return &mcp.CallToolResult{
				StructuredContent: map[string]any{"ok": true, "arguments": json.RawMessage(request.Params.Arguments)},
				Content:           []mcp.Content{&mcp.TextContent{Text: "DUPLICATE_TEXT_MUST_NOT_REACH_MODEL"}},
			}, nil
		})
	}
	var handler http.Handler = mcp.NewStreamableHTTPHandler(func(*http.Request) *mcp.Server { return peer.Server }, &mcp.StreamableHTTPOptions{
		Stateless:    true,
		JSONResponse: true,
	})
	if transport == "sse" {
		handler = mcp.NewSSEHandler(func(*http.Request) *mcp.Server { return peer.Server }, nil)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		peer.Requests.Add(1)
		if r.Header.Get("Authorization") != "Bearer fixture-private-key" || r.Header.Get("User-Agent") != "Astering-MCP/1.0" {
			peer.BadAuth.Store(true)
			http.Error(w, "unauthorized", http.StatusUnauthorized)
			return
		}
		if gate := peer.ListGate.Load(); gate != nil && r.Method == http.MethodPost {
			body, _ := io.ReadAll(io.LimitReader(r.Body, 128*1024))
			_ = r.Body.Close()
			r.Body = io.NopCloser(bytes.NewReader(body))
			var message struct {
				Method string `json:"method"`
			}
			_ = json.Unmarshal(body, &message)
			if message.Method == "tools/list" {
				gate.once.Do(func() { close(gate.Started) })
				select {
				case <-gate.Release:
				case <-r.Context().Done():
					return
				}
			}
		}
		if peer.LiteralHTMLResponse.Load() {
			recorded := httptest.NewRecorder()
			handler.ServeHTTP(recorded, r)
			for key, values := range recorded.Header() {
				if strings.EqualFold(key, "Content-Length") {
					continue
				}
				for _, value := range values {
					w.Header().Add(key, value)
				}
			}
			w.WriteHeader(recorded.Code)
			_, _ = w.Write(bytes.ReplaceAll(recorded.Body.Bytes(), []byte(`\u003c`), []byte("<")))
			return
		}
		handler.ServeHTTP(w, r)
	}))
	t.Cleanup(server.Close)
	peer.Connection = MCPConnection{
		ID:          "fixture",
		Name:        "Fixture",
		URL:         server.URL,
		Transport:   transport,
		Preset:      "custom",
		Enabled:     true,
		AllowWrite:  true,
		AllowDelete: true,
		ReadTools:   []string{"read_fixture"},
		APIKey:      "fixture-private-key",
	}
	return peer
}

func saveMCPFixture(t *testing.T, peer *mcpFixturePeer) MCPSettings {
	t.Helper()
	saved, err := SaveMCP(94101, MCPSettings{Connections: []MCPConnection{peer.Connection}})
	require.NoError(t, err)
	return saved
}

func TestTCYAIMCPSettingsEncryptedRevisionAndDestination(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saved := saveMCPFixture(t, peer)
	require.Equal(t, int64(1), saved.Revision)
	require.Empty(t, saved.Connections[0].APIKey)
	require.True(t, saved.Connections[0].HasKey)
	file, err := os.ReadFile(mcpSettingsPath(94101))
	require.NoError(t, err)
	assert.NotContains(t, string(file), peer.Connection.APIKey)
	stored, err := LoadMCP(94101)
	require.NoError(t, err)
	assert.Equal(t, peer.Connection.APIKey, stored.Connections[0].APIKey)
	again, err := SaveMCP(94101, saved)
	require.NoError(t, err)
	assert.Equal(t, saved.Connections[0].Revision, again.Connections[0].Revision)
	_, err = SaveMCP(94101, saved)
	require.ErrorIs(t, err, ErrMCPSettingsConflict)
	again.Connections[0].URL += "/different"
	_, err = SaveMCP(94101, again)
	require.ErrorIs(t, err, ErrMCPCredentials)
	again.Connections[0].APIKey = "new-destination-key"
	changed, err := SaveMCP(94101, again)
	require.NoError(t, err)
	assert.NotEqual(t, saved.Connections[0].Revision, changed.Connections[0].Revision)
	other, err := LoadMCP(94102)
	require.NoError(t, err)
	assert.Empty(t, other.Connections)
	require.NoError(t, os.MkdirAll(conversationDir(94102), 0700))
	require.NoError(t, os.WriteFile(mcpSettingsPath(94102), file, 0600)) //nolint:gosec // Fixed UID under t.TempDir; ciphertext copy verifies account-bound AAD rejection.
	_, err = LoadMCP(94102)
	require.Error(t, err, "ciphertext is authenticated to its original account")
}

func TestTCYAIMCPRealTransportsDiscoverPrepareCall(t *testing.T) {
	for _, transport := range []string{"streamable_http", "sse"} {
		t.Run(transport, func(t *testing.T) {
			peer := newMCPFixture(t, transport)
			saveMCPFixture(t, peer)
			ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer cancel()
			runtime, err := NewMCPRuntime(ctx, 94101, []string{peer.Connection.ID})
			require.NoError(t, err)
			defer runtime.Close()
			metadata, err := runtime.Connections()
			require.NoError(t, err)
			assert.Len(t, metadata, 1)
			assert.Zero(t, peer.Requests.Load(), "metadata must not initialize connections")
			_, err = runtime.Prepare(ctx, "fixture", "read_fixture", json.RawMessage(`{"value":"x"}`), RunInput{Mode: "read"})
			require.ErrorContains(t, err, "TOOL_NOT_LOADED")
			discovery, err := runtime.Discover(ctx, "fixture", "read_fixture", 1)
			require.NoError(t, err)
			require.Len(t, discovery.Tools, 1)
			assert.True(t, discovery.Tools[0].ReadOnly)
			assert.Zero(t, peer.Calls.Load(), "discover must not call tools")
			_, err = runtime.Prepare(ctx, "fixture", "read_fixture", json.RawMessage(`{"wrong":true}`), RunInput{Mode: "read"})
			require.ErrorContains(t, err, "INVALID_ARGUMENTS")
			prepared, err := runtime.Prepare(ctx, "fixture", "read_fixture", json.RawMessage(`{"value":"x"}`), RunInput{Mode: "read"})
			require.NoError(t, err)
			assert.Zero(t, peer.Calls.Load(), "prepare must not dry-run the business tool")
			result, err := runtime.Call(ctx, prepared, json.RawMessage(`{"value":"x"}`))
			require.NoError(t, err)
			assert.Contains(t, result, `"source":"external_mcp"`)
			assert.NotContains(t, result, "DUPLICATE_TEXT")
			assert.Equal(t, int64(1), peer.Calls.Load())
			assert.False(t, peer.BadAuth.Load())
			_, err = runtime.Call(ctx, prepared, json.RawMessage(`{"value":"x"}`))
			require.ErrorContains(t, err, "MCP_REVIEW_REQUIRED", "the operation is consumed, not automatically replayed")
		})
	}
}

func TestTCYAIMCPPermissionsAndLiveRevocation(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	peer.Connection.AllowDelete = false
	saved := saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	_, err = runtime.Discover(context.Background(), "fixture", "write_fixture", 1)
	require.NoError(t, err)
	raw := json.RawMessage(`{"value":"x"}`)
	for _, input := range []RunInput{
		{Mode: "read"},
		{Mode: "write"},
		{Mode: "write", AllowDelete: true, WriteProjectIDs: []int64{1}},
	} {
		_, err = runtime.Prepare(context.Background(), "fixture", "write_fixture", raw, input)
		require.Error(t, err)
	}
	saved.Connections[0].AllowDelete = true
	saved, err = SaveMCP(94101, saved)
	require.NoError(t, err)
	_, err = runtime.Discover(context.Background(), "fixture", "write_fixture", 1)
	require.NoError(t, err)
	prepared, err := runtime.Prepare(context.Background(), "fixture", "write_fixture", raw, RunInput{Mode: "write", AllowDelete: false})
	require.NoError(t, err)
	saved.Connections[0].Enabled = false
	_, err = SaveMCP(94101, saved)
	require.NoError(t, err)
	_, err = runtime.Call(context.Background(), prepared, raw)
	require.ErrorContains(t, err, "MCP_DISABLED")
	assert.Zero(t, peer.Calls.Load())
	other, err := NewMCPRuntime(context.Background(), 94102, []string{"fixture"})
	require.NoError(t, err)
	defer other.Close()
	_, err = other.Discover(context.Background(), "fixture", "", 1)
	require.ErrorContains(t, err, "MCP_DISABLED")
	unselected, err := NewMCPRuntime(context.Background(), 94101, nil)
	require.NoError(t, err)
	defer unselected.Close()
	_, err = unselected.Discover(context.Background(), "fixture", "", 1)
	require.ErrorContains(t, err, "MCP_NOT_ALLOWED")
}

func TestTCYAIMCPRemoteSchemaChangeInvalidatesTicket(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	_, err = runtime.Discover(context.Background(), "fixture", "read_fixture", 1)
	require.NoError(t, err)
	peer.Server.AddTool(&mcp.Tool{
		Name:        "read_fixture",
		Description: "Changed contract",
		InputSchema: map[string]any{"type": "object"},
	}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		peer.Calls.Add(1)
		return &mcp.CallToolResult{}, nil
	})
	_, err = runtime.Prepare(context.Background(), "fixture", "read_fixture", json.RawMessage(`{}`), RunInput{Mode: "read"})
	require.ErrorContains(t, err, "MCP_DEFINITION_CHANGED")
	assert.Zero(t, peer.Calls.Load())
}

func TestTCYAIMCPTestOnlyInitializesAndLists(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	peer.Connection.Enabled = false
	saveMCPFixture(t, peer)
	draft := peer.Connection
	draft.APIKey = ""
	result, err := TestMCP(context.Background(), 94101, draft)
	require.NoError(t, err)
	assert.Equal(t, "fixture", result.ServerName)
	assert.Len(t, result.Tools, 3)
	assert.Equal(t, 3, result.Matched)
	assert.Zero(t, peer.Calls.Load())
	draft.URL += "/other"
	_, err = TestMCP(context.Background(), 94101, draft)
	require.ErrorIs(t, err, ErrMCPCredentials)
}

func TestTCYAIMCPOriginGuardAndBodyLimit(t *testing.T) {
	endpoint, err := url.Parse("https://trusted.example/mcp")
	require.NoError(t, err)
	var sent atomic.Int64
	transport := &mcpRoundTripper{
		owner:    context.Background(),
		endpoint: endpoint,
		key:      "do-not-leak",
		current:  func() error { return nil },
		base: mcpTestRoundTripper(func(request *http.Request) (*http.Response, error) {
			sent.Add(1)
			assert.Equal(t, "Bearer do-not-leak", request.Header.Get("Authorization"))
			return &http.Response{
				StatusCode: http.StatusOK,
				Header:     http.Header{},
				Body:       io.NopCloser(strings.NewReader(strings.Repeat("x", mcpResponseLimit+1))),
			}, nil
		}),
	}
	for _, target := range []string{"https://evil.example/message", "http://trusted.example/message", "https://trusted.example:444/message", "https://user:pass@trusted.example/message"} {
		request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, target, nil)
		require.NoError(t, err)
		rejected, rejectedErr := transport.RoundTrip(request)
		if rejected != nil {
			require.NoError(t, rejected.Body.Close())
		}
		require.ErrorContains(t, rejectedErr, "MCP_DESTINATION_REJECTED")
	}
	assert.Zero(t, sent.Load())
	request, err := http.NewRequestWithContext(context.Background(), http.MethodPost, "https://trusted.example:443/message", nil)
	require.NoError(t, err)
	response, err := transport.RoundTrip(request)
	require.NoError(t, err)
	defer response.Body.Close()
	_, err = io.ReadAll(response.Body)
	require.ErrorContains(t, err, "size limit")
}

type mcpTestRoundTripper func(*http.Request) (*http.Response, error)

func (roundTrip mcpTestRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	return roundTrip(request)
}

func TestTCYAIMCPPolicyIgnoresAnnotationsAndUnknownTools(t *testing.T) {
	connection := MCPConnection{
		URL:       "https://wallos.tcymc.space/api/agent/mcp.php",
		Preset:    "wallos",
		ReadTools: []string{"manual_read", "wallos_payments_delete", "wallos_unknown"},
	}
	for _, tc := range []struct {
		name        string
		readOnly    bool
		destructive bool
	}{
		{"wallos_context", true, false},
		{"wallos_payments_update", false, false},
		{"wallos_references_save", false, false},
		{"wallos_price_rules_set", false, true},
		{"wallos_payments_delete", false, true},
		{"manual_read", false, true},
		{"wallos_unknown", false, true},
		{"unknown", false, true},
	} {
		readOnly, destructive := mcpToolPolicy(connection, tc.name)
		assert.Equal(t, tc.readOnly, readOnly, tc.name)
		assert.Equal(t, tc.destructive, destructive, tc.name)
	}
	connection.URL = "https://untrusted.example/mcp"
	readOnly, destructive := mcpToolPolicy(connection, "wallos_context")
	assert.False(t, readOnly)
	assert.True(t, destructive)
	connection.Preset = "custom"
	readOnly, destructive = mcpToolPolicy(connection, "manual_read")
	assert.True(t, readOnly, "custom connections retain the owner's explicit trust decision")
	assert.False(t, destructive)
}

func TestTCYAIMCPOutputPrivacyAndBinaryContent(t *testing.T) {
	data, err := mcpToolOutput(&mcp.CallToolResult{StructuredContent: map[string]any{"value": "Bearer fixture-key", "fixture-key": "secret"}}, "fixture-key")
	require.NoError(t, err)
	assert.NotContains(t, data, "fixture-key")
	assert.Contains(t, data, "[redacted]")
	data, err = mcpToolOutput(&mcp.CallToolResult{Content: []mcp.Content{&mcp.ImageContent{Data: []byte("PRIVATE_BYTES"), MIMEType: "image/png"}}}, "")
	require.NoError(t, err)
	assert.NotContains(t, data, "UFJJVkFURV9CWVRFUw")
	assert.Contains(t, data, "unsupported_non_text")
}

func TestTCYAIMCPEndpointHTTPSAndSSRF(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(false)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, endpoint := range []string{"file:///etc/passwd", "https://user:pass@public.example/mcp", "https://public.example/mcp?key=secret", "http://public.example/mcp", "http://127.0.0.1/mcp"} {
		_, err := mcpEndpoint(endpoint)
		require.Error(t, err, endpoint)
	}
	_, err := connectMCP(context.Background(), 94101, MCPConnection{URL: "https://127.0.0.1:444/mcp", APIKey: "key"}, func() error { return nil })
	require.Error(t, err, "production SSRF dialer must reject loopback even on HTTPS")
}

func TestTCYAIMCPDiscoveryBudgetAndExactArguments(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	for _, name := range []string{"large_a", "large_b", "large_c"} {
		peer.Server.AddTool(&mcp.Tool{
			Name: name,
			InputSchema: map[string]any{
				"type":        "object",
				"description": strings.Repeat("d", 50*1024),
				"properties":  map[string]any{"amount": map[string]any{"type": "integer"}},
			},
		}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
			return &mcp.CallToolResult{}, nil
		})
	}
	saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	discovery, err := runtime.Discover(context.Background(), "fixture", "large_", 5)
	require.NoError(t, err)
	data, err := json.Marshal(discovery)
	require.NoError(t, err)
	assert.LessOrEqual(t, len(data), 96*1024)
	assert.True(t, discovery.MoreAvailable)
	assert.Equal(t, 3, discovery.Matched)
	require.Len(t, discovery.Tools, 1)
	assert.Len(t, discovery.Tools[0].Parameters["description"], 50*1024, "schemas are complete rather than truncated")
	canonical, err := mcpCanonicalArguments(json.RawMessage(`{"amount":9007199254740993}`))
	require.NoError(t, err)
	assert.Contains(t, string(canonical), "9007199254740993")
	_, err = mcpCanonicalArguments(json.RawMessage(`{} {}`))
	require.Error(t, err)
	_, err = mcpValidateArguments(MCPToolDefinition{Parameters: map[string]any{
		"type":       "object",
		"properties": map[string]any{"nested": map[string]any{"$ref": "https://must-not-fetch.example/schema"}},
	}}, json.RawMessage(`{"nested":{}}`))
	require.ErrorContains(t, err, "MCP_SCHEMA_UNSUPPORTED")
}

func TestTCYAIMCPCancelIsUncertainWithoutAssumingRemoteRollback(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	started := make(chan struct{})
	stopped := make(chan struct{})
	release := make(chan struct{})
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	peer.Server.AddTool(&mcp.Tool{
		Name:        "write_fixture",
		InputSchema: map[string]any{"type": "object"},
	}, func(ctx context.Context, _ *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		peer.Calls.Add(1)
		close(started)
		select {
		case <-ctx.Done():
		case <-release:
		}
		close(stopped)
		return &mcp.CallToolResult{}, nil
	})
	saved := saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = runtime.Discover(ctx, "fixture", "write_fixture", 1)
	require.NoError(t, err)
	prepared, err := runtime.Prepare(ctx, "fixture", "write_fixture", json.RawMessage(`{}`), RunInput{Mode: "write", AllowDelete: true})
	require.NoError(t, err)
	result := make(chan error, 1)
	go func() { _, callErr := runtime.Call(ctx, prepared, json.RawMessage(`{}`)); result <- callErr }()
	select {
	case <-started:
	case <-ctx.Done():
		t.Fatal("business call did not start")
	}
	saved.Connections[0].Enabled = false
	_, err = SaveMCP(94101, saved)
	require.NoError(t, err)
	select {
	case err = <-result:
		var toolError *ToolError
		require.ErrorAs(t, err, &toolError)
		assert.True(t, toolError.Uncertain, "cancelled write outcomes must not be presented as confirmed failures")
	case <-ctx.Done():
		t.Fatal("disabling the connection did not cancel its active request")
	}
	_, err = runtime.Call(ctx, prepared, json.RawMessage(`{}`))
	require.ErrorContains(t, err, "MCP_REVIEW_REQUIRED")
	assert.Equal(t, int64(1), peer.Calls.Load())
	// Cancellation is local: an upstream may continue or commit after disconnect.
	unblock()
	select {
	case <-stopped:
	case <-time.After(2 * time.Second):
		t.Fatal("fixture handler failed to finish after its explicit release")
	}
}

func TestTCYAIMCPLegacySSECannotRedirectBearerOrigin(t *testing.T) {
	allowLocalProvider(t)
	var leaked atomic.Int64
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		leaked.Add(1)
		w.WriteHeader(http.StatusAccepted)
	}))
	defer target.Close()
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		_, _ = io.WriteString(w, "event: endpoint\ndata: "+target.URL+"/message\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	ctx, cancel := context.WithTimeout(context.Background(), time.Second)
	defer cancel()
	_, err := connectMCP(ctx, 94101, MCPConnection{
		URL:       endpoint.URL,
		Transport: "sse",
		APIKey:    "never-forward-cross-origin",
	}, func() error { return nil })
	require.Error(t, err)
	assert.Zero(t, leaked.Load(), "the SDK endpoint event must not move a bearer credential to another origin")
}

func TestTCYAIMCPExplicitRediscoveryReplacesCancelledSession(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	_, err = runtime.Discover(context.Background(), "fixture", "read_fixture", 1)
	require.NoError(t, err)
	first := runtime.remotes["fixture"]
	cancelled, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = runtime.Discover(cancelled, "fixture", "read_fixture", 1)
	require.Error(t, err)
	require.Error(t, first.ctx.Err())
	_, err = runtime.Discover(context.Background(), "fixture", "read_fixture", 1)
	require.NoError(t, err)
	assert.NotSame(t, first, runtime.remotes["fixture"])
	assert.Zero(t, peer.Calls.Load(), "explicit reconnect only initializes and discovers, never replays business calls")
}

func TestTCYAIMCPPostCommitOutputFailuresAreUncertainWrites(t *testing.T) {
	for _, isError := range []bool{false, true} {
		for _, readOnly := range []bool{false, true} {
			t.Run(fmt.Sprintf("isError=%t/readOnly=%t", isError, readOnly), func(t *testing.T) {
				peer := newMCPFixture(t, "streamable_http")
				peer.LiteralHTMLResponse.Store(true)
				name := "write_fixture"
				if readOnly {
					name = "read_fixture"
				}
				peer.Server.AddTool(&mcp.Tool{
					Name:        name,
					InputSchema: map[string]any{"type": "object"},
				}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
					peer.Calls.Add(1)
					payload := any(map[string]any{"error": "partial write cannot be ruled out"})
					if !isError {
						payload = map[string]any{"committed": true, "text": strings.Repeat("<", 800*1024)}
					}
					return &mcp.CallToolResult{
						StructuredContent: payload,
						IsError:           isError,
					}, nil
				})
				saveMCPFixture(t, peer)
				runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
				require.NoError(t, err)
				defer runtime.Close()
				_, err = runtime.Discover(context.Background(), "fixture", name, 1)
				require.NoError(t, err)
				proposal, err := runtime.Prepare(context.Background(), "fixture", name, json.RawMessage(`{}`), RunInput{Mode: "write"})
				require.NoError(t, err)
				result, err := runtime.Call(context.Background(), proposal, json.RawMessage(`{}`))
				var failure *ToolError
				require.ErrorAs(t, err, &failure)
				assert.Equal(t, !readOnly, failure.Uncertain)
				if isError {
					assert.Equal(t, "MCP_TOOL_FAILED", failure.Code)
					assert.Contains(t, result, "partial write cannot be ruled out")
				} else {
					assert.Equal(t, "MCP_RESULT_TOO_LARGE", failure.Code, "wire JSON is small, local HTML escaping exceeds the output budget after commit")
				}
				assert.Equal(t, int64(1), peer.Calls.Load())
				_, err = runtime.Call(context.Background(), proposal, json.RawMessage(`{}`))
				require.ErrorContains(t, err, "MCP_REVIEW_REQUIRED")
				assert.Equal(t, int64(1), peer.Calls.Load())
			})
		}
	}
}

func TestTCYAIMCPRejectsUnrequestedFutureCachedListProtocol(t *testing.T) {
	allowLocalProvider(t)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request struct {
			ID     json.RawMessage `json:"id"`
			Method string          `json:"method"`
		}
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request.Method == "initialize" {
			w.Header().Set("Content-Type", "application/json")
			_, _ = fmt.Fprintf(w, `{"jsonrpc":"2.0","id":%s,"result":{"protocolVersion":"2026-07-28","capabilities":{},"serverInfo":{"name":"future","version":"1"}}}`, request.ID)
			return
		}
		w.WriteHeader(http.StatusAccepted)
	}))
	defer server.Close()
	remote, err := connectMCP(context.Background(), 94101, MCPConnection{
		URL:       server.URL,
		Transport: "streamable_http",
		APIKey:    "key",
	}, func() error { return nil })
	require.ErrorContains(t, err, "MCP_CONNECT_FAILED")
	assert.Nil(t, remote)
}

func TestTCYAIMCPConcurrentCallsReserveProposalBeforeRefresh(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_, err = runtime.Discover(ctx, "fixture", "write_fixture", 1)
	require.NoError(t, err)
	raw := json.RawMessage(`{"value":"x"}`)
	prepared, err := runtime.Prepare(ctx, "fixture", "write_fixture", raw, RunInput{Mode: "write"})
	require.NoError(t, err)
	gate := &mcpFixtureListGate{
		Started: make(chan struct{}),
		Release: make(chan struct{}),
	}
	var releaseOnce sync.Once
	unblock := func() { releaseOnce.Do(func() { close(gate.Release) }) }
	t.Cleanup(unblock)
	peer.ListGate.Store(gate)
	first := make(chan error, 1)
	go func() { _, callErr := runtime.Call(ctx, prepared, raw); first <- callErr }()
	select {
	case <-gate.Started:
	case <-ctx.Done():
		t.Fatal("first call did not reach its pre-execution catalog refresh")
	}
	second := make(chan error, 1)
	go func() { _, callErr := runtime.Call(ctx, prepared, raw); second <- callErr }()
	select {
	case err = <-second:
		require.ErrorContains(t, err, "MCP_REVIEW_REQUIRED")
	case <-time.After(500 * time.Millisecond):
		unblock()
		t.Fatal("the second caller was not rejected while the first was refreshing its proposal")
	}
	assert.Zero(t, peer.Calls.Load(), "reservation happens before any business request")
	unblock()
	select {
	case err = <-first:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("first call did not settle")
	}
	assert.Equal(t, int64(1), peer.Calls.Load())
}

func TestTCYAIMCPRejectsSDKRoundedSchemaIntegers(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	peer.Server.AddTool(&mcp.Tool{
		Name: "unsafe_schema",
		InputSchema: map[string]any{
			"type": "object",
			"properties": map[string]any{"id": map[string]any{
				"type": "integer",
				"enum": []any{int64(9007199254740993)},
			}},
		},
	}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		peer.Calls.Add(1)
		return &mcp.CallToolResult{}, nil
	})
	saveMCPFixture(t, peer)
	runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	_, err = runtime.Discover(context.Background(), "fixture", "unsafe_schema", 1)
	require.ErrorContains(t, err, "MCP_SCHEMA_UNSUPPORTED")
	assert.Zero(t, peer.Calls.Load(), "a rounded catalog constraint cannot authorize a business call")
}

func TestTCYAIMCPStructuredNumericIDsFailClosedAfterSDKDecode(t *testing.T) {
	for _, tc := range []struct {
		name      string
		id        any
		supported bool
	}{
		{name: "unsafe_integer", id: int64(9007199254740993)},
		{name: "unsafe_negative", id: int64(-9007199254740993)},
		{name: "safe_integer", id: int64(9007199254740991), supported: true},
		{name: "string_identifier", id: "9007199254740993", supported: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			peer := newMCPFixture(t, "streamable_http")
			peer.Server.AddTool(&mcp.Tool{
				Name:        "write_fixture",
				InputSchema: map[string]any{"type": "object"},
			}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
				peer.Calls.Add(1)
				return &mcp.CallToolResult{StructuredContent: map[string]any{"record": map[string]any{"id": tc.id}}}, nil
			})
			saveMCPFixture(t, peer)
			runtime, err := NewMCPRuntime(context.Background(), 94101, []string{"fixture"})
			require.NoError(t, err)
			defer runtime.Close()
			_, err = runtime.Discover(context.Background(), "fixture", "write_fixture", 1)
			require.NoError(t, err)
			proposal, err := runtime.Prepare(context.Background(), "fixture", "write_fixture", json.RawMessage(`{}`), RunInput{Mode: "write"})
			require.NoError(t, err)
			data, err := runtime.Call(context.Background(), proposal, json.RawMessage(`{}`))
			if tc.supported {
				require.NoError(t, err)
				assert.Contains(t, data, fmt.Sprint(tc.id))
			} else {
				var uncertain *ToolError
				require.ErrorAs(t, err, &uncertain)
				assert.Equal(t, "MCP_RESULT_UNSUPPORTED", uncertain.Code)
				assert.True(t, uncertain.Uncertain)
				assert.Empty(t, data, "never publish a rounded remote identifier")
			}
			assert.Equal(t, int64(1), peer.Calls.Load())
		})
	}
}

func TestTCYAIMCPNumericArgumentsUseExactValidationCopy(t *testing.T) {
	definition := MCPToolDefinition{Parameters: map[string]any{
		"type": "object",
		"properties": map[string]any{
			"page":   map[string]any{"type": "integer", "minimum": 1},
			"count":  map[string]any{"type": "integer", "minimum": 0},
			"amount": map[string]any{"type": "number"},
			"id":     map[string]any{"type": "integer"},
			"nested": map[string]any{
				"type":  "array",
				"items": map[string]any{"type": "object", "properties": map[string]any{"value": map[string]any{"type": "integer"}}},
			},
		},
		"additionalProperties": false,
	}}
	for _, raw := range []string{
		`{"page":1,"count":20,"amount":1.25,"id":9007199254740993}`,
		`{"page":1.0,"count":2e1,"amount":-0.125,"id":18446744073709551615}`,
		`{"id":-9223372036854775808,"nested":[{"value":9007199254740993}]}`,
	} {
		canonical, err := mcpValidateArguments(definition, json.RawMessage(raw))
		require.NoError(t, err, raw)
		var expected bytes.Buffer
		require.NoError(t, json.Compact(&expected, []byte(raw)))
		var original, decoded map[string]any
		require.NoError(t, mcpDecodeJSON(expected.Bytes(), &original))
		require.NoError(t, mcpDecodeJSON(canonical, &decoded))
		assert.Equal(t, original, decoded, "validation must not rewrite canonical numbers")
	}
	for _, raw := range []string{
		`{"id":18446744073709551616}`,
		`{"id":-9223372036854775809}`,
		`{"amount":1e9999}`,
		`{"amount":1e-9999}`,
		`{"id":9007199254740993.0}`,
	} {
		_, err := mcpValidateArguments(definition, json.RawMessage(raw))
		require.ErrorContains(t, err, "MCP_SCHEMA_UNSUPPORTED")
	}
	_, err := mcpValidateArguments(definition, json.RawMessage(`{"page":1.5}`))
	require.ErrorContains(t, err, "INVALID_ARGUMENTS", "fractional pages cannot satisfy integer schemas")
}
