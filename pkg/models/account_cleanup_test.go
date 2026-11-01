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
	"context"
	"errors"
	"sync"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/notifications"
	"code.vikunja.io/api/pkg/user"
	"github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/schemas"
)

type cleanupTestBridge struct {
	calls   []int64
	failure error
	retries int
}

func (b *cleanupTestBridge) CleanupDeletedUser(id int64) error {
	b.calls = append(b.calls, id)
	return b.failure
}
func (b *cleanupTestBridge) RetryDeletedUsers() error { b.retries++; return nil }

func prepareAccountCleanup(t *testing.T) *cleanupTestBridge {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	notifications.Fake()
	t.Cleanup(notifications.Unfake)
	bridge := &cleanupTestBridge{}
	previous := SetAccountCleanupBridge(bridge)
	t.Cleanup(func() { SetAccountCleanupBridge(previous) })
	return bridge
}

func cleanupOwnedFile(t *testing.T, ownerID int64) *files.File {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte("account deletion bytes")), "owned.txt", 0, &user.User{ID: ownerID})
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	require.NoError(t, s.Commit())
	return f
}

func assertCleanupFile(t *testing.T, f *files.File, exists bool) {
	t.Helper()
	s := db.NewReadSession()
	defer s.Close()
	has, err := s.ID(f.ID).Exist(&files.File{})
	require.NoError(t, err)
	require.Equal(t, exists, has)
	has, err = s.Where("file_id = ?", f.ID).Exist(&files.DriveFile{})
	require.NoError(t, err)
	require.Equal(t, exists, has)
	err = f.LoadFileByID()
	if exists {
		require.NoError(t, err)
		require.NoError(t, f.File.Close())
	} else {
		require.Error(t, err)
	}
}

func TestAccountCleanupCommitRollbackAndRetry(t *testing.T) {
	bridge := prepareAccountCleanup(t)
	f := cleanupOwnedFile(t, 4)
	// No cleanup merely because an account is disabled or scheduled, nor while live.
	require.NoError(t, CleanupDeletedAccount(4))
	require.Empty(t, bridge.calls)
	assertCleanupFile(t, f, true)

	s := db.NewSession()
	require.NoError(t, DeleteUser(s, &user.User{ID: 4}))
	require.Empty(t, bridge.calls)
	require.NoError(t, s.Rollback())
	events.CleanupPending(s)
	require.NoError(t, s.Close())
	assertCleanupFile(t, f, true)

	s = db.NewSession()
	require.NoError(t, DeleteUser(s, &user.User{ID: 4}))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	// Failed private-store cleanup must retain every Drive blob and chat pin for retry.
	pin := &files.DriveChatRef{OwnerID: 4, ConversationID: driveChatA, FileID: f.ID}
	write := db.NewSession()
	_, err := write.Insert(pin)
	require.NoError(t, err)
	require.NoError(t, write.Commit())
	require.NoError(t, write.Close())
	bridge.failure = errors.New("private volume unavailable")
	events.DispatchPending(context.Background(), s)
	require.Equal(t, []int64{4}, bridge.calls)
	assertCleanupFile(t, f, true)
	db.AssertExists(t, "drive_chat_refs", map[string]interface{}{"id": pin.ID}, false)
	bridge.failure = nil
	require.NoError(t, RetryDeletedAccountCleanup())
	require.Equal(t, 1, bridge.retries)
	assertCleanupFile(t, f, false)
	db.AssertMissing(t, "drive_chat_refs", map[string]interface{}{"id": pin.ID})
	require.NoError(t, RetryDeletedAccountCleanup())
}

