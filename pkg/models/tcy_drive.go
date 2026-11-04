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

package models

import (
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/xorm"
)

var ErrDriveMissing = errors.New("drive_missing")
var ErrDriveChanged = errors.New("drive_changed")
var ErrDriveTrashed = errors.New("drive_trashed")
var ErrDriveInUse = errors.New("drive_in_use")
var ErrDriveChatUnreadable = errors.New("drive_chat_unreadable")
var ErrDriveConfirm = errors.New("drive_confirm")

// DriveItem only grants access to the owner, even when a task referencing it is shared.
type DriveItem struct {
	files.DriveFile `xorm:"extends"`
}

func (d *DriveItem) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	u, isUser := a.(*user.User)
	if !isUser {
		return false, 0, nil
	}
	ok, err := s.Where("file_id = ? AND owner_id = ?", d.FileID, u.ID).Exist(&files.DriveFile{})
	return ok, 0, err
}
func (d *DriveItem) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	ok, _, err := d.CanRead(s, a)
	return ok, err
}
func (d *DriveItem) CanDelete(s *xorm.Session, a web.Auth) (bool, error) { return d.CanUpdate(s, a) }
func (d *DriveItem) CanCreate(_ *xorm.Session, a web.Auth) (bool, error) {
	u, err := user.GetFromAuth(a)
	return err == nil && u.ID > 0, nil
}

func GetDriveItem(s *xorm.Session, a web.Auth, id int64) (*files.DriveFile, error) {
	d := &DriveItem{DriveFile: files.DriveFile{FileID: id}}
	ok, _, err := d.CanRead(s, a)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrDriveMissing
	}
	item := &files.DriveFile{}
	ok, err = s.Where("file_id = ?", id).Get(item)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, ErrDriveMissing
	}
	item.File = &files.File{ID: id}
	if err = item.File.LoadFileMetaByID(s); err != nil {
		return nil, err
	}
	return item, nil
}

// LockDriveItem uses a conditional write for serialization on SQLite, MySQL and Postgres.
// All reuse/trash/purge operations take this row lock before examining references.
func LockDriveItem(s *xorm.Session, a web.Auth, id, revision int64) (*files.DriveFile, error) {
	d, err := GetDriveItem(s, a, id)
	if err != nil {
		return nil, err
	}
	if d.Revision != revision {
		return nil, ErrDriveChanged
	}
	n, err := s.Where("file_id = ? AND owner_id = ? AND revision = ?", id, d.OwnerID, revision).
		Cols("revision").Update(&files.DriveFile{Revision: revision + 1})
	if err != nil {
		return nil, err
	}
	if n != 1 {
		return nil, ErrDriveChanged
	}
	d.Revision++
	return d, nil
}

type DriveUsage struct {
	Kind       string `json:"kind" enum:"attachment,task_cover,project_cover,avatar,chat,chat_draft,compass_entry,compass_trash,compass_history,compass_background" doc:"attachment, task_cover, project_cover, avatar, chat (sent AI conversation messages) chat_draft (only unsent AI conversation attachments), or a Compass entry, trash, revision or space background reference."`
	Title      string `json:"title" doc:"Task, project, account or conversation title; empty when restricted."`
	URL        string `json:"url" doc:"Frontend location; empty when restricted."`
	Restricted bool   `json:"restricted" doc:"Something the viewer cannot access uses this file."`
}

// DriveUsages never discloses project/task titles after the owner loses access, and
// lists AI conversations only to their owner. With the AI module linked it takes the
// conversation lock, so it must not be called inside a transaction.
func DriveUsages(s *xorm.Session, a web.Auth, id int64) ([]DriveUsage, error) {
	return driveUsages(s, a, id, true)
}

// DriveUsagesForAPIToken lists usages to an API token, which never reaches AI
// conversations: they appear only as restricted entries.
func DriveUsagesForAPIToken(s *xorm.Session, a web.Auth, id int64) ([]DriveUsage, error) {
	return driveUsages(s, a, id, false)
}

