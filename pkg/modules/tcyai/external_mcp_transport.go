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
	"errors"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"

	"github.com/modelcontextprotocol/go-sdk/mcp"
)

const mcpResponseLimit = 4 * 1024 * 1024

type mcpRemote struct {
	connection MCPConnection
	ctx        context.Context
	session    *mcp.ClientSession
	cancel     context.CancelFunc
	release    func()
	stopClose  func() bool
	closeOnce  sync.Once
}

var mcpSessions = struct {
	sync.Mutex
	entries map[accountStoreKey]map[*mcpRemote]struct{}
}{entries: map[accountStoreKey]map[*mcpRemote]struct{}{}}

func revokeChangedMCPSessions(uid int64, settings MCPSettings) {
	mcpSessions.Lock()
	defer mcpSessions.Unlock()
	for remote := range mcpSessions.entries[accountKey(uid)] {
		current, exists := mcpSettingsConnection(settings, remote.connection.ID)
		if !exists || !current.Enabled || current.Revision != remote.connection.Revision {
			remote.cancel()
		}
	}
}

func (remote *mcpRemote) close() {
	remote.closeOnce.Do(func() {
		remote.cancel()
		if remote.stopClose != nil {
			remote.stopClose()
		}
		if remote.session != nil {
			_ = remote.session.Close()
		}
		remote.release()
	})
}

type mcpRoundTripper struct {
	base     http.RoundTripper
	owner    context.Context
	endpoint *url.URL
	key      string
	current  func() error
}

func mcpOrigin(u *url.URL) string {
	port := u.Port()
	if port == "" {
		if u.Scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}
	return strings.ToLower(u.Scheme + "://" + u.Hostname() + ":" + port)
}

func (transport *mcpRoundTripper) RoundTrip(request *http.Request) (*http.Response, error) {
	if request.URL.User != nil || request.URL.Opaque != "" || request.URL.Fragment != "" ||
		mcpOrigin(request.URL) != mcpOrigin(transport.endpoint) {
		return nil, ToolFailure("MCP_DESTINATION_REJECTED", "MCP requests cannot leave their configured credential origin.")
	}
	if err := transport.current(); err != nil {
		return nil, err
	}
	ctx, cancel := context.WithCancel(request.Context())
	stop := context.AfterFunc(transport.owner, cancel) //nolint:contextcheck // Both the SDK request and its owning run can cancel the HTTP body.
	if transport.owner.Err() != nil {
		cancel()
	}
	cloned := request.Clone(ctx)
	cloned.Header.Set("Authorization", "Bearer "+transport.key)
	cloned.Header.Set("User-Agent", "vikunja-x-mcp/1.0")
	base := transport.base
	if base == nil {
		base = http.DefaultTransport
	}
	response, err := base.RoundTrip(cloned)
	if err != nil {
		stop()
		cancel()
		return nil, err
	}
	limit := mcpResponseLimit
	if strings.HasPrefix(strings.ToLower(response.Header.Get("Content-Type")), "text/event-stream") {
		limit *= 4
	}
	body := &mcpLimitedBody{ReadCloser: response.Body, remaining: limit}
	response.Body = &mcpOwnedBody{ReadCloser: body, closeContext: func() { stop(); cancel() }}
	return response, nil
}

type mcpOwnedBody struct {
	io.ReadCloser
	closeContext func()
}

func (body *mcpOwnedBody) Close() error {
	defer body.closeContext()
	return body.ReadCloser.Close()
}

type mcpLimitedBody struct {
	io.ReadCloser
	remaining int
}

func (body *mcpLimitedBody) Read(buffer []byte) (int, error) {
	if len(buffer) > body.remaining+1 {
		buffer = buffer[:body.remaining+1]
	}
	n, err := body.ReadCloser.Read(buffer)
	if n > body.remaining {
		return 0, errors.New("MCP response exceeds its size limit")
	}
	body.remaining -= n
	return n, err
}

func connectMCP(ctx context.Context, _ int64, connection MCPConnection, current func() error) (*mcpRemote, error) {
	endpoint, err := mcpEndpoint(connection.URL)
	if err != nil || strings.TrimSpace(connection.APIKey) == "" {
		return nil, ErrMCPCredentials
	}
	owned, cancel := context.WithCancel(ctx)
	client, release := providerClient(owned)
	remote := &mcpRemote{
		connection: connection,
		ctx:        owned,
		cancel:     cancel,
		release:    release,
	}
	guarded := *client
	guarded.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	guarded.Transport = &mcpRoundTripper{
		base:     client.Transport,
		owner:    owned,
		endpoint: endpoint,
		key:      connection.APIKey,
		current:  current,
	}
	var transport mcp.Transport = &mcp.StreamableClientTransport{
		Endpoint:             connection.URL,
		HTTPClient:           &guarded,
		MaxRetries:           -1,
		DisableStandaloneSSE: true,
		MaxEventSize:         1024 * 1024,
	}
	if connection.Transport == "sse" {
		transport = &mcp.SSEClientTransport{
			Endpoint:     connection.URL,
			HTTPClient:   &guarded,
			MaxEventSize: 1024 * 1024,
		}
	}
	clientMCP := mcp.NewClient(&mcp.Implementation{Name: "vikunja-x", Version: "1"}, &mcp.ClientOptions{
		Capabilities:   &mcp.ClientCapabilities{},
		MultiRoundTrip: &mcp.MultiRoundTripOptions{Disabled: true},
	})
	// Legacy SSE keeps the Connect request alive for its session: cancel a timer,
	// not its context, after initialization has completed.
	connectCtx, finishConnect := context.WithCancel(owned)
	handshakeTimer := time.AfterFunc(15*time.Second, finishConnect)
	remote.session, err = clientMCP.Connect(connectCtx, transport, &mcp.ClientSessionOptions{ProtocolVersion: "2025-11-25"})
	handshakeTimer.Stop()
	if err != nil {
		finishConnect()
		remote.close()
		return nil, ToolFailure("MCP_CONNECT_FAILED", "The remote MCP handshake failed. Check the endpoint, transport and credential.")
	}
	initialized := remote.session.InitializeResult()
	if initialized == nil || initialized.ServerInfo == nil ||
		(initialized.ProtocolVersion != "2024-11-05" && initialized.ProtocolVersion != "2025-03-26" &&
			initialized.ProtocolVersion != "2025-06-18" && initialized.ProtocolVersion != "2025-11-25") {
		remote.close()
		return nil, ToolFailure("MCP_CONNECT_FAILED", "The remote MCP server negotiated an unsupported protocol version.")
	}
	remote.stopClose = context.AfterFunc(owned, func() { _ = remote.session.Close() })
	return remote, nil
}
