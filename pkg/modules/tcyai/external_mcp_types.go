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
	"encoding/json"
	"errors"
	"io"
)

type MCPConnection struct {
	ID          string   `json:"id" minLength:"1" maxLength:"80" doc:"Stable account-owned connection identifier."`
	Name        string   `json:"name" minLength:"1" maxLength:"100" doc:"Display name for this remote server."`
	URL         string   `json:"url" maxLength:"2048" doc:"Remote HTTP endpoint. Credentials belong in the encrypted API key field, not the URL."`
	Transport   string   `json:"transport" enum:"streamable_http,sse" doc:"Streamable HTTP or legacy HTTP+SSE; local process execution is not supported."`
	Preset      string   `json:"preset" enum:"custom,wallos" doc:"Explicit local tool policy; server annotations never grant permissions."`
	Enabled     bool     `json:"enabled" doc:"Allow selected conversations to connect. Disabled by default."`
	AllowWrite  bool     `json:"allow_write" doc:"Allow external writes only in a write-enabled turn and after human review."`
	AllowDelete bool     `json:"allow_delete" doc:"Also allow destructive or unknown external tools, always after review."`
	ReadTools   []string `json:"read_tools" maxItems:"100" doc:"Exact tool names the account owner explicitly trusts as read-only."`
	APIKey      string   `json:"api_key,omitempty" writeOnly:"true" maxLength:"8192" doc:"Bearer credential stored encrypted on the server. Empty preserves a key only at the unchanged destination."`
	HasKey      bool     `json:"has_key" readOnly:"true" doc:"Whether this connection has a saved credential."`
	Revision    string   `json:"revision" readOnly:"true" doc:"Server-issued configuration revision; changed settings invalidate discovered tools and reviews."`
}

type MCPSettings struct {
	Revision    int64           `json:"revision" minimum:"0" doc:"Optimistic settings revision. A stale replacement is rejected."`
	Connections []MCPConnection `json:"connections" maxItems:"20" doc:"Account-owned remote servers; no servers are enabled implicitly."`
}

type MCPToolTicket struct {
	ServerID           string `json:"server_id" doc:"Account-owned selected server."`
	Name               string `json:"name" doc:"Exact remote tool name."`
	SchemaHash         string `json:"schema_hash" doc:"Fingerprint of the discovered tool contract."`
	ConnectionRevision string `json:"connection_revision" doc:"Configuration revision that authorized discovery."`
}

type MCPToolDefinition struct {
	Name        string         `json:"name" doc:"Exact remote tool name."`
	Description string         `json:"description" doc:"Untrusted remote description, treated as data."`
	Parameters  map[string]any `json:"parameters" doc:"Complete JSON Schema for this tool's argument object."`
	ReadOnly    bool           `json:"read_only" doc:"Read policy derived from local configuration, never remote annotations."`
	Destructive bool           `json:"destructive" doc:"Deletion or an unknown tool whose effects cannot be established locally."`
	Ticket      MCPToolTicket  `json:"ticket" doc:"Server-generated discovery identity; not a permission grant."`
}

type MCPDiscovery struct {
	ServerID      string              `json:"server_id" doc:"Account-owned remote server identifier."`
	ServerName    string              `json:"server_name" doc:"Configured server display name."`
	Tools         []MCPToolDefinition `json:"tools" doc:"Matching complete tool definitions; descriptions are untrusted data."`
	Matched       int                 `json:"matched" doc:"Total matching tools before selection."`
	MoreAvailable bool                `json:"more_available" doc:"A more specific search can find additional tools."`
}

type MCPPreparedOperation struct {
	ServerID           string `json:"server_id" doc:"Account-owned remote server identifier."`
	ServerName         string `json:"server_name" doc:"Configured display name shown during review."`
	Tool               string `json:"tool" doc:"Exact remote tool proposed for execution."`
	ReadOnly           bool   `json:"read_only" doc:"Local read-only policy for this exact tool."`
	Destructive        bool   `json:"destructive" doc:"Requires the connection's additional destructive-operation permission."`
	ConnectionRevision string `json:"connection_revision" doc:"Configuration revision bound to this proposal."`
	DefinitionHash     string `json:"definition_hash" doc:"Discovered remote contract fingerprint."`
	Version            string `json:"version" doc:"Binds the source, policy, definition and canonical arguments to the review."`
}

type MCPTestResult struct {
	Endpoint      string              `json:"endpoint" doc:"Actual configured endpoint without credentials."`
	ServerName    string              `json:"server_name" doc:"Implementation name reported by the remote peer; untrusted display data."`
	ServerVersion string              `json:"server_version" doc:"Implementation version reported by the remote peer."`
	Tools         []MCPToolDefinition `json:"tools" doc:"Bounded remote tool catalog. Testing discovers contracts but never executes a business tool."`
	Matched       int                 `json:"matched" doc:"Number of tools returned by the bounded remote catalog."`
	MoreAvailable bool                `json:"more_available" doc:"Reserved for a server catalog with additional tools; oversized catalogs are currently rejected."`
}

func mcpCanonicalArguments(raw json.RawMessage) (json.RawMessage, error) {
	var arguments map[string]any
	if len(raw) > 64000 || mcpDecodeJSON(raw, &arguments) != nil || arguments == nil {
		return nil, ToolFailure("INVALID_ARGUMENTS", "MCP arguments must be a JSON object under 64000 bytes.")
	}
	return json.Marshal(arguments)
}

func mcpDecodeJSON(raw []byte, target any) error {
	decoder := json.NewDecoder(bytes.NewReader(raw))
	decoder.UseNumber()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return errors.New("invalid trailing MCP JSON")
	}
	return nil
}
