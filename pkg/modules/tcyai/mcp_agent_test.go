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
	"strings"
	"testing"

	"github.com/modelcontextprotocol/go-sdk/mcp"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIMCPHarnessOptInAndStablePrefix(t *testing.T) {
	ctx := context.Background()
	state := NewAgentState(ctx, Connection{}, RunInput{Mode: "write"})
	for _, tool := range state.catalog() {
		assert.False(t, isMCPAgentTool(toolName(tool)))
	}
	_, err := ValidateTool("find_mcp_tools", json.RawMessage(`{}`), state.Input)
	require.ErrorContains(t, err, "MCP_NOT_SELECTED")
	state.Input.MCPServerIDs = []string{"wallos-personal"}
	data, err := state.discover(json.RawMessage(`{"query":"MCP"}`))
	require.NoError(t, err)
	assert.Contains(t, data, "find_mcp_tools")
	assert.Contains(t, data, "call_mcp_tool")
	assert.Nil(t, state.mcp, "local discovery must not connect to any server")
	before, err := json.Marshal(state.tools())
	require.NoError(t, err)
	state.Input.MCPServerIDs = nil
	after, err := json.Marshal(state.tools())
	require.NoError(t, err)
	assert.Equal(t, string(before), string(after), "connection selection must not rewrite the provider cache prefix")
	assert.NotContains(t, string(before), "wallos_subscriptions_update", "remote schemas are loaded on demand")
	assert.Contains(t, executionContext(state.Input, Connection{}), `"mcp_server_ids":[]`)
}

func TestTCYAIMCPHarnessUsesRemoteArgumentConventions(t *testing.T) {
	input := RunInput{Mode: "read", MCPServerIDs: []string{"selected"}}
	raw := json.RawMessage(`{"server_id":"selected","tool_name":"lookup","arguments":{"due_date":"2026-11-02","title":""}}`)
	validated, err := ValidateTool("call_mcp_tool", raw, input)
	require.NoError(t, err, "remote schema, not local task conventions, must validate nested arguments")
	assert.JSONEq(t, string(raw), string(validated))
	_, err = ValidateTool("call_mcp_tool", json.RawMessage(`{"server_id":"selected","tool_name":"lookup","arguments":"{}"}`), input)
	require.Error(t, err)
	large := json.RawMessage(`{"server_id":"selected","tool_name":"lookup","arguments":{"id":9007199254740993}}`)
	validated, err = ValidateTool("call_mcp_tool", large, input)
	require.NoError(t, err)
	assert.Contains(t, string(validated), `9007199254740993`, "the harness must preserve remote integer identities before MCP validation")
}

func TestTCYAIMCPHarnessAlwaysReviewsWrites(t *testing.T) {
	for _, approval := range []string{"review", "smart", "auto"} {
		input := RunInput{Mode: "write", Approval: approval}
		assert.True(t, operationNeedsReview("call_mcp_tool", input, Operation{}))
		assert.True(t, operationNeedsReview("call_mcp_tool", input, Operation{External: &MCPPreparedOperation{ReadOnly: false}}))
		assert.False(t, operationNeedsReview("call_mcp_tool", input, Operation{External: &MCPPreparedOperation{ReadOnly: true}}))
	}
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write", MCPServerIDs: []string{"selected"}})
	_, err := state.callMCP(context.Background(), nil, &Operation{})
	require.ErrorContains(t, err, "MCP_NOT_PREPARED")
	_, err = state.callMCP(context.Background(), nil, &Operation{External: &MCPPreparedOperation{ReadOnly: false}})
	require.ErrorContains(t, err, "MCP_REVIEW_REQUIRED")
}

func TestTCYAIMCPHarnessSnapshotsOwnSelectionsAndReceipts(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write", MCPServerIDs: []string{"selected"}})
	state.mcp = &MCPRuntime{}
	state.MCPTickets = []MCPToolTicket{{ServerID: "selected", Name: "lookup", SchemaHash: "original"}}
	state.Result.Pending = &Operation{External: &MCPPreparedOperation{ServerName: "original"}}
	state.Result.Operations = []Operation{{External: &MCPPreparedOperation{ServerName: "original"}}}
	state.Approved = &Operation{External: &MCPPreparedOperation{ServerName: "original"}}
	snapshot := snapshotAgentState(state)
	assert.Nil(t, snapshot.mcp, "encrypted snapshots must never retain live clients")
	snapshot.Input.MCPServerIDs[0] = "changed"
	snapshot.MCPTickets[0].SchemaHash = "changed"
	snapshot.Result.Pending.External.ServerName = "changed"
	snapshot.Result.Operations[0].External.ServerName = "changed"
	snapshot.Approved.External.ServerName = "changed"
	snapshot.Result.Configuration.MCPServerIDs[0] = "changed"
	assert.Equal(t, "selected", state.Input.MCPServerIDs[0])
	assert.Equal(t, "original", state.MCPTickets[0].SchemaHash)
	assert.Equal(t, "original", state.Result.Pending.External.ServerName)
	assert.Equal(t, "original", state.Result.Operations[0].External.ServerName)
	assert.Equal(t, "original", state.Approved.External.ServerName)
	assert.Equal(t, "selected", state.Result.Configuration.MCPServerIDs[0])
}

