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
	"bytes"
	"context"
	"encoding/json"
	"image"
	"image/color"
	"image/png"
	"strings"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

func chatImageFixture(t *testing.T) (*aiExecution, context.Context, tcyai.ChatAttachment) {
	t.Helper()
	aiBucketFixtures(t)
	old := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(old) })
	chat, err := tcyai.CreateConversation(1, "Image placement regression")
	require.NoError(t, err)
	var data bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 2, 2))
	picture.Set(0, 0, color.RGBA{R: 255, A: 255})
	require.NoError(t, png.Encode(&data, picture))
	attachment, err := tcyai.UploadChatAttachment(1, chat.ID, "placement.png", &data)
	require.NoError(t, err)
	require.Positive(t, attachment.DriveFileID)
	return aiBucketWriter(), tcyai.WithChatImageContext(context.Background(), 1, chat.ID, []string{attachment.ID}), attachment
}

func chatImageTask(t *testing.T) models.Task {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	task, err := models.GetTaskByIDSimple(s, 1)
	require.NoError(t, err)
	return task
}

func chatImageSetDescription(t *testing.T, text string) {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	_, err := s.ID(1).Cols("description").Update(&models.Task{Description: text})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
}

func chatImageInvoke(ctx context.Context, t *testing.T, e *aiExecution, name string, args aiChatImageArgs) (string, error) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	return e.executeChatImage(ctx, name, raw)
}

func chatImageLayout(t *testing.T) *aiDescriptionDocument {
	t.Helper()
	task := chatImageTask(t)
	document, err := descriptionDocument(&task)
	require.NoError(t, err)
	return document
}

func TestTCYAIChatImagePlacementAndRetention(t *testing.T) {
	e, ctx, source := chatImageFixture(t)
	chatImageSetDescription(t, "<p>First paragraph</p><p>Second paragraph</p>")
	before := chatImageTask(t)
	s := db.NewSession()
	count, err := s.Count(&files.File{})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	block := 1
	args := aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: descriptionHash(before.Description),
		AttachmentID:       source.ID,
		Position:           "before",
		BlockIndex:         &block,
	}
	_, err = chatImageInvoke(ctx, t, e, "insert_chat_image", args)
	require.NoError(t, err)
	document := chatImageLayout(t)
	require.Len(t, document.images, 1)
	require.Equal(t, []string{"p", "img", "p"}, []string{document.blocks[0].Data, document.blocks[1].Data, document.blocks[2].Data})
	assert.Contains(t, chatImageTask(t).Description, "First paragraph")
	assert.Contains(t, chatImageTask(t).Description, "Second paragraph")
	// Reusing the same chat image adds a second placement, not a second file or attachment.
	args.DescriptionVersion = document.layout.Version
	args.Position = "end"
	_, err = chatImageInvoke(ctx, t, e, "insert_chat_image", args)
	require.NoError(t, err)
	document = chatImageLayout(t)
	require.Len(t, document.images, 2)
	assert.Equal(t, imageAttribute(document.images[0], "src"), imageAttribute(document.images[1], "src"))
	s = db.NewSession()
	afterCount, err := s.Count(&files.File{})
	require.NoError(t, err)
	assert.Equal(t, count, afterCount)
	links, err := s.Where("task_id = ? AND file_id = ?", 1, source.DriveFileID).Count(&models.TaskAttachment{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, links)
	require.NoError(t, s.Close())
	index := 0
	alt := "A safely escaped <caption>"
	args = aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: document.layout.Version,
		ImageIndex:         &index,
		ImageHash:          document.layout.Images[0].Hash,
		Position:           "end",
		Alt:                &alt,
	}
	_, err = chatImageInvoke(ctx, t, e, "update_task_description_image", args)
	require.NoError(t, err)
	document = chatImageLayout(t)
	assert.Equal(t, alt, imageAttribute(document.images[1], "alt"))
	args.DescriptionVersion = document.layout.Version
	args.ImageHash = document.layout.Images[0].Hash
	_, err = chatImageInvoke(ctx, t, e, "remove_task_description_image", args)
	require.NoError(t, err)
	require.Len(t, chatImageLayout(t).images, 1)
	identity := tcyai.ChatImagesFromContext(ctx)
	_, data, err := tcyai.DownloadChatAttachment(1, identity.ConversationID, source.ID)
	require.NoError(t, err)
	assert.NotEmpty(t, data)
	s = db.NewSession()
	defer s.Close()
	drive, err := models.GetDriveItem(s, e.auth, source.DriveFileID)
	require.NoError(t, err)
	assert.Equal(t, source.DriveFileID, drive.FileID)
	links, err = s.Where("task_id = ? AND file_id = ?", 1, source.DriveFileID).Count(&models.TaskAttachment{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, links)
}

