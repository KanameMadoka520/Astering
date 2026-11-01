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
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/notifications"
	"code.vikunja.io/api/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func accountCleanupFixture(t *testing.T, uid int64) *xorm.Engine {
	t.Helper()
	config.InitDefaultConfig()
	log.InitLogger()
	events.Fake()
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	previousWrite, previousExists := accountWrite, accountUserExists
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("bark-account-fixture")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	accountWrite, accountUserExists = models.WithAccountWrite, readAccountUserExists
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow)
		accountWrite, accountUserExists = previousWrite, previousExists
	})
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.Sync2(models.GetTables()...))
	require.NoError(t, engine.Sync2(&user.User{}, &notifications.DatabaseNotification{}))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	_, err = engine.Insert(&user.User{ID: uid, Username: fmt.Sprintf("bark-cleanup-%d", uid), Email: "fixture@example.test"})
	require.NoError(t, err)
	t.Cleanup(func() { _, cleanupErr := engine.ID(uid).Delete(&user.User{}); assert.NoError(t, cleanupErr) })
	return engine
}

func awaitSignal(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("Bark lifecycle did not finish")
	}
}

func TestBarkAccountCleanupPreservesExistingAndRetries(t *testing.T) {
	const uid int64 = 93101
	engine := accountCleanupFixture(t, uid)
	r, err := read(uid)
	require.NoError(t, err)
	r.Settings.DeviceKey = "private-device-fixture"
	r.Deliveries = []BarkDelivery{{NotificationID: 12, Status: "pending"}}
	require.NoError(t, write(uid, r))
	before, err := os.ReadFile(path(uid))
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	after, err := os.ReadFile(path(uid))
	require.NoError(t, err)
	assert.Equal(t, before, after)
	root := accountKey(uid).root
	temporary := filepath.Join(root, fmt.Sprintf(".push-%d-crash", uid))
	require.NoError(t, os.WriteFile(temporary, []byte("encrypted temporary data"), 0600))
	other := filepath.Join(root, "system-note")
	require.NoError(t, os.WriteFile(other, []byte("keep"), 0600))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	injected := errors.New("temporary disk failure")
	bridge := accountCleanupBridge{removeAll: func(file string) error {
		if file == path(uid) {
			return injected
		}
		return os.RemoveAll(file)
	}}
	require.ErrorIs(t, bridge.CleanupDeletedUser(uid), injected)
	assert.FileExists(t, path(uid))
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.NoFileExists(t, path(uid))
	assert.NoFileExists(t, temporary)
	deletedAccounts.Delete(accountKey(uid))                   // Explicit process-restart simulation, never production UID reuse.
	require.NoError(t, os.WriteFile(path(uid), before, 0600)) // #nosec G703 -- fixed fixture UID 93101 and t.TempDir store; no external path input.
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.NoFileExists(t, path(uid))
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(0))
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(-1))
	assert.FileExists(t, other)
	_, err = Save(uid, r.Settings)
	require.ErrorIs(t, err, ErrAccountDeleted)
}

func TestBarkAccountCleanupStopsDeliveryAndLateQueueWrites(t *testing.T) {
	for index, variant := range []struct{ queue, external bool }{{false, false}, {true, false}, {false, true}, {true, true}} {
		t.Run(fmt.Sprintf("queue-%t-external-%t", variant.queue, variant.external), func(t *testing.T) {
			uid := int64(93110 + index)
			engine := accountCleanupFixture(t, uid)
			started, cancelled := make(chan struct{}), make(chan struct{})
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
				_, _ = io.Copy(io.Discard, request.Body)
				calls.Add(1)
				close(started)
				<-request.Context().Done()
				close(cancelled)
			}))
			t.Cleanup(server.Close)
			r, err := read(uid)
			require.NoError(t, err)
			r.Settings.Enabled, r.Settings.DeviceKey, r.Settings.ServerURL = true, "target-device-fixture", server.URL
			require.NoError(t, write(uid, r))
			_, err = engine.Insert(&notifications.DatabaseNotification{NotifiableID: uid, Name: "task.reminder", Notification: json.RawMessage(`{"task":{"id":123}}`)})
			require.NoError(t, err)
			otherUID := uid + 100
			_, err = engine.Insert(&user.User{ID: otherUID, Username: fmt.Sprintf("bark-other-%d", uid), Email: "other@example.test"})
			require.NoError(t, err)
			require.NoError(t, write(otherUID, r))
			otherBefore, err := os.ReadFile(path(otherUID))
			require.NoError(t, err)
			result := make(chan error, 1)
			requestCtx, cancel := context.WithCancel(context.Background())
			t.Cleanup(cancel)
			go func() {
				if variant.queue {
					result <- processUser(requestCtx, uid)
				} else {
					_, testErr := Test(requestCtx, uid)
					result <- testErr
				}
			}()
			awaitSignal(t, started)
			lock.Lock()
			var job *deliveryJob
			for active := range deliveries[accountKey(uid)] {
				job = active
			}
			lock.Unlock()
			require.NotNil(t, job)
			_, err = engine.ID(uid).Delete(&user.User{})
			require.NoError(t, err)
			if !variant.external {
				require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
			}
			awaitSignal(t, cancelled)
			select {
			case err = <-result:
				require.ErrorIs(t, err, ErrAccountDeleted)
			case <-time.After(5 * time.Second):
				t.Fatal("delivery callback deadlocked with account cleanup")
			}
			awaitSignal(t, job.watchDone)
			assert.EqualValues(t, 1, calls.Load())
			assert.NoFileExists(t, path(uid), "late delivery settlement must not revive credentials or queue")
			otherAfter, err := os.ReadFile(path(otherUID))
			require.NoError(t, err)
			assert.Equal(t, otherBefore, otherAfter)
			_, err = Save(uid, r.Settings)
			require.ErrorIs(t, err, ErrAccountDeleted)
			require.ErrorIs(t, processUser(context.Background(), uid), ErrAccountDeleted)
		})
	}
}

func TestBarkAccountCleanupExternalDeleteRejectsSave(t *testing.T) {
	const uid int64 = 93102
	engine := accountCleanupFixture(t, uid)
	r, err := read(uid)
	require.NoError(t, err)
	r.Settings.DeviceKey = "private-device-fixture"
	require.NoError(t, write(uid, r))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	_, err = Save(uid, r.Settings)
	require.ErrorIs(t, err, ErrAccountDeleted)
	assert.NoFileExists(t, path(uid))
}
