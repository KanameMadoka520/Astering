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

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIChatImagesRuntimeTrustedContext(t *testing.T) {
	state := NewAgentState(context.Background(), Connection{}, RunInput{
		Mode:              "write",
		AttachmentIDs:     []string{"client-only-id"},
		ServerAttachments: []ChatAttachment{{ID: "current-image"}, {ID: "historical-image"}},
	})
	state.OwnerID = 17
	state.ConversationID = "runner-conversation"
	state.KnownAttachments = []ChatAttachment{{ID: "historical-image"}, {ID: ""}}
	spoofed := WithChatImageContext(context.Background(), 999, "wrong-conversation", []string{"wrong-image"})
	raw := json.RawMessage(`{"id":1,"attachment_id":"current-image","position":"end"}`)
	expected := ChatImageContext{
		OwnerID:        17,
		ConversationID: "runner-conversation",
		AttachmentIDs:  []string{"historical-image", "current-image"},
	}
	prepared := false
	op, err := state.prepareOperation(spoofed, func(ctx context.Context, name string, arguments json.RawMessage) (Operation, error) {
		prepared = true
		assert.Equal(t, "insert_chat_image", name)
		assert.JSONEq(t, string(raw), string(arguments))
		identity := ChatImagesFromContext(ctx)
		assert.Equal(t, expected, identity)
		identity.AttachmentIDs[0] = "mutated callback slice"
		return Operation{Version: "description-version"}, nil
	}, "insert_chat_image", raw, Operation{ID: "receipt"})
	require.NoError(t, err)
	require.True(t, prepared)
	executed := false
	data, _, err := state.executeAgentTool(spoofed, Connection{}, func(ctx context.Context, name string, arguments json.RawMessage) (string, error) {
		executed = true
		assert.Equal(t, expected, ChatImagesFromContext(ctx))
		assert.Same(t, &op, CurrentOperation(ctx))
		assert.Equal(t, "insert_chat_image", name)
		assert.JSONEq(t, string(raw), string(arguments))
		return `{"id":1}`, nil
	}, &op, "insert_chat_image", raw, func() error { return nil })
	require.NoError(t, err)
	require.True(t, executed)
	assert.JSONEq(t, `{"id":1}`, data)
	assert.Equal(t, "historical-image", state.KnownAttachments[0].ID)
	assert.Equal(t, "wrong-image", ChatImagesFromContext(spoofed).AttachmentIDs[0])
}

func TestTCYAIChatImagesRuntimeSchemaAndReview(t *testing.T) {
	input := RunInput{Mode: "write", Approval: "auto"}
	args := map[string]any{
		"id":                  1,
		"attachment_id":       strings.Repeat("a", 64),
		"description_version": strings.Repeat("b", 64),
		"position":            "end",
	}
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	_, err = ValidateTool("insert_chat_image", raw, input)
	require.NoError(t, err)
	for _, field := range []string{"owner_id", "conversation_id", "visible_attachment_ids"} {
		args[field] = "forged"
		malicious, marshalErr := json.Marshal(args)
		require.NoError(t, marshalErr)
		_, err = ValidateTool("insert_chat_image", malicious, input)
		require.Error(t, err, field)
		delete(args, field)
	}
	for _, name := range []string{"insert_chat_image", "update_task_description_image", "remove_task_description_image"} {
		assert.True(t, NeedsReview(name, input), name)
	}
	assert.False(t, NeedsReview("get_task_description_layout", input))
	input.Mode = "read"
	_, err = ValidateTool("insert_chat_image", raw, input)
	require.Error(t, err)
}
