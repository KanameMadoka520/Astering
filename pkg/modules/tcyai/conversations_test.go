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
	"encoding/json"
	"os"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIConversationStorage(t *testing.T) {
	oldPath := config.FilesBasePath.GetString()
	oldSecret := config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("test-only-encryption-secret")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	c, err := CreateConversation(1, "private title")
	require.NoError(t, err)
	_, err = GetConversation(2, c.ID)
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = GetConversation(1, "../../secret")
	require.ErrorIs(t, err, ErrConversationMissing)
	path, err := conversationPath(1, c.ID)
	require.NoError(t, err)
	raw, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "private title")
	info, err := os.Stat(path)
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: uuid.NewString(), RequestID: "request-1", Prompt: "private user text", Status: "completed", Started: time.Now(), Result: RunResult{RequestedModel: "model", Protocol: "anthropic", Endpoint: "https://example.com/messages", Reply: "answer"}}, {ID: uuid.NewString(), Status: "running", Result: RunResult{Operations: []Operation{{ID: "uncertain", Status: "running", Tool: "create_task"}}}}}
	record.Contexts = [][]storedMessage{{{Message: Message{Role: "assistant", Content: "answer"}, Native: json.RawMessage(`[{"type":"thinking","signature":"opaque-private"}]`)}}, {}}
	require.NoError(t, writeConversation(1, record))
	value, err := GetConversation(1, c.ID)
	require.NoError(t, err)
	assert.Equal(t, "interrupted", value.Turns[1].Status)
	assert.Equal(t, "unknown", value.Turns[1].Result.Operations[0].Status)
	assert.Equal(t, "INTERRUPTED", value.Turns[1].Result.ErrorCode)
	public, err := json.Marshal(value)
	require.NoError(t, err)
	assert.NotContains(t, string(public), "opaque-private")
	branch, err := ForkConversation(1, c.ID, record.Turns[0].ID)
	require.NoError(t, err)
	assert.Len(t, branch.Turns, 1)
	assert.Equal(t, c.ID, branch.ParentID)
	native, err := readConversation(1, branch.ID)
	require.NoError(t, err)
	assert.Contains(t, string(native.Contexts[0][0].Native), "opaque-private")
	value, err = GetConversation(1, c.ID)
	require.NoError(t, err)
	assert.Len(t, value.Turns, 2)
	value, err = RenameConversation(1, c.ID, "renamed")
	require.NoError(t, err)
	assert.Equal(t, "renamed", value.Title)
	require.NoError(t, DeleteConversation(1, c.ID))
	_, err = GetConversation(1, c.ID)
	require.ErrorIs(t, err, ErrConversationMissing)
}

func TestTCYAIConversationOrganization(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("organization-test")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		for key := range conversations.live {
			if key.uid == 1 {
				delete(conversations.live, key)
			}
		}
	})
	older, err := CreateConversation(1, "Older chat")
	require.NoError(t, err)
	newer, err := CreateConversation(1, "Newer chat")
	require.NoError(t, err)
	yes, no := true, false
	pinned, err := UpdateConversationMetadata(1, older.ID, ConversationMetadata{Pinned: &yes})
	require.NoError(t, err)
	assert.True(t, pinned.Pinned)
	assert.Equal(t, older.Updated, pinned.Updated)
	entries, err := SearchConversations(1, "", "active")
	require.NoError(t, err)
	require.Len(t, entries, 2)
	assert.Equal(t, older.ID, entries[0].ID)
	_, err = UpdateConversationMetadata(2, older.ID, ConversationMetadata{Pinned: &yes})
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = UpdateConversationMetadata(1, older.ID, ConversationMetadata{Pinned: &yes, Archived: &yes})
	require.ErrorIs(t, err, ErrConversationMetadata)
	blank := "  "
	_, err = RenameConversation(1, older.ID, blank)
	require.ErrorIs(t, err, ErrConversationMetadata)
	record, err := readConversation(1, older.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: uuid.NewString(), Prompt: "NeedLE in message", Status: "completed", Result: RunResult{Reply: "Answer keyword"}}}
	record.Contexts = [][]storedMessage{{}}
	require.NoError(t, writeConversation(1, record))
	archived, err := UpdateConversationMetadata(1, older.ID, ConversationMetadata{Archived: &yes})
	require.NoError(t, err)
	assert.True(t, archived.Archived)
	assert.False(t, archived.Pinned)
	entries, err = SearchConversations(1, "", "active")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.Equal(t, newer.ID, entries[0].ID)
	entries, err = SearchConversations(1, "needle", "all")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	assert.True(t, entries[0].Archived)
	entries, err = SearchConversations(2, "needle", "all")
	require.NoError(t, err)
	assert.Empty(t, entries)
	entries, err = SearchConversations(1, "KEYWORD", "archived")
	require.NoError(t, err)
	require.Len(t, entries, 1)
	branch, err := ForkConversation(1, older.ID, record.Turns[0].ID)
	require.NoError(t, err)
	assert.False(t, branch.Archived)
	assert.False(t, branch.Pinned)
	restored, err := UpdateConversationMetadata(1, older.ID, ConversationMetadata{Pinned: &yes})
	require.NoError(t, err)
	assert.False(t, restored.Archived)
	// Live metadata must update the same record used by the worker; deleting remains forbidden.
	live, err := readConversation(1, older.ID)
	require.NoError(t, err)
	live.Turns[0].Status = "running"
	conversations.live[liveKey(1, older.ID)] = &liveConversation{uid: 1, id: older.ID, record: live}
	title := "Renamed while running"
	_, err = UpdateConversationMetadata(1, older.ID, ConversationMetadata{Title: &title, Archived: &yes, Pinned: &no})
	require.NoError(t, err)
	assert.Equal(t, title, live.Title)
	assert.True(t, live.Archived)
	assert.Equal(t, "running", live.Turns[0].Status)
	require.ErrorIs(t, DeleteConversation(1, older.ID), ErrConversationBusy)
	live.Turns[0].Status = "completed"
	require.NoError(t, writeConversation(1, live))
	delete(conversations.live, liveKey(1, older.ID))
	saved, err := GetConversation(1, older.ID)
	require.NoError(t, err)
	assert.Equal(t, title, saved.Title)
	assert.True(t, saved.Archived)
	require.NoError(t, DeleteConversation(1, older.ID))
	_, err = GetConversation(1, branch.ID)
	require.NoError(t, err)
}
