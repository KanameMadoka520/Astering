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
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/user"

	"github.com/gabriel-vasile/mimetype"
)

// New chat uploads are stored once in the owner's personal drive and conversations
// keep references. drive_chat_refs pins those files for drive usage checks, and every
// pin change happens under the conversation lock, in the same critical section that
// saves the conversation: pin before saving a reference, unpin only after the saved
// conversation is verified not to reference the file. So every saved reference has a
// pin, while a stale pin merely keeps a file. Lock order is conversation lock, then a
// database transaction; nothing may wait for the conversation lock inside one.

var ErrAttachmentTrashed = errors.New("chatDriveTrashed")
var errConversationStoreMissing = errors.New("AI conversation store missing while chat references are pinned")

func init() { models.SetChatDriveBridge(chatDriveBridge{}) }

func chatDriveError(err error) error {
	switch {
	case err == nil:
		return nil
	case errors.Is(err, models.ErrDriveMissing), files.IsErrFileDoesNotExist(err):
		return ErrAttachmentMissing
	case errors.Is(err, models.ErrDriveTrashed):
		return ErrAttachmentTrashed
	}
	return err
}

func driveOwner(uid int64) *user.User { return &user.User{ID: uid} }

// storeDriveUpload saves validated chat bytes as a new file in the owner's drive. The
// chat keeps its own 32 MiB limit instead of the instance upload limit, as before.
func storeDriveUpload(uid int64, name string, data []byte) (int64, error) {
	s := db.NewSession()
	defer s.Close()
	f, err := files.CreateWithMimeAndSession(s, bytes.NewReader(data), name, uint64(len(data)), driveOwner(uid), mimetype.Detect(data).String(), false)
	if err != nil {
		return 0, err
	}
	if err = files.AddToDrive(s, f); err == nil {
		err = s.Commit()
	}
	if err != nil {
		_ = s.Rollback()
		if removeErr := files.DeleteBlob(f.ID); removeErr != nil {
			log.Warningf("Could not remove uncommitted chat upload blob %d: %s", f.ID, removeErr)
		}
		return 0, err
	}
	return f.ID, nil
}

// discardNewDriveUpload removes a file storeDriveUpload created when the conversation
// could not reference it. Anything that uses the file meanwhile keeps it. A failure
// leaves either an ordinary drive file the owner can see and delete, or one in the
// recycle bin whose purge the owner can finish.
func discardNewDriveUpload(uid, fileID int64) {
	defer forgetDriveStat(uid, fileID)
	// The scan may take the conversation lock and pool connections: no session yet.
	scan := models.ScanDriveChats(uid, fileID)
	s := db.NewSession()
	defer s.Close()
	purge, err := models.DiscardUnusedDriveFile(s, driveOwner(uid), fileID, scan)
	if err == nil && purge {
		if err = s.Commit(); err == nil {
			err = files.FinishDrivePurge(fileID)
		}
	}
	if err != nil {
		log.Warningf("Chat upload %d of user %d stays in the drive: %s", fileID, uid, err)
	}
}

type driveStat struct {
	FileID  int64
	Purging bool
	Size    uint64
}

var driveStatCache = struct {
	sync.Mutex
	entries map[[2]int64]cachedDriveStat
}{entries: map[[2]int64]cachedDriveStat{}}

type cachedDriveStat struct {
	stat  driveStat
	found bool
	at    time.Time
}

// SSE snapshots decorate attachments every 120ms. A referenced drive file cannot be
// purged and its blob never changes, so a short cache avoids a query per tick.
const driveStatTTL = 10 * time.Second

func forgetDriveStat(uid, fileID int64) {
	driveStatCache.Lock()
	defer driveStatCache.Unlock()
	delete(driveStatCache.entries, [2]int64{uid, fileID})
}

