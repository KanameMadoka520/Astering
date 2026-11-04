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
	"sort"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// AccountCleanupBridge keeps optional encrypted user data outside the models package.
// Calls run after commit, never while holding the deleting transaction's locks.
type AccountCleanupBridge interface {
	CleanupDeletedUser(userID int64) error
	RetryDeletedUsers() error
}

var accountCleanupBridge struct {
	sync.RWMutex
	value   AccountCleanupBridge
	modules map[string]AccountCleanupBridge
}

// SetAccountCleanupBridge installs the optional module and returns the previous bridge.
func SetAccountCleanupBridge(bridge AccountCleanupBridge) AccountCleanupBridge {
	accountCleanupBridge.Lock()
	defer accountCleanupBridge.Unlock()
	previous := accountCleanupBridge.value
	accountCleanupBridge.value = bridge
	return previous
}

func getAccountCleanupBridge() AccountCleanupBridge {
	accountCleanupBridge.RLock()
	defer accountCleanupBridge.RUnlock()
	return accountCleanupBridge.value
}

// SetAccountCleanupModule registers an additional account-owned private store.
// Registration occurs during module init; nil removes an entry for isolated tests.
func SetAccountCleanupModule(name string, bridge AccountCleanupBridge) AccountCleanupBridge {
	accountCleanupBridge.Lock()
	defer accountCleanupBridge.Unlock()
	if accountCleanupBridge.modules == nil {
		accountCleanupBridge.modules = map[string]AccountCleanupBridge{}
	}
	previous := accountCleanupBridge.modules[name]
	if bridge == nil {
		delete(accountCleanupBridge.modules, name)
	} else {
		accountCleanupBridge.modules[name] = bridge
	}
	return previous
}

func accountCleanupModules() []AccountCleanupBridge {
	accountCleanupBridge.RLock()
	defer accountCleanupBridge.RUnlock()
	names := make([]string, 0, len(accountCleanupBridge.modules))
	for name := range accountCleanupBridge.modules {
		names = append(names, name)
	}
	sort.Strings(names)
	result := make([]AccountCleanupBridge, 0, len(names))
	for _, name := range names {
		result = append(result, accountCleanupBridge.modules[name])
	}
	return result
}

// CleanupDeletedAccount is idempotent. A missing users row is the durable deletion
// marker: a crash between commit and this callback is recovered by the hourly scan.
// IDs of deleted accounts must never be manually reused.
func CleanupDeletedAccount(userID int64) error {
	if userID <= 0 {
		return nil
	}
	s := db.NewReadSession()
	exists, err := s.ID(userID).Exist(&user.User{})
	_ = s.Close()
	if err != nil || exists {
		return err
	}
	bridge := getAccountCleanupBridge()
	if bridge == nil {
		return errors.New("account private-store cleanup module is unavailable")
	}
	var privateFailures []error
	for _, module := range append([]AccountCleanupBridge{bridge}, accountCleanupModules()...) {
		if err = module.CleanupDeletedUser(userID); err != nil {
			privateFailures = append(privateFailures, fmt.Errorf("private account module %T: %w", module, err))
		}
	}
	if err = errors.Join(privateFailures...); err != nil {
		return err
	}
	// Private conversations are gone and their late writers are fenced. Shared
	// blobs stay pinned by their other references; never delete by uploader alone.
	s = db.NewSession()
	_, err = s.Where("owner_id = ?", userID).Delete(&files.DriveChatRef{})
	if err == nil {
		err = s.Commit()
	}
	_ = s.Close()
	if err != nil {
		return err
	}
	s = db.NewReadSession()
	var ids []int64
	err = s.Table(&files.DriveFile{}).Where("owner_id = ?", userID).Cols("file_id").Find(&ids)
	_ = s.Close()
	if err != nil {
		return err
	}
	var failures []error
	for _, id := range ids {
		if err := cleanupDeletedAccountFile(userID, id); err != nil {
			failures = append(failures, fmt.Errorf("deleted account %d file %d: %w", userID, id, err))
		}
	}
	return errors.Join(failures...)
}

