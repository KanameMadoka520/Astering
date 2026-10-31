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
	"bytes"
	"errors"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

const (
	driveChatA = "0b5e1c0e-2a4b-4c3d-8e9f-1a2b3c4d5e6f"
	driveChatB = "7c9d2e1f-3b4a-4d5c-9e8f-2b3c4d5e6f70"
)

type fakeChatDriveBridge struct {
	usages      []DriveUsage
	usageCalls  int
	referenced  bool
	scanErr     error
	scannedFile int64
}

func (b *fakeChatDriveBridge) Usages(_, _ int64) ([]DriveUsage, error) {
	b.usageCalls++
	return b.usages, nil
}
func (b *fakeChatDriveBridge) Referenced(_, fileID int64) (bool, error) {
	b.scannedFile = fileID
	return b.referenced, b.scanErr
}

func useChatDriveBridge(t *testing.T, b ChatDriveBridge) {
	t.Helper()
	previous := SetChatDriveBridge(b)
	t.Cleanup(func() { SetChatDriveBridge(previous) })
}

func newChatDriveFile(t *testing.T, s *xorm.Session, owner *user.User, name, content string) *files.File {
	t.Helper()
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte(content)), name, 0, owner)
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	return f
}

// prepareInSession stands in for PrepareDriveChange inside an uncommitted test
// session, whose rows PrepareDriveChange's own read session could not see.
func prepareInSession(a *user.User, id int64, in DriveChange) DriveChange {
	in.prepared = true
	if in.Action == "purge" && in.Confirm {
		in.chatScan, in.chatScanned = chatDriveScanBlocks(a.ID, id), true
	}
	return in
}

func driveRevision(t *testing.T, s *xorm.Session, id int64) int64 {
	t.Helper()
	d := &files.DriveFile{}
	found, err := s.Where("file_id = ?", id).Get(d)
	require.NoError(t, err)
	require.True(t, found)
	return d.Revision
}