// driveStats returns the owner's drive files among ids; absent IDs are unavailable.
// Without IDs it returns nil without touching the database (or allocating, which the
// SSE snapshot path relies on).
func driveStats(uid int64, ids []int64, cached bool) (map[int64]driveStat, error) {
	if len(ids) == 0 {
		return nil, nil
	}
	out := map[int64]driveStat{}
	missing := []int64{}
	now := time.Now()
	driveStatCache.Lock()
	for _, id := range ids {
		entry, ok := driveStatCache.entries[[2]int64{uid, id}]
		switch {
		case cached && ok && now.Sub(entry.at) < driveStatTTL:
			if entry.found {
				out[id] = entry.stat
			}
		case !slices.Contains(missing, id):
			missing = append(missing, id)
		}
	}
	driveStatCache.Unlock()
	if len(missing) == 0 {
		return out, nil
	}
	s := db.NewReadSession()
	defer s.Close()
	found := []driveStat{}
	for start := 0; start < len(missing); start += 500 {
		chunk := missing[start:min(start+500, len(missing))]
		rows := []driveStat{}
		if err := s.Table("drive_files").Join("INNER", "files", "files.id = drive_files.file_id").
			Where("drive_files.owner_id = ?", uid).In("drive_files.file_id", chunk).
			Select("drive_files.file_id, drive_files.purging, files.size").Find(&rows); err != nil {
			return nil, err
		}
		found = append(found, rows...)
	}
	driveStatCache.Lock()
	defer driveStatCache.Unlock()
	if len(driveStatCache.entries) > 16384 {
		for key, entry := range driveStatCache.entries {
			if now.Sub(entry.at) >= driveStatTTL {
				delete(driveStatCache.entries, key)
			}
		}
		if len(driveStatCache.entries) > 16384 {
			driveStatCache.entries = map[[2]int64]cachedDriveStat{}
		}
	}
	for _, id := range missing {
		driveStatCache.entries[[2]int64{uid, id}] = cachedDriveStat{at: now}
	}
	for _, row := range found {
		out[row.FileID] = row
		driveStatCache.entries[[2]int64{uid, row.FileID}] = cachedDriveStat{stat: row, found: true, at: now}
	}
	return out, nil
}

func driveStatUsable(st driveStat, found bool, a ChatAttachment) bool {
	return found && !st.Purging && a.Size > 0 && a.Size <= MaxChatAttachmentBytes && st.Size == uint64(a.Size) // #nosec G115 -- a.Size is positive here
}

// checkDriveAttachment confirms an owned drive file without reading it. Contents are
// verified against size and SHA-256 whenever they are actually read.
func checkDriveAttachment(uid int64, a ChatAttachment, cached bool) error {
	stats, err := driveStats(uid, []int64{a.DriveFileID}, cached)
	if err != nil {
		return err
	}
	st, found := stats[a.DriveFileID]
	if !driveStatUsable(st, found, a) {
		return ErrAttachmentMissing
	}
	return nil
}

func readDriveBlob(fileID, size int64) ([]byte, error) {
	f := &files.File{ID: fileID}
	if err := f.LoadFileByID(); err != nil {
		if files.IsErrFileDoesNotExist(err) {
			return nil, ErrAttachmentMissing
		}
		return nil, err
	}
	defer f.File.Close()
	data, err := io.ReadAll(io.LimitReader(f.File, size+1))
	if err != nil {
		return nil, err
	}
	if int64(len(data)) != size {
		return nil, ErrAttachmentMissing
	}
	return data, nil
}

type driveBytesKey struct {
	uid, fileID int64
	id          string
}

type driveBytesEntry struct {
	key  driveBytesKey
	data []byte
	at   time.Time
}

// Every model round reads all attachments in context again, which with remote
// storage means downloading them again. Verified bytes are kept briefly; the content
// hash makes a hit exact, and availability is still checked on every read.
var driveBytesCache struct {
	sync.Mutex
	entries []driveBytesEntry
	size    int
}

const driveBytesTTL = 2 * time.Minute
const driveBytesLimit = 64 * 1024 * 1024

