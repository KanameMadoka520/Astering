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
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func personalStorageFixture(t *testing.T) {
	t.Helper()
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("personal-storage-isolated-secret")
	t.Cleanup(func() {
		conversations.Lock()
		for key := range conversations.live {
			if key.uid == 1 || key.uid == 2 {
				delete(conversations.live, key)
			}
		}
		conversations.Unlock()
		deletedAccounts.Delete(accountKey(1))
		deletedAccounts.Delete(accountKey(2))
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
}

func storageTestFile(t *testing.T, path string, data []byte) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, data, 0600))
}

func TestTCYAIPersonalStorageMetadataDoesNotDecryptOrFollowLinks(t *testing.T) {
	personalStorageFixture(t)
	uid := int64(1)
	id := uuid.NewString()
	path, err := conversationPath(uid, id)
	require.NoError(t, err)
	// Deliberately unreadable ciphertext remains measurable without a valid key.
	storageTestFile(t, path, []byte("not encrypted; do not read this as metadata"))
	storageTestFile(t, fileFor(uid), []byte("private model credentials"))
	storageTestFile(t, filepath.Join(conversationDir(uid), ".mcp-settings"), []byte("private MCP credentials"))
	attachmentID := strings.Repeat("a", 64)
	attachmentPath, err := attachmentPath(uid, attachmentID)
	require.NoError(t, err)
	storageTestFile(t, attachmentPath, []byte("unique legacy ciphertext"))
	storageTestFile(t, filepath.Join(conversationDir(uid), "not-a-uuid.enc"), []byte("unmanaged debris"))
	storageTestFile(t, filepath.Join(conversationDir(uid), "attachments", "not-a-hash.enc"), []byte("unmanaged debris"))
	otherPath, err := conversationPath(2, uuid.NewString())
	require.NoError(t, err)
	storageTestFile(t, otherPath, []byte("other account ciphertext"))
	linkedID := uuid.NewString()
	require.NoError(t, os.Symlink(otherPath, filepath.Join(conversationDir(uid), linkedID+".enc")))
	result, err := GetPersonalStorage(context.Background(), uid)
	require.NoError(t, err)
	assert.Equal(t, int64(1), result.ConversationCount)
	assert.Equal(t, int64(len("not encrypted; do not read this as metadata")), result.ConversationBytes)
	assert.Equal(t, int64(1), result.LegacyAttachmentCount)
	assert.Equal(t, int64(len("unique legacy ciphertext")), result.LegacyAttachmentBytes)
	assert.Equal(t, int64(len("private model credentials")+len("private MCP credentials")), result.SettingsBytes)
	assert.False(t, result.Complete, "an ignored canonical symlink is unknown usage, not zero")
	_, err = GetStorageConversation(context.Background(), uid, linkedID)
	require.ErrorIs(t, err, errStoragePathUnsafe)
	_, err = DeleteStorageConversation(uid, linkedID, "anything", true)
	require.ErrorIs(t, err, errStoragePathUnsafe)
	data, err := os.ReadFile(otherPath)
	require.NoError(t, err)
	assert.Equal(t, "other account ciphertext", string(data))
}

func TestTCYAIPersonalStorageRejectsLinkedAccountDirectories(t *testing.T) {
	personalStorageFixture(t)
	other, err := CreateConversation(2, "not accessible")
	require.NoError(t, err)
	require.NoError(t, os.Symlink(conversationDir(2), conversationDir(1)))
	_, err = GetPersonalStorage(context.Background(), 1)
	require.ErrorIs(t, err, errStoragePathUnsafe)
	_, err = ListStorageConversations(context.Background(), 1, StorageConversationQuery{})
	require.ErrorIs(t, err, errStoragePathUnsafe)
	_, err = DeleteStorageConversation(1, other.ID, "anything", true)
	require.ErrorIs(t, err, errStoragePathUnsafe)
	_, err = GetStorageConversation(context.Background(), 2, other.ID)
	require.NoError(t, err)
}

