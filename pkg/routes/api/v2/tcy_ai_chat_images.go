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
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"slices"
	"strings"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"

	"golang.org/x/net/html"
	"golang.org/x/net/html/atom"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

type aiChatImageArgs struct {
	ID                 int64   `json:"id"`
	DescriptionVersion string  `json:"description_version"`
	AttachmentID       string  `json:"attachment_id"`
	Position           string  `json:"position"`
	BlockIndex         *int    `json:"block_index"`
	ImageIndex         *int    `json:"image_index"`
	ImageHash          string  `json:"image_hash"`
	Alt                *string `json:"alt"`
	Title              *string `json:"title"`
}

type aiDescriptionBlock struct {
	Index int    `json:"block_index"`
	Kind  string `json:"kind"`
	Text  string `json:"text_preview"`
}

type aiDescriptionImage struct {
	Index int    `json:"image_index"`
	Hash  string `json:"image_hash"`
	Block int    `json:"block_index"`
	Alt   string `json:"alt"`
	Title string `json:"title"`
}

type aiDescriptionLayout struct {
	ID        int64                `json:"id"`
	ProjectID int64                `json:"project_id"`
	Version   string               `json:"description_version"`
	Blocks    []aiDescriptionBlock `json:"blocks"`
	Images    []aiDescriptionImage `json:"images"`
}

type aiDescriptionDocument struct {
	root   *html.Node
	blocks []*html.Node
	images []*html.Node
	layout aiDescriptionLayout
}

func descriptionHash(value string) string { return fmt.Sprintf("%x", sha256.Sum256([]byte(value))) }

func imageNodeHTML(node *html.Node) string {
	var output strings.Builder
	_ = html.Render(&output, node)
	return output.String()
}

func imageAttribute(node *html.Node, name string) string {
	for _, attribute := range node.Attr {
		if attribute.Key == name {
			return attribute.Val
		}
	}
	return ""
}

func setImageAttribute(node *html.Node, name, value string) {
	node.Attr = slices.DeleteFunc(node.Attr, func(attribute html.Attribute) bool { return attribute.Key == name })
	if value != "" {
		node.Attr = append(node.Attr, html.Attribute{Key: name, Val: value})
	}
}

func descriptionDocument(task *models.Task) (*aiDescriptionDocument, error) {
	root := &html.Node{Type: html.ElementNode, Data: "div", DataAtom: atom.Div}
	nodes, err := html.ParseFragment(strings.NewReader(task.Description), root)
	if err != nil {
		return nil, err
	}
	document := &aiDescriptionDocument{
		root: root,
		layout: aiDescriptionLayout{
			ID:        task.ID,
			ProjectID: task.ProjectID,
			Version:   descriptionHash(task.Description),
			Blocks:    []aiDescriptionBlock{},
			Images:    []aiDescriptionImage{},
		},
	}
	for _, node := range nodes {
		root.AppendChild(node)
		if node.Type == html.TextNode && strings.TrimSpace(node.Data) == "" {
			continue
		}
		index := len(document.blocks)
		document.blocks = append(document.blocks, node)
		var text strings.Builder
		var walk func(*html.Node)
		walk = func(current *html.Node) {
			if current.Type == html.TextNode {
				text.WriteString(current.Data)
			}
			if current.Type == html.ElementNode && current.Data == "img" {
				document.layout.Images = append(document.layout.Images, aiDescriptionImage{
					Index: len(document.images),
					Hash:  descriptionHash(imageNodeHTML(current)),
					Block: index,
					Alt:   imageAttribute(current, "alt"),
					Title: imageAttribute(current, "title"),
				})
				document.images = append(document.images, current)
			}
			for child := current.FirstChild; child != nil; child = child.NextSibling {
				walk(child)
			}
		}
		walk(node)
		preview := []rune(text.String())
		if len(preview) > 256 {
			preview = preview[:256]
		}
		document.layout.Blocks = append(document.layout.Blocks, aiDescriptionBlock{Index: index, Kind: descriptionBlockKind(node), Text: string(preview)})
	}
	return document, nil
}

