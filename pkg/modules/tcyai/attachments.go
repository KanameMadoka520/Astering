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
	"bytes"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // Register supported image decoders.
	_ "image/jpeg" // Register supported image decoders.
	"image/png"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/log"

	_ "golang.org/x/image/webp" // Register WebP decoding for MIME-independent validation.
)

// Attachments are identified by the SHA-256 of their bytes within one account.
// New uploads live once in the owner's personal drive (drive.go); older uploads are
// encrypted chat files and stay readable. Conversations/forks own references, never
// provider URLs or public file links.
const MaxChatAttachmentBytes = 32 * 1024 * 1024
const maxDraftAttachments = 16

var ErrAttachmentInvalid = errors.New("chatAttachmentInvalid")
var ErrAttachmentMissing = errors.New("chatAttachmentMissing")
var ErrImageModel = errors.New("chatImageModel")

type ChatAttachment struct {
	ID          string `json:"id" doc:"SHA-256 of the original bytes within this account. Authorization also requires a reference in this conversation and, for drive files, ownership."`
	Name        string `json:"name" doc:"Original display filename, never used as a server path."`
	MIME        string `json:"mime" doc:"Server-detected media type."`
	Size        int64  `json:"size" doc:"Original content bytes, excluding encryption overhead."`
	DriveFileID int64  `json:"drive_file_id,omitempty" readOnly:"true" doc:"Personal drive file holding this attachment; absent for older encrypted chat files. Removing the attachment never deletes the drive file."`
	Missing     bool   `json:"missing,omitempty" readOnly:"true" doc:"The referenced file is no longer available."`
}
type ConversationStorage struct {
	RecordBytes     int64 `json:"record_bytes" doc:"Encrypted conversation file bytes, including summaries and durable execution state."`
	AttachmentBytes int64 `json:"attachment_bytes" doc:"Stored bytes of distinct referenced files: older encrypted chat files plus drive files, each counted once."`
	TotalBytes      int64 `json:"total_bytes" doc:"Record plus existing attachments. Shared files also count in other conversations; this is not exclusive disk usage."`
	AttachmentCount int   `json:"attachment_count" doc:"Distinct attachment references, including drafts and missing files."`
	MissingCount    int   `json:"missing_count" doc:"Referenced files no longer available."`
	DriveCount      int   `json:"drive_attachment_count,omitempty" doc:"Distinct available drive files among the attachments."`
	DriveBytes      int64 `json:"drive_attachment_bytes,omitempty" doc:"Part of attachment_bytes kept in the personal drive. Deleting conversations does not free it; manage it in the drive."`
}

func recordOwner(record *conversationFile) int64 { return record.OwnerID }
func attachmentPath(uid int64, id string) (string, error) {
	hash, err := hex.DecodeString(id)
	if err != nil || len(hash) != sha256.Size || id != strings.ToLower(id) || uid <= 0 {
		return "", ErrAttachmentMissing
	}
	return filepath.Join(conversationDir(uid), "attachments", id+".enc"), nil
}
func allAttachments(c Conversation) []ChatAttachment {
	out := append([]ChatAttachment{}, c.DraftAttachments...)
	for _, turn := range c.Turns {
		out = append(out, turn.Attachments...)
	}
	return out
}

// attachmentCandidates lists the distinct stored files behind one content ID. Equal
// IDs mean equal bytes, so any readable candidate serves the attachment.
func attachmentCandidates(c Conversation, id string) []ChatAttachment {
	out := []ChatAttachment{}
	for _, a := range allAttachments(c) {
		if a.ID == id && !slices.ContainsFunc(out, func(b ChatAttachment) bool { return b.DriveFileID == a.DriveFileID }) {
			out = append(out, a)
		}
	}
	return out
}
func decorateAttachments(uid int64, c *Conversation) {
	decorateAttachmentsWithHistory(uid, c, nil)
}