func TestTCYAIChatImageGuards(t *testing.T) {
	e, ctx, source := chatImageFixture(t)
	original := chatImageTask(t).Description
	args := aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: descriptionHash(original),
		AttachmentID:       source.ID,
		Position:           "end",
	}
	tests := []struct {
		name      string
		execution *aiExecution
		context   context.Context
		mutate    func(*aiChatImageArgs)
	}{
		{name: "no chat context", execution: e, context: context.Background()},
		{name: "different owner", execution: e, context: tcyai.WithChatImageContext(ctx, 2, tcyai.ChatImagesFromContext(ctx).ConversationID, []string{source.ID})},
		{name: "not visible", execution: e, context: tcyai.WithChatImageContext(ctx, 1, tcyai.ChatImagesFromContext(ctx).ConversationID, nil)},
		{name: "different conversation", execution: e, context: tcyai.WithChatImageContext(ctx, 1, "00000000-0000-4000-8000-000000000001", []string{source.ID})},
		{name: "read mode", execution: aiBucketExecutor(tcyai.RunInput{Mode: "read"}), context: ctx},
		{name: "project restriction", execution: aiBucketExecutor(tcyai.RunInput{Mode: "write", WriteProjectIDs: []int64{10}}), context: ctx},
		{name: "read-only project", execution: e, context: ctx, mutate: func(a *aiChatImageArgs) { a.ID = 18 }},
		{name: "inaccessible project", execution: e, context: ctx, mutate: func(a *aiChatImageArgs) { a.ID = 13 }},
		{name: "stale description", execution: e, context: ctx, mutate: func(a *aiChatImageArgs) { a.DescriptionVersion = strings.Repeat("0", 64) }},
		{name: "invalid placement", execution: e, context: ctx, mutate: func(a *aiChatImageArgs) { a.Position = "before" }},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			input := args
			if test.mutate != nil {
				test.mutate(&input)
			}
			_, err := chatImageInvoke(test.context, t, test.execution, "insert_chat_image", input)
			require.Error(t, err)
			assert.Equal(t, original, chatImageTask(t).Description)
			s := db.NewSession()
			defer s.Close()
			count, err := s.Where("task_id = ? AND file_id = ?", 1, source.DriveFileID).Count(&models.TaskAttachment{})
			require.NoError(t, err)
			assert.Zero(t, count)
		})
	}
	// Description reads still respect model ACL and never expose inaccessible layout.
	_, err := chatImageInvoke(ctx, t, e, "get_task_description_layout", aiChatImageArgs{ID: 13})
	require.Error(t, err)
	_, err = chatImageInvoke(ctx, t, e, "get_task_description_layout", aiChatImageArgs{ID: 18})
	require.NoError(t, err)
}

func TestTCYAIChatImageReviewAndIdentity(t *testing.T) {
	e, ctx, source := chatImageFixture(t)
	args := aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: descriptionHash(chatImageTask(t).Description),
		AttachmentID:       source.ID,
		Position:           "start",
	}
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	op, err := e.prepareChatImage(ctx, "insert_chat_image", raw)
	require.NoError(t, err)
	chatImageSetDescription(t, "<p>Concurrent author update</p>")
	_, err = e.executeChatImage(tcyai.WithOperation(ctx, &op), "insert_chat_image", raw)
	require.Error(t, err)
	assert.Equal(t, "<p>Concurrent author update</p>", chatImageTask(t).Description)
	args.DescriptionVersion = descriptionHash(chatImageTask(t).Description)
	_, err = chatImageInvoke(ctx, t, e, "insert_chat_image", args)
	require.NoError(t, err)
	document := chatImageLayout(t)
	index := 0
	_, err = chatImageInvoke(ctx, t, e, "remove_task_description_image", aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: document.layout.Version,
		ImageIndex:         &index,
		ImageHash:          strings.Repeat("0", 64),
	})
	require.Error(t, err)
	assert.Len(t, chatImageLayout(t).images, 1)
	// Removing an image never grants file access to another account.
	s := db.NewSession()
	defer s.Close()
	_, err = models.GetDriveItem(s, &user.User{ID: 2}, source.DriveFileID)
	require.Error(t, err)
}