func descriptionBlockKind(node *html.Node) string {
	if node.Type == html.TextNode {
		return "text"
	}
	return node.Data
}

func parseChatImageArgs(raw json.RawMessage) (aiChatImageArgs, error) {
	var args aiChatImageArgs
	if err := json.Unmarshal(raw, &args); err != nil || args.ID <= 0 {
		return args, tcyai.ToolFailure("INVALID_ARGUMENTS", "Read a real task ID and follow the discovered image tool schema.")
	}
	return args, nil
}

func (e *aiExecution) readImageTask(ctx context.Context, s *xorm.Session, id int64, write bool) (*models.Task, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	task, err := models.GetTaskSimple(s, &models.Task{ID: id})
	if err != nil {
		return nil, err
	}
	if write {
		if e.input.Mode != "write" {
			return nil, tcyai.ToolFailure("FORBIDDEN", "Image changes require write mode.")
		}
		if err = e.scope(task.ProjectID); err != nil {
			return nil, err
		}
		can, permissionErr := task.CanUpdate(s, e.auth)
		if permissionErr != nil {
			return nil, permissionErr
		}
		if !can {
			return nil, tcyai.ToolFailure("FORBIDDEN", "Current task permissions deny image changes.")
		}
	} else {
		can, _, permissionErr := task.CanRead(s, e.auth)
		if permissionErr != nil {
			return nil, permissionErr
		}
		if !can {
			return nil, tcyai.ToolFailure("FORBIDDEN", "Current task permissions deny reading its description.")
		}
	}
	return &task, nil
}

func (e *aiExecution) prepareChatImage(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{Units: 1, After: string(raw)}
	if !tcyai.IsChatImageTool(name) {
		return op, tcyai.ToolFailure("INVALID_ARGUMENTS", "Unknown task image operation.")
	}
	args, err := parseChatImageArgs(raw)
	if err != nil {
		return op, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	if name != "get_task_description_layout" && db.Type() != schemas.SQLITE {
		s.ForUpdate()
	}
	task, err := e.readImageTask(ctx, s, args.ID, name != "get_task_description_layout")
	if err != nil {
		return op, err
	}
	op.ProjectIDs = []int64{task.ProjectID}
	op.Version = descriptionHash(task.Description)
	op.Before, err = marshalAI(map[string]any{"id": task.ID, "description": task.Description})
	if err != nil {
		return op, err
	}
	if name != "get_task_description_layout" {
		document, parseErr := descriptionDocument(task)
		if parseErr != nil {
			return op, parseErr
		}
		if _, planErr := document.validatePlan(name, args); planErr != nil {
			return op, planErr
		}
		// Do not hold a database read transaction while the conversation store
		// resolves a draft and may reconcile its Drive references.
		if err = s.Close(); err != nil {
			return op, err
		}
		if args.AttachmentID != "" {
			source, sourceErr := e.chatImageSource(ctx, args.AttachmentID)
			if sourceErr != nil {
				return op, sourceErr
			}
			if source.DriveFileID <= 0 {
				return op, tcyai.ToolFailure("INVALID_ARGUMENTS", "This legacy image must be uploaded to the conversation again before insertion.")
			}
		}
	}
	return op, nil
}

func (e *aiExecution) chatImageSource(ctx context.Context, id string) (tcyai.ChatAttachment, error) {
	identity := tcyai.ChatImagesFromContext(ctx)
	a, ok := e.auth.(*user.User)
	if !ok || identity.OwnerID != a.ID || identity.ConversationID == "" || !slices.Contains(identity.AttachmentIDs, id) {
		return tcyai.ChatAttachment{}, tcyai.ToolFailure("FORBIDDEN", "Only images visible in this account's current conversation may be inserted.")
	}
	item, _, err := tcyai.DownloadChatAttachment(a.ID, identity.ConversationID, id)
	if err != nil {
		return item, err
	}
	if !slices.Contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp"}, item.MIME) {
		return item, tcyai.ToolFailure("INVALID_ARGUMENTS", "The selected conversation attachment is not a supported raster image.")
	}
	return item, nil
}