// RetryDeletedAccountCleanup also runs when nobody is newly scheduled for deletion.
// Orphan Drive rows protect shared files until the last reference disappears; they
// remain a durable retry index through storage failures and process restarts.
func RetryDeletedAccountCleanup() error {
	var failures []error
	modules := accountCleanupModules()
	if bridge := getAccountCleanupBridge(); bridge != nil {
		modules = append(modules, bridge)
	}
	for _, module := range modules {
		if err := module.RetryDeletedUsers(); err != nil {
			failures = append(failures, err)
		}
	}
	owners := map[int64]struct{}{}
	for _, table := range []string{"drive_files", "drive_chat_refs"} {
		s := db.NewReadSession()
		var ids []int64
		err := s.Table(table).Select("DISTINCT owner_id").Where("owner_id > 0 AND NOT EXISTS (SELECT 1 FROM users WHERE users.id = " + table + ".owner_id)").Find(&ids)
		_ = s.Close()
		if err != nil {
			failures = append(failures, err)
			continue
		}
		for _, id := range ids {
			owners[id] = struct{}{}
		}
	}
	for id := range owners {
		if err := CleanupDeletedAccount(id); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func cleanupDeletedAccountFile(ownerID, fileID int64) error {
	s := db.NewSession()
	defer s.Close()
	// A conditional write serializes with every Drive reuse operation on SQLite,
	// PostgreSQL and MySQL; ordinary SELECTs after it could still see an old RR
	// snapshot, so reference probes below are locking current reads.
	changed, err := s.Exec("UPDATE drive_files SET revision = revision + 1 WHERE file_id = ? AND owner_id = ?", fileID, ownerID)
	if err != nil {
		return err
	}
	n, err := changed.RowsAffected()
	if err != nil || n == 0 {
		return err
	}
	owner := &user.User{}
	exists, err := routineCurrentRead(s).ID(ownerID).Get(owner)
	if err != nil || exists {
		return err
	}
	d := &files.DriveFile{}
	exists, err = routineCurrentRead(s).Where("file_id = ?", fileID).Get(d)
	if err != nil || !exists {
		return err
	}
	if !d.Purging {
		used, err := deletedAccountFileReferenced(s, fileID)
		if err != nil || used {
			return err
		}
		_, err = s.Where("file_id = ?", fileID).Cols("purging", "trashed_at").Update(&files.DriveFile{Purging: true, TrashedAt: time.Now()})
		if err != nil {
			return err
		}
	}
	if err = s.Commit(); err != nil {
		return err
	}
	// FinishDrivePurge preserves its tombstone on any storage/DB failure.
	return files.FinishDrivePurge(fileID)
}

func deletedAccountFileReferenced(s *xorm.Session, fileID int64) (bool, error) {
	// Keep even mounted Compass media without a saved entry: a simultaneous editor
	// may be about to use it. gcCompassImages removes such mounts under its space
	// lock; there is no reverse Drive→space lock here.
	for _, reference := range []struct{ table, column string }{
		{"task_attachments", "file_id"},
		{"projects", "background_file_id"},
		{"users", "avatar_file_id"},
		{"users", "export_file_id"},
		{"compass_media", "file_id"},
		{"compass_entry_media", "file_id"},
		{"compass_spaces", "background_file_id"},
		{"drive_chat_refs", "file_id"},
	} {
		var rows []struct {
			ID int64 `xorm:"id"`
		}
		err := routineCurrentRead(s).Table(reference.table).Select(reference.column+" AS id").Where(reference.column+" = ?", fileID).Limit(1).Find(&rows)
		if err != nil {
			return false, err
		}
		if len(rows) > 0 {
			return true, nil
		}
	}
	return false, nil
}

// ErrAccountCleanupUserMissing prevents a previously authorized request from
// recreating private data after a deletion committed in another process.
var ErrAccountCleanupUserMissing = errors.New("account no longer exists")

// WithAccountWrite serializes a private-store write with users-row deletion.
// The caller already holds its private store's writer lock. DeleteUser never
// takes such a lock until after commit, so this does not reverse its lock order.
// The callback must only persist its private store, not start another database
// transaction that needs to modify this user row.
func WithAccountWrite(userID int64, write func() error) error {
	if userID <= 0 {
		return ErrAccountCleanupUserMissing
	}
	s := db.NewSession()
	defer s.Close()
	if db.Type() == schemas.SQLITE {
		// SQLite has no SELECT FOR UPDATE. A no-op conditional write takes its
		// writer lock, and is rolled back when this read-only gate closes.
		if _, err := s.Exec("UPDATE users SET id = id WHERE id = ?", userID); err != nil {
			return err
		}
	}
	exists, err := routineCurrentRead(s).ID(userID).Get(&user.User{})
	if err != nil {
		return err
	}
	if !exists {
		return ErrAccountCleanupUserMissing
	}
	return write()
}