func TestTCYAIChatImageReplacementAndContextIsolation(t *testing.T) {
	e, ctx, source := chatImageFixture(t)
	identity := tcyai.ChatImagesFromContext(ctx)
	identity.AttachmentIDs[0] = "changed"
	require.Equal(t, source.ID, tcyai.ChatImagesFromContext(ctx).AttachmentIDs[0])
	var data bytes.Buffer
	picture := image.NewRGBA(image.Rect(0, 0, 3, 3))
	picture.Set(0, 0, color.RGBA{G: 255, A: 255})
	require.NoError(t, png.Encode(&data, picture))
	replacement, err := tcyai.UploadChatAttachment(1, identity.ConversationID, "replacement.png", &data)
	require.NoError(t, err)
	ids := []string{source.ID, replacement.ID}
	ctx = tcyai.WithChatImageContext(ctx, 1, identity.ConversationID, ids)
	ids[0] = "mutated after context creation"
	require.Equal(t, source.ID, tcyai.ChatImagesFromContext(ctx).AttachmentIDs[0])
	chatImageSetDescription(t, "")
	_, err = chatImageInvoke(ctx, t, e, "insert_chat_image", aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: descriptionHash(""),
		AttachmentID:       source.ID,
		Position:           "end",
	})
	require.NoError(t, err)
	document := chatImageLayout(t)
	require.Len(t, document.images, 1)
	oldSrc := imageAttribute(document.images[0], "src")
	index := 0
	_, err = chatImageInvoke(ctx, t, e, "update_task_description_image", aiChatImageArgs{
		ID:                 1,
		DescriptionVersion: document.layout.Version,
		ImageIndex:         &index,
		ImageHash:          document.layout.Images[0].Hash,
		AttachmentID:       replacement.ID,
	})
	require.NoError(t, err)
	document = chatImageLayout(t)
	require.Len(t, document.images, 1)
	assert.NotEqual(t, oldSrc, imageAttribute(document.images[0], "src"))
	s := db.NewSession()
	defer s.Close()
	for _, item := range []tcyai.ChatAttachment{source, replacement} {
		count, err := s.Where("task_id = ? AND file_id = ?", 1, item.DriveFileID).Count(&models.TaskAttachment{})
		require.NoError(t, err)
		assert.EqualValues(t, 1, count)
		_, err = models.GetDriveItem(s, e.auth, item.DriveFileID)
		require.NoError(t, err)
	}
}

func TestTCYAIChatImageLockRejectsMovedTask(t *testing.T) {
	aiBucketFixtures(t)
	e := aiBucketWriter()
	task := chatImageTask(t)
	raw, err := json.Marshal([]map[string]any{{"id": task.ID, "project_id": task.ProjectID + 1}})
	require.NoError(t, err)
	s := db.NewSession()
	defer s.Close()
	_, err = e.lockTasks(context.Background(), s, []aiChange{{ID: 1}}, "update_task", tcyai.Operation{
		Before:     string(raw),
		ProjectIDs: []int64{task.ProjectID + 1},
	})
	require.ErrorContains(t, err, "STATE_CONFLICT")
	lockedTask, readErr := models.GetTaskSimple(s, &models.Task{ID: 1})
	require.NoError(t, readErr)
	assert.Equal(t, task.Updated, lockedTask.Updated, "locking must not update timestamps")
}

