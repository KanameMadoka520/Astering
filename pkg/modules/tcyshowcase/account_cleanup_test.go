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
	"sync"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func cleanupFixture(t *testing.T) *xorm.Engine {
	t.Helper()
	config.InitDefaultConfig()
	old := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(old) })
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.Sync2(&user.User{}))
	for _, uid := range []int64{91201, 91202} {
		_, err = engine.ID(uid).Delete(&user.User{})
		require.NoError(t, err)
		_, err = engine.Insert(&user.User{ID: uid, Username: "showcase-cleanup-" + strconv.FormatInt(uid, 10), Email: "fixture@example.test" + strconv.FormatInt(uid, 10)})
		require.NoError(t, err)
	}
	t.Cleanup(func() { _, _ = engine.In("id", 91201, 91202).Delete(&user.User{}) })
	return engine
}

func cleanupDraft(slug string) Draft {
	d := Default()
	d.Slug = slug
	d.Content = "Personal public content " + slug
	return d
}

func TestShowcaseAccountCleanupKeepsOtherOwnersAndRejectsLateSave(t *testing.T) {
	engine := cleanupFixture(t)
	own, other := cleanupDraft("deleted-owner"), cleanupDraft("living-owner")
	_, err := Save(91201, own, true)
	require.NoError(t, err)
	_, err = Save(91202, other, true)
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(91201))
	_, state, err := Public(own.Slug)
	require.NoError(t, err)
	require.Equal(t, own.Content, state.Published.Content)
	tx := engine.NewSession()
	defer tx.Close()
	require.NoError(t, tx.Begin())
	_, err = tx.ID(91201).Delete(&user.User{})
	require.NoError(t, err)
	require.NoError(t, tx.Rollback())
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(91201))
	_, err = Load(91201)
	require.NoError(t, err)
	_, err = engine.ID(91201).Delete(&user.User{})
	require.NoError(t, err)
	// A request admitted before deletion races the hook. Either it finishes
	// before cleanup, or the fence rejects it; it must never restore the page.
	var wg sync.WaitGroup
	wg.Add(1)
	result := make(chan error, 1)
	go func() { defer wg.Done(); _, saveErr := Save(91201, own, true); result <- saveErr }()
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(91201))
	wg.Wait()
	err = <-result
	require.True(t, err == nil || errors.Is(err, ErrAccountDeleted))
	_, _, err = Public(own.Slug)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, err = Save(91201, own, true)
	require.ErrorIs(t, err, ErrAccountDeleted)
	_, err = Unpublish(91201)
	require.ErrorIs(t, err, ErrAccountDeleted)
	_, state, err = Public(other.Slug)
	require.NoError(t, err)
	require.Equal(t, other.Content, state.Published.Content)
	data, err := os.ReadFile(path())
	require.NoError(t, err)
	require.NotContains(t, string(data), own.Content)
	require.Contains(t, string(data), other.Content)
}

func TestShowcaseAccountCleanupRetryAndSnapshotRecovery(t *testing.T) {
	engine := cleanupFixture(t)
	own, other := cleanupDraft("orphan-page"), cleanupDraft("preserved-page")
	_, err := Save(91201, own, true)
	require.NoError(t, err)
	_, err = Save(91202, other, true)
	require.NoError(t, err)
	_, err = engine.ID(91201).Delete(&user.User{})
	require.NoError(t, err)
	// Real filesystem failure must not remove another owner's page or undo fence.
	backup := path() + ".retained"
	require.NoError(t, os.Rename(path(), backup))
	require.NoError(t, os.Mkdir(path(), 0700))
	require.Error(t, (accountCleanupBridge{}).CleanupDeletedUser(91201))
	require.NoError(t, os.Remove(path()))
	require.NoError(t, os.Rename(backup, path()))
	_, err = Save(91201, own, true)
	require.ErrorIs(t, err, ErrAccountDeleted)
	// Restart has no memory fence. Persisted owner keys and abandoned atomic
	// snapshots are sufficient to discover cleanup, including partial snapshots.
	lock.Lock()
	delete(deletedOwners, path())
	lock.Unlock()
	temporary := filepath.Join(filepath.Dir(path()), ".pages-crashed")
	require.NoError(t, os.WriteFile(temporary, []byte("{partial private snapshot"), 0600))
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	require.NoFileExists(t, temporary)
	_, _, err = Public(own.Slug)
	require.ErrorIs(t, err, os.ErrNotExist)
	_, state, err := Public(other.Slug)
	require.NoError(t, err)
	require.Equal(t, other.Content, state.Published.Content)
}

func TestShowcaseAccountCleanupExternalDeleteRejectsWrites(t *testing.T) {
	engine := cleanupFixture(t)
	draft := cleanupDraft("external-delete")
	_, err := Save(91201, draft, true)
	require.NoError(t, err)
	// Simulates CLI/database deletion in another process: no local hook or
	// in-memory fence has run, but the persistent write gate must reject it.
	_, err = engine.ID(91201).Delete(&user.User{})
	require.NoError(t, err)
	draft.Content = "stale request must not replace the old content"
	_, err = Save(91201, draft, true)
	require.ErrorIs(t, err, ErrAccountDeleted)
	_, err = Unpublish(91201)
	require.ErrorIs(t, err, ErrAccountDeleted)
	data, err := os.ReadFile(path())
	require.NoError(t, err)
	require.NotContains(t, string(data), draft.Content)
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	_, _, err = Public(draft.Slug)
	require.ErrorIs(t, err, os.ErrNotExist)
}