// history contributes references to storage totals without cloning its results or
// mutating saved attachment flags. File metadata is read once per distinct stored
// file, and drive files with one batched, briefly cached query. Equal IDs are equal
// bytes, so like a download an attachment is missing only when no stored copy of its
// ID is left.
func decorateAttachmentsWithHistory(uid int64, c *Conversation, history []ChatTurn) {
	stats := &ConversationStorage{}
	if p, err := conversationPath(uid, c.ID); err == nil {
		if info, err := os.Stat(p); err == nil {
			stats.RecordBytes = info.Size()
		}
	}
	each := func(withHistory bool, fn func(*ChatAttachment)) {
		for i := range c.DraftAttachments {
			fn(&c.DraftAttachments[i])
		}
		for i := range c.Turns {
			for j := range c.Turns[i].Attachments {
				fn(&c.Turns[i].Attachments[j])
			}
		}
		if withHistory {
			for _, turn := range history {
				for _, attachment := range turn.Attachments {
					fn(&attachment)
				}
			}
		}
	}
	var driveIDs []int64
	each(true, func(a *ChatAttachment) {
		if a.DriveFileID > 0 {
			driveIDs = append(driveIDs, a.DriveFileID)
		}
	})
	drive, err := driveStats(uid, driveIDs, true)
	if err != nil {
		// Unknown is not missing: never flag files because the database is unavailable.
		log.Debugf("Could not check drive attachments of user %d: %s", uid, err)
		drive = nil
	}
	type storedFile struct {
		drive int64
		id    string
	}
	seen := map[storedFile]bool{}
	available := map[string]bool{}
	absent := []string{}
	each(true, func(a *ChatAttachment) {
		key := storedFile{drive: a.DriveFileID}
		if a.DriveFileID <= 0 {
			key.id = a.ID
		}
		if seen[key] {
			return
		}
		seen[key] = true
		stats.AttachmentCount++
		missing := false
		if a.DriveFileID > 0 {
			st, found := drive[a.DriveFileID]
			missing = drive != nil && !driveStatUsable(st, found, *a)
			if !missing && found {
				stats.AttachmentBytes += a.Size
				stats.DriveBytes += a.Size
				stats.DriveCount++
			}
		} else {
			path, err := attachmentPath(uid, a.ID)
			if err == nil {
				var info os.FileInfo
				if info, err = os.Stat(path); err == nil {
					stats.AttachmentBytes += info.Size()
				}
			}
			missing = err != nil
		}
		if missing {
			absent = append(absent, a.ID)
		} else {
			available[a.ID] = true
		}
	})
	for _, id := range absent {
		if !available[id] {
			stats.MissingCount++
		}
	}
	each(false, func(a *ChatAttachment) { a.Missing = !available[a.ID] })
	stats.TotalBytes = stats.RecordBytes + stats.AttachmentBytes
	c.Storage = stats
}

// readAttachment reads an older encrypted chat file.
func readAttachment(uid int64, id string) ([]byte, error) {
	if accountDeleted(uid) {
		return nil, ErrAccountDeleted
	}
	path, err := attachmentPath(uid, id)
	if err != nil {
		return nil, err
	}
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, ErrAttachmentMissing
	}
	if err != nil {
		return nil, err
	}
	a, err := aead()
	if err != nil {
		return nil, err
	}
	if len(data) < a.NonceSize() {
		return nil, ErrAttachmentMissing
	}
	return a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], []byte(fmt.Sprintf("attachment:%d:%s", uid, id)))
}

// readChatAttachment reads either storage. uid is the conversation owner, never a
// value taken from the attachment itself.
func readChatAttachment(uid int64, a ChatAttachment) ([]byte, error) {
	if a.DriveFileID > 0 {
		return readDriveAttachment(uid, a)
	}
	return readAttachment(uid, a.ID)
}

// checkChatAttachment confirms availability. Older files are decrypted (authenticated)
// as before; drive files are checked in the database and verified when read.
func checkChatAttachment(uid int64, a ChatAttachment, cached bool) error {
	if a.DriveFileID > 0 {
		return checkDriveAttachment(uid, a, cached)
	}
	_, err := readAttachment(uid, a.ID)
	return err
}
func isChatImage(mime string) bool {
	return slices.Contains([]string{"image/png", "image/jpeg", "image/gif", "image/webp"}, mime)
}
func cleanChatFilename(name string) (string, bool) {
	name = filepath.Base(strings.ReplaceAll(name, "\\", "/"))
	name = strings.Map(cleanFilenameRune, name)
	return name, name != "" && name != "." && name != "/" && len([]rune(name)) <= 255
}

// chatAttachmentFromBytes applies the checks every chat attachment gets, whatever its
// source: size, media type detected from the bytes, a full image decode and a
// printable filename.
func chatAttachmentFromBytes(name string, data []byte) (ChatAttachment, error) {
	if len(data) == 0 || len(data) > MaxChatAttachmentBytes {
		return ChatAttachment{}, ErrAttachmentInvalid
	}
	mime := http.DetectContentType(data)
	if isChatImage(mime) && !validChatImage(data) {
		return ChatAttachment{}, ErrAttachmentInvalid
	}
	name, ok := cleanChatFilename(name)
	if !ok {
		return ChatAttachment{}, ErrAttachmentInvalid
	}
	sum := sha256.Sum256(data)
	return ChatAttachment{ID: hex.EncodeToString(sum[:]), Name: name, MIME: mime, Size: int64(len(data))}, nil
}