func TestTCYAIPersonalStorageDeletionCASAndBusyIsolation(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "reviewed conversation")
	require.NoError(t, err)
	preview, err := GetStorageConversation(context.Background(), 1, chat.ID)
	require.NoError(t, err)
	_, err = DeleteStorageConversation(1, chat.ID, preview.Revision, false)
	require.ErrorIs(t, err, ErrStorageConversationConfirm)
	_, err = DeleteStorageConversation(2, chat.ID, preview.Revision, true)
	require.ErrorIs(t, err, ErrConversationMissing)
	// Re-encrypt the exact same plaintext: equal length and unchanged semantic
	// timestamps cannot allow an old preview to authorize deletion of newer bytes.
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	require.NoError(t, writeConversation(1, record))
	changed, err := GetStorageConversation(context.Background(), 1, chat.ID)
	require.NoError(t, err)
	assert.Equal(t, preview.Bytes, changed.Bytes)
	assert.NotEqual(t, preview.Revision, changed.Revision)
	_, err = DeleteStorageConversation(1, chat.ID, preview.Revision, true)
	require.ErrorIs(t, err, ErrStorageConversationChanged)
	conversations.Lock()
	conversations.live[liveKey(1, chat.ID)] = &liveConversation{
		uid:        1,
		id:         chat.ID,
		record:     record,
		compacting: true,
	}
	conversations.Unlock()
	_, err = DeleteStorageConversation(1, chat.ID, changed.Revision, true)
	require.ErrorIs(t, err, ErrConversationBusy)
	busy, err := GetStorageConversation(context.Background(), 1, chat.ID)
	require.NoError(t, err)
	assert.True(t, busy.Running)
	assert.True(t, busy.Compacting)
	// An unrelated busy conversation must not prevent deleting this one.
	conversations.Lock()
	delete(conversations.live, liveKey(1, chat.ID))
	conversations.live[liveKey(2, chat.ID)] = &liveConversation{
		uid:        2,
		id:         chat.ID,
		compacting: true,
	}
	conversations.Unlock()
	result, err := DeleteStorageConversation(1, chat.ID, changed.Revision, true)
	require.NoError(t, err)
	assert.Equal(t, changed.Bytes, result.FreedBytes)
	_, err = GetStorageConversation(context.Background(), 1, chat.ID)
	require.ErrorIs(t, err, ErrConversationMissing)
	assert.NotNil(t, conversations.live[liveKey(2, chat.ID)])
}

func TestTCYAIPersonalStorageLegacySharedAttachmentsAreNotDoubleCounted(t *testing.T) {
	personalStorageFixture(t)
	a, err := CreateConversation(1, "first branch")
	require.NoError(t, err)
	b, err := CreateConversation(1, "second branch")
	require.NoError(t, err)
	data := []byte("shared attachment content")
	attachment := legacyChatAttachment(t, 1, a.ID, "shared.txt", data)
	legacyChatAttachment(t, 1, b.ID, "shared.txt", data)
	path, err := attachmentPath(1, attachment.ID)
	require.NoError(t, err)
	info, err := os.Stat(path)
	require.NoError(t, err)
	summary, err := GetPersonalStorage(context.Background(), 1)
	require.NoError(t, err)
	assert.True(t, summary.Complete)
	assert.Equal(t, int64(2), summary.ConversationCount)
	assert.Equal(t, int64(1), summary.LegacyAttachmentCount)
	assert.Equal(t, info.Size(), summary.LegacyAttachmentBytes)
	first, err := GetStorageConversation(context.Background(), 1, a.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, first.AttachmentCount)
	assert.True(t, first.SharedAttachments)
	deleted, err := DeleteStorageConversation(1, a.ID, first.Revision, true)
	require.NoError(t, err)
	assert.Equal(t, first.Bytes, deleted.FreedBytes, "shared attachment is never claimed as reclaimed")
	_, err = os.Stat(path)
	require.NoError(t, err, "another branch keeps the legacy bytes")
	second, err := GetStorageConversation(context.Background(), 1, b.ID)
	require.NoError(t, err)
	_, err = DeleteStorageConversation(1, b.ID, second.Revision, true)
	require.NoError(t, err)
	_, err = os.Stat(path)
	require.ErrorIs(t, err, os.ErrNotExist)
}