func mcpHarnessState(t *testing.T, input RunInput) *AgentState {
	t.Helper()
	input.MCPServerIDs = []string{"fixture"}
	state := NewAgentState(context.Background(), Connection{}, input)
	state.OwnerID = 94101
	_, err := state.discover(json.RawMessage(`{"query":"mcp"}`))
	require.NoError(t, err)
	t.Cleanup(state.closeMCP)
	return state
}

func mcpHarnessPending(t *testing.T, state *AgentState, toolName string) {
	t.Helper()
	envelope, err := json.Marshal(map[string]any{"name": "call_mcp_tool", "arguments": map[string]any{
		"server_id": "fixture", "tool_name": toolName, "arguments": map[string]any{"value": "proposed"},
	}})
	require.NoError(t, err)
	state.Pending = []ToolCall{toolCall("remote-call", "invoke_tool", envelope)}
}

func TestTCYAIMCPHarnessRealWriteWaitsForExactReview(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saveMCPFixture(t, peer)
	ctx := context.Background()
	state := mcpHarnessState(t, RunInput{Mode: "write", Approval: "auto", AllowDelete: true})
	_, err := state.discoverMCP(ctx, json.RawMessage(`{}`))
	require.NoError(t, err)
	assert.Zero(t, peer.Requests.Load(), "listing selected metadata cannot contact any remote server")
	_, err = state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"write_fixture"}`))
	require.NoError(t, err)
	mcpHarnessPending(t, state, "write_fixture")
	persist := func() error { return nil }
	require.ErrorIs(t, state.toolStep(ctx, Connection{}, nil, nil, persist), ErrAgentPaused)
	assert.Zero(t, peer.Calls.Load())
	require.NotNil(t, state.Result.Pending.External)
	assert.Equal(t, "fixture", state.Result.Pending.External.ServerID)
	assert.False(t, state.Result.Pending.External.ReadOnly)
	receipt := state.Result.Pending.ID
	require.NoError(t, ReviewAgent(ctx, state, ReviewInput{OperationID: receipt, Decision: "approve"}, nil))
	assert.Nil(t, state.mcp, "a paused engine must not keep an idle remote session")
	require.NoError(t, state.toolStep(ctx, Connection{}, nil, nil, persist))
	assert.Equal(t, int64(1), peer.Calls.Load())
	require.Len(t, state.Result.Operations, 1)
	assert.Equal(t, receipt, state.Result.Operations[0].ID)
	assert.Equal(t, "succeeded", state.Result.Operations[0].Status)
	assert.True(t, state.Result.Actions[0].Success)
	assert.Contains(t, state.Result.Actions[0].Result, `"source":"external_mcp"`)
}

func TestTCYAIMCPHarnessApprovedWriteCannotBypassDisable(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	saved := saveMCPFixture(t, peer)
	ctx := context.Background()
	state := mcpHarnessState(t, RunInput{Mode: "write", AllowDelete: true})
	_, err := state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"write_fixture"}`))
	require.NoError(t, err)
	mcpHarnessPending(t, state, "write_fixture")
	persist := func() error { return nil }
	require.ErrorIs(t, state.toolStep(ctx, Connection{}, nil, nil, persist), ErrAgentPaused)
	require.NoError(t, ReviewAgent(ctx, state, ReviewInput{OperationID: state.Result.Pending.ID, Decision: "approve"}, nil))
	saved.Connections[0].Enabled = false
	_, err = SaveMCP(94101, saved)
	require.NoError(t, err)
	require.NoError(t, state.toolStep(ctx, Connection{}, nil, nil, persist))
	assert.Zero(t, peer.Calls.Load())
	assert.False(t, state.Result.Actions[0].Success)
	assert.Equal(t, "MCP_DISABLED", state.Result.Operations[0].ErrorCode)
}

