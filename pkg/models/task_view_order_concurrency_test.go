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
	"context"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/contexts"
	"xorm.io/xorm/schemas"
)

type taskOrderLockProbeKey struct{}
type taskOrderLockProbe struct {
	once    sync.Once
	reached chan struct{}
}
type taskOrderLockObserver struct{}

var taskOrderObserverOnce sync.Once

func (taskOrderLockObserver) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	probe, _ := c.Ctx.Value(taskOrderLockProbeKey{}).(*taskOrderLockProbe)
	if probe != nil && strings.Contains(strings.ToUpper(c.SQL), "FOR UPDATE") && strings.Contains(c.SQL, "project_views") {
		probe.once.Do(func() { close(probe.reached) })
	}
	return c.Ctx, nil
}
func (taskOrderLockObserver) AfterProcess(_ *contexts.ContextHook) error { return nil }

func TestTaskViewOrderPostgresRevocationAfterLock(t *testing.T) {
	if db.Type() != schemas.POSTGRES {
		t.Skip("requires real PostgreSQL row locks")
	}
	scope, tasks, _ := taskOrderFixture(t, 3, true)
	original := taskOrderRead(t, scope)
	setup := db.NewSession()
	_, err := setup.Insert(&ProjectUser{
		ProjectID:  scope.ProjectID,
		UserID:     2,
		Permission: PermissionWrite,
	})
	require.NoError(t, err)
	require.NoError(t, setup.Commit())
	require.NoError(t, setup.Close())
	engine, err := db.CreateDBEngine()
	require.NoError(t, err)
	taskOrderObserverOnce.Do(func() { engine.AddHook(taskOrderLockObserver{}) })
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectViewsForTaskMutation(blocker, scope.ProjectID))
	probe := &taskOrderLockProbe{reached: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), taskOrderLockProbeKey{}, probe), 5*time.Second)
	defer cancel()
	done := make(chan error, 1)
	go func() {
		s := db.NewSession()
		defer s.Close()
		defer events.CleanupPending(s)
		db.SetSessionContext(ctx, s)
		_, runErr := ReorderTaskView(ctx, s, &user.User{ID: 2}, scope, TaskOrderChange{
			TaskIDs:      []int64{tasks[2].ID},
			BeforeTaskID: tasks[0].ID,
			OrderVersion: original.Version,
		})
		if runErr == nil {
			runErr = s.Commit()
		}
		done <- runErr
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("reorder never reached the view lock")
	}
	// The writer already passed the initial grant check, but is blocked on the
	// official view lock. Revoking that grant does not need to acquire view locks.
	revoke := db.NewSession()
	_, err = revoke.Where("project_id = ? AND user_id = ?", scope.ProjectID, 2).Delete(&ProjectUser{})
	require.NoError(t, err)
	require.NoError(t, revoke.Commit())
	require.NoError(t, revoke.Close())
	select {
	case err = <-done:
		t.Fatalf("writer escaped held view lock: %v", err)
	default:
	}
	require.NoError(t, blocker.Rollback())
	select {
	case err = <-done:
		require.Error(t, err)
	case <-ctx.Done():
		t.Fatal("reorder did not settle after releasing the view lock")
	}
	require.True(t, IsErrGenericForbidden(err), "revoked write permission must be freshly checked: %v", err)
	assert.Equal(t, original.Version, taskOrderRead(t, scope).Version)
}

func TestTaskViewOrderPostgresPermissionDeadline(t *testing.T) {
	if db.Type() != schemas.POSTGRES {
		t.Skip("requires an independent PostgreSQL authorization connection")
	}
	scope, tasks, _ := taskOrderFixture(t, 3, true)
	original := taskOrderRead(t, scope)
	engine, err := db.CreateDBEngine()
	require.NoError(t, err)
	oldLimit := engine.DB().Stats().MaxOpenConnections
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	engine.SetMaxOpenConns(1)
	defer engine.SetMaxOpenConns(oldLimit)
	ctx, cancel := context.WithTimeout(context.Background(), 150*time.Millisecond)
	defer cancel()
	db.SetSessionContext(ctx, s)
	done := make(chan error, 1)
	go func() {
		_, runErr := ReorderTaskView(ctx, s, &user.User{ID: 1}, scope, TaskOrderChange{
			TaskIDs:      []int64{tasks[2].ID},
			BeforeTaskID: tasks[0].ID,
			OrderVersion: original.Version,
		})
		done <- runErr
	}()
	select {
	case err = <-done:
	case <-time.After(3 * time.Second):
		// A regression must fail boundedly rather than wedging the whole test suite.
		engine.SetMaxOpenConns(oldLimit)
		select {
		case <-done:
		case <-time.After(3 * time.Second):
			t.Fatal("permission query remained stuck after restoring pool")
		}
		t.Fatal("permission query did not honor its context deadline")
	}
	require.Error(t, err)
	require.ErrorIs(t, ctx.Err(), context.DeadlineExceeded)
	require.NoError(t, s.Rollback())
	require.NoError(t, s.Close())
	engine.SetMaxOpenConns(oldLimit)
	assert.Equal(t, original.Version, taskOrderRead(t, scope).Version)
}
