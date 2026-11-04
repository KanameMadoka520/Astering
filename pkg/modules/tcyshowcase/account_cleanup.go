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

package tcyshowcase

import (
	"errors"
	"os"
	"path/filepath"
	"strconv"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
)

var ErrAccountDeleted = errors.New("public page owner has been deleted")

// Protected by lock, as are all public-page writers. Scope fences to the backing
// store; a deleted UID is never automatically reactivated in that store.
var deletedOwners = map[string]map[int64]bool{}

func ownerStorePath() string {
	absolute, err := filepath.Abs(path())
	if err != nil {
		return path()
	}
	return absolute
}
func ownerDeleted(uid int64) bool { return deletedOwners[ownerStorePath()][uid] }

type accountCleanupBridge struct{}

func init() { models.SetAccountCleanupModule("showcase", accountCleanupBridge{}) }

func (accountCleanupBridge) CleanupDeletedUser(uid int64) error {
	if uid <= 0 {
		return nil
	}
	s := db.NewReadSession()
	exists, err := s.ID(uid).Exist(&user.User{})
	_ = s.Close()
	if err != nil || exists {
		return err
	}
	lock.Lock()
	defer lock.Unlock()
	lease, err := acquireStoreLock()
	if err != nil {
		return err
	}
	defer lease.Close()
	if deletedOwners[ownerStorePath()] == nil {
		deletedOwners[ownerStorePath()] = map[int64]bool{}
	}
	deletedOwners[ownerStorePath()][uid] = true
	states, err := read()
	if err != nil {
		return err
	}
	key := strconv.FormatInt(uid, 10)
	if _, exists := states[key]; exists {
		delete(states, key)
		if err = write(states); err != nil {
			return err
		}
	}
	return removeAbandonedSnapshots()
}

// Atomic-write snapshots are never authoritative. Under the module and OS store
// locks, none can belong to a live write. Removing them also removes partially written
// snapshots whose owner IDs could not be recovered after a crash.
func removeAbandonedSnapshots() error {
	paths, err := filepath.Glob(filepath.Join(filepath.Dir(path()), ".pages-*"))
	if err != nil {
		return err
	}
	var failures []error
	for _, temporary := range paths {
		if err := os.Remove(temporary); err != nil && !errors.Is(err, os.ErrNotExist) {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func (bridge accountCleanupBridge) RetryDeletedUsers() error {
	lock.Lock()
	lease, err := acquireStoreLock()
	if err != nil {
		lock.Unlock()
		return err
	}
	states, err := read()
	temporaryErr := removeAbandonedSnapshots()
	_ = lease.Close()
	lock.Unlock()
	if err != nil {
		return errors.Join(err, temporaryErr)
	}
	var failures []error
	if temporaryErr != nil {
		failures = append(failures, temporaryErr)
	}
	for key := range states {
		uid, parseErr := strconv.ParseInt(key, 10, 64)
		if parseErr != nil || uid <= 0 {
			continue
		}
		if err = bridge.CleanupDeletedUser(uid); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}