// draftMatchLocked finds a draft holding the same drive file or the same bytes. It is
// reusable while available; an unavailable match is replaced in place.
func draftMatchLocked(uid int64, record *conversationFile, id string, fileID int64) (int, bool) {
	for i, a := range record.DraftAttachments {
		if (fileID > 0 && a.DriveFileID == fileID) || (id != "" && a.ID == id) {
			return i, checkChatAttachment(uid, a, false) == nil
		}
	}
	return -1, false
}

// precheckDraft rejects requests that cannot succeed before any file is stored or read.
func precheckDraft(uid int64, cid, id string, fileID int64) (ChatAttachment, bool, error) {
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, cid)
	if err != nil {
		return ChatAttachment{}, false, err
	}
	if live := conversations.live[liveKey(uid, cid)]; live != nil {
		return ChatAttachment{}, false, ErrConversationBusy
	}
	index, reusable := draftMatchLocked(uid, record, id, fileID)
	if reusable {
		return record.DraftAttachments[index], true, nil
	}
	if index < 0 && len(record.DraftAttachments) >= maxDraftAttachments {
		return ChatAttachment{}, false, ErrAttachmentInvalid
	}
	return ChatAttachment{}, false, nil
}

// addDriveDraft pins the drive file and saves the draft reference in one critical
// section, so the pin always precedes the saved reference.
func addDriveDraft(uid int64, cid string, item ChatAttachment) (ChatAttachment, error) {
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, cid)
	if err != nil {
		return ChatAttachment{}, err
	}
	if live := conversations.live[liveKey(uid, cid)]; live != nil {
		return ChatAttachment{}, ErrConversationBusy
	}
	index, reusable := draftMatchLocked(uid, record, item.ID, item.DriveFileID)
	if reusable {
		return record.DraftAttachments[index], nil
	}
	if index < 0 && len(record.DraftAttachments) >= maxDraftAttachments {
		return ChatAttachment{}, ErrAttachmentInvalid
	}
	if err = pinDriveFileLocked(uid, cid, item.DriveFileID); err != nil {
		return ChatAttachment{}, err
	}
	replaced := []ChatAttachment{}
	if index >= 0 {
		replaced = append(replaced, record.DraftAttachments[index])
		record.DraftAttachments[index] = item
	} else {
		record.DraftAttachments = append(record.DraftAttachments, item)
	}
	record.Updated = time.Now().UTC()
	if err = writeConversation(uid, record); err != nil {
		logDriveRefError(uid, reconcileDriveRefsLocked(uid, []int64{item.DriveFileID}))
		return ChatAttachment{}, err
	}
	cleanupAttachments(uid, replaced)
	return item, nil
}

// UploadChatAttachment stores a new upload once in the owner's personal drive and
// references it from the conversation draft. Uploading identical bytes again is
// idempotent and stores nothing new.
func UploadChatAttachment(uid int64, cid, name string, body io.Reader) (ChatAttachment, error) {
	data, err := io.ReadAll(io.LimitReader(body, MaxChatAttachmentBytes+1))
	if err != nil {
		return ChatAttachment{}, err
	}
	item, err := chatAttachmentFromBytes(name, data)
	if err != nil {
		return ChatAttachment{}, err
	}
	if existing, done, err := precheckDraft(uid, cid, item.ID, 0); err != nil || done {
		return existing, err
	}
	// The blob is written outside the conversation lock; it is pinned under the lock.
	fileID, err := storeDriveUpload(uid, item.Name, data)
	if err != nil {
		return ChatAttachment{}, err
	}
	item.DriveFileID = fileID
	added, err := addDriveDraft(uid, cid, item)
	if err != nil || added.DriveFileID != fileID {
		discardNewDriveUpload(uid, fileID)
	}
	return added, err
}

