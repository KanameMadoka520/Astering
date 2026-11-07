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
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"slices"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
)

var ErrAccountDeleted = errors.New("AI account has been deleted")
var ErrAccountInactive = errors.New("AI account is not active")

type accountStoreKey struct {
	root string
	uid  int64
}

// A deleted UID is never reused in the same store. Separate store roots isolate
// test fixtures; observing a new users row must never un-revoke an old writer.
var deletedAccounts sync.Map
var accountWrite = models.WithAccountWrite
var accountUserExists = readAccountUserExists

func readAccountUserExists(uid int64) (bool, error) {
	identity, exists, err := readBackgroundCurrentAccount(uid)
	if err != nil || !exists {
		return exists, err
	}
	if identity.IsBot() || identity.Status != user.StatusActive {
		// Exists remains true. Suspension must never trigger deletion cleanup or
		// the permanent deleted-account fence; reactivation preserves all data.
		return true, ErrAccountInactive
	}
	return true, nil
}

func requireActiveAccount(uid int64) error {
	if uid <= 0 {
		return nil
	}
	if accountDeleted(uid) {
		return ErrAccountDeleted
	}
	exists, err := accountUserExists(uid)
	if err != nil {
		return err
	}
	if !exists {
		deletedAccounts.Store(accountKey(uid), struct{}{})
		return ErrAccountDeleted
	}
	return nil
}

func withAccountWrite(uid int64, write func() error) error {
	if accountDeleted(uid) {
		return ErrAccountDeleted
	}
	err := accountWrite(uid, write)
	if errors.Is(err, models.ErrAccountCleanupUserMissing) {
		deletedAccounts.Store(accountKey(uid), struct{}{})
		return ErrAccountDeleted
	}
	return err
}

// Only live model jobs poll. A separate CLI deletion cannot cancel this process's
// context directly, so detect it within one 2s poll plus the bounded DB read.
func watchAccount(ctx context.Context, uid int64, cancel context.CancelFunc, done <-chan struct{}) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-done:
			return
		case <-ticker.C:
			exists, err := accountUserExists(uid)
			if err != nil || !exists {
				cancel()
				if err == nil {
					_ = (accountCleanupBridge{}).CleanupDeletedUser(uid)
				}
				return
			}
		}
	}
}

func accountKey(uid int64) accountStoreKey {
	root := filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai")
	if absolute, err := filepath.Abs(root); err == nil {
		root = absolute
	}
	return accountStoreKey{root: root, uid: uid}
}

func accountDeleted(uid int64) bool {
	_, deleted := deletedAccounts.Load(accountKey(uid))
	return deleted
}

func currentLiveAccountLocked(uid int64, live *liveConversation) bool {
	return live != nil && conversations.live[liveKey(uid, live.id)] == live && live.storeRoot == accountKey(uid).root && !accountDeleted(uid)
}

func finishDeletedLiveAccount(uid int64, live *liveConversation) {
	conversations.Lock()
	if conversations.live[liveKey(uid, live.id)] == live && (accountDeleted(uid) || live.storeRoot != accountKey(uid).root) {
		delete(conversations.live, liveKey(uid, live.id))
	}
	conversations.Unlock()
	if live.storeRoot == accountKey(uid).root {
		cleanupRevokedAccount(uid)
	}
}

func cleanupRevokedAccount(uid int64) {
	if accountDeleted(uid) {
		_ = (accountCleanupBridge{}).CleanupDeletedUser(uid)
	}
}

type accountCleanupBridge struct {
	removeAll func(string) error
}

func init() {
	models.SetAccountCleanupBridge(accountCleanupBridge{})
	models.SetAccountRunRevoker(CancelAccountRuns)
}

// CancelAccountRuns stops all running/compacting conversations for one account.
// It is called only after credential-revocation commit. Private files, messages
// and ownership remain intact; late callbacks record a stopped result normally.
func CancelAccountRuns(uid int64) {
	conversations.Lock()
	defer conversations.Unlock()
	cancelAccountRunsLocked(uid)
}

func cancelAccountRunsLocked(uid int64) {
	storeKey := accountKey(uid)
	accountRunGenerations[storeKey]++
	for _, cancel := range accountEphemeralRuns[storeKey] {
		cancel()
	}
	for key, live := range conversations.live {
		if key.uid != uid || live.storeRoot != storeKey.root {
			continue
		}
		live.acceptingSteering = false
		if live.cancel != nil {
			live.cancel()
		}
	}
}