func (e *aiExecution) executeChatImage(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	args, err := parseChatImageArgs(raw)
	if err != nil {
		return "", err
	}
	preview, err := e.prepareChatImage(ctx, name, raw)
	if err != nil {
		return "", err
	}
	if op := tcyai.CurrentOperation(ctx); op != nil && op.Version != "" && op.Version != preview.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The task description changed after review.")
	}
	var source tcyai.ChatAttachment
	if args.AttachmentID != "" {
		source, err = e.chatImageSource(ctx, args.AttachmentID)
		if err != nil {
			return "", err
		}
	}
	// Resolve the conversation outside a DB write transaction: chat callbacks may themselves use Drive.
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	if name != "get_task_description_layout" {
		if err = models.LockProjectViewsForTaskMutation(s, preview.ProjectIDs...); err != nil {
			return "", err
		}
		if db.Type() == schemas.SQLITE {
			_, err = s.NoAutoTime().Where("id = ?", args.ID).Cols("id").Update(&models.Task{ID: args.ID})
		} else {
			var row models.Task
			_, err = s.ForUpdate().ID(args.ID).Get(&row)
		}
		if err != nil {
			return "", err
		}
	}
	if name != "get_task_description_layout" && db.Type() != schemas.SQLITE {
		s.ForUpdate()
	}
	task, err := e.readImageTask(ctx, s, args.ID, name != "get_task_description_layout")
	if err != nil {
		return "", err
	}
	if name != "get_task_description_layout" && !slices.Contains(preview.ProjectIDs, task.ProjectID) {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The task moved to another project before its lock was acquired.")
	}
	document, err := descriptionDocument(task)
	if err != nil {
		return "", err
	}
	if name == "get_task_description_layout" {
		return marshalAI(document.layout)
	}
	if document.layout.Version != args.DescriptionVersion {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The description changed while waiting for its lock.")
	}
	if err = e.mutateChatImage(s, task.ID, document, name, args, source); err != nil {
		return "", err
	}
	return e.saveChatImage(ctx, s, task.ID, document)
}

func (document *aiDescriptionDocument) validatePlan(name string, args aiChatImageArgs) (*html.Node, error) {
	if args.DescriptionVersion != document.layout.Version {
		return nil, tcyai.ToolFailure("STATE_CONFLICT", "The description changed. Read its layout again before editing images.")
	}
	if name == "update_task_description_image" && args.AttachmentID == "" && args.Alt == nil && args.Title == nil && args.Position == "" {
		return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "Specify an image replacement, alt/title change or new position.")
	}
	var image *html.Node
	if name != "insert_chat_image" {
		if args.ImageIndex == nil || *args.ImageIndex < 0 || *args.ImageIndex >= len(document.images) {
			return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "Read the layout and select an existing image_index.")
		}
		image = document.images[*args.ImageIndex]
		if descriptionHash(imageNodeHTML(image)) != args.ImageHash {
			return nil, tcyai.ToolFailure("STATE_CONFLICT", "The selected image no longer matches image_hash.")
		}
	} else {
		if args.AttachmentID == "" {
			return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "A current conversation image attachment_id is required.")
		}
		image = &html.Node{Type: html.ElementNode, Data: "img", DataAtom: atom.Img}
	}

	if name == "insert_chat_image" || args.Position != "" {
		if err := document.place(image, args); err != nil {
			return nil, err
		}
	}
	return image, nil
}

