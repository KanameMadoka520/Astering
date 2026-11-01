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

//nolint:gosmopolitan // Portable exports intentionally use bilingual labels.
package tcyai

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"
)

// The portable export contains only the public transcript, never credentials,
// native provider signatures, hidden execution contexts, or task database rows.
func ExportConversation(uid int64, id, format string) ([]byte, string, error) {
	c, err := GetConversation(uid, id)
	if err != nil {
		return nil, "", err
	}
	if format == "json" {
		b, err := json.MarshalIndent(c, "", "  ")
		return b, "application/json", err
	}
	var archive bytes.Buffer
	z := zip.NewWriter(&archive)
	available := map[string]string{}
	var total int64
	for _, a := range allAttachments(c) {
		if _, ok := available[a.ID]; ok {
			continue
		}
		available[a.ID] = ""
		if a.Missing {
			continue
		}
		path := "attachments/" + a.ID + "/" + strings.ReplaceAll(a.Name, "..", "_")
		if format == "zip" {
			_, data, err := DownloadChatAttachment(uid, id, a.ID)
			if errors.Is(err, ErrAttachmentMissing) {
				continue
			}
			if err != nil {
				return nil, "", err
			}
			total += int64(len(data))
			if total > 256*1024*1024 {
				return nil, "", ErrAttachmentInvalid
			}
			f, err := z.Create(path)
			if err != nil {
				return nil, "", err
			}
			if _, err = f.Write(data); err != nil {
				return nil, "", err
			}
		}
		available[a.ID] = path
	}
	text := conversationMarkdown(c, available)
	if format == "md" {
		return []byte(text), "text/markdown; charset=utf-8", nil
	}
	if format != "zip" {
		return nil, "", ErrAttachmentInvalid
	}
	f, err := z.Create("conversation.md")
	if err != nil {
		return nil, "", err
	}
	if _, err = f.Write([]byte(text)); err != nil {
		return nil, "", err
	}
	f, err = z.Create("conversation.json")
	if err != nil {
		return nil, "", err
	}
	if err = json.NewEncoder(f).Encode(c); err != nil {
		return nil, "", err
	}
	if err = z.Close(); err != nil {
		return nil, "", err
	}
	return archive.Bytes(), "application/zip", nil
}
func markdownLabel(s string) string {
	return strings.NewReplacer("\\", "\\\\", "[", "\\[", "]", "\\]", "\n", " ", "\r", " ", "<", "&lt;", ">", "&gt;").Replace(s)
}
func conversationMarkdown(c Conversation, available map[string]string) string {
	var b strings.Builder
	fmt.Fprintf(&b, "# %s\n\nConversation / 会话 ID: `%s`\n\nCreated / 创建时间: %s\n\n", markdownLabel(c.Title), c.ID, exportConversationTime(c.Created))
	writeFiles := func(items []ChatAttachment) {
		for _, a := range items {
			path := available[a.ID]
			if path == "" {
				fmt.Fprintf(&b, "\n> [Attachment missing / 附件已丢失] %s\n\n", markdownLabel(a.Name))
				continue
			}
			prefix := ""
			if isChatImage(a.MIME) {
				prefix = "!"
			}
			// Angle-bracket destinations support spaces; escape delimiters and percent itself.
			path = strings.NewReplacer("%", "%25", "<", "%3C", ">", "%3E", "#", "%23", "?", "%3F").Replace(path)
			fmt.Fprintf(&b, "\n%s[%s](<%s>)\n\n", prefix, markdownLabel(a.Name), path)
		}
	}
	for _, turn := range c.Turns {
		fmt.Fprintf(&b, "## You / 你%s\n\n%s\n\n", exportTimeSuffix(turn.Started), turn.Prompt)
		writeFiles(turn.Attachments)
		for _, entry := range turn.Steering {
			fmt.Fprintf(&b, "### Additional instruction / 补充指令%s · %s\n\n%s\n\n", exportTimeSuffix(entry.Created), entry.Status, entry.Message)
		}
		finished := time.Time{}
		if turn.Finished != nil {
			finished = *turn.Finished
		}
		fmt.Fprintf(&b, "## Arona / 阿罗娜%s\n\n%s\n\n", exportTimeSuffix(finished), turn.Result.Reply)
		if turn.Result.Error != "" {
			fmt.Fprintf(&b, "> %s\n\n", turn.Result.Error)
		}
		fmt.Fprintf(&b, "Status / 状态: %s · Model / 模型: %s · Duration / 耗时: %.2f s\n\n", turn.Status, markdownLabel(turn.Result.Model), float64(turn.Result.DurationMS)/1000)
		if turn.Result.Usage.Reported {
			fmt.Fprintf(&b, "Tokens: %d input / %d output\n\n", turn.Result.Usage.Input, turn.Result.Usage.Output)
		}
		if len(turn.Result.Actions) > 0 {
			raw, err := json.MarshalIndent(turn.Result.Actions, "", "  ")
			if err != nil {
				raw = []byte("Unable to serialize tool results")
			}
			fmt.Fprintf(&b, "### Tool results / 工具执行记录\n\n````json\n%s\n````\n\n", raw)
		}
	}
	if len(c.DraftAttachments) > 0 {
		b.WriteString("## Unsent attachments / 未发送附件\n\n")
		writeFiles(c.DraftAttachments)
	}
	for _, summary := range c.Compactions {
		fmt.Fprintf(&b, "## Context summary / 上下文摘要\n\n%s\n\n", summary.Summary)
	}
	return b.String()
}

func exportConversationTime(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return value.In(time.FixedZone("GMT+8", 8*60*60)).Format("2006-01-02 15:04:05 MST")
}
func exportTimeSuffix(value time.Time) string {
	if value.IsZero() {
		return ""
	}
	return " · " + exportConversationTime(value)
}
