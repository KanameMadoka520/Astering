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

package apiv2

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIUnattendedNotesKeepOwnershipVersionsAndDeletionSwitch(t *testing.T) {
	executors := noteExecutorFixture(t)
	executor := executors(1)
	executor.input.Approval = "unattended"
	ctx := context.Background()
	raw, preview := noteToolPrepare(t, executor, "create_note", map[string]any{
		"title":   "Unattended fixture",
		"content": "Original article",
	})
	preview.Approved = false
	_, err := executor.execute(ctx, "create_note", raw)
	requireAIBucketCode(t, err, "REVIEW_REQUIRED")
	created, err := executor.execute(tcyai.WithOperation(ctx, &preview), "create_note", raw)
	require.NoError(t, err)
	assert.False(t, preview.Approved)
	assert.True(t, preview.Verified)
	var result struct {
		Note models.AsterNote `json:"note"`
	}
	require.NoError(t, json.Unmarshal([]byte(created), &result))
	note := noteToolReadStored(t, executor, result.Note.ID)
	require.Equal(t, "Original article", note.Content)
	raw, preview = noteToolPrepare(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
		"append_content":    "\nUnattended appendix",
	})
	preview.Approved = false
	other := executors(2)
	other.input.Approval = "unattended"
	other.auth.(*user.User).IsAdmin = true
	_, err = other.execute(tcyai.WithOperation(ctx, &preview), "update_note", raw)
	require.Error(t, err, "unattended and instance administration cannot grant another account's note")
	for _, mode := range []string{
		"off",
		"read",
	} {
		executor.input.ToolModules.Notes = mode
		_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "update_note", raw)
		requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	}
	executor.input.ToolModules.Notes = "write"
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "update_note", raw)
	require.NoError(t, err)
	assert.False(t, preview.Approved)
	assert.Equal(t, "Original article\nUnattended appendix", noteToolReadStored(t, executor, note.ID).Content)
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "update_note", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	note = noteToolReadStored(t, executor, note.ID)
	raw, preview = noteToolPrepare(t, executor, "delete_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
	})
	preview.Approved = false
	executor.input.AllowDelete = false
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "delete_note", raw)
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED: delete_note")
	assert.False(t, preview.Verified)
	preserved := noteToolReadStored(t, executor, note.ID)
	assert.Equal(t, note.Revision, preserved.Revision)
	assert.Equal(t, note.Content, preserved.Content)
	executor.input.AllowDelete = true
	noteToolAppendASR(t, executor, note.ID, "New transcript after preparation")
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "delete_note", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	raw, preview = noteToolPrepare(t, executor, "delete_note", map[string]any{
		"id":                note.ID,
		"expected_revision": noteToolReadStored(t, executor, note.ID).Revision,
	})
	preview.Approved = false
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "delete_note", raw)
	require.NoError(t, err)
	assert.False(t, preview.Approved)
	db.AssertMissing(t, "aster_notes", map[string]interface{}{"id": note.ID})
	raw, preview = noteToolPrepare(t, executor, "create_note", map[string]any{"title": "Revoked session must not create"})
	preview.Approved = false
	s := db.NewSession()
	_, err = s.ID(executor.auth.(*user.User).CredentialScope().SessionID).Delete(&models.Session{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	_, err = executor.execute(tcyai.WithOperation(ctx, &preview), "create_note", raw)
	require.Error(t, err, "unattended must not bypass a revoked login credential")
}

func TestTCYAIUnattendedBucketDeleteKeepsExactMigrationPreview(t *testing.T) {
	aiBucketFixtures(t)
	executor := aiBucketWriter()
	executor.input.Approval = "unattended"
	op, err := aiBucketPrepare(t, executor, "delete_bucket", map[string]any{
		"project_id": 1,
		"view_id":    4,
		"bucket_id":  2,
	})
	require.NoError(t, err)
	assert.False(t, op.Approved)
	stale := op
	stale.Version = "different-preview"
	_, err = aiBucketExecute(t, executor, &stale)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	other := *executor
	other.auth = &user.User{ID: 2}
	_, err = aiBucketExecute(t, &other, &op)
	require.Error(t, err, "unattended cannot delete another account's bucket")
	executor.input.Mode = "read"
	_, err = aiBucketExecute(t, executor, &op)
	requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	executor.input.Mode = "write"
	result, err := aiBucketExecute(t, executor, &op)
	require.NoError(t, err)
	assert.False(t, op.Approved)
	assert.True(t, op.Verified)
	assert.InDelta(t, 3, result["tasks_moved"], 0)
	db.AssertMissing(t, "buckets", map[string]interface{}{"id": 2})
	for _, taskID := range []int64{
		3,
		4,
		5,
	} {
		db.AssertExists(t, "tasks", map[string]interface{}{"id": taskID}, false)
		db.AssertExists(t, "task_buckets", map[string]interface{}{
			"task_id":         taskID,
			"project_view_id": 4,
			"bucket_id":       1,
		}, false)
	}
}

func TestTCYAIUnattendedChatImageStillBindsPreparedScopeAndLayout(t *testing.T) {
	executor, ctx, source := chatImageFixture(t)
	executor.input.Approval = "unattended"
	raw, err := json.Marshal(aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: descriptionHash(chatImageTask(t).Description),
		AttachmentID:       source.ID,
		Position:           "start",
	})
	require.NoError(t, err)
	op, err := executor.prepareChatImage(ctx, "insert_chat_image", raw)
	require.NoError(t, err)
	_, err = executor.executeChatImage(ctx, "insert_chat_image", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	executor.input.Approval = "auto"
	_, err = executor.executeChatImage(tcyai.WithOperation(ctx, &op), "insert_chat_image", raw)
	requireAIBucketCode(t, err, "REVIEW_REQUIRED")
	executor.input.Approval = "unattended"
	stale := op
	stale.Version = "different-layout-preview"
	_, err = executor.executeChatImage(tcyai.WithOperation(ctx, &stale), "insert_chat_image", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	executor.input.WriteProjectIDs = []int64{2}
	_, err = executor.executeChatImage(tcyai.WithOperation(ctx, &op), "insert_chat_image", raw)
	requireAIBucketCode(t, err, "SCOPE_DENIED")
	executor.input.WriteProjectIDs = nil
	other := *executor
	other.auth = &user.User{ID: 2}
	_, err = other.executeChatImage(tcyai.WithOperation(ctx, &op), "insert_chat_image", raw)
	require.Error(t, err, "unattended cannot share an image into an inaccessible task")
	_, err = executor.executeChatImage(tcyai.WithOperation(ctx, &op), "insert_chat_image", raw)
	require.NoError(t, err)
	assert.False(t, op.Approved)
	assert.True(t, op.Verified)
	require.Len(t, chatImageLayout(t).images, 1)
}
