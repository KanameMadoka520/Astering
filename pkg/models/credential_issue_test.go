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
	"encoding/json"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func revokeCredentialFixture(t *testing.T, id int64) {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	_, err := RevokeManagedAccountAccess(s, &user.User{ID: 1}, id, AccountAccessRevoke{ConfirmUsername: "user2"})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
}
func TestCredentialIssueRejectsRevokedAuthenticatedRequest(t *testing.T) {
	const sid = "550e8400-e29b-41d4-a716-446655440003"
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	cases := []struct {
		name  string
		issue func(*user.User) error
	}{
		{name: "api token", issue: func(actor *user.User) error {
			s := db.NewSession()
			defer s.Close()
			return (&APIToken{Title: "late token", ExpiresAt: time.Now().Add(time.Hour)}).Create(s, actor)
		}},
		{name: "bot", issue: func(actor *user.User) error {
			s := db.NewSession()
			defer s.Close()
			return (&BotUser{User: user.User{Username: "bot-late-admin-revoke"}}).Create(s, actor)
		}},
		{name: "oauth authorization code", issue: func(actor *user.User) error {
			s := db.NewSession()
			defer s.Close()
			_, err := CreateOAuthCodeForAuth(s, actor, "test-client", "https://example.com/oauth", "challenge", "S256")
			return err
		}},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			actor := user.WithSessionCredential(&user.User{ID: 2}, sid)
			revokeCredentialFixture(t, 2)
			err := tc.issue(actor)
			assert.True(t, IsErrGenericForbidden(err), "the request passed its entry authentication before revocation, but must not mint credentials afterwards: %v", err)
		})
	}
}
func TestCredentialIssueRejectsRevokedAPITokenRequest(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	s := db.NewSession()
	token := &APIToken{Title: "proof", ExpiresAt: time.Now().Add(time.Hour)}
	require.NoError(t, token.Create(s, &user.User{ID: 2}))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	actor := user.WithAPITokenCredential(&user.User{ID: 2}, token.ID)
	revokeCredentialFixture(t, 2)
	s = db.NewSession()
	defer s.Close()
	err := (&APIToken{Title: "late replacement", ExpiresAt: time.Now().Add(time.Hour)}).Create(s, actor)
	assert.True(t, IsErrGenericForbidden(err), "revoked token cannot replace itself: %v", err)
}
func TestCredentialIssueLocksCurrentAccountStatus(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewReadSession()
	_, err := s.ID(2).Cols("status").Update(&user.User{Status: user.StatusDisabled})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	s = db.NewSession()
	defer s.Close()
	_, err = CreateSession(s, 2, "late login", "127.0.0.1", false, nil)
	assert.True(t, user.IsErrAccountDisabled(err), "stale authenticated login result cannot create a session for a disabled user: %v", err)
}
func TestCredentialIssueConsumedOAuthCodeCannotSurviveRevocation(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	s := db.NewSession()
	code, err := CreateOAuthCode(s, 2, "client", "https://example.com/cb", "challenge", "S256")
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	s = db.NewSession()
	consumed, err := GetAndDeleteOAuthCode(s, code)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NotEmpty(t, consumed.AuthorizationGeneration)
	revokeCredentialFixture(t, 2)
	s = db.NewSession()
	defer s.Close()
	require.NoError(t, LockCredentialIssue(s, &user.User{ID: 2}), "normal new login remains possible for active accounts")
	assert.Error(t, ValidateOAuthCodeExchange(consumed), "a code consumed before revocation must not mint a new session afterwards")
}
func TestAccountManagementRollbackKeepsCredentialsAndNoJournal(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	canceled := []int64{}
	previous := SetAccountRunRevoker(func(id int64) { canceled = append(canceled, id) })
	t.Cleanup(func() { SetAccountRunRevoker(previous) })
	s := db.NewSession()
	_, err := ChangeManagedAccountStatus(s, &user.User{ID: 1}, 2, AccountStatusChange{Status: user.StatusDisabled, ExpectedStatus: user.StatusActive, ConfirmUsername: "user2"})
	require.NoError(t, err)
	require.Empty(t, canceled, "cancellation is not allowed before commit")
	require.NoError(t, s.Rollback())
	events.CleanupPending(s)
	require.NoError(t, s.Close())
	s = db.NewReadSession()
	defer s.Close()
	u, err := user.GetUserByIDForAuth(s, 2)
	require.NoError(t, err)
	assert.Equal(t, user.StatusActive, u.Status)
	n, err := s.Where("user_id = ?", 2).Count(new(Session))
	require.NoError(t, err)
	assert.Positive(t, n)
	n, err = s.Count(new(AccountAdminEvent))
	require.NoError(t, err)
	assert.Zero(t, n)
	assert.Empty(t, canceled)
}

