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
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
)

// These ceilings bound an inventory request. Incomplete results are lower bounds,
// never evidence that the unvisited files are empty or safe to delete.
const personalStorageEntryLimit = 100000
const personalStorageListByteLimit = 256 * 1024 * 1024
const personalStorageRecordByteLimit = 256*1024*1024 + 1024

var ErrStorageConversationChanged = errors.New("storage_conversation_changed")
var ErrStorageConversationConfirm = errors.New("storage_conversation_confirm")
var errStoragePathUnsafe = errors.New("private storage path is not a regular owned path")

type PersonalStorage struct {
	ConversationCount     int64 `json:"conversation_count" required:"true" doc:"Canonical encrypted conversation records owned by the current account."`
	ConversationBytes     int64 `json:"conversation_bytes" required:"true" doc:"Conversation ciphertext lengths, counted once per record."`
	LegacyAttachmentCount int64 `json:"legacy_attachment_count" required:"true" doc:"Canonical legacy encrypted attachment files, counted once regardless of branches."`
	LegacyAttachmentBytes int64 `json:"legacy_attachment_bytes" required:"true" doc:"Independent encrypted legacy attachment lengths; excludes Drive originals."`
	SettingsBytes         int64 `json:"settings_bytes" required:"true" doc:"Model and MCP encrypted settings lengths, metadata only and not a cleanup target."`
	Complete              bool  `json:"complete" required:"true" doc:"False means metadata counts and bytes are lower bounds, not zero usage."`
}

type StorageConversation struct {
	ID                string    `json:"id" required:"true" doc:"Conversation UUID within the current account."`
	Title             string    `json:"title" required:"true" doc:"Title of the current account's conversation; no message text is returned."`
	Revision          string    `json:"revision" required:"true" doc:"Opaque version of the encrypted record; deletion rejects stale versions."`
	Bytes             int64     `json:"bytes" required:"true" doc:"Encrypted conversation record bytes only; Drive attachments are retained after deleting the conversation."`
	Updated           time.Time `json:"updated" required:"true" doc:"Last saved conversation activity."`
	Archived          bool      `json:"archived" required:"true" doc:"Whether this conversation is archived, which does not free disk space."`
	Pinned            bool      `json:"pinned" required:"true" doc:"Whether the owner pinned this conversation."`
	Running           bool      `json:"running" required:"true" doc:"A live model execution or compaction owns this conversation; deletion is blocked."`
	Compacting        bool      `json:"compacting" required:"true" doc:"A live context compaction is active in this conversation."`
	AttachmentCount   int       `json:"attachment_count" required:"true" doc:"Distinct visible attachment content IDs, including drafts; attachments can be shared by other conversations."`
	SharedAttachments bool      `json:"shared_attachments" required:"true" doc:"Referenced attachment bytes are not exclusive to this record and are not added to its reclaimable bytes."`
}

type StorageConversationQuery struct {
	Page    int
	PerPage int
	Q       string
	Scope   string
	SortBy  string
	OrderBy string
	Running string
}

type StorageConversationPage struct {
	Items           []StorageConversation `json:"items" required:"true"`
	Total           int64                 `json:"total" required:"true"`
	Page            int                   `json:"page" required:"true"`
	PerPage         int                   `json:"per_page" required:"true"`
	TotalPages      int64                 `json:"total_pages" required:"true"`
	Complete        bool                  `json:"complete" required:"true" doc:"False means the list is a partial inventory; unreadable or unvisited records are not deletable from it."`
	UnreadableCount int                   `json:"unreadable_count" required:"true" doc:"Unreadable or unsafe canonical entries that were skipped, never treated as reclaimable files."`
}

type StorageConversationDeleteResult struct {
	FreedBytes int64 `json:"freed_bytes" required:"true" doc:"Confirmed deleted conversation-record bytes only; excludes shared Drive files and best-effort legacy attachment cleanup."`
}

type personalStorageRoots struct {
	ai      *os.Root
	account *os.Root
}

func storageChildRoot(parent *os.Root, name string) (*os.Root, error) {
	before, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return nil, errStoragePathUnsafe
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	after, err := root.Stat(".")
	if err != nil || !os.SameFile(before, after) {
		_ = root.Close()
		return nil, errStoragePathUnsafe
	}
	return root, nil
}