func cachedDriveBytes(key driveBytesKey) []byte {
	driveBytesCache.Lock()
	defer driveBytesCache.Unlock()
	expireDriveBytesLocked(time.Now())
	for _, entry := range driveBytesCache.entries {
		if entry.key == key {
			return entry.data
		}
	}
	return nil
}

func cacheDriveBytes(key driveBytesKey, data []byte) {
	if len(data) > driveBytesLimit/4 {
		return
	}
	driveBytesCache.Lock()
	defer driveBytesCache.Unlock()
	now := time.Now()
	expireDriveBytesLocked(now)
	if slices.ContainsFunc(driveBytesCache.entries, func(entry driveBytesEntry) bool { return entry.key == key }) {
		return
	}
	for driveBytesCache.size+len(data) > driveBytesLimit {
		dropOldestDriveBytesLocked()
	}
	// Capacity is clipped, so a caller appending to the slice never writes into it.
	driveBytesCache.entries = append(driveBytesCache.entries, driveBytesEntry{key: key, data: data[:len(data):len(data)], at: now})
	driveBytesCache.size += len(data)
}

// Entries are kept in insertion order, so expired ones are at the front.
func expireDriveBytesLocked(now time.Time) {
	for len(driveBytesCache.entries) > 0 && now.Sub(driveBytesCache.entries[0].at) >= driveBytesTTL {
		dropOldestDriveBytesLocked()
	}
}

// The dropped slot is cleared: the backing array would otherwise keep its bytes alive.
func dropOldestDriveBytesLocked() {
	driveBytesCache.size -= len(driveBytesCache.entries[0].data)
	driveBytesCache.entries[0] = driveBytesEntry{}
	driveBytesCache.entries = driveBytesCache.entries[1:]
	if len(driveBytesCache.entries) == 0 {
		driveBytesCache.entries = nil
	}
}

// readDriveAttachment returns the original bytes of the owner's drive file only while
// they still match what was attached, so a replaced or damaged blob never reaches a
// model or an export. Callers must not modify the returned bytes.
func readDriveAttachment(uid int64, a ChatAttachment) ([]byte, error) {
	if uid <= 0 {
		return nil, ErrAttachmentMissing
	}
	if err := checkDriveAttachment(uid, a, false); err != nil {
		return nil, err
	}
	key := driveBytesKey{uid: uid, fileID: a.DriveFileID, id: a.ID}
	if data := cachedDriveBytes(key); data != nil {
		return data, nil
	}
	data, err := readDriveBlob(a.DriveFileID, a.Size)
	if err != nil {
		return nil, err
	}
	if sum := sha256.Sum256(data); hex.EncodeToString(sum[:]) != a.ID {
		return nil, ErrAttachmentMissing
	}
	cacheDriveBytes(key, data)
	return data, nil
}

// loadDriveFileForChat reads an active drive file of the owner for validation as a
// chat attachment; the size limit is checked before any byte is read.
func loadDriveFileForChat(uid, fileID int64) (string, []byte, error) {
	s := db.NewReadSession()
	defer s.Close()
	d, err := models.GetDriveItem(s, driveOwner(uid), fileID)
	if err != nil {
		return "", nil, chatDriveError(err)
	}
	if d.Purging {
		return "", nil, ErrAttachmentMissing
	}
	if d.InTrash() {
		return "", nil, ErrAttachmentTrashed
	}
	if d.File.Size == 0 || d.File.Size > MaxChatAttachmentBytes {
		return "", nil, ErrAttachmentInvalid
	}
	data, err := readDriveBlob(fileID, int64(d.File.Size)) // #nosec G115 -- bounded by MaxChatAttachmentBytes above
	return d.File.Name, data, err
}

// pinDriveFileLocked references an active owned drive file from conversation cid.
// Callers hold the conversation lock and save the conversation right afterwards.
func pinDriveFileLocked(uid int64, cid string, fileID int64) error {
	defer forgetDriveStat(uid, fileID)
	s := db.NewSession()
	defer s.Close()
	if _, err := models.ReferenceDriveFileForChat(s, uid, cid, fileID); err != nil {
		return chatDriveError(err)
	}
	return s.Commit()
}