// AttachDriveFileToConversation references an existing drive file of the owner from
// the conversation draft without copying it. Choosing a file already in the draft is
// idempotent. The bytes get the same checks as an upload.
func AttachDriveFileToConversation(uid int64, cid string, fileID int64) (ChatAttachment, error) {
	if fileID <= 0 {
		return ChatAttachment{}, ErrAttachmentMissing
	}
	if existing, done, err := precheckDraft(uid, cid, "", fileID); err != nil || done {
		return existing, err
	}
	name, data, err := loadDriveFileForChat(uid, fileID)
	if err != nil {
		return ChatAttachment{}, err
	}
	if _, ok := cleanChatFilename(name); !ok {
		name = "attachment"
	}
	item, err := chatAttachmentFromBytes(name, data)
	if err != nil {
		return ChatAttachment{}, err
	}
	item.DriveFileID = fileID
	return addDriveDraft(uid, cid, item)
}

// DownloadChatAttachment authorizes against the conversation under its lock and reads
// outside it, so a large or remote file never blocks other conversations.
func DownloadChatAttachment(uid int64, cid, id string) (ChatAttachment, []byte, error) {
	conversations.Lock()
	record, err := getConversationLocked(uid, cid)
	var candidates []ChatAttachment
	if err == nil {
		candidates = attachmentCandidates(record.Conversation, id)
	}
	conversations.Unlock()
	if err != nil {
		return ChatAttachment{}, nil, err
	}
	if len(candidates) == 0 {
		return ChatAttachment{}, nil, ErrAttachmentMissing
	}
	err = ErrAttachmentMissing
	for _, a := range candidates {
		data, readErr := readChatAttachment(uid, a)
		if readErr == nil {
			return a, data, nil
		}
		if !errors.Is(readErr, ErrAttachmentMissing) {
			err = readErr
		}
	}
	return candidates[0], nil, err
}

// RemoveChatDraftAttachment only removes the draft reference. A drive file always
// stays in the drive; an older encrypted file is deleted once nothing references it.
func RemoveChatDraftAttachment(uid int64, cid, id string) error {
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, cid)
	if err != nil {
		return err
	}
	if live := conversations.live[liveKey(uid, cid)]; live != nil {
		return ErrConversationBusy
	}
	index := slices.IndexFunc(record.DraftAttachments, func(a ChatAttachment) bool { return a.ID == id })
	if index < 0 {
		return ErrAttachmentMissing
	}
	old := record.DraftAttachments[index]
	record.DraftAttachments = slices.Delete(record.DraftAttachments, index, index+1)
	if err = writeConversation(uid, record); err != nil {
		return err
	}
	cleanupAttachments(uid, []ChatAttachment{old})
	return nil
}

// cleanupAttachments runs under the conversation lock after references were removed.
// Drive files are never deleted here; only their pins are verified again, conversation
// by conversation. Older encrypted files are shared by content ID across branches, so
// one unreadable conversation keeps all of them.
func cleanupAttachments(uid int64, candidates []ChatAttachment) {
	driveIDs := []int64{}
	legacy := []ChatAttachment{}
	for _, a := range candidates {
		if a.DriveFileID > 0 {
			driveIDs = append(driveIDs, a.DriveFileID)
		} else {
			legacy = append(legacy, a)
		}
	}
	if len(driveIDs) > 0 {
		logDriveRefError(uid, reconcileDriveRefsLocked(uid, driveIDs))
	}
	if len(legacy) == 0 {
		return
	}
	entries, err := os.ReadDir(conversationDir(uid))
	if err != nil {
		return
	}
	referenced := map[string]bool{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".enc") {
			continue
		}
		record, err := getConversationLocked(uid, strings.TrimSuffix(entry.Name(), ".enc"))
		if err != nil {
			return
		}
		for _, a := range allAttachments(record.Conversation) {
			referenced[a.ID] = true
		}
	}
	for _, a := range legacy {
		if !referenced[a.ID] {
			if path, err := attachmentPath(uid, a.ID); err == nil {
				_ = os.Remove(path)
			}
		}
	}
}
func resolveTurnAttachments(uid int64, record *conversationFile, ids []string, c Connection) ([]ChatAttachment, error) {
	if len(ids) > maxDraftAttachments {
		return nil, ErrAttachmentInvalid
	}
	out := []ChatAttachment{}
	seen := map[string]bool{}
	for _, id := range ids {
		if seen[id] {
			continue
		}
		seen[id] = true
		candidates := attachmentCandidates(record.Conversation, id)
		chosen := -1
		err := ErrAttachmentMissing
		for i, a := range candidates {
			checkErr := checkChatAttachment(uid, a, false)
			if checkErr == nil {
				chosen = i
				break
			}
			if !errors.Is(checkErr, ErrAttachmentMissing) {
				err = checkErr
			}
		}
		if chosen < 0 {
			return nil, err
		}
		a := candidates[chosen]
		if isChatImage(a.MIME) && !slices.Contains(c.Capabilities().InputTypes, "image") {
			return nil, ErrImageModel
		}
		out = append(out, a)
	}
	return out, nil
}

