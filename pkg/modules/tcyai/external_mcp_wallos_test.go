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
	"io"
	"net/http"
	"net/http/httptest"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Only the separate, freshly seeded PHP/SQLite fixture may enable this test.
// The runner destroys its entire container and database, never production data.
func TestTCYAIMCPWallosDisposableInterop(t *testing.T) {
	endpoint := os.Getenv("WALLOS_AGENT_TEST_URL")
	if endpoint == "" {
		t.Skip("requires the explicit disposable Wallos fixture")
	}
	endpointURL, err := url.Parse(endpoint)
	require.NoError(t, err)
	address, err := netip.ParseAddr(endpointURL.Hostname())
	require.NoError(t, err)
	require.True(t, address.IsLoopback(), "external integration fixture must be a literal loopback address")
	require.Equal(t, "http", endpointURL.Scheme)
	require.NotEmpty(t, endpointURL.Port())
	require.Empty(t, endpointURL.RawQuery)
	require.Nil(t, endpointURL.User)
	keyFile := os.Getenv("WALLOS_AGENT_TEST_KEY_FILE")
	require.Equal(t, "test-key.json", filepath.Base(keyFile))
	private, err := os.ReadFile(keyFile) //nolint:gosec // Explicit opt-in disposable fixture file; basename and loopback peer are validated above.
	require.NoError(t, err)
	var credential struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(private, &credential))
	require.NotEmpty(t, credential.Token)
	speechSettingsFixture(t)
	allowLocalProvider(t)
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()

	var dropped atomic.Bool
	var lostWrites atomic.Int64
	lostRequestID := uuid.NewString()
	client := &http.Client{Timeout: 10 * time.Second}
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, request *http.Request) {
		body, readErr := io.ReadAll(io.LimitReader(request.Body, 256*1024))
		if readErr != nil {
			http.Error(w, "fixture read failed", http.StatusInternalServerError)
			return
		}
		var rpc struct {
			Method string `json:"method"`
			Params struct {
				Name      string `json:"name"`
				Arguments struct {
					RequestID string `json:"request_id"`
				} `json:"arguments"`
			} `json:"params"`
		}
		_ = json.Unmarshal(body, &rpc)
		upstream, requestErr := http.NewRequestWithContext(request.Context(), request.Method, endpoint+"/api/agent/mcp.php", bytes.NewReader(body)) //nolint:gosec // Parsed literal loopback only; this disposable fixture proxy cannot target remote hosts.
		if requestErr != nil {
			http.Error(w, "fixture request failed", http.StatusInternalServerError)
			return
		}
		upstream.Header = request.Header.Clone()
		response, requestErr := client.Do(upstream) //nolint:gosec // Request URL is restricted to the already-validated literal loopback fixture.
		if requestErr != nil {
			http.Error(w, "fixture unavailable", http.StatusBadGateway)
			return
		}
		defer response.Body.Close()
		payload, readErr := io.ReadAll(io.LimitReader(response.Body, 4*1024*1024))
		if readErr != nil {
			http.Error(w, "fixture response failed", http.StatusBadGateway)
			return
		}
		if rpc.Method == "tools/call" && rpc.Params.Name == "wallos_subscriptions_create" && rpc.Params.Arguments.RequestID == lostRequestID {
			lostWrites.Add(1)
			if !dropped.Swap(true) {
				connection, _, hijackErr := w.(http.Hijacker).Hijack()
				if hijackErr == nil {
					_ = connection.Close()
				}
				return
			}
		}
		for key, values := range response.Header {
			for _, value := range values {
				w.Header().Add(key, value)
			}
		}
		w.WriteHeader(response.StatusCode)
		_, _ = w.Write(payload)
	}))
	defer proxy.Close()
	_, err = SaveMCP(94101, MCPSettings{Connections: []MCPConnection{{
		ID:          "wallos-fixture",
		Name:        "Disposable PHP fixture",
		URL:         proxy.URL,
		APIKey:      credential.Token,
		Transport:   "streamable_http",
		Preset:      "custom",
		Enabled:     true,
		AllowWrite:  true,
		AllowDelete: true,
		ReadTools:   []string{"wallos_context", "wallos_subscriptions_get", "wallos_subscriptions_list"},
	}}})
	require.NoError(t, err)
	runtime, err := NewMCPRuntime(ctx, 94101, []string{"wallos-fixture"})
	require.NoError(t, err)
	defer runtime.Close()
	input := RunInput{Mode: "write", AllowDelete: true}
	call := func(name string, args any, expectError bool) map[string]any {
		t.Helper()
		discovery, discoverErr := runtime.Discover(ctx, "wallos-fixture", name, 1)
		require.NoError(t, discoverErr)
		require.Len(t, discovery.Tools, 1)
		require.Equal(t, name, discovery.Tools[0].Name)
		raw, marshalErr := json.Marshal(args)
		require.NoError(t, marshalErr)
		prepared, prepareErr := runtime.Prepare(ctx, "wallos-fixture", name, raw, input)
		require.NoError(t, prepareErr)
		data, callErr := runtime.Call(ctx, prepared, raw)
		if expectError {
			require.Error(t, callErr)
		} else {
			require.NoError(t, callErr)
		}
		var output struct {
			Result map[string]any `json:"result"`
		}
		require.NoError(t, json.Unmarshal([]byte(data), &output))
		return output.Result
	}
	identity := call("wallos_context", map[string]any{}, false)
	account, ok := identity["account"].(map[string]any)
	require.True(t, ok)
	require.Equal(t, "agent-ui-test", account["username"], "refusing mutations outside the disposable fixture")

	create := map[string]any{
		"request_id": uuid.NewString(),
		"data": map[string]any{
			"name":              "MCP interop fixture",
			"price":             10,
			"currency_id":       100,
			"start_date":        "2026-11-01",
			"next_payment":      "2026-11-01",
			"cycle":             3,
			"frequency":         1,
			"category_id":       100,
			"payment_method_id": 100,
			"payer_user_id":     100,
		},
	}
	created := call("wallos_subscriptions_create", create, false)
	subscription := created["subscription"].(map[string]any)
	id := subscription["id"]
	originalVersion := subscription["version"]
	replay := call("wallos_subscriptions_create", create, false)
	assert.Equal(t, true, replay["replayed"])
	assert.Equal(t, id, replay["subscription"].(map[string]any)["id"])
	get := call("wallos_subscriptions_get", map[string]any{"id": id}, false)
	assert.Equal(t, originalVersion, get["subscription"].(map[string]any)["version"])
	updated := call("wallos_subscriptions_update", map[string]any{
		"id":               id,
		"expected_version": originalVersion,
		"changes":          map[string]any{"price": 11},
		"request_id":       uuid.NewString(),
	}, false)
	assert.EqualValues(t, 11, updated["subscription"].(map[string]any)["price"])
	conflict := call("wallos_subscriptions_update", map[string]any{
		"id":               id,
		"expected_version": originalVersion,
		"changes":          map[string]any{"price": 12},
		"request_id":       uuid.NewString(),
	}, true)
	assert.Equal(t, "conflict", conflict["error"].(map[string]any)["code"], "structured isError details must survive")
	version := updated["subscription"].(map[string]any)["version"]
	dry := call("wallos_subscriptions_update", map[string]any{
		"id":               id,
		"expected_version": version,
		"changes":          map[string]any{"price": 999},
		"request_id":       uuid.NewString(),
		"dry_run":          true,
	}, false)
	assert.Equal(t, true, dry["dry_run"])
	unchanged := call("wallos_subscriptions_get", map[string]any{"id": id}, false)
	assert.EqualValues(t, 11, unchanged["subscription"].(map[string]any)["price"])
	assert.Equal(t, version, unchanged["subscription"].(map[string]any)["version"])

	create["request_id"] = lostRequestID
	_, err = runtime.Discover(ctx, "wallos-fixture", "wallos_subscriptions_create", 1)
	require.NoError(t, err)
	raw, err := json.Marshal(create)
	require.NoError(t, err)
	proposal, err := runtime.Prepare(ctx, "wallos-fixture", "wallos_subscriptions_create", raw, input)
	require.NoError(t, err)
	_, err = runtime.Call(ctx, proposal, raw)
	var unknown *ToolError
	require.ErrorAs(t, err, &unknown)
	assert.True(t, unknown.Uncertain)
	assert.Equal(t, int64(1), lostWrites.Load(), "a committed write with a lost response must not be automatically repeated")
	explicitReplay := call("wallos_subscriptions_create", create, false)
	assert.Equal(t, true, explicitReplay["replayed"], "an explicit retry preserves the upstream idempotency key")
	assert.Equal(t, int64(2), lostWrites.Load())
}
