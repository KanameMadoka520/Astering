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
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIUnattendedReviewPolicyKeepsLegacyModes(t *testing.T) {
	input := RunInput{
		Mode:        "write",
		Approval:    "unattended",
		AllowDelete: true,
		ToolModules: ToolModules{
			ProjectTasks: "write",
			Compass:      "write",
			Notes:        "write",
		},
	}
	for _, definition := range ScopedTools(input) {
		assert.False(t, NeedsReview(toolName(definition), input), toolName(definition))
	}
	for _, approval := range []string{
		"smart",
		"review",
		"auto",
	} {
		legacy := input
		legacy.Approval = approval
		for _, name := range []string{
			"delete_task",
			"add_comment",
			"create_project",
			"assign_task",
			"unassign_task",
			"update_project_announcement",
			"delete_bucket",
			"insert_chat_image",
			"update_task_description_image",
			"remove_task_description_image",
			"restore_project_version",
			"create_note",
			"update_note",
			"delete_note",
			"restore_compass_revision",
		} {
			assert.True(t, NeedsReview(name, legacy), approval+"/"+name)
		}
	}
	options := runOptions(input)
	require.True(t, validAssistantOptions(*options))
	assert.Equal(t, "unattended", retryInput(ChatTurn{Result: RunResult{Configuration: options}}).Approval)
	input.Mode = "read"
	assert.False(t, UnattendedWrites(input))
	_, err := ValidateTool("create_note", json.RawMessage(`{"title":"Forbidden read-mode write"}`), input)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	input.Mode = "write"
	input.AllowDelete = false
	_, err = ValidateTool("delete_task", json.RawMessage(`{"id":1}`), input)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	_, err = ValidateTool("delete_note", json.RawMessage(`{"id":1,"expected_revision":1}`), input)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	input.ToolModules.Notes = "off"
	_, err = ValidateTool("create_note", json.RawMessage(`{"title":"Disabled module"}`), input)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
}

func TestTCYAIUnattendedToolStepPersistsPreparedIntentWithoutHumanApproval(t *testing.T) {
	ctx := context.Background()
	input := notesToolInput("write")
	input.Approval = "unattended"
	state := NewAgentState(ctx, Connection{}, input)
	call := toolCall("unattended-note", "create_note", json.RawMessage(`{"title":"Synthetic unattended note"}`))
	state.Pending = []ToolCall{call}
	state.Available = append(state.Available, "create_note")
	state.appendMessage(Message{
		Role:      "assistant",
		ToolCalls: []ToolCall{call},
	})
	prepared, executed, persisted := 0, 0, 0
	prepare := func(context.Context, string, json.RawMessage) (Operation, error) {
		prepared++
		return Operation{
			Version: "exact-fixture-preview",
			Before:  "null",
			After:   call.Function.Arguments,
			Units:   1,
		}, nil
	}
	execute := func(ctx context.Context, name string, _ json.RawMessage) (string, error) {
		executed++
		op := CurrentOperation(ctx)
		require.NotNil(t, op)
		assert.False(t, op.Approved, "unattended must never pretend a person approved")
		assert.Equal(t, "exact-fixture-preview", op.Version)
		assert.Positive(t, persisted, "durable intent must precede the side effect")
		assert.Equal(t, "create_note", name)
		op.Verified = true
		return `{"note_id":1,"success":true}`, nil
	}
	require.NoError(t, state.toolStep(ctx, Connection{}, execute, prepare, func() error {
		persisted++
		return nil
	}))
	assert.Equal(t, 1, prepared)
	assert.Equal(t, 1, executed)
	assert.Empty(t, state.Result.Pause)
	require.Len(t, state.Result.Operations, 1)
	assert.Equal(t, "succeeded", state.Result.Operations[0].Status)
	assert.False(t, state.Result.Operations[0].Approved)
}

func TestTCYAIUnattendedMCPKeepsPreparationAndConnectionPolicy(t *testing.T) {
	for _, policy := range []string{
		"allowed",
		"read_mode",
		"write_disabled",
		"destructive_disabled",
		"project_restricted",
		"not_selected",
	} {
		t.Run(policy, func(t *testing.T) {
			peer := newMCPFixture(t, "streamable_http")
			if policy == "write_disabled" {
				peer.Connection.AllowWrite = false
			}
			if policy == "destructive_disabled" {
				peer.Connection.AllowDelete = false
			}
			saveMCPFixture(t, peer)
			input := RunInput{
				Mode:     "write",
				Approval: "unattended",
			}
			if policy == "read_mode" {
				input.Mode = "read"
			}
			if policy == "project_restricted" {
				input.WriteProjectIDs = []int64{1}
			}
			state := mcpHarnessState(t, input)
			ctx := context.Background()
			_, err := state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"write_fixture"}`))
			require.NoError(t, err)
			if policy == "not_selected" {
				state.Input.MCPServerIDs = nil
			}
			mcpHarnessPending(t, state, "write_fixture")
			require.NoError(t, state.toolStep(ctx, Connection{}, nil, nil, func() error { return nil }))
			assert.Empty(t, state.Result.Pause)
			require.Len(t, state.Result.Operations, 1)
			assert.False(t, state.Result.Operations[0].Approved)
			if policy == "allowed" {
				assert.EqualValues(t, 1, peer.Calls.Load())
				assert.Equal(t, "succeeded", state.Result.Operations[0].Status)
				assert.NotNil(t, state.Result.Operations[0].External)
			} else {
				assert.Zero(t, peer.Calls.Load())
				assert.Equal(t, "failed", state.Result.Operations[0].Status)
			}
		})
	}
}

func TestTCYAIUnattendedMCPRejectsChangedProposalOrRevokedConnection(t *testing.T) {
	for _, change := range []string{
		"arguments",
		"disabled_connection",
	} {
		t.Run(change, func(t *testing.T) {
			peer := newMCPFixture(t, "streamable_http")
			saved := saveMCPFixture(t, peer)
			state := mcpHarnessState(t, RunInput{
				Mode:     "write",
				Approval: "unattended",
			})
			ctx := context.Background()
			_, err := state.discoverMCP(ctx, json.RawMessage(`{"server_id":"fixture","query":"write_fixture"}`))
			require.NoError(t, err)
			raw := json.RawMessage(`{"server_id":"fixture","tool_name":"write_fixture","arguments":{"value":"proposed"}}`)
			op, err := state.prepareMCPOperation(ctx, raw, Operation{})
			require.NoError(t, err)
			if change == "arguments" {
				raw = json.RawMessage(`{"server_id":"fixture","tool_name":"write_fixture","arguments":{"value":"changed"}}`)
			} else {
				saved.Connections[0].Enabled = false
				_, err = SaveMCP(94101, saved)
				require.NoError(t, err)
			}
			_, err = state.callMCP(ctx, raw, &op)
			require.Error(t, err)
			assert.Zero(t, peer.Calls.Load())
			assert.False(t, op.Approved)
		})
	}
}
