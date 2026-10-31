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
	"net/url"
	"slices"
	"time"

	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

// ChatDriveBridge connects drive usage checks to private AI conversations. They live
// in encrypted files this package can neither read nor import, so the AI module
// installs the bridge at init. Without it only the database pins are consulted.
type ChatDriveBridge interface {
	// Usages verifies the owner's pins for fileID against the saved conversations,
	// prunes pins proven stale and returns titled usages. It takes the conversation
	// lock and may write, so it must never be called inside a database transaction.
	Usages(ownerID, fileID int64) ([]DriveUsage, error)
	// Referenced scans the owner's saved conversations for the file and pins the
	// conversations that reference it. It is the safety net for a reference that was
	// never pinned; it takes the conversation lock and pool connections to pin, so
	// callers must not hold an open transaction.
	Referenced(ownerID, fileID int64) (bool, error)
}

var chatDriveBridge ChatDriveBridge

// SetChatDriveBridge installs the AI conversation bridge and returns the previous one.
func SetChatDriveBridge(b ChatDriveBridge) ChatDriveBridge {
	previous := chatDriveBridge
	chatDriveBridge = b
	return previous
}

// ChatDriveUsageURL is the frontend location of a private AI conversation.
func ChatDriveUsageURL(conversationID string) string {
	return "/ai?chat=" + url.QueryEscape(conversationID)
}

// Keeps IN lists below every supported database's bound-parameter limit.
func driveIDChunks(ids []int64) [][]int64 {
	chunks := [][]int64{}
	for len(ids) > 0 {
		n := min(len(ids), 500)
		chunks = append(chunks, ids[:n])
		ids = ids[n:]
	}
	return chunks
}

// touchDriveItems starts a transaction with a write on the owner's drive rows, so
// the database serializes it with trash and purge by waiting for their locks (SQLite
// fails a later read-to-write upgrade at once instead). The revision bump makes usage
// lists and confirmations shown before this reference stale.
func touchDriveItems(s *xorm.Session, ownerID int64, ids []int64) (int64, error) {
	var touched int64
	for _, chunk := range driveIDChunks(ids) {
		n, err := s.Where("owner_id = ?", ownerID).In("file_id", chunk).Cols("revision").Incr("revision").Update(&files.DriveFile{})
		if err != nil {
			return 0, err
		}
		touched += n
	}
	return touched, nil
}

// ReferenceDriveFileForChat pins an active drive file owned by ownerID for a private
// AI conversation, so a later trash or purge has to be confirmed again against this
// reference. On error the caller rolls back.
func ReferenceDriveFileForChat(s *xorm.Session, ownerID int64, conversationID string, fileID int64) (*files.DriveFile, error) {
	touched, err := touchDriveItems(s, ownerID, []int64{fileID})
	if err != nil {
		return nil, err
	}
	if touched == 0 {
		return nil, ErrDriveMissing
	}
	d, err := GetDriveItem(s, &user.User{ID: ownerID}, fileID)
	if err != nil {
		return nil, err
	}
	if d.InTrash() || d.Purging {
		return nil, ErrDriveTrashed
	}
	return d, pinDriveChatReferences(s, ownerID, conversationID, []int64{fileID})
}

// PinDriveChatReferences records that a conversation may reference the owner's drive
// files, whatever their state: a new branch keeps what its parent references. IDs
// that are not in the owner's drive are skipped, so a conversation can never pin, and
// thereby block deletion of, another account's file.
func PinDriveChatReferences(s *xorm.Session, ownerID int64, conversationID string, fileIDs []int64) error {
	if ownerID <= 0 || conversationID == "" || len(fileIDs) == 0 {
		return nil
	}
	if _, err := touchDriveItems(s, ownerID, fileIDs); err != nil {
		return err
	}
	return pinDriveChatReferences(s, ownerID, conversationID, fileIDs)
}

func pinDriveChatReferences(s *xorm.Session, ownerID int64, conversationID string, fileIDs []int64) error {
	for _, chunk := range driveIDChunks(fileIDs) {
		owned := []int64{}
		if err := s.Table(&files.DriveFile{}).Where("owner_id = ?", ownerID).In("file_id", chunk).Cols("file_id").Find(&owned); err != nil {
			return err
		}
		if len(owned) == 0 {
			continue
		}
		pinned := []int64{}
		if err := s.Table(&files.DriveChatRef{}).Where("owner_id = ? AND conversation_id = ?", ownerID, conversationID).In("file_id", owned).Cols("file_id").Find(&pinned); err != nil {
			return err
		}
		for _, id := range owned {
			if slices.Contains(pinned, id) {
				continue
			}
			if _, err := s.Insert(&files.DriveChatRef{OwnerID: ownerID, ConversationID: conversationID, FileID: id}); err != nil {
				return err
			}
			pinned = append(pinned, id)
		}
	}
	return nil
}

