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

package bark

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
)

var ErrAccountDeleted = errors.New("push account has been deleted")

type accountStoreKey struct {
	root string
	uid  int64
}

var deletedAccounts sync.Map
var accountWrite = models.WithAccountWrite
var accountUserExists = readAccountUserExists

func readAccountUserExists(uid int64) (bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	return s.ID(uid).Exist(&user.User{})
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

func cleanupRevokedAccount(uid int64) {
	if accountDeleted(uid) {
		_ = (accountCleanupBridge{}).CleanupDeletedUser(uid)
	}
}

func requireActiveAccount(uid int64) error {
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

func accountKey(uid int64) accountStoreKey {
	root := directory()
	if absolute, err := filepath.Abs(root); err == nil {
		root = absolute
	}
	return accountStoreKey{root: root, uid: uid}
}

func accountDeleted(uid int64) bool {
	_, deleted := deletedAccounts.Load(accountKey(uid))
	return deleted
}

type deliveryJob struct {
	key       accountStoreKey
	cancel    context.CancelFunc
	watchDone chan struct{}
}

// Protected by the same lock as encrypted settings and queue writes. Cleanup
// cancels requests but never waits for their callbacks while holding this lock.
var deliveries = map[accountStoreKey]map[*deliveryJob]struct{}{}

func beginDeliveryLocked(ctx context.Context, uid int64) (context.Context, *deliveryJob, error) {
	if err := requireActiveAccount(uid); err != nil {
		return nil, nil, err
	}
	requestCtx, cancel := context.WithCancel(ctx)
	job := &deliveryJob{key: accountKey(uid), cancel: cancel, watchDone: make(chan struct{})}
	if deliveries[job.key] == nil {
		deliveries[job.key] = map[*deliveryJob]struct{}{}
	}
	deliveries[job.key][job] = struct{}{}
	go func() { defer close(job.watchDone); watchDeliveryAccount(requestCtx, job) }()
	return requestCtx, job, nil
}

func watchDeliveryAccount(ctx context.Context, job *deliveryJob) {
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			exists, err := accountUserExists(job.key.uid)
			if err != nil || !exists {
				job.cancel()
				if err == nil {
					_ = (accountCleanupBridge{}).CleanupDeletedUser(job.key.uid)
				}
				return
			}
		}
	}
}

func currentDeliveryLocked(job *deliveryJob) bool {
	_, active := deliveries[job.key][job]
	return active && accountKey(job.key.uid) == job.key && !accountDeleted(job.key.uid)
}

func finishDelivery(job *deliveryJob) {
	lock.Lock()
	delete(deliveries[job.key], job)
	if len(deliveries[job.key]) == 0 {
		delete(deliveries, job.key)
	}
	lock.Unlock()
	job.cancel()
}

type accountCleanupBridge struct {
	removeAll func(string) error
}

func init() { models.SetAccountCleanupModule("bark", accountCleanupBridge{}) }

func (bridge accountCleanupBridge) CleanupDeletedUser(uid int64) error {
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
	key := accountKey(uid)
	deletedAccounts.Store(key, struct{}{})
	for job := range deliveries[key] {
		job.cancel()
	}
	delete(deliveries, key)
	lock.Unlock()

	// Writers that entered first have drained. Later saves and delivery results
	// reject the monotonic fence under lock, so slow I/O cannot block other users.
	paths, err := filepath.Glob(filepath.Join(key.root, fmt.Sprintf(".push-%d-*", uid)))
	if err != nil {
		return err
	}
	remove := bridge.removeAll
	if remove == nil {
		remove = os.RemoveAll
	}
	var failures []error
	for _, file := range append(paths, path(uid)) {
		if err := remove(file); err != nil {
			failures = append(failures, err)
		}
	}
	return errors.Join(failures...)
}

func privateAccountID(name string) (int64, bool) {
	switch {
	case strings.HasPrefix(name, ".push-"):
		parts := strings.SplitN(strings.TrimPrefix(name, ".push-"), "-", 2)
		if len(parts) != 2 {
			return 0, false
		}
		name = parts[0]
	case strings.HasSuffix(name, ".enc"):
		name = strings.TrimSuffix(name, ".enc")
	default:
		return 0, false
	}
	uid, err := strconv.ParseInt(name, 10, 64)
	return uid, err == nil && uid > 0 && strconv.FormatInt(uid, 10) == name
}

func (bridge accountCleanupBridge) RetryDeletedUsers() error {
	owners := map[int64]struct{}{}
	lock.Lock()
	for key := range deliveries {
		if key.root == accountKey(0).root {
			owners[key.uid] = struct{}{}
		}
	}
	lock.Unlock()
	entries, err := os.ReadDir(directory())
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	for _, entry := range entries {
		if uid, valid := privateAccountID(entry.Name()); valid {
			owners[uid] = struct{}{}
		}
	}
	var failures []error
	for uid := range owners {
		if err := bridge.CleanupDeletedUser(uid); err != nil {
			failures = append(failures, fmt.Errorf("deleted push account %d: %w", uid, err))
		}
	}
	return errors.Join(failures...)
}
