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
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/contexts"
	"xorm.io/xorm/schemas"
)

type accountReadProbeKey struct{}
type accountReadProbe struct {
	attempts  atomic.Int32
	blocked   chan struct{}
	once      sync.Once
	forcedErr error
}
type accountReadObserver struct{}

var accountReadObserverOnce sync.Once

func (accountReadObserver) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	probe, _ := c.Ctx.Value(accountReadProbeKey{}).(*accountReadProbe)
	if probe != nil && strings.HasPrefix(strings.ToUpper(c.SQL), "SELECT") && strings.Contains(strings.ToUpper(c.SQL), "USERS") {
		if probe.attempts.Add(1) == 2 {
			probe.once.Do(func() { close(probe.blocked) })
		}
		return c.Ctx, probe.forcedErr
	}
	return c.Ctx, nil
}

func (accountReadObserver) AfterProcess(*contexts.ContextHook) error { return nil }

func accountReadContext(t *testing.T) (context.Context, *accountReadProbe) {
	t.Helper()
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	accountReadObserverOnce.Do(func() { engine.AddHook(accountReadObserver{}) })
	probe := &accountReadProbe{blocked: make(chan struct{})}
	return context.WithValue(context.Background(), accountReadProbeKey{}, probe), probe
}

func TestTCYAIAccountReadRechecksSuspensionAfterSQLiteLock(t *testing.T) {
	const uid int64 = 91260
	accountCleanupFixture(t, uid)
	if db.Type() != schemas.SQLITE {
		t.Skip("requires SQLite's transient shared-cache read lock")
	}
	ctx, probe := accountReadContext(t)
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	writer := db.NewSession()
	defer writer.Close()
	_, err := writer.ID(uid).Cols("status").Update(&user.User{Status: user.StatusDisabled})
	require.NoError(t, err)
	// SQLite can report this error while scanning the rows, after its query hook
	// already ran. Verify the real contention directly before observing retries.
	_, _, err = readCurrentAccountAttempt(context.Background(), uid)
	var contention sqlite3.Error
	require.ErrorAs(t, err, &contention)
	require.True(t, contention.Code == sqlite3.ErrBusy || contention.Code == sqlite3.ErrLocked, "%v", err)
	type result struct {
		identity *user.User
		exists   bool
		err      error
	}
	done := make(chan result, 1)
	go func() {
		identity, exists, readErr := readCurrentAccount(ctx, uid)
		done <- result{identity: identity, exists: exists, err: readErr}
	}()
	select {
	case <-probe.blocked:
	case <-ctx.Done():
		t.Fatal("identity read never encountered the held SQLite users lock")
	}
	select {
	case early := <-done:
		t.Fatalf("transient lock ended the read instead of waiting: %v", early.err)
	default:
	}
	require.NoError(t, writer.Commit())
	select {
	case actual := <-done:
		require.NoError(t, actual.err)
		require.True(t, actual.exists)
		require.NotNil(t, actual.identity)
		assert.Equal(t, user.StatusDisabled, actual.identity.Status, "retry must observe current committed status, never a cached pre-lock identity")
	case <-ctx.Done():
		t.Fatal("identity read did not finish after the SQLite users lock released")
	}
	assert.GreaterOrEqual(t, probe.attempts.Load(), int32(2))
	exists, err := readAccountUserExists(uid)
	assert.True(t, exists, "suspended accounts still exist")
	require.ErrorIs(t, err, ErrAccountInactive)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	assert.False(t, accountDeleted(uid), "cleanup's shared read must never interpret suspension as deletion")
}

func TestTCYAIAccountReadDoesNotRetryOtherDatabaseErrors(t *testing.T) {
	const uid int64 = 91261
	accountCleanupFixture(t, uid)
	ctx, probe := accountReadContext(t)
	// Matching text alone must never turn arbitrary errors into retryable locks.
	probe.forcedErr = errors.New("database table is locked: users")
	_, exists, err := readCurrentAccount(ctx, uid)
	require.ErrorIs(t, err, probe.forcedErr)
	assert.False(t, exists)
	assert.EqualValues(t, 1, probe.attempts.Load())
}

func TestTCYAIAccountReadRejectsUnknownStatusWithoutDeleting(t *testing.T) {
	const uid int64 = 91263
	engine := accountCleanupFixture(t, uid)
	_, err := engine.ID(uid).Cols("status").Update(&user.User{Status: user.Status(99)})
	require.NoError(t, err)
	exists, err := readAccountUserExists(uid)
	assert.True(t, exists)
	require.ErrorIs(t, err, ErrAccountInactive)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	assert.False(t, accountDeleted(uid))
}

func TestTCYAIAccountReadHonorsTotalSQLiteDeadline(t *testing.T) {
	const uid int64 = 91262
	accountCleanupFixture(t, uid)
	if db.Type() != schemas.SQLITE {
		t.Skip("requires SQLite's typed lock errors")
	}
	for _, code := range []sqlite3.ErrNo{sqlite3.ErrBusy, sqlite3.ErrLocked} {
		t.Run(code.Error(), func(t *testing.T) {
			ctx, probe := accountReadContext(t)
			probe.forcedErr = sqlite3.Error{Code: code}
			ctx, cancel := context.WithTimeout(ctx, 35*time.Millisecond)
			defer cancel()
			started := time.Now()
			_, exists, err := readCurrentAccount(ctx, uid)
			require.ErrorIs(t, err, context.DeadlineExceeded)
			assert.False(t, exists)
			assert.GreaterOrEqual(t, probe.attempts.Load(), int32(2))
			assert.Less(t, time.Since(started), time.Second, "one deadline bounds the entire retry sequence")
		})
	}
}