func pinDriveFilesLocked(uid int64, cid string, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	s := db.NewSession()
	defer s.Close()
	if err := models.PinDriveChatReferences(s, uid, cid, ids); err != nil {
		return err
	}
	return s.Commit()
}

// releaseDriveRefsLocked deletes pins proven stale. The conversation directory is
// synced first, so the renames and removals that proved them survive a crash.
func releaseDriveRefsLocked(uid int64, ids []int64) error {
	if len(ids) == 0 {
		return nil
	}
	if err := syncDir(conversationDir(uid)); err != nil {
		return err
	}
	s := db.NewSession()
	defer s.Close()
	if err := models.DeleteDriveChatReferences(s, uid, ids); err != nil {
		return err
	}
	return s.Commit()
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	// Windows and some network or FUSE mounts cannot flush directories; like
	// PostgreSQL, only real I/O errors count there.
	err = d.Sync()
	if err == nil || runtime.GOOS == "windows" || errors.Is(err, errors.ErrUnsupported) || errors.Is(err, syscall.EINVAL) || errors.Is(err, syscall.EBADF) {
		return nil
	}
	return err
}

// A ChatAttachment as encoding/json writes it. Matching the whole shape, not just the
// field name, means provider payloads and tool arguments that merely mention
// drive_file_id never count, and encoded strings escape their quotes, so text that
// quotes an attachment never matches either.
var driveIDPattern = regexp.MustCompile(`\{"id":"[0-9a-f]{64}","name":"(?:[^"\\]|\\.)*","mime":"(?:[^"\\]|\\.)*","size":[0-9]+,"drive_file_id":([0-9]+)`)

// jsonDriveIDs finds drive references anywhere in serialized conversation state, so
// fields added later are covered without being listed here.
func jsonDriveIDs(raw []byte) []int64 {
	ids := []int64{}
	for _, match := range driveIDPattern.FindAllSubmatch(raw, -1) {
		id, err := strconv.ParseInt(string(match[1]), 10, 64)
		if err == nil && id > 0 && !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
	}
	slices.Sort(ids)
	return ids
}

// recordDriveIDs must only see records no other goroutine mutates: a saved copy or a
// new branch. A live record's agent state changes outside the conversation lock.
func recordDriveIDs(record *conversationFile) ([]int64, error) {
	raw, err := json.Marshal(record)
	if err != nil {
		return nil, err
	}
	return jsonDriveIDs(raw), nil
}

// writeForkWithDrivePins saves a new branch after pinning the drive files it
// references for the branch itself; if saving fails, those pins are verified again.
func writeForkWithDrivePins(uid int64, record *conversationFile) error {
	ids, err := recordDriveIDs(record)
	if err != nil {
		return err
	}
	if err = pinDriveFilesLocked(uid, record.ID, ids); err != nil {
		return err
	}
	if err = writeConversation(uid, record); err != nil {
		logDriveRefError(uid, reconcileDriveRefsLocked(uid, ids))
		return err
	}
	return nil
}

type driveUse struct{ draft, sent bool }

// savedDriveUses reports the drive files a saved conversation references: drafts and
// the visible messages are classified, and the full serialized record is scanned for
// references kept anywhere else (they count as sent).
func savedDriveUses(record *conversationFile) (map[int64]driveUse, error) {
	uses := map[int64]driveUse{}
	markVisibleDriveUses(uses, record)
	ids, err := recordDriveIDs(record)
	if err != nil {
		return nil, err
	}
	for _, id := range ids {
		if _, ok := uses[id]; !ok {
			uses[id] = driveUse{sent: true}
		}
	}
	return uses, nil
}