func TestAccountCleanupSurvivingSharedReferences(t *testing.T) {
	prepareAccountCleanup(t)
	// Owner 9999 has already been removed (simulates restart after commit).
	f := cleanupOwnedFile(t, 9999)
	s := db.NewSession()
	attachment := &TaskAttachment{TaskID: 1, FileID: f.ID, CreatedByID: 9999}
	_, err := s.Insert(attachment)
	require.NoError(t, err)
	_, err = s.Insert(&compassMedia{SpaceID: 700, FileID: f.ID, AddedByID: 9999})
	require.NoError(t, err)
	// History-only reference remains a reference even without a current entry use.
	_, err = s.Insert(&compassEntryMedia{SpaceID: 700, EntryID: 701, FileID: f.ID, Current: false})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
	// Ordinary deletion of one shared reference must retain the Drive protection.
	s = db.NewSession()
	_, err = s.ID(attachment.ID).Delete(&TaskAttachment{})
	require.NoError(t, err)
	require.NoError(t, f.DeleteOnCommit(s))
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
	s = db.NewSession()
	_, err = s.Where("file_id = ?", f.ID).Delete(&compassMedia{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
	s = db.NewSession()
	_, err = s.Where("file_id = ?", f.ID).Delete(&compassEntryMedia{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, false)
}

func TestAccountCleanupRechecksReferencesAfterConcurrentReuse(t *testing.T) {
	prepareAccountCleanup(t)
	f := cleanupOwnedFile(t, 9999)
	writer := db.NewSession()
	defer writer.Close()
	// A Drive reuse transaction acquired its row before cleanup.
	_, err := writer.Exec("UPDATE drive_files SET revision = revision + 1 WHERE file_id = ?", f.ID)
	require.NoError(t, err)
	started := make(chan struct{})
	done := make(chan error, 1)
	go func() { close(started); done <- cleanupDeletedAccountFile(9999, f.ID) }()
	<-started
	// Let the cleaner reach its lock while the writer still owns it.
	time.Sleep(50 * time.Millisecond)
	_, err = writer.Insert(&TaskAttachment{TaskID: 1, FileID: f.ID, CreatedByID: 9999})
	require.NoError(t, err)
	require.NoError(t, writer.Commit())
	select {
	case err = <-done:
		if err != nil {
			require.Equal(t, schemas.SQLITE, db.Type())
			var sqliteErr sqlite3.Error
			require.ErrorAs(t, err, &sqliteErr)
			require.True(t, sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked, "%v", err)
		}
	case <-time.After(10 * time.Second):
		t.Fatal("cleanup did not release its Drive lock")
	}
	// SQLite may fail busy rather than wait; either way, the retry keeps the new reference.
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
}

func TestAccountCleanupKeepsBackgroundAndOtherChatPins(t *testing.T) {
	prepareAccountCleanup(t)
	f := cleanupOwnedFile(t, 9999)
	s := db.NewSession()
	_, err := s.Exec("UPDATE projects SET background_file_id = ? WHERE id = 1", f.ID)
	require.NoError(t, err)
	pin := &files.DriveChatRef{OwnerID: 1, ConversationID: driveChatA, FileID: f.ID}
	_, err = s.Insert(pin)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
	s = db.NewSession()
	_, err = s.Exec("UPDATE projects SET background_file_id = 0 WHERE id = 1")
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, true)
	db.AssertExists(t, "drive_chat_refs", map[string]interface{}{"id": pin.ID}, false)
	s = db.NewSession()
	_, err = s.ID(pin.ID).Delete(&files.DriveChatRef{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, false)
}

func TestAccountCleanupMissingModuleAndPurgingRestart(t *testing.T) {
	bridge := prepareAccountCleanup(t)
	f := cleanupOwnedFile(t, 9999)
	SetAccountCleanupBridge(nil)
	require.Error(t, CleanupDeletedAccount(9999))
	assertCleanupFile(t, f, true)
	SetAccountCleanupBridge(bridge)
	// A previous cleanup committed the purge marker, then crashed before deleting
	// storage. The ordinary orphan scan must complete it without a separate queue.
	s := db.NewSession()
	_, err := s.Exec("UPDATE drive_files SET purging = ?, trashed_at = ? WHERE file_id = ?", true, time.Now(), f.ID)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, RetryDeletedAccountCleanup())
	assertCleanupFile(t, f, false)
}

func TestAccountCleanupRunsEveryPrivateModuleBeforeReleasingDrive(t *testing.T) {
	primary := prepareAccountCleanup(t)
	failed, successful := &cleanupTestBridge{failure: errors.New("push store unavailable")}, &cleanupTestBridge{}
	oldFirst := SetAccountCleanupModule("test-first", failed)
	oldSecond := SetAccountCleanupModule("test-second", successful)
	t.Cleanup(func() {
		SetAccountCleanupModule("test-first", oldFirst)
		SetAccountCleanupModule("test-second", oldSecond)
	})
	f := cleanupOwnedFile(t, 9999)
	require.Error(t, CleanupDeletedAccount(9999))
	require.Equal(t, []int64{9999}, primary.calls)
	require.Equal(t, []int64{9999}, failed.calls)
	require.Equal(t, []int64{9999}, successful.calls)
	assertCleanupFile(t, f, true)
	failed.failure = nil
	require.NoError(t, RetryDeletedAccountCleanup())
	require.Equal(t, 1, failed.retries)
	require.Equal(t, 1, successful.retries)
	assertCleanupFile(t, f, false)
}

func TestAccountCleanupWriteGateSerializesExternalDeletion(t *testing.T) {
	prepareAccountCleanup(t)
	entered, release := make(chan struct{}), make(chan struct{})
	var releaseOnce sync.Once
	defer releaseOnce.Do(func() { close(release) })
	writerResult, deleteResult := make(chan error, 1), make(chan error, 1)
	go func() {
		writerResult <- WithAccountWrite(4, func() error {
			close(entered)
			<-release
			return nil
		})
	}()
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("private write gate did not open")
	}
	remove := func() error {
		s := db.NewSession()
		defer s.Close()
		if _, err := s.ID(4).Delete(&user.User{}); err != nil {
			return err
		}
		return s.Commit()
	}
	go func() { deleteResult <- remove() }()
	var early error
	completed := false
	select {
	case early = <-deleteResult:
		completed = true
		// SQLite may report BUSY immediately. A successful deletion while the
		// callback still owns its write lease would permit late resurrection.
		require.Equal(t, schemas.SQLITE, db.Type())
		require.Error(t, early)
	case <-time.After(50 * time.Millisecond):
	}
	releaseOnce.Do(func() { close(release) })
	select {
	case err := <-writerResult:
		require.NoError(t, err)
	case <-time.After(5 * time.Second):
		t.Fatal("private write gate did not close")
	}
	if !completed {
		select {
		case early = <-deleteResult:
		case <-time.After(5 * time.Second):
			t.Fatal("external deletion did not finish after writer exit")
		}
	}
	if early != nil {
		var sqliteErr sqlite3.Error
		require.Equal(t, schemas.SQLITE, db.Type())
		require.ErrorAs(t, early, &sqliteErr)
		require.True(t, sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked)
		require.NoError(t, remove())
	}
	called := false
	err := WithAccountWrite(4, func() error { called = true; return nil })
	require.ErrorIs(t, err, ErrAccountCleanupUserMissing)
	require.False(t, called, "a stale request cannot persist after an external deletion")
}