func openPersonalStorage(uid int64) (*personalStorageRoots, error) {
	if uid <= 0 || accountDeleted(uid) {
		return nil, ErrAccountDeleted
	}
	base, err := os.OpenRoot(config.FilesBasePath.GetString())
	if err != nil {
		return nil, err
	}
	defer base.Close()
	roots := &personalStorageRoots{}
	roots.ai, err = storageChildRoot(base, ".tcymc-ai")
	if errors.Is(err, os.ErrNotExist) {
		return roots, nil
	}
	if err != nil {
		return nil, err
	}
	conversationsRoot, err := storageChildRoot(roots.ai, "conversations")
	if errors.Is(err, os.ErrNotExist) {
		return roots, nil
	}
	if err == nil {
		defer conversationsRoot.Close()
		roots.account, err = storageChildRoot(conversationsRoot, strconv.FormatInt(uid, 10))
	}
	if errors.Is(err, os.ErrNotExist) {
		return roots, nil
	}
	if err != nil {
		roots.close()
		return nil, err
	}
	return roots, nil
}

func (r *personalStorageRoots) close() {
	if r.account != nil {
		_ = r.account.Close()
	}
	if r.ai != nil {
		_ = r.ai.Close()
	}
}

func storageRegularSize(root *os.Root, name string) (int64, bool) {
	if root == nil {
		return 0, true
	}
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return 0, true
	}
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.Size(), true
}

func storageConversationName(name string) bool {
	id := strings.TrimSuffix(name, ".enc")
	parsed, err := uuid.Parse(id)
	return strings.HasSuffix(name, ".enc") && err == nil && parsed.String() == id
}

func storageAttachmentName(name string) bool {
	if len(name) != sha256.Size*2+4 || !strings.HasSuffix(name, ".enc") {
		return false
	}
	id := strings.TrimSuffix(name, ".enc")
	data, err := hex.DecodeString(id)
	return err == nil && len(data) == sha256.Size && id == strings.ToLower(id)
}

// visitStorage enumerates bounded batches and never follows a directory entry.
// Returning false from visit stops the scan and marks it incomplete.
func visitStorage(ctx context.Context, root *os.Root, remaining *int, visit func(string, os.FileInfo) bool) bool {
	if root == nil {
		return true
	}
	dir, err := root.Open(".")
	if err != nil {
		return false
	}
	defer dir.Close()
	complete := true
	for {
		if ctx.Err() != nil || *remaining <= 0 {
			return false
		}
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			if ctx.Err() != nil || *remaining <= 0 {
				return false
			}
			*remaining--
			info, statErr := root.Lstat(entry.Name())
			if errors.Is(statErr, os.ErrNotExist) {
				continue
			}
			if statErr != nil {
				complete = false
				continue
			}
			if !visit(entry.Name(), info) {
				return false
			}
		}
		if errors.Is(readErr, io.EOF) {
			return complete
		}
		if readErr != nil {
			return false
		}
	}
}

// GetPersonalStorage only stats canonical files. It never decrypts conversation,
// model or MCP settings and never counts the same legacy attachment per branch.
func GetPersonalStorage(ctx context.Context, uid int64) (PersonalStorage, error) {
	result := PersonalStorage{Complete: true}
	roots, err := openPersonalStorage(uid)
	if err != nil {
		return result, err
	}
	defer roots.close()
	var complete bool
	result.SettingsBytes, complete = storageRegularSize(roots.ai, strconv.FormatInt(uid, 10)+".enc")
	result.Complete = complete
	mcpBytes, complete := storageRegularSize(roots.account, ".mcp-settings")
	result.SettingsBytes += mcpBytes
	result.Complete = result.Complete && complete
	remaining := personalStorageEntryLimit
	complete = visitStorage(ctx, roots.account, &remaining, func(name string, info os.FileInfo) bool {
		if storageConversationName(name) {
			if !info.Mode().IsRegular() {
				result.Complete = false
				return true
			}
			result.ConversationCount++
			result.ConversationBytes += info.Size()
		}
		return true
	})
	result.Complete = result.Complete && complete
	if roots.account == nil {
		result.Complete = result.Complete && ctx.Err() == nil
		return result, nil
	}
	attachments, err := storageChildRoot(roots.account, "attachments")
	if errors.Is(err, os.ErrNotExist) {
		return result, nil
	}
	if err != nil {
		result.Complete = false
		return result, nil
	}
	defer attachments.Close()
	complete = visitStorage(ctx, attachments, &remaining, func(name string, info os.FileInfo) bool {
		if storageAttachmentName(name) {
			if !info.Mode().IsRegular() {
				result.Complete = false
				return true
			}
			result.LegacyAttachmentCount++
			result.LegacyAttachmentBytes += info.Size()
		}
		return true
	})
	result.Complete = result.Complete && complete
	result.Complete = result.Complete && ctx.Err() == nil
	return result, nil
}