func TestDriveChatReferencePinsAndPrivacy(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	useChatDriveBridge(t, nil)
	s := db.NewSession()
	defer s.Close()
	owner, other := &user.User{ID: 1}, &user.User{ID: 2}
	f := newChatDriveFile(t, s, owner, "chat.png", "chat bytes")

	d, err := ReferenceDriveFileForChat(s, owner.ID, driveChatA, f.ID)
	require.NoError(t, err)
	assert.EqualValues(t, 2, d.Revision, "a new chat reference invalidates usage lists shown elsewhere")
	_, err = ReferenceDriveFileForChat(s, owner.ID, driveChatA, f.ID)
	require.NoError(t, err)
	pins, err := s.Where("file_id = ?", f.ID).Count(&files.DriveChatRef{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, pins, "repeating a reference keeps one pin")

	// Another account can neither reference nor pin the file.
	_, err = ReferenceDriveFileForChat(s, other.ID, driveChatB, f.ID)
	require.ErrorIs(t, err, ErrDriveMissing)
	require.NoError(t, PinDriveChatReferences(s, other.ID, driveChatB, []int64{f.ID, 999999}))
	pins, err = s.Where("owner_id = ?", other.ID).Count(&files.DriveChatRef{})
	require.NoError(t, err)
	assert.Zero(t, pins)
	_, err = ReferenceDriveFileForChat(s, owner.ID, driveChatA, 999999)
	require.ErrorIs(t, err, ErrDriveMissing)

	usages, err := DriveUsages(s, owner, f.ID)
	require.NoError(t, err)
	assert.Equal(t, []DriveUsage{{Kind: "chat", URL: "/ai?chat=" + driveChatA}}, usages)
	usages, err = DriveUsagesForAPIToken(s, owner, f.ID)
	require.NoError(t, err)
	assert.Equal(t, []DriveUsage{{Kind: "chat", Restricted: true}}, usages, "API tokens never see conversations")
	// However a foreign pin got there, its conversation stays private.
	_, err = s.Insert(&files.DriveChatRef{OwnerID: other.ID, ConversationID: driveChatB, FileID: f.ID})
	require.NoError(t, err)
	usages, err = DriveUsages(s, owner, f.ID)
	require.NoError(t, err)
	require.Len(t, usages, 2)
	assert.Equal(t, DriveUsage{Kind: "chat", Restricted: true}, usages[1])

	refs, err := DriveChatReferences(s, owner.ID, []int64{f.ID})
	require.NoError(t, err)
	require.Len(t, refs, 1)
	assert.Equal(t, driveChatA, refs[0].ConversationID)
	foreign := &files.DriveChatRef{}
	_, err = s.Where("owner_id = ?", other.ID).Get(foreign)
	require.NoError(t, err)
	require.NoError(t, DeleteDriveChatReferences(s, owner.ID, []int64{refs[0].ID, foreign.ID}))
	pins, err = s.Where("file_id = ?", f.ID).Count(&files.DriveChatRef{})
	require.NoError(t, err)
	assert.EqualValues(t, 1, pins, "deleting is limited to the owner's pins")
}

func TestDriveChatReferencesFollowTrashAndPurgeRules(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	useChatDriveBridge(t, nil)
	s := db.NewSession()
	defer s.Close()
	owner := &user.User{ID: 1}
	f := newChatDriveFile(t, s, owner, "plan.txt", "used by a chat")
	_, err := ReferenceDriveFileForChat(s, owner.ID, driveChatA, f.ID)
	require.NoError(t, err)

	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 1, Action: "trash", Confirm: true})
	require.ErrorIs(t, err, ErrDriveChanged, "a confirmation given before the chat used the file is stale")
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: driveRevision(t, s, f.ID), Action: "trash"})
	require.ErrorIs(t, err, ErrDriveConfirm)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: driveRevision(t, s, f.ID), Action: "trash", Confirm: true})
	require.NoError(t, err)
	_, err = ReferenceDriveFileForChat(s, owner.ID, driveChatB, f.ID)
	require.ErrorIs(t, err, ErrDriveTrashed, "trashed files cannot gain new chat references")
	purge := func() error {
		_, err := ChangeDriveItem(s, owner, f.ID, prepareInSession(owner, f.ID, DriveChange{Revision: driveRevision(t, s, f.ID), Action: "purge", Confirm: true, ConfirmName: f.Name}))
		return err
	}
	require.ErrorIs(t, purge(), ErrDriveInUse)

	// With every pin gone the saved conversations are still scanned: a reference that
	// was never pinned, or a scan that fails, keeps the file.
	refs, err := DriveChatReferences(s, owner.ID, []int64{f.ID})
	require.NoError(t, err)
	require.NoError(t, DeleteDriveChatReferences(s, owner.ID, []int64{refs[0].ID}))
	bridge := &fakeChatDriveBridge{referenced: true}
	useChatDriveBridge(t, bridge)
	require.ErrorIs(t, purge(), ErrDriveInUse)
	assert.Equal(t, f.ID, bridge.scannedFile)
	bridge.referenced, bridge.scanErr = false, errors.New("conversation could not be decrypted")
	require.ErrorIs(t, purge(), ErrDriveChatUnreadable)
	assert.Zero(t, bridge.usageCalls, "transactions never take the conversation lock")
	bridge.scanErr = nil
	// Without the scan result a purge never proceeds, and the transaction never scans.
	bridge.scannedFile = 0
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: driveRevision(t, s, f.ID), Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.ErrorIs(t, err, ErrDriveChanged)
	assert.Zero(t, bridge.scannedFile)
	require.NoError(t, purge())
	d, err := GetDriveItem(s, owner, f.ID)
	require.NoError(t, err)
	assert.True(t, d.Purging)
}