func markVisibleDriveUses(uses map[int64]driveUse, record *conversationFile) {
	mark := func(items []ChatAttachment, draft bool) {
		for _, a := range items {
			if a.DriveFileID <= 0 {
				continue
			}
			use := uses[a.DriveFileID]
			use.draft = use.draft || draft
			use.sent = use.sent || !draft
			uses[a.DriveFileID] = use
		}
	}
	mark(record.DraftAttachments, true)
	for _, turn := range record.Turns {
		mark(turn.Attachments, false)
	}
	for _, messages := range record.Contexts {
		for _, m := range messages {
			mark(m.Attachments, false)
		}
	}
}

// conversationDriveUsesLocked reports the drive files conversation cid references:
// the saved file, which is authoritative, plus the lock-protected drafts, turns and
// contexts of a live record. A conversation is only reported missing when its
// directory is there without it; a missing directory (an unmounted volume, say)
// proves nothing.
func conversationDriveUsesLocked(uid int64, cid string) (map[int64]driveUse, string, error) {
	uses := map[int64]driveUse{}
	title, found := "", false
	saved, err := readConversation(uid, cid)
	switch {
	case err == nil:
		found, title = true, saved.Title
		if uses, err = savedDriveUses(saved); err != nil {
			return nil, "", err
		}
	case !errors.Is(err, ErrConversationMissing):
		return nil, "", err
	}
	if live := conversations.live[uid]; live != nil && live.id == cid {
		found, title = true, live.record.Title
		markVisibleDriveUses(uses, live.record)
	}
	if !found {
		if _, err = os.Stat(conversationDir(uid)); err != nil {
			return nil, "", err
		}
		return nil, "", ErrConversationMissing
	}
	return uses, title, nil
}

// reconcileDriveRefsLocked removes the owner's pins for fileIDs whose conversation is
// gone or verifiably no longer references the file. An unreadable conversation keeps
// its pins: nothing is released without proof.
func reconcileDriveRefsLocked(uid int64, fileIDs []int64) error {
	if len(fileIDs) == 0 {
		return nil
	}
	s := db.NewReadSession()
	refs, err := models.DriveChatReferences(s, uid, fileIDs)
	_ = s.Close()
	if err != nil {
		return err
	}
	byConversation := map[string][]*files.DriveChatRef{}
	for _, ref := range refs {
		byConversation[ref.ConversationID] = append(byConversation[ref.ConversationID], ref)
	}
	stale := []int64{}
	for cid, pins := range byConversation {
		uses, _, err := conversationDriveUsesLocked(uid, cid)
		if err != nil && !errors.Is(err, ErrConversationMissing) {
			continue
		}
		for _, pin := range pins {
			if _, used := uses[pin.FileID]; !used {
				stale = append(stale, pin.ID)
			}
		}
	}
	return releaseDriveRefsLocked(uid, stale)
}

func logDriveRefError(uid int64, err error) {
	if err != nil {
		log.Warningf("Drive pins of user %d stay until the next verification: %s", uid, err)
	}
}

func chatDriveUsage(cid, title string, use driveUse) models.DriveUsage {
	usage := models.DriveUsage{Kind: "chat", Title: title, URL: models.ChatDriveUsageURL(cid)}
	if use.draft && !use.sent {
		usage.Kind = "chat_draft"
	}
	return usage
}

type chatDriveBridge struct{}