// DriveChatReferences returns the owner's pins for the given files.
func DriveChatReferences(s *xorm.Session, ownerID int64, fileIDs []int64) ([]*files.DriveChatRef, error) {
	refs := []*files.DriveChatRef{}
	for _, chunk := range driveIDChunks(fileIDs) {
		part := []*files.DriveChatRef{}
		if err := s.Where("owner_id = ?", ownerID).In("file_id", chunk).OrderBy("id").Find(&part); err != nil {
			return nil, err
		}
		refs = append(refs, part...)
	}
	return refs, nil
}

// DeleteDriveChatReferences removes pins by row ID. Callers hold the AI conversation
// lock and have verified that the saved conversations no longer reference the files.
func DeleteDriveChatReferences(s *xorm.Session, ownerID int64, ids []int64) error {
	for _, chunk := range driveIDChunks(ids) {
		if _, err := s.Where("owner_id = ?", ownerID).In("id", chunk).Delete(&files.DriveChatRef{}); err != nil {
			return err
		}
	}
	return nil
}

// Pins of the viewer are listed through the bridge when resolve is set, which titles
// them after pruning stale pins. Otherwise every pin, stale or not, is counted as a
// restricted usage: transactions (trash, purge) only count, which only ever keeps a
// file, and API tokens never see conversations.
func driveChatUsages(s *xorm.Session, a web.Auth, id int64, resolve bool) ([]DriveUsage, error) {
	refs := []*files.DriveChatRef{}
	if err := s.Where("file_id = ?", id).OrderBy("id").Find(&refs); err != nil {
		return nil, err
	}
	viewer := a.GetID()
	bridged := resolve && chatDriveBridge != nil
	usages := []DriveUsage{}
	own := false
	for _, ref := range refs {
		if ref.OwnerID == viewer {
			own = true
			if bridged {
				continue
			}
		}
		usage := DriveUsage{Kind: "chat", Restricted: ref.OwnerID != viewer || !resolve}
		if !usage.Restricted {
			usage.URL = ChatDriveUsageURL(ref.ConversationID)
		}
		usages = append(usages, usage)
	}
	if own && bridged {
		resolved, err := chatDriveBridge.Usages(viewer, id)
		if err != nil {
			return nil, err
		}
		usages = append(resolved, usages...)
	}
	return usages, nil
}

// Pins are authoritative for usage lists; this scan additionally catches (and pins) a
// chat reference that was never pinned. Any scan failure keeps the file. It reads
// conversations for a while and may take the conversation lock and pool connections,
// so callers run it before opening their transaction: no connection, row lock or
// SQLite database lock is held meanwhile.
func chatDriveScanBlocks(ownerID, fileID int64) error {
	if chatDriveBridge == nil {
		return nil
	}
	used, err := chatDriveBridge.Referenced(ownerID, fileID)
	if err != nil {
		log.Warningf("Keeping drive file %d: AI conversations of user %d could not be scanned: %s", fileID, ownerID, err)
		return ErrDriveChatUnreadable
	}
	if used {
		return ErrDriveInUse
	}
	return nil
}

// ScanDriveChats is the AI conversation scan DiscardUnusedDriveFile needs. Run it
// before opening the session (see chatDriveScanBlocks).
func ScanDriveChats(ownerID, fileID int64) error {
	return chatDriveScanBlocks(ownerID, fileID)
}

// DiscardUnusedDriveFile purges a drive file the current request created but could
// not reference, for example a chat upload whose conversation changed meanwhile. The
// file is kept when the owner already changed it or anything uses it, including an
// unpinned AI conversation (chatScan, from ScanDriveChats). It must be the session's
// first work. A true result must be finished with files.FinishDrivePurge after the
// session commits; if that fails, the file waits in the recycle bin, where purging it
// again finishes the job.
func DiscardUnusedDriveFile(s *xorm.Session, a web.Auth, id int64, chatScan error) (bool, error) {
	if chatScan != nil {
		if errors.Is(chatScan, ErrDriveInUse) {
			return false, nil
		}
		return false, chatScan
	}
	touched, err := touchDriveItems(s, a.GetID(), []int64{id})
	if err != nil {
		return false, err
	}
	if touched == 0 {
		return false, ErrDriveMissing
	}
	d, err := GetDriveItem(s, a, id)
	if err != nil {
		return false, err
	}
	if d.Purging {
		return true, nil
	}
	if d.InTrash() || d.Pinned || d.Category != "" {
		return false, nil
	}
	usages, err := driveUsages(s, a, id, false)
	if err != nil || len(usages) > 0 {
		return false, err
	}
	_, err = s.Where("file_id = ?", id).Cols("trashed_at", "purging").Update(&files.DriveFile{TrashedAt: time.Now(), Purging: true})
	return err == nil, err
}