func TestTCYAIChatImageProjectViewLockPrecedesTaskLock(t *testing.T) {
	aiBucketFixtures(t)
	if db.Type() != schemas.POSTGRES {
		t.Skip("PostgreSQL row-lock ordering regression")
	}
	// Hold the same view lock used by an ordinary bulk task update.
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, models.LockProjectViewsForTaskMutation(blocker, 1))
	worker := db.NewSession()
	defer worker.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	db.SetSessionContext(ctx, worker)
	rows, err := worker.QueryString("SELECT pg_backend_pid() AS pid")
	require.NoError(t, err)
	require.Len(t, rows, 1)
	pid := rows[0]["pid"]
	finished := make(chan error, 1)
	go func() {
		_, lockErr := aiBucketWriter().lockTasks(ctx, worker, []aiChange{{ID: 1}}, "update_task", tcyai.Operation{
			Before:     `[{"id":1,"project_id":1}]`,
			ProjectIDs: []int64{1},
		})
		finished <- lockErr
	}()
	defer func() { cancel(); <-finished }()
	observer := db.NewSession()
	defer observer.Close()
	db.SetSessionContext(ctx, observer)
	require.Eventually(t, func() bool {
		// PG may retain a statistics snapshot for this observer transaction.
		if _, clearErr := observer.QueryString("SELECT pg_stat_clear_snapshot()"); clearErr != nil {
			return false
		}
		waiting, queryErr := observer.QueryString("SELECT wait_event_type FROM pg_stat_activity WHERE pid = ?", pid)
		return queryErr == nil && len(waiting) == 1 && waiting[0]["wait_event_type"] == "Lock"
	}, time.Second, 10*time.Millisecond, "worker must actually be waiting on the held view lock")
	// The waiting image/tool writer must not already own the task row. The old
	// task->view order makes this bounded independent probe time out.
	probe := db.NewSession()
	defer probe.Close()
	probeCtx, probeCancel := context.WithTimeout(context.Background(), 300*time.Millisecond)
	defer probeCancel()
	db.SetSessionContext(probeCtx, probe)
	_, err = models.GetTaskSimple(probe.ForUpdate(), &models.Task{ID: 1})
	require.NoError(t, err, "waiting for a project view must not hold a task lock")
}

func TestTCYAIChatImagePrepareRejectsInvalidProposals(t *testing.T) {
	e, ctx, source := chatImageFixture(t)
	chatImageSetDescription(t, `<p>Keep this paragraph</p><img src="https://example.invalid/image.png" alt="old"/>`)
	document := chatImageLayout(t)
	index := 0
	tests := []struct {
		name string
		tool string
		args aiChatImageArgs
		ctx  context.Context
	}{
		{
			name: "invisible source",
			tool: "insert_chat_image",
			args: aiChatImageArgs{ID: 1, DescriptionVersion: document.layout.Version, AttachmentID: source.ID, Position: "end"},
			ctx:  context.Background(),
		},
		{
			name: "missing before target",
			tool: "insert_chat_image",
			args: aiChatImageArgs{ID: 1, DescriptionVersion: document.layout.Version, AttachmentID: source.ID, Position: "before"},
			ctx:  ctx,
		},
		{
			name: "wrong image fingerprint",
			tool: "remove_task_description_image",
			args: aiChatImageArgs{ID: 1, DescriptionVersion: document.layout.Version, ImageIndex: &index, ImageHash: strings.Repeat("0", 64)},
			ctx:  ctx,
		},
		{
			name: "empty update",
			tool: "update_task_description_image",
			args: aiChatImageArgs{ID: 1, DescriptionVersion: document.layout.Version, ImageIndex: &index, ImageHash: document.layout.Images[0].Hash},
			ctx:  ctx,
		},
	}
	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			raw, err := json.Marshal(test.args)
			require.NoError(t, err)
			_, err = e.prepareChatImage(test.ctx, test.tool, raw)
			require.Error(t, err)
			assert.Equal(t, document.layout.Version, descriptionHash(chatImageTask(t).Description))
		})
	}
	s := db.NewSession()
	defer s.Close()
	links, err := s.Where("task_id = ? AND file_id = ?", 1, source.DriveFileID).Count(&models.TaskAttachment{})
	require.NoError(t, err)
	assert.Zero(t, links, "preparation never attaches files")
}