// Usages titles the owner's conversations that use the file. Saved conversations are
// read without the lock (they are replaced atomically); only pins that look stale are
// verified again with the live state, and pruned, under it. An unreadable
// conversation stays listed, untitled, rather than released.
func (chatDriveBridge) Usages(ownerID, fileID int64) ([]models.DriveUsage, error) {
	s := db.NewReadSession()
	refs, err := models.DriveChatReferences(s, ownerID, []int64{fileID})
	_ = s.Close()
	if err != nil {
		return nil, err
	}
	usages := []models.DriveUsage{}
	suspect := []*files.DriveChatRef{}
	for _, ref := range refs {
		saved, err := readConversation(ownerID, ref.ConversationID)
		var uses map[int64]driveUse
		if err == nil {
			uses, err = savedDriveUses(saved)
		}
		use, used := uses[fileID]
		switch {
		case err == nil && used:
			usages = append(usages, chatDriveUsage(ref.ConversationID, saved.Title, use))
		case err == nil || errors.Is(err, ErrConversationMissing):
			suspect = append(suspect, ref)
		default:
			usages = append(usages, models.DriveUsage{Kind: "chat", URL: models.ChatDriveUsageURL(ref.ConversationID)})
		}
	}
	if len(suspect) == 0 {
		return usages, nil
	}
	conversations.Lock()
	defer conversations.Unlock()
	stale := []int64{}
	for _, ref := range suspect {
		uses, title, err := conversationDriveUsesLocked(ownerID, ref.ConversationID)
		use, used := uses[fileID]
		switch {
		case err == nil && used:
			usages = append(usages, chatDriveUsage(ref.ConversationID, title, use))
		case err == nil || errors.Is(err, ErrConversationMissing):
			stale = append(stale, ref.ID)
		default:
			usages = append(usages, models.DriveUsage{Kind: "chat", URL: models.ChatDriveUsageURL(ref.ConversationID)})
		}
	}
	// Unpruned pins would still block trash/purge, so a failure must not hide them.
	if err = releaseDriveRefsLocked(ownerID, stale); err != nil {
		return nil, err
	}
	return usages, nil
}

// conversationStoreAbsent decides what a missing conversation directory means. With
// the conversation store present the owner has no conversations. Without it (never
// used, or a volume that is not mounted) the owner's pins tell: an owner whose chats
// pinned drive files had conversations, so their absence proves nothing.
func conversationStoreAbsent(ownerID int64) error {
	_, err := os.Stat(filepath.Dir(conversationDir(ownerID)))
	if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	s := db.NewReadSession()
	defer s.Close()
	pinned, err := s.Where("owner_id = ?", ownerID).Exist(&files.DriveChatRef{})
	if err != nil {
		return err
	}
	if pinned {
		return errConversationStoreMissing
	}
	return nil
}

// Referenced scans saved conversations without the lock: files are replaced
// atomically and every reference is saved before it can be used. Conversations found
// referencing the file get the pin they should have had, so the usage list names
// them. Any unreadable record keeps the file: an unknown reference must never
// authorize irreversible deletion, including temporary key or storage failures.
func (chatDriveBridge) Referenced(ownerID, fileID int64) (bool, error) {
	entries, err := os.ReadDir(conversationDir(ownerID))
	if errors.Is(err, os.ErrNotExist) {
		return false, conversationStoreAbsent(ownerID)
	}
	if err != nil {
		return false, err
	}
	found := []string{}
	for _, entry := range entries {
		if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".enc") {
			continue
		}
		cid := strings.TrimSuffix(entry.Name(), ".enc")
		record, err := readConversation(ownerID, cid)
		var pathErr *fs.PathError
		switch {
		case errors.Is(err, ErrConversationMissing):
			continue
		case errors.As(err, &pathErr):
			return false, err
		case err != nil:
			return false, err
		}
		ids, err := recordDriveIDs(record)
		if err != nil {
			return false, err
		}
		if slices.Contains(ids, fileID) {
			found = append(found, cid)
		}
	}
	if len(found) == 0 {
		return false, nil
	}
	s := db.NewReadSession()
	refs, err := models.DriveChatReferences(s, ownerID, []int64{fileID})
	_ = s.Close()
	if err != nil {
		return true, err
	}
	unpinned := slices.DeleteFunc(found, func(cid string) bool {
		return slices.ContainsFunc(refs, func(ref *files.DriveChatRef) bool { return ref.ConversationID == cid })
	})
	if len(unpinned) == 0 {
		return true, nil
	}
	conversations.Lock()
	defer conversations.Unlock()
	for _, cid := range unpinned {
		logDriveRefError(ownerID, pinDriveFilesLocked(ownerID, cid, []int64{fileID}))
	}
	return true, nil
}