func TestDriveUsagesTitleOwnChatsThroughBridge(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	owner := &user.User{ID: 1}
	f := newChatDriveFile(t, s, owner, "notes.txt", "titled usage")
	unused := newChatDriveFile(t, s, owner, "unused.txt", "no usage")
	require.NoError(t, PinDriveChatReferences(s, owner.ID, driveChatA, []int64{f.ID}))
	_, err := s.Insert(&files.DriveChatRef{OwnerID: 2, ConversationID: driveChatB, FileID: f.ID})
	require.NoError(t, err)
	bridge := &fakeChatDriveBridge{usages: []DriveUsage{{Kind: "chat_draft", Title: "Weekly plan", URL: ChatDriveUsageURL(driveChatA)}}}
	useChatDriveBridge(t, bridge)

	usages, err := DriveUsages(s, owner, f.ID)
	require.NoError(t, err)
	assert.Equal(t, []DriveUsage{{Kind: "chat_draft", Title: "Weekly plan", URL: "/ai?chat=" + driveChatA}, {Kind: "chat", Restricted: true}}, usages)
	assert.Equal(t, 1, bridge.usageCalls)
	// Without own pins the conversations are not opened at all.
	usages, err = DriveUsages(s, owner, unused.ID)
	require.NoError(t, err)
	assert.Empty(t, usages)
	assert.Equal(t, 1, bridge.usageCalls)
	// Trash counts pins inside its transaction without the bridge.
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: driveRevision(t, s, f.ID), Action: "trash"})
	require.ErrorIs(t, err, ErrDriveConfirm)
	assert.Equal(t, 1, bridge.usageCalls)
}

func TestDiscardUnusedDriveFileKeepsAnythingInUse(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	useChatDriveBridge(t, nil)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	owner, other := &user.User{ID: 1}, &user.User{ID: 2}
	discard := func(a *user.User, f *files.File) bool {
		t.Helper()
		ok, err := DiscardUnusedDriveFile(s, a, f.ID, ScanDriveChats(a.ID, f.ID))
		require.NoError(t, err)
		return ok
	}

	pinned := newChatDriveFile(t, s, owner, "pinned.txt", "pinned by chat")
	require.NoError(t, PinDriveChatReferences(s, owner.ID, driveChatA, []int64{pinned.ID}))
	assert.False(t, discard(owner, pinned))
	attached := newChatDriveFile(t, s, owner, "task.txt", "attached to a task")
	_, err := AttachDriveFile(s, owner, attached.ID, 1, 1)
	require.NoError(t, err)
	assert.False(t, discard(owner, attached))
	organized := newChatDriveFile(t, s, owner, "organized.txt", "owner already changed it")
	_, err = s.Where("file_id = ?", organized.ID).Cols("category").Update(&files.DriveFile{Category: "Docs"})
	require.NoError(t, err)
	assert.False(t, discard(owner, organized))
	scanned := newChatDriveFile(t, s, owner, "scanned.txt", "saved in an unpinned chat")
	bridge := &fakeChatDriveBridge{referenced: true}
	useChatDriveBridge(t, bridge)
	assert.False(t, discard(owner, scanned))
	bridge.referenced, bridge.scanErr = false, errors.New("unreadable conversation")
	discarded, scanErr := DiscardUnusedDriveFile(s, owner, scanned.ID, ScanDriveChats(owner.ID, scanned.ID))
	require.ErrorIs(t, scanErr, ErrDriveChatUnreadable)
	assert.False(t, discarded)
	bridge.scanErr = nil

	fresh := newChatDriveFile(t, s, owner, "fresh.txt", "nobody uses this")
	_, err = DiscardUnusedDriveFile(s, other, fresh.ID, ScanDriveChats(other.ID, fresh.ID))
	require.ErrorIs(t, err, ErrDriveMissing)
	assert.True(t, discard(owner, fresh))
	d, err := GetDriveItem(s, owner, fresh.ID)
	require.NoError(t, err)
	assert.True(t, d.Purging && d.InTrash(), "if finishing fails, the recycle bin can retry it")
	// A decided purge is only finished, whatever references were added since.
	require.NoError(t, PinDriveChatReferences(s, owner.ID, driveChatB, []int64{fresh.ID}))
	bridge.referenced = true
	d, err = ChangeDriveItem(s, owner, fresh.ID, DriveChange{Revision: driveRevision(t, s, fresh.ID), Action: "purge", Confirm: true, ConfirmName: fresh.Name})
	require.NoError(t, err)
	assert.True(t, d.Purging)
	for _, kept := range []*files.File{pinned, attached, organized, scanned} {
		d, err := GetDriveItem(s, owner, kept.ID)
		require.NoError(t, err)
		assert.False(t, d.Purging, kept.Name)
	}
	require.NoError(t, s.Commit())
	require.NoError(t, files.FinishDrivePurge(fresh.ID))
	require.Error(t, fresh.LoadFileByID())
	require.NoError(t, scanned.LoadFileByID())
	require.NoError(t, scanned.File.Close())
}