// CleanupDeletedUser runs only after the deleting DB transaction committed. The
// missing users row is the durable deletion marker; surviving private paths are
// the retry queue. Never wait for a worker while holding these locks: cancel it
// and let its late callbacks observe the fence and detached live identity.
func (bridge accountCleanupBridge) CleanupDeletedUser(uid int64) error {
	if uid <= 0 {
		return nil
	}
	_, exists, err := readBackgroundCurrentAccount(uid)
	if err != nil || exists {
		return err
	}
	key := accountKey(uid)
	// All private-store writers check this fence under their existing settings
	// or conversation lock. Drain writers that entered first, then release both
	// global locks before potentially slow filesystem deletion.
	settingsLock.Lock()
	conversations.Lock()
	deletedAccounts.Store(key, struct{}{})
	cancelAccountRunsLocked(uid)
	for liveID, live := range conversations.live {
		if liveID.uid != uid {
			continue
		}
		if live.cancel != nil {
			live.cancel()
		}
		delete(conversations.live, liveID)
	}
	forgetAccountDriveCache(uid)
	conversations.Unlock()
	settingsLock.Unlock()

	var failures []error
	paths := []string{fileFor(uid), conversationDir(uid), filepath.Join(key.root, "attachments", strconv.FormatInt(uid, 10))}
	temporary, globErr := filepath.Glob(filepath.Join(key.root, fmt.Sprintf(".settings-%d-*", uid)))
	if globErr != nil {
		failures = append(failures, globErr)
	}
	for _, path := range append(paths, temporary...) {
		remove := bridge.removeAll
		if remove == nil {
			remove = os.RemoveAll
		}
		if err := remove(path); err != nil {
			failures = append(failures, fmt.Errorf("remove deleted account private data: %w", err))
		}
	}
	return errors.Join(failures...)
}

func privateAccountID(name string) (int64, bool) {
	if strings.HasPrefix(name, ".settings-") {
		parts := strings.SplitN(strings.TrimPrefix(name, ".settings-"), "-", 2)
		if len(parts) != 2 {
			return 0, false
		}
		name = parts[0]
	} else {
		name = strings.TrimSuffix(name, ".enc")
	}
	uid, err := strconv.ParseInt(name, 10, 64)
	return uid, err == nil && uid > 0 && strconv.FormatInt(uid, 10) == name
}

func (bridge accountCleanupBridge) RetryDeletedUsers() error {
	owners := map[int64]struct{}{}
	conversations.Lock()
	for key := range conversations.live {
		owners[key.uid] = struct{}{}
	}
	conversations.Unlock()
	root := accountKey(0).root
	var failures []error
	for _, directory := range []string{root, filepath.Join(root, "conversations"), filepath.Join(root, "attachments")} {
		entries, err := os.ReadDir(directory)
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			failures = append(failures, err)
			continue
		}
		for _, entry := range entries {
			if uid, valid := privateAccountID(entry.Name()); valid {
				owners[uid] = struct{}{}
			}
		}
	}
	ids := make([]int64, 0, len(owners))
	for uid := range owners {
		ids = append(ids, uid)
	}
	slices.Sort(ids)
	for _, uid := range ids {
		if err := bridge.CleanupDeletedUser(uid); err != nil {
			failures = append(failures, fmt.Errorf("deleted AI account %d: %w", uid, err))
		}
	}
	return errors.Join(failures...)
}

func forgetAccountDriveCache(uid int64) {
	driveStatCache.Lock()
	for key := range driveStatCache.entries {
		if key[0] == uid {
			delete(driveStatCache.entries, key)
		}
	}
	driveStatCache.Unlock()
	driveBytesCache.Lock()
	defer driveBytesCache.Unlock()
	kept := driveBytesCache.entries[:0]
	for _, entry := range driveBytesCache.entries {
		if entry.key.uid == uid {
			driveBytesCache.size -= len(entry.data)
		} else {
			kept = append(kept, entry)
		}
	}
	clear(driveBytesCache.entries[len(kept):])
	driveBytesCache.entries = kept
}
