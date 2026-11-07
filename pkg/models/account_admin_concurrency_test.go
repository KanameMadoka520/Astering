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

type accountCredentialProbeKey struct{}
type accountCredentialProbe struct {
	once    sync.Once
	reached chan struct{}
}
type accountCredentialObserver struct{}

var accountCredentialObserverOnce sync.Once

func (accountCredentialObserver) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	probe, _ := c.Ctx.Value(accountCredentialProbeKey{}).(*accountCredentialProbe)
	query := strings.ToUpper(c.SQL)
	if probe != nil && strings.Contains(query, "USERS") && strings.Contains(query, "FOR UPDATE") {
		probe.once.Do(func() { close(probe.reached) })
	}
	return c.Ctx, nil
}
func (accountCredentialObserver) AfterProcess(*contexts.ContextHook) error { return nil }

func accountCredentialContext(t *testing.T) (context.Context, *accountCredentialProbe) {
	t.Helper()
	if kind := db.Type(); kind != schemas.POSTGRES && kind != schemas.MYSQL {
		t.Skip("requires real PostgreSQL or MySQL users-row locks")
	}
	engine, err := db.CreateDBEngine()
	require.NoError(t, err)
	accountCredentialObserverOnce.Do(func() { engine.AddHook(accountCredentialObserver{}) })
	probe := &accountCredentialProbe{reached: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), accountCredentialProbeKey{}, probe), 10*time.Second)
	t.Cleanup(cancel)
	return ctx, probe
}

func accountWaitForGate(ctx context.Context, t *testing.T, probe *accountCredentialProbe, done <-chan error) {
	t.Helper()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("request never reached its users-row gate")
	}
	select {
	case err := <-done:
		t.Fatalf("request escaped the held users-row gate: %v", err)
	default:
	}
}

func accountWaitForResult(ctx context.Context, t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		t.Fatal("request did not finish after the users-row gate released")
		return ctx.Err()
	}
}

func TestAccountCredentialConcurrentRevocationRejectsWaitingIssuer(t *testing.T) {
	ctx, probe := accountCredentialContext(t)
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	revoker := db.NewSession()
	defer revoker.Close()
	defer events.CleanupPending(revoker)
	_, err := RevokeManagedAccountAccess(revoker, &user.User{ID: 1}, 2, AccountAccessRevoke{ConfirmUsername: "user2"})
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		issuer := db.NewSession()
		defer issuer.Close()
		db.SetSessionContext(ctx, issuer)
		actor := user.WithSessionCredential(&user.User{ID: 2}, "550e8400-e29b-41d4-a716-446655440003")
		err := (&APIToken{Title: "must not replace revoked access", ExpiresAt: time.Now().Add(time.Hour)}).Create(issuer, actor)
		if err == nil {
			err = issuer.Commit()
		}
		done <- err
	}()
	accountWaitForGate(ctx, t, probe, done)
	require.NoError(t, revoker.Commit())
	events.DispatchPending(context.Background(), revoker)
	err = accountWaitForResult(ctx, t, done)
	assert.True(t, IsErrGenericForbidden(err), "a previously admitted request must recheck its original sid after waiting: %v", err)
	read := db.NewReadSession()
	defer read.Close()
	n, err := read.Where("owner_id = ?", 2).Count(new(APIToken))
	require.NoError(t, err)
	assert.Zero(t, n)
}

func TestAccountManagementConcurrentRechecksRevokedAdminSession(t *testing.T) {
	ctx, probe := accountCredentialContext(t)
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	logout := db.NewSession()
	defer logout.Close()
	defer events.CleanupPending(logout)
	_, err := logout.ForUpdate().ID(1).Get(&user.User{})
	require.NoError(t, err)
	require.NoError(t, DeleteAllUserSessions(logout, 1))
	done := make(chan error, 1)
	go func() {
		management := db.NewSession()
		defer management.Close()
		defer events.CleanupPending(management)
		db.SetSessionContext(ctx, management)
		actor := user.WithSessionCredential(&user.User{ID: 1}, "550e8400-e29b-41d4-a716-446655440001")
		_, err := ChangeManagedAccountStatus(management, actor, 2, AccountStatusChange{Status: user.StatusDisabled, ExpectedStatus: user.StatusActive, ConfirmUsername: "user2"})
		if err == nil {
			err = management.Commit()
		}
		done <- err
	}()
	accountWaitForGate(ctx, t, probe, done)
	require.NoError(t, logout.Commit())
	events.DispatchPending(context.Background(), logout)
	err = accountWaitForResult(ctx, t, done)
	var denied *AccountAdminError
	require.ErrorAs(t, err, &denied)
	assert.Equal(t, "account_management_forbidden", denied.Key)
	read := db.NewReadSession()
	defer read.Close()
	identity, err := user.GetUserByIDForAuth(read, 2)
	require.NoError(t, err)
	assert.Equal(t, user.StatusActive, identity.Status)
	n, err := read.Count(new(AccountAdminEvent))
	require.NoError(t, err)
	assert.Zero(t, n, "a revoked administrator must not commit the queued operation or its audit")
}

func TestAccountCredentialCurrentDeleteCountsNewlyCommittedSession(t *testing.T) {
	ctx, _ := accountCredentialContext(t)
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	revoker := db.NewSession()
	defer revoker.Close()
	defer events.CleanupPending(revoker)
	db.SetSessionContext(ctx, revoker)
	// Establish an older repeatable-read snapshot before another login commits.
	before, err := revoker.Where("user_id = ?", 2).Count(new(Session))
	require.NoError(t, err)
	issuer := db.NewSession()
	_, err = CreateSession(issuer, 2, "newly committed login", "127.0.0.1", false, nil)
	require.NoError(t, err)
	require.NoError(t, issuer.Commit())
	require.NoError(t, issuer.Close())
	result, err := RevokeManagedAccountAccess(revoker, &user.User{ID: 1}, 2, AccountAccessRevoke{ConfirmUsername: "user2"})
	require.NoError(t, err)
	assert.Equal(t, before+1, result.RevokedSessions, "audit counts actual DELETE rows, not an older repeatable-read COUNT")
	require.NoError(t, revoker.Commit())
	events.DispatchPending(context.Background(), revoker)
}