func driveUsages(s *xorm.Session, a web.Auth, id int64, resolveChats bool) ([]DriveUsage, error) {
	usages := []DriveUsage{}
	attachments := []*TaskAttachment{}
	if err := s.Where("file_id = ?", id).Find(&attachments); err != nil {
		return nil, err
	}
	for _, attachment := range attachments {
		task, err := GetTaskByIDSimple(s, attachment.TaskID)
		if err != nil {
			return nil, err
		}
		can, _, err := task.CanRead(s, a)
		if err != nil {
			return nil, err
		}
		usage := DriveUsage{Kind: "attachment", Restricted: !can}
		if can {
			usage.Title = task.Title
			usage.URL = fmt.Sprintf("/tasks/%d", task.ID)
			if task.CoverImageAttachmentID == attachment.ID {
				usage.Kind = "task_cover"
			}
		}
		usages = append(usages, usage)
	}
	projects := []*Project{}
	if err := s.Where("background_file_id = ?", id).Find(&projects); err != nil {
		return nil, err
	}
	for _, p := range projects {
		can, _, err := p.CanRead(s, a)
		if err != nil {
			return nil, err
		}
		usage := DriveUsage{Kind: "project_cover", Restricted: !can}
		if can {
			usage.Title = p.Title
			usage.URL = fmt.Sprintf("/projects/%d", p.ID)
		}
		usages = append(usages, usage)
	}
	avatars := []*user.User{}
	if err := s.Where("avatar_file_id = ?", id).Find(&avatars); err != nil {
		return nil, err
	}
	for _, u := range avatars {
		usage := DriveUsage{Kind: "avatar", Restricted: u.ID != a.GetID()}
		if !usage.Restricted {
			usage.Title = u.Username
			usage.URL = "/user/settings/avatar"
		}
		usages = append(usages, usage)
	}
	compass, err := compassDriveUsages(s, a, id)
	if err != nil {
		return nil, err
	}
	usages = append(usages, compass...)
	chats, err := driveChatUsages(s, a, id, resolveChats)
	if err != nil {
		return nil, err
	}
	return append(usages, chats...), nil
}

type DriveChange struct {
	Revision    int64  `json:"revision" minimum:"1"`
	Action      string `json:"action" enum:"edit,trash,restore,purge"`
	Name        string `json:"name" maxLength:"255"`
	Category    string `json:"category" maxLength:"120"`
	Pinned      bool   `json:"pinned"`
	Confirm     bool   `json:"confirm"`
	ConfirmName string `json:"confirm_name"`

	// Set by PrepareDriveChange.
	prepared    bool
	chatScanned bool
	chatScan    error
}

// PrepareDriveChange runs what a change needs before its transaction exists. A
// confirmed purge scans the AI conversations, which reads them for a while and may
// pin a reference it finds, taking the conversation lock and more pool connections;
// a transaction waiting meanwhile would hold its own connection (and locks). Requests
// that cannot purge the file scan nothing.
func PrepareDriveChange(a web.Auth, id int64, in *DriveChange) {
	in.prepared = true
	if in.Action != "purge" || !in.Confirm {
		return
	}
	s := db.NewReadSession()
	d, err := GetDriveItem(s, a, id)
	_ = s.Close()
	if err != nil || d.TrashedAt.IsZero() || d.Purging || in.ConfirmName != d.File.Name {
		return
	}
	in.chatScan, in.chatScanned = chatDriveScanBlocks(a.GetID(), id), true
}