type imagePayload struct{ MIME, Data string }

func (p imagePayload) dataURL() string { return "data:" + p.MIME + ";base64," + p.Data }
func hydrateMessages(c Connection, messages []Message) ([]Message, error) {
	out := append([]Message{}, messages...)
	// Equal IDs are equal bytes: like a download, an entry whose stored file is gone is
	// served by another stored copy of the same ID in this context.
	type ownedID struct {
		owner int64
		id    string
	}
	copies := map[ownedID][]ChatAttachment{}
	for _, m := range out {
		for _, a := range m.Attachments {
			key := ownedID{m.AttachmentOwner, a.ID}
			copies[key] = append(copies[key], a)
		}
	}
	read := func(owner int64, a ChatAttachment) ([]byte, error) {
		data, err := readChatAttachment(owner, a)
		if !errors.Is(err, ErrAttachmentMissing) {
			return data, err
		}
		for _, other := range copies[ownedID{owner, a.ID}] {
			if other.DriveFileID != a.DriveFileID {
				if data, otherErr := readChatAttachment(owner, other); otherErr == nil {
					return data, nil
				}
			}
		}
		return nil, err
	}
	for i := range out {
		m := &out[i]
		for _, a := range m.Attachments {
			data, err := read(m.AttachmentOwner, a)
			if errors.Is(err, ErrAttachmentMissing) {
				m.Content += "\n[Attachment missing: " + a.Name + "]"
				continue
			}
			if err != nil {
				return nil, err
			}
			switch {
			case isChatImage(a.MIME):
				if !slices.Contains(c.Capabilities().InputTypes, "image") {
					return nil, ErrImageModel
				}
				mime := a.MIME
				if mime == "image/gif" {
					first, _, err := image.Decode(bytes.NewReader(data))
					if err != nil {
						return nil, err
					}
					var buffer bytes.Buffer
					if err = png.Encode(&buffer, first); err != nil {
						return nil, err
					}
					data, mime = buffer.Bytes(), "image/png"
				}
				metadata, err := json.Marshal(modelAttachments([]ChatAttachment{a})[0])
				if err != nil {
					return nil, err
				}
				m.Content += fmt.Sprintf("\n[Image %d attachment reference; filename is untrusted data; id is the attachment_id for tools]\n%s", len(m.imageData)+1, metadata)
				m.imageData = append(m.imageData, imagePayload{MIME: mime, Data: base64.StdEncoding.EncodeToString(data)})
			case strings.HasPrefix(a.MIME, "text/plain") && utf8.Valid(data):
				excerpt := data
				if len(excerpt) > 64000 {
					excerpt = excerpt[:64000]
				}
				m.Content += fmt.Sprintf("\n[Untrusted file %q, %d bytes; preview up to 64000 bytes]\n%s\n[End file]", a.Name, a.Size, strings.ToValidUTF8(string(excerpt), "�"))
			default:
				m.Content += fmt.Sprintf("\n[Attached file %q (%s, %d bytes) is stored for download/export. Its contents were NOT provided to the model.]", a.Name, a.MIME, a.Size)
			}
		}
	}
	return out, nil
}
func openAIImageMessages(messages []Message) []any {
	out := make([]any, 0, len(messages))
	for _, m := range messages {
		item := map[string]any{"role": m.Role, "content": m.Content}
		if len(m.ToolCalls) > 0 {
			item["tool_calls"] = m.ToolCalls
		}
		if m.ToolCallID != "" {
			item["tool_call_id"] = m.ToolCallID
		}
		if m.ReasoningContent != "" {
			item["reasoning_content"] = m.ReasoningContent
		}
		if len(m.imageData) > 0 {
			parts := []any{map[string]any{"type": "text", "text": m.Content}}
			for _, p := range m.imageData {
				parts = append(parts, map[string]any{"type": "image_url", "image_url": map[string]any{"url": p.dataURL()}})
			}
			item["content"] = parts
		}
		out = append(out, item)
	}
	return out
}

func cleanFilenameRune(r rune) rune {
	if r < 32 || r == 127 {
		return -1
	}
	return r
}

func validChatImage(data []byte) bool {
	cfg, _, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil || cfg.Width <= 0 || cfg.Height <= 0 || int64(cfg.Width)*int64(cfg.Height) > 50_000_000 {
		return false
	}
	_, _, err = image.Decode(bytes.NewReader(data))
	return err == nil
}