func readStorageRecord(root *os.Root, uid int64, id string) (*conversationFile, []byte, error) {
	if accountDeleted(uid) {
		return nil, nil, ErrAccountDeleted
	}
	if root == nil || !storageConversationName(id+".enc") {
		return nil, nil, ErrConversationMissing
	}
	name := id + ".enc"
	before, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil, ErrConversationMissing
	}
	if err != nil {
		return nil, nil, err
	}
	if !before.Mode().IsRegular() || before.Size() > personalStorageRecordByteLimit {
		return nil, nil, errStoragePathUnsafe
	}
	f, err := root.Open(name)
	if err != nil {
		return nil, nil, err
	}
	defer f.Close()
	after, err := f.Stat()
	if err != nil || !os.SameFile(before, after) {
		return nil, nil, ErrStorageConversationChanged
	}
	raw, err := io.ReadAll(io.LimitReader(f, personalStorageRecordByteLimit+1))
	if err != nil {
		return nil, nil, err
	}
	if len(raw) > personalStorageRecordByteLimit {
		return nil, nil, errStoragePathUnsafe
	}
	aead, err := aead()
	if err != nil {
		return nil, nil, err
	}
	if len(raw) < aead.NonceSize() {
		return nil, nil, errors.New("invalid conversation file")
	}
	plain, err := aead.Open(nil, raw[:aead.NonceSize()], raw[aead.NonceSize():], []byte(fmt.Sprintf("conversation:%d:%s", uid, id)))
	if err != nil {
		return nil, nil, errors.New("conversation cannot be read")
	}
	record := &conversationFile{}
	if err = json.Unmarshal(plain, record); err != nil {
		return nil, nil, errors.New("invalid conversation file")
	}
	if record.ID != id {
		return nil, nil, errors.New("invalid conversation identity")
	}
	record.OwnerID = uid
	return record, raw, nil
}

func storageConversationItem(record *conversationFile, raw []byte) StorageConversation {
	hash := sha256.Sum256(raw)
	attachments := map[string]bool{}
	for _, attachment := range allAttachments(record.Conversation) {
		attachments[attachment.ID] = true
	}
	return StorageConversation{
		ID:                record.ID,
		Title:             record.Title,
		Revision:          hex.EncodeToString(hash[:]),
		Bytes:             int64(len(raw)),
		Updated:           record.Updated,
		Archived:          record.Archived,
		Pinned:            record.Pinned,
		AttachmentCount:   len(attachments),
		SharedAttachments: len(attachments) > 0,
	}
}

func markStorageConversationRunning(uid int64, item *StorageConversation) {
	if live := conversations.live[liveKey(uid, item.ID)]; live != nil {
		item.Running = true
		item.Compacting = live.compacting
	}
}

// GetStorageConversation returns metadata, not prompts, replies or tool state.
func GetStorageConversation(ctx context.Context, uid int64, id string) (StorageConversation, error) {
	if err := ctx.Err(); err != nil {
		return StorageConversation{}, err
	}
	roots, err := openPersonalStorage(uid)
	if err != nil {
		return StorageConversation{}, err
	}
	defer roots.close()
	record, raw, err := readStorageRecord(roots.account, uid, id)
	if err != nil {
		return StorageConversation{}, err
	}
	item := storageConversationItem(record, raw)
	conversations.Lock()
	markStorageConversationRunning(uid, &item)
	conversations.Unlock()
	return item, nil
}