func TestTCYAIPersonalStorageListIsPagedFilteredAndHonestAboutUnreadable(t *testing.T) {
	personalStorageFixture(t)
	older, err := CreateConversation(1, "Older title")
	require.NoError(t, err)
	newer, err := CreateConversation(1, "Newer title")
	require.NoError(t, err)
	other, err := CreateConversation(2, "Other account title")
	require.NoError(t, err)
	record, err := readConversation(1, older.ID)
	require.NoError(t, err)
	record.Updated = time.Date(2025, 1, 1, 0, 0, 0, 0, time.UTC)
	record.Archived = true
	record.Pinned = true
	record.Turns = []ChatTurn{{Prompt: "body-only secret query"}}
	require.NoError(t, writeConversation(1, record))
	conversations.Lock()
	conversations.live[liveKey(1, newer.ID)] = &liveConversation{
		uid:        1,
		id:         newer.ID,
		compacting: true,
	}
	conversations.Unlock()
	page, err := ListStorageConversations(context.Background(), 1, StorageConversationQuery{PerPage: 1})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, int64(2), page.Total)
	assert.Equal(t, int64(2), page.TotalPages)
	assert.Equal(t, newer.ID, page.Items[0].ID)
	assert.True(t, page.Items[0].Compacting)
	assert.True(t, page.Complete)
	page, err = ListStorageConversations(context.Background(), 1, StorageConversationQuery{
		Page:    2,
		PerPage: 1,
	})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, older.ID, page.Items[0].ID)
	page, err = ListStorageConversations(context.Background(), 1, StorageConversationQuery{
		Scope:   "archived",
		Q:       "OLDER",
		Running: "idle",
	})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.True(t, page.Items[0].Pinned)
	page, err = ListStorageConversations(context.Background(), 1, StorageConversationQuery{Q: "body-only secret query"})
	require.NoError(t, err)
	assert.Empty(t, page.Items, "storage search deliberately does not search conversation bodies")
	page, err = ListStorageConversations(context.Background(), 2, StorageConversationQuery{})
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	assert.Equal(t, other.ID, page.Items[0].ID)
	badPath, err := conversationPath(1, uuid.NewString())
	require.NoError(t, err)
	storageTestFile(t, badPath, []byte("unreadable encrypted record"))
	page, err = ListStorageConversations(context.Background(), 1, StorageConversationQuery{})
	require.NoError(t, err)
	assert.Equal(t, int64(2), page.Total)
	assert.False(t, page.Complete)
	assert.Equal(t, 1, page.UnreadableCount)
}

func TestTCYAIPersonalStorageIncompleteCancellationAndDeletedAccount(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "retained")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	summary, err := GetPersonalStorage(ctx, 1)
	require.NoError(t, err)
	assert.False(t, summary.Complete)
	page, err := ListStorageConversations(ctx, 1, StorageConversationQuery{})
	require.NoError(t, err)
	assert.False(t, page.Complete)
	assert.Empty(t, page.Items)
	preview, err := GetStorageConversation(context.Background(), 1, chat.ID)
	require.NoError(t, err)
	deletedAccounts.Store(accountKey(1), struct{}{})
	_, err = DeleteStorageConversation(1, chat.ID, preview.Revision, true)
	require.ErrorIs(t, err, ErrAccountDeleted)
	path, err := conversationPath(1, chat.ID)
	require.NoError(t, err)
	_, err = os.Stat(path)
	require.NoError(t, err, "account revocation is not authority to delete through this settings helper")
}