func TestAttachDriveFileKeepsTheUploadLimit(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	owner := &user.User{ID: 1}
	oldMax := config.FilesMaxSize.GetString()
	require.NoError(t, config.SetMaxFileSizeMBytesFromString("1MB"))
	t.Cleanup(func() { _ = config.SetMaxFileSizeMBytesFromString(oldMax) })
	// Chat uploads may store up to 32 MiB in the drive, above files.maxsize.
	f := newChatDriveFile(t, s, owner, "large.bin", "stored by a chat upload")
	_, err := s.ID(f.ID).Cols("size").Update(&files.File{Size: 2 << 20})
	require.NoError(t, err)
	_, err = AttachDriveFile(s, owner, f.ID, 1, 1)
	assert.True(t, files.IsErrFileIsTooLarge(err), "%v", err)
	_, err = s.ID(f.ID).Cols("size").Update(&files.File{Size: 1 << 20})
	require.NoError(t, err)
	_, err = AttachDriveFile(s, owner, f.ID, driveRevision(t, s, f.ID), 1)
	require.NoError(t, err)
}

func TestPrepareDriveChangeScansBeforeTheTransaction(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	bridge := &fakeChatDriveBridge{referenced: true}
	useChatDriveBridge(t, bridge)
	owner := &user.User{ID: 1}
	setup := db.NewSession()
	f := newChatDriveFile(t, setup, owner, "old.txt", "trashed, still in a chat")
	_, err := setup.Where("file_id = ?", f.ID).Cols("trashed_at").Update(&files.DriveFile{TrashedAt: time.Now()})
	require.NoError(t, err)
	require.NoError(t, setup.Commit())
	require.NoError(t, setup.Close())

	// Requests that cannot purge the file scan nothing.
	for _, in := range []DriveChange{{Revision: 1, Action: "purge", Confirm: true, ConfirmName: "other.txt"}, {Revision: 1, Action: "purge", ConfirmName: f.Name}, {Revision: 1, Action: "restore"}} {
		PrepareDriveChange(owner, f.ID, &in)
		assert.Zero(t, bridge.scannedFile)
	}
	foreign := DriveChange{Revision: 1, Action: "purge", Confirm: true, ConfirmName: f.Name}
	PrepareDriveChange(&user.User{ID: 2}, f.ID, &foreign)
	assert.Zero(t, bridge.scannedFile, "another account's file is never scanned for")

	in := DriveChange{Revision: 1, Action: "purge", Confirm: true, ConfirmName: f.Name}
	PrepareDriveChange(owner, f.ID, &in)
	assert.Equal(t, f.ID, bridge.scannedFile)
	// The transaction uses that result and never scans itself.
	bridge.scannedFile = 0
	s := db.NewSession()
	defer s.Close()
	_, err = ChangeDriveItem(s, owner, f.ID, in)
	require.ErrorIs(t, err, ErrDriveInUse)
	assert.Zero(t, bridge.scannedFile)
	// A file that only became purgeable after the request was prepared is confirmed again.
	late := DriveChange{Revision: driveRevision(t, s, f.ID), Action: "purge", Confirm: true, ConfirmName: "renamed meanwhile"}
	late.prepared = true
	late.ConfirmName = f.Name
	_, err = ChangeDriveItem(s, owner, f.ID, late)
	require.ErrorIs(t, err, ErrDriveChanged)
	assert.Zero(t, bridge.scannedFile)
}