// ListStorageConversations reads one account's encrypted records outside the
// worker lock. It then briefly snapshots live state; it never holds the global
// conversation lock while enumerating/decrypting the entire history.
func ListStorageConversations(ctx context.Context, uid int64, q StorageConversationQuery) (StorageConversationPage, error) {
	q.Page = max(q.Page, 1)
	if q.PerPage <= 0 {
		q.PerPage = 30
	}
	q.PerPage = min(q.PerPage, 100)
	result := StorageConversationPage{
		Items:    []StorageConversation{},
		Page:     q.Page,
		PerPage:  q.PerPage,
		Complete: true,
	}
	roots, err := openPersonalStorage(uid)
	if err != nil {
		return result, err
	}
	defer roots.close()
	items := []StorageConversation{}
	remaining := personalStorageEntryLimit
	remainingBytes := int64(personalStorageListByteLimit)
	needle := strings.ToLower(strings.TrimSpace(q.Q))
	complete := visitStorage(ctx, roots.account, &remaining, func(name string, info os.FileInfo) bool {
		if !storageConversationName(name) {
			return true
		}
		if !info.Mode().IsRegular() {
			result.UnreadableCount++
			result.Complete = false
			return true
		}
		if info.Size() > remainingBytes {
			return false
		}
		remainingBytes -= info.Size()
		record, raw, err := readStorageRecord(roots.account, uid, strings.TrimSuffix(name, ".enc"))
		if errors.Is(err, ErrConversationMissing) {
			return true
		}
		if err != nil {
			result.UnreadableCount++
			result.Complete = false
			return true
		}
		if (q.Scope == "archived" && !record.Archived) || (q.Scope == "active" && record.Archived) {
			return true
		}
		if needle != "" && !strings.Contains(strings.ToLower(record.Title), needle) {
			return true
		}
		items = append(items, storageConversationItem(record, raw))
		return true
	})
	result.Complete = result.Complete && complete
	conversations.Lock()
	for i := range items {
		markStorageConversationRunning(uid, &items[i])
	}
	conversations.Unlock()
	if q.Running == "running" || q.Running == "idle" {
		items = slices.DeleteFunc(items, func(item StorageConversation) bool {
			return (q.Running == "running") != item.Running
		})
	}
	slices.SortFunc(items, func(a, b StorageConversation) int {
		order := a.Updated.Compare(b.Updated)
		switch q.SortBy {
		case "bytes":
			order = cmp.Compare(a.Bytes, b.Bytes)
		case "title":
			order = strings.Compare(strings.ToLower(a.Title), strings.ToLower(b.Title))
		}
		if q.OrderBy != "asc" {
			order = -order
		}
		if order == 0 {
			return strings.Compare(a.ID, b.ID)
		}
		return order
	})
	result.Total = int64(len(items))
	result.TotalPages = (result.Total + int64(q.PerPage) - 1) / int64(q.PerPage)
	if int64(q.Page) <= result.TotalPages {
		start := (q.Page - 1) * q.PerPage
		result.Items = items[start:min(start+q.PerPage, len(items))]
	}
	return result, nil
}

// DeleteStorageConversation validates the exact previewed ciphertext and the live
// run slot while holding the same lock as every conversation mutation. A client
// disconnect cannot turn this into a background account-wide cleanup.
func DeleteStorageConversation(uid int64, id, revision string, confirm bool) (StorageConversationDeleteResult, error) {
	result := StorageConversationDeleteResult{}
	if !confirm {
		return result, ErrStorageConversationConfirm
	}
	roots, err := openPersonalStorage(uid)
	if err != nil {
		return result, err
	}
	defer roots.close()
	conversations.Lock()
	defer conversations.Unlock()
	if conversations.live[liveKey(uid, id)] != nil {
		return result, ErrConversationBusy
	}
	record, raw, err := readStorageRecord(roots.account, uid, id)
	if err != nil {
		return result, err
	}
	item := storageConversationItem(record, raw)
	if revision == "" || item.Revision != revision {
		return result, ErrStorageConversationChanged
	}
	if err = roots.account.Remove(id + ".enc"); err != nil {
		return result, err
	}
	// This is the same post-delete reference reconciliation as DeleteConversation.
	// It never removes Drive originals, and any unreadable branch keeps legacy data.
	cleanupAttachments(uid, allAttachments(record.Conversation))
	result.FreedBytes = int64(len(raw))
	return result, nil
}