func TestAccountManagementReactivationRollbackKeepsLegacyCredentials(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	canceled := []int64{}
	previous := SetAccountRunRevoker(func(id int64) { canceled = append(canceled, id) })
	t.Cleanup(func() { SetAccountRunRevoker(previous) })
	// This disabled fixture deliberately retains an old session and API token,
	// as SetUserStatus and the historical/CLI suspension paths can do.
	s := db.NewSession()
	result, err := ChangeManagedAccountStatus(s, &user.User{ID: 1}, 17, AccountStatusChange{
		Status: user.StatusActive, ExpectedStatus: user.StatusDisabled, ConfirmUsername: "user17",
	})
	require.NoError(t, err)
	assert.Equal(t, int64(1), result.RevokedSessions)
	assert.Equal(t, int64(1), result.RevokedAPITokens)
	require.Empty(t, canceled, "restoring an account cannot cancel work before its transaction commits")
	require.NoError(t, s.Rollback())
	events.CleanupPending(s)
	require.NoError(t, s.Close())

	s = db.NewReadSession()
	defer s.Close()
	u := &user.User{}
	exists, err := s.ID(17).Get(u)
	require.NoError(t, err)
	require.True(t, exists)
	assert.Equal(t, user.StatusDisabled, u.Status)
	db.AssertExists(t, "sessions", map[string]interface{}{"id": "test-session-17", "user_id": 17}, false)
	db.AssertExists(t, "api_tokens", map[string]interface{}{"id": 4, "owner_id": 17}, false)
	n, err := s.Count(new(AccountAdminEvent))
	require.NoError(t, err)
	assert.Zero(t, n, "rolled-back restoration must not leave a successful journal entry")
	assert.Empty(t, canceled)
}

func TestAccountManagementRejectsAgentAndStaleAdminSession(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	s := db.NewReadSession()
	defer s.Close()
	_, err := RequireAccountSuperadmin(s, user.RestrictToResourcePermissions(&user.User{ID: 1}))
	require.Error(t, err, "Arona resource-only identity must not inherit configured superadmin operations")
	_, err = RequireAccountSuperadmin(s, user.WithSessionCredential(&user.User{ID: 1}, "revoked-admin-session"))
	require.Error(t, err, "an admin action waiting on a row lock must recheck its original session after the wait")
}
func TestCredentialScopeNotAcceptedFromJSON(t *testing.T) {
	original := user.WithSessionCredential(&user.User{ID: 2}, "private-current-session")
	raw, err := json.Marshal(original)
	require.NoError(t, err)
	assert.NotContains(t, string(raw), "private-current-session")
	var decoded user.User
	require.NoError(t, json.Unmarshal([]byte(`{"id":2,"credential":{"SessionID":"forged"},"session_id":"forged","api_token_id":777}`), &decoded))
	assert.Empty(t, decoded.CredentialScope().SessionID)
	assert.Zero(t, decoded.CredentialScope().APITokenID)
}

func TestAccountManagementRejectsUnknownSuperadminAfterEntryCheck(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	actor := user.WithSessionCredential(&user.User{ID: 1}, "550e8400-e29b-41d4-a716-446655440001")
	gate := db.NewReadSession()
	_, err := RequireAccountSuperadmin(gate, actor)
	require.NoError(t, err, "the original browser session is active at the entry check")
	require.NoError(t, gate.Close())

	write := db.NewReadSession()
	_, err = write.ID(actor.ID).Cols("status").Update(&user.User{Status: user.Status(99)})
	require.NoError(t, err)
	require.NoError(t, write.Close())

	s := db.NewSession()
	defer s.Close()
	result, err := RevokeManagedAccountAccess(s, actor, 2, AccountAccessRevoke{ConfirmUsername: "user2"})
	var denied *AccountAdminError
	require.ErrorAs(t, err, &denied)
	assert.Equal(t, "account_management_forbidden", denied.Key, "fresh authorization must deny every status except active")
	assert.Nil(t, result)
	require.NoError(t, s.Rollback())
	db.AssertMissing(t, "account_admin_events", map[string]interface{}{"actor_id": actor.ID})
	db.AssertExists(t, "sessions", map[string]interface{}{"id": "550e8400-e29b-41d4-a716-446655440003", "user_id": 2}, false)
}

func TestAccountMutationCurrentPermissionsRejectInactiveActor(t *testing.T) {
	for _, status := range []user.Status{user.StatusDisabled, user.StatusAccountLocked, user.StatusEmailConfirmationRequired} {
		t.Run(status.String(), func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			write := db.NewReadSession()
			_, err := write.ID(1).Cols("status").Update(&user.User{Status: status})
			require.NoError(t, err)
			require.NoError(t, write.Close())
			s := db.NewSession()
			defer s.Close()
			_, _, err = currentProjectReadPermission(s, &user.User{ID: 1}, 1)
			assert.True(t, IsErrGenericForbidden(err), "a stale active principal must not remain authorized after suspension: %v", err)
		})
	}
}

func TestAccountManagementProtectsUpstreamAdministratorStatus(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1,3")
	write := db.NewReadSession()
	_, err := write.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	require.NoError(t, write.Close())
	for _, actorID := range []int64{1, 3} {
		s := db.NewSession()
		_, err = ChangeManagedAccountStatus(s, &user.User{ID: actorID}, 2, AccountStatusChange{Status: user.StatusDisabled, ExpectedStatus: user.StatusActive, ConfirmUsername: "user2"})
		var denied *AccountAdminError
		require.ErrorAs(t, err, &denied)
		assert.Equal(t, "account_protected", denied.Key, "the independent account capability must not race the upstream administrator lifecycle")
		require.NoError(t, s.Close())
	}
	protected, canStatus, canRevoke, reason := accountManagementFlags(1, &user.User{ID: 2, IsAdmin: true})
	assert.False(t, protected)
	assert.False(t, canStatus)
	assert.True(t, canRevoke)
	assert.Equal(t, "instance_admin", reason)
	read := db.NewReadSession()
	defer read.Close()
	u, err := user.GetUserByIDForAuth(read, 2)
	require.NoError(t, err)
	assert.Equal(t, user.StatusActive, u.Status)
	assert.True(t, u.IsAdmin)
	n, err := read.Count(new(AccountAdminEvent))
	require.NoError(t, err)
	assert.Zero(t, n)
}