func TestTCYAIMCPHarnessPreservesRemoteBusinessErrors(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	peer.Server.AddTool(&mcp.Tool{Name: "read_fixture", InputSchema: map[string]any{"type": "object"}}, func(context.Context, *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		peer.Calls.Add(1)
		return &mcp.CallToolResult{IsError: true, StructuredContent: map[string]any{"error": map[string]any{"code": "conflict", "message": "Actual version conflict"}}}, nil
	})
	saveMCPFixture(t, peer)
	ctx := context.Background()
	state := mcpHarnessState(t, RunInput{Mode: "read"})
	_, err := state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"read_fixture"}`))
	require.NoError(t, err)
	mcpHarnessPending(t, state, "read_fixture")
	require.NoError(t, state.toolStep(ctx, Connection{}, nil, nil, func() error { return nil }))
	assert.Equal(t, int64(1), peer.Calls.Load())
	assert.False(t, state.Result.Actions[0].Success)
	assert.Contains(t, state.Result.Actions[0].Result, "Actual version conflict")
	assert.Contains(t, state.Messages[len(state.Messages)-1].Content, `"code":"conflict"`)
	assert.Contains(t, state.Messages[len(state.Messages)-1].Content, "MCP_TOOL_FAILED")
}

func TestTCYAIMCPHarnessKeepsCompleteDiscoveryContracts(t *testing.T) {
	encoded, err := json.Marshal(map[string]any{"discovery": map[string]any{"tools": []any{map[string]any{"name": "large", "parameters": map[string]any{"type": "object", "description": strings.Repeat("x", 17000)}}}}})
	require.NoError(t, err)
	projected := modelToolResult("find_mcp_tools", json.RawMessage(`{}`), string(encoded), "reference")
	assert.NotContains(t, projected, "preview_is_partial")
	var result map[string]any
	require.NoError(t, json.Unmarshal([]byte(projected), &result))
	assert.Equal(t, "reference", result["result_ref"])
	assert.NotNil(t, result["discovery"])
}

func TestTCYAIMCPProjectionsPreserveExactNumbers(t *testing.T) {
	for _, tool := range []string{"find_mcp_tools", "call_mcp_tool"} {
		t.Run(tool, func(t *testing.T) {
			projected := modelToolResult(tool, json.RawMessage(`{}`), `{"id":9007199254740993,"parameters":{"enum":[9007199254740993]}}`, "reference")
			assert.Contains(t, projected, `9007199254740993`)
			assert.NotContains(t, projected, `9007199254740992`)
		})
	}
	projected := modelToolResult("call_mcp_tool", json.RawMessage(`{}`), `{"id":9007199254740993,"detail":"`+strings.Repeat("x", 17000)+`"}`, "reference")
	assert.Contains(t, projected, `"id":9007199254740993`)
}

func TestTCYAIMCPHarnessKeepsArgumentsExactInCompactedHistory(t *testing.T) {
	peer := newMCPFixture(t, "streamable_http")
	peer.Server.AddTool(&mcp.Tool{Name: "read_fixture", InputSchema: map[string]any{
		"type": "object", "properties": map[string]any{"id": map[string]any{"type": "integer"}}, "required": []string{"id"},
	}}, func(_ context.Context, request *mcp.CallToolRequest) (*mcp.CallToolResult, error) {
		assert.Contains(t, string(request.Params.Arguments), `9007199254740993`)
		return &mcp.CallToolResult{StructuredContent: map[string]any{"ok": true}}, nil
	})
	saveMCPFixture(t, peer)
	state := mcpHarnessState(t, RunInput{Mode: "read"})
	ctx := context.Background()
	_, err := state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"read_fixture"}`))
	require.NoError(t, err)
	state.Pending = []ToolCall{toolCall("large-id", "invoke_tool", json.RawMessage(`{"name":"call_mcp_tool","arguments":{"server_id":"fixture","tool_name":"read_fixture","arguments":{"id":9007199254740993}}}`))}
	require.NoError(t, state.toolStep(ctx, Connection{}, nil, nil, func() error { return nil }))
	require.Len(t, state.Result.Actions, 1)
	require.True(t, state.Result.Actions[0].Success, "%+v", state.Result.Actions[0])
	compacted, err := json.Marshal(compactActions(state.Result.Actions))
	require.NoError(t, err)
	assert.Contains(t, string(compacted), `"id":9007199254740993`)
	assert.NotContains(t, string(compacted), `9007199254740992`)
}
