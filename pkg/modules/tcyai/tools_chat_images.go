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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package tcyai

import (
	"context"
	"slices"
)

type chatImageContextKey struct{}

// ChatImageContext is supplied by the runner, never by model-generated arguments.
type ChatImageContext struct {
	OwnerID        int64
	ConversationID string
	AttachmentIDs  []string
}

func WithChatImageContext(ctx context.Context, ownerID int64, conversationID string, attachmentIDs []string) context.Context {
	return context.WithValue(ctx, chatImageContextKey{}, ChatImageContext{
		OwnerID:        ownerID,
		ConversationID: conversationID,
		AttachmentIDs:  slices.Clone(attachmentIDs),
	})
}

func ChatImagesFromContext(ctx context.Context) ChatImageContext {
	value, _ := ctx.Value(chatImageContextKey{}).(ChatImageContext)
	value.AttachmentIDs = slices.Clone(value.AttachmentIDs)
	return value
}

func IsChatImageTool(name string) bool {
	return name == "get_task_description_layout" || name == "insert_chat_image" || name == "update_task_description_image" || name == "remove_task_description_image"
}

func ChatImageTools(mode string) []map[string]any {
	id := map[string]any{"type": "integer", "minimum": 1}
	index := map[string]any{"type": "integer", "minimum": 0}
	hash := map[string]any{"type": "string", "pattern": "^[a-f0-9]{64}$"}
	position := map[string]any{"type": "string", "enum": []string{"start", "end", "before", "after"}}
	result := []map[string]any{tool("get_task_description_layout", "读取任务描述的精确布局：description_version、从0开始的顶层block_index、image_index和image_hash。先读取再插入/修改/移除图片；这不是Project描述。", map[string]any{"id": id}, "id")}
	if mode != "write" {
		return result
	}
	result = append(result,
		tool("insert_chat_image", "把当前对话中可见的图片附件放进任务描述。必须先读布局；attachment_id取当前聊天附件ID，不能填URL或伪造会话ID。position为start/end或before/after；后两者必须传block_index。只共享已有网盘文件，不删除聊天原图。", map[string]any{
			"id":                  id,
			"description_version": hash,
			"attachment_id":       hash,
			"position":            position,
			"block_index":         index,
			"alt":                 map[string]any{"type": "string", "maxLength": 500},
			"title":               map[string]any{"type": "string", "maxLength": 200},
		}, "id", "description_version", "attachment_id", "position"),
		tool("update_task_description_image", "修改任务描述中单张图片的替代文字/标题、用当前聊天附图替换、或移动到指定顶层块前后。必须提供最新布局的description_version、image_index、image_hash。不会删除旧任务附件或网盘原件。", map[string]any{
			"id":                  id,
			"description_version": hash,
			"image_index":         index,
			"image_hash":          hash,
			"attachment_id":       hash,
			"position":            position,
			"block_index":         index,
			"alt":                 map[string]any{"type": "string", "maxLength": 500},
			"title":               map[string]any{"type": "string", "maxLength": 200},
		}, "id", "description_version", "image_index", "image_hash"),
		tool("remove_task_description_image", "仅移除任务描述中指定图片节点，保留任务附件、封面、网盘和聊天原件。必须提供最新布局的description_version、image_index、image_hash；不会删除文件。", map[string]any{
			"id":                  id,
			"description_version": hash,
			"image_index":         index,
			"image_hash":          hash,
		}, "id", "description_version", "image_index", "image_hash"),
	)
	return result
}