func (e *aiExecution) mutateChatImage(s *xorm.Session, taskID int64, document *aiDescriptionDocument, name string, args aiChatImageArgs, source tcyai.ChatAttachment) error {
	image, err := document.validatePlan(name, args)
	if err != nil {
		return err
	}
	if name == "remove_task_description_image" {
		image.Parent.RemoveChild(image)
	} else {
		if source.ID != "" {
			attachment, attachErr := e.attachChatImage(s, taskID, source)
			if attachErr != nil {
				return attachErr
			}
			base := strings.TrimRight(config.ServiceAPIURL.GetString(), "/")
			if base == "" {
				base = strings.TrimRight(config.ServicePublicURL.GetString(), "/")
			}
			if !strings.HasSuffix(base, "/api/v2") && !strings.HasSuffix(base, "/api/v1") {
				base += "/api/v2"
			}
			setImageAttribute(image, "src", fmt.Sprintf("%s/tasks/%d/attachments/%d", base, taskID, attachment.ID))
			setImageAttribute(image, "data-src", "")
			setImageAttribute(image, "id", "")
		}
		if args.Alt != nil {
			setImageAttribute(image, "alt", *args.Alt)
		}
		if args.Title != nil {
			setImageAttribute(image, "title", *args.Title)
		}
	}
	return nil
}

func (e *aiExecution) saveChatImage(ctx context.Context, s *xorm.Session, taskID int64, document *aiDescriptionDocument) (string, error) {
	var err error
	var htmlValue strings.Builder
	for node := document.root.FirstChild; node != nil; node = node.NextSibling {
		if err = html.Render(&htmlValue, node); err != nil {
			return "", err
		}
	}
	bulk := &models.BulkTask{TaskIDs: []int64{taskID}, Fields: []string{"description"}, Values: &models.Task{Description: htmlValue.String()}}
	can, err := bulk.CanUpdate(s, e.auth)
	if err != nil {
		return "", err
	}
	if !can {
		return "", tcyai.ToolFailure("FORBIDDEN", "Task access was revoked before saving the image.")
	}
	if err = bulk.Update(s, e.auth); err != nil {
		return "", err
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Image transaction commit was not confirmed. Read the task before retrying.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	if op := tcyai.CurrentOperation(ctx); op != nil {
		op.Verified = true
	}
	return marshalAI(bulk.Tasks[0])
}

func (e *aiExecution) attachChatImage(s *xorm.Session, taskID int64, source tcyai.ChatAttachment) (*models.TaskAttachment, error) {
	if source.DriveFileID <= 0 {
		return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "This legacy encrypted image has no reusable Drive file. Upload it to this conversation again before inserting it.")
	}
	drive, err := models.GetDriveItem(s, e.auth, source.DriveFileID)
	if err != nil {
		return nil, err
	}
	return models.AttachDriveFile(s, e.auth, source.DriveFileID, drive.Revision, taskID)
}

func (document *aiDescriptionDocument) place(image *html.Node, args aiChatImageArgs) error {
	var before *html.Node
	switch args.Position {
	case "start":
		before = document.root.FirstChild
	case "end":
	case "before", "after":
		if args.BlockIndex == nil || *args.BlockIndex < 0 || *args.BlockIndex >= len(document.blocks) {
			return tcyai.ToolFailure("INVALID_ARGUMENTS", "before/after requires an existing block_index from the latest layout.")
		}
		before = document.blocks[*args.BlockIndex]
		for parent := image; parent != nil; parent = parent.Parent {
			if parent == before {
				return tcyai.ToolFailure("INVALID_ARGUMENTS", "Choose a different block when moving an image out of its current block.")
			}
		}
		if args.Position == "after" {
			before = before.NextSibling
		}
	default:
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "position must be start, end, before or after.")
	}
	if before == image {
		return nil
	}
	if image.Parent != nil {
		image.Parent.RemoveChild(image)
	}
	document.root.InsertBefore(image, before)
	return nil
}