func ChangeDriveItem(s *xorm.Session, a web.Auth, id int64, in DriveChange) (*files.DriveFile, error) {
	// The scan never runs here: s already holds a pool connection. Without
	// PrepareDriveChange a purge fails closed, unless there are no conversations to scan.
	// A chat reference added after the scan bumps the revision (the CAS below fails) or
	// is a counted pin.
	if !in.prepared && chatDriveBridge == nil {
		in.chatScanned = true
	}
	d, err := LockDriveItem(s, a, id, in.Revision)
	if err != nil {
		return nil, err
	}
	if d.Purging && in.Action != "purge" {
		return nil, ErrDriveTrashed
	}
	switch in.Action {
	case "edit":
		if !d.TrashedAt.IsZero() || d.Purging {
			return nil, ErrDriveTrashed
		}
		name := strings.TrimSpace(in.Name)
		if name == "" || len([]rune(name)) > 255 || len([]rune(in.Category)) > 120 {
			return nil, ErrDriveConfirm
		}
		d.File.Name = name
		d.Category = strings.TrimSpace(in.Category)
		d.Pinned = in.Pinned
		if _, err = s.ID(id).Cols("name").Update(d.File); err != nil {
			return nil, err
		}
	case "trash":
		usages, err := driveUsages(s, a, id, false)
		if err != nil {
			return nil, err
		}
		if len(usages) > 0 && !in.Confirm {
			return nil, ErrDriveConfirm
		}
		d.TrashedAt = time.Now()
	case "restore":
		d.TrashedAt = time.Time{}
	case "purge":
		if d.TrashedAt.IsZero() || !in.Confirm || in.ConfirmName != d.File.Name {
			return nil, ErrDriveConfirm
		}
		// A purge that failed half way was already checked and refuses new references;
		// the blob may be gone, so it is only finished.
		if d.Purging {
			return d, nil
		}
		usages, err := driveUsages(s, a, id, false)
		if err != nil {
			return nil, err
		}
		if len(usages) > 0 {
			return nil, ErrDriveInUse
		}
		// The file only became purgeable after PrepareDriveChange looked at it.
		if !in.chatScanned {
			return nil, ErrDriveChanged
		}
		if in.chatScan != nil {
			return nil, in.chatScan
		}
		if err = d.File.PurgeFromDrive(s); err != nil {
			return nil, err
		}
		d.Purging = true
		return d, nil
	default:
		return nil, ErrDriveConfirm
	}
	_, err = s.Where("file_id = ?", id).Cols("category", "pinned", "trashed_at").Update(d)
	return d, err
}

func AttachDriveFile(s *xorm.Session, a web.Auth, id, revision, taskID int64) (*TaskAttachment, error) {
	d, err := LockDriveItem(s, a, id, revision)
	if err != nil {
		return nil, err
	}
	if !d.TrashedAt.IsZero() || d.Purging {
		return nil, ErrDriveTrashed
	}
	// Chat uploads may exceed files.maxsize; task attachments may not.
	if files.ExceedsUploadLimit(d.File.Size) {
		return nil, files.ErrFileIsTooLarge{Size: d.File.Size}
	}
	ta := &TaskAttachment{TaskID: taskID, FileID: id, CreatedByID: a.GetID(), File: d.File}
	can, err := ta.CanCreate(s, a)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, ErrGenericForbidden{}
	}
	// Choosing an already attached file is idempotent and does not create duplicate references.
	existing := &TaskAttachment{}
	found, err := s.Where("task_id = ? AND file_id = ?", taskID, id).Get(existing)
	if err != nil {
		return nil, err
	}
	if found {
		err = existing.ReadOne(s, a)
		return existing, err
	}
	ta.CreatedBy, err = user.GetFromAuth(a)
	if err != nil {
		return nil, err
	}
	if _, err = s.Insert(ta); err != nil {
		return nil, err
	}
	task, err := GetTaskByIDSimple(s, taskID)
	if err != nil {
		return nil, err
	}
	events.DispatchOnCommit(s, &TaskAttachmentCreatedEvent{Task: &task, Attachment: ta, Doer: ta.CreatedBy})
	return ta, nil
}
