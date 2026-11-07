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

package apiv2

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func accountManagementTestServer(t *testing.T) *echo.Echo {
	t.Helper()
	aiBucketFixtures(t)
	config.FilesBasePath.Set(t.TempDir())
	instanceusage.Invalidate()
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			id, err := strconv.ParseInt(c.Request().Header.Get("X-Test-User"), 10, 64)
			if err == nil {
				c.Set("api_user", &user.User{ID: id})
			}
			if c.Request().Header.Get("X-Test-Token") == "true" {
				c.Set("api_token", &models.APIToken{OwnerID: id})
			}
			return next(c)
		}
	})
	RegisterSystemAccountRoutes(NewAPI(e, e.Group(GroupPrefix)))
	return e
}
func accountManagementRequest(e *echo.Echo, uid int64, method, path, body string, token, scoped bool) *httptest.ResponseRecorder {
	req := httptest.NewRequest(method, GroupPrefix+path, strings.NewReader(body))
	req.Header.Set("Content-Type", "application/json")
	if uid > 0 {
		req.Header.Set("X-Test-User", strconv.FormatInt(uid, 10))
	}
	if token {
		req.Header.Set("X-Test-Token", "true")
	}
	if scoped {
		req = req.WithContext(user.WithResourceOnlyPermissions(req.Context()))
	}
	response := httptest.NewRecorder()
	e.ServeHTTP(response, req)
	return response
}
func managementJSON(t *testing.T, value any) string {
	t.Helper()
	raw, err := json.Marshal(value)
	require.NoError(t, err)
	return string(raw)
}
func managedUsername(t *testing.T, id int64) string {
	t.Helper()
	s := db.NewReadSession()
	defer s.Close()
	u := &user.User{}
	found, err := s.ID(id).Get(u)
	require.NoError(t, err)
	require.True(t, found)
	return u.Username
}
func managedStatus(t *testing.T, e *echo.Echo, id int64, current, next user.Status, username string) *httptest.ResponseRecorder {
	t.Helper()
	return accountManagementRequest(e, 1, http.MethodPost, fmt.Sprintf("/system/accounts/%d/status", id), managementJSON(t, models.AccountStatusChange{
		Status: next, ExpectedStatus: current, ConfirmUsername: username, Reason: "  maintenance test  ",
	}), false, false)
}
func countManagementEvents(t *testing.T) int64 {
	t.Helper()
	s := db.NewReadSession()
	defer s.Close()
	n, err := s.Count(new(models.AccountAdminEvent))
	require.NoError(t, err)
	return n
}
func TestSystemAccountsExplicitHumanGrant(t *testing.T) {
	e := accountManagementTestServer(t)
	response := accountManagementRequest(e, 1, "GET", "/system/accounts/access", "", false, false)
	require.Equal(t, 200, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"can_manage_accounts":true`)
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "2")
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "2")
	s := db.NewReadSession()
	_, err := s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	response = accountManagementRequest(e, 2, "GET", "/system/accounts/access", "", false, false)
	require.Equal(t, 200, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"can_manage_accounts":false`)
	for _, path := range []string{"/system/accounts", "/system/accounts/events"} {
		assert.Equal(t, 403, accountManagementRequest(e, 2, "GET", path, "", false, false).Code)
		assert.Equal(t, 403, accountManagementRequest(e, 1, "GET", path, "", true, false).Code)
		assert.Equal(t, 403, accountManagementRequest(e, 1, "GET", path, "", false, true).Code, "trusted Arona resource-only identity must not acquire superadmin capability")
	}
	assert.Equal(t, 403, accountManagementRequest(e, 1, "GET", "/system/accounts/access", "", false, true).Code)
	assert.Equal(t, 401, accountManagementRequest(e, 0, "GET", "/system/accounts/access", "", false, false).Code)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "")
	assert.Equal(t, 403, accountManagementRequest(e, 1, "GET", "/system/accounts", "", false, false).Code)
}
func TestSystemAccountsPrivacyAndProtectedControls(t *testing.T) {
	e := accountManagementTestServer(t)
	response := accountManagementRequest(e, 1, "GET", "/system/accounts?per_page=100", "", false, false)
	require.Equal(t, 200, response.Code, response.Body.String())
	result := models.AccountManagementSnapshot{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	require.NotEmpty(t, result.Items)
	foundSelf, foundOrdinary := false, false
	for _, row := range result.Items {
		if row.ID == 1 {
			foundSelf = true
			assert.True(t, row.IsSuperadmin)
			assert.True(t, row.IsProtected)
			assert.False(t, row.CanChangeStatus)
			assert.False(t, row.CanRevokeAccess)
			assert.Equal(t, "self", row.ProtectedReason)
		}
		if row.ID == 2 {
			foundOrdinary = true
			assert.False(t, row.IsProtected)
			assert.True(t, row.CanChangeStatus)
			assert.True(t, row.CanRevokeAccess)
			assert.Positive(t, row.Sessions)
		}
	}
	assert.True(t, foundSelf)
	assert.True(t, foundOrdinary)
	for _, secret := range []string{`"email"`, `"password"`, `"token_hash"`, `"token_sha256"`, `"api_key"`, `"filename"`, `"title"`, `"issuer"`, `"subject"`} {
		assert.NotContains(t, response.Body.String(), secret)
	}
	// Account supervision is not a cross-resource permission grant.
	s := db.NewReadSession()
	can, _, err := (&models.Project{ID: 2}).CanRead(s, &user.User{ID: 1})
	require.NoError(t, err)
	assert.False(t, can)
	require.NoError(t, s.Close())
	assert.Equal(t, 403, managedStatus(t, e, 1, user.StatusActive, user.StatusDisabled, managedUsername(t, 1)).Code)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1,2")
	assert.Equal(t, 403, managedStatus(t, e, 2, user.StatusActive, user.StatusDisabled, managedUsername(t, 2)).Code)
	assert.Zero(t, countManagementEvents(t))
}
func TestSystemAccountsStatusRevokesJWTAndOwnedBotCredentials(t *testing.T) {
	e := accountManagementTestServer(t)
	username := managedUsername(t, 2)
	s := db.NewSession()
	bot := &user.User{Username: "bot-management-child", BotOwnerID: 2, Status: user.StatusActive}
	_, err := s.Insert(bot)
	require.NoError(t, err)
	token := &models.APIToken{Title: "test token", OwnerID: bot.ID, ExpiresAt: time.Now().Add(time.Hour)}
	require.NoError(t, token.Create(s, &user.User{ID: 2}))
	ownerToken := &models.APIToken{Title: "owner test token", ExpiresAt: time.Now().Add(time.Hour)}
	require.NoError(t, ownerToken.Create(s, &user.User{ID: 2}))
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	require.NoError(t, s.Close())
	const sid = "550e8400-e29b-41d4-a716-446655440003"
	claims := &auth.UserTokenClaims{UserID: 2, SessionID: sid, ExpiresAt: time.Now().Add(time.Hour)}
	require.NoError(t, auth.CheckUserTokenSession(claims), "warm successful JWT auth cache before revocation")
	canceled := []int64{}
	previous := models.SetAccountRunRevoker(func(id int64) { canceled = append(canceled, id) })
	t.Cleanup(func() { models.SetAccountRunRevoker(previous) })
	before := countManagementEvents(t)
	response := managedStatus(t, e, 2, user.StatusActive, user.StatusDisabled, username)
	require.Equal(t, 200, response.Code, response.Body.String())
	result := models.AccountManagementResult{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	assert.Equal(t, user.StatusDisabled, result.Status)
	assert.Positive(t, result.RevokedSessions)
	assert.GreaterOrEqual(t, result.RevokedAPITokens, int64(2))
	assert.ElementsMatch(t, []int64{2, bot.ID}, canceled)
	require.ErrorIs(t, auth.CheckUserTokenSession(claims), auth.ErrUserTokenRejected, "still-unexpired JWT must be rejected immediately")
	s = db.NewReadSession()
	_, _, err = models.ValidateTokenAndGetOwner(s, token.Token, false)
	require.Error(t, err)
	_, _, err = models.ValidateTokenAndGetOwner(s, ownerToken.Token, false)
	require.Error(t, err)
	_, err = user.GetUserByIDForAuth(s, 2)
	require.True(t, user.IsErrAccountDisabled(err))
	project := &models.Project{}
	exists, err := s.ID(2).Get(project)
	require.NoError(t, err)
	assert.True(t, exists, "suspension retains business data")
	require.NoError(t, s.Close())
	assert.Equal(t, before+1, countManagementEvents(t))
	assert.Equal(t, 409, managedStatus(t, e, 2, user.StatusActive, user.StatusDisabled, username).Code, "stale confirmation cannot repeat operation")
	response = managedStatus(t, e, 2, user.StatusDisabled, user.StatusActive, username)
	require.Equal(t, 200, response.Code, response.Body.String())
	require.ErrorIs(t, auth.CheckUserTokenSession(claims), auth.ErrUserTokenRejected, "reactivation must not revive an old session")
	s = db.NewReadSession()
	_, err = user.GetUserByIDForAuth(s, 2)
	require.NoError(t, err)
	require.NoError(t, s.Close())
	response = accountManagementRequest(e, 1, "GET", "/system/accounts/events?target_id=2", "", false, false)
	require.Equal(t, 200, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"action":"status_changed"`)
	assert.Contains(t, response.Body.String(), `"reason":"maintenance test"`)
	assert.NotContains(t, response.Body.String(), ownerToken.Token)
}
func TestSystemAccountsConfirmationValidationAndVerificationProtection(t *testing.T) {
	e := accountManagementTestServer(t)
	before := countManagementEvents(t)
	username := managedUsername(t, 2)
	assert.Equal(t, 409, managedStatus(t, e, 2, user.StatusActive, user.StatusDisabled, "wrong-account").Code)
	assert.Equal(t, 409, managedStatus(t, e, 2, user.StatusDisabled, user.StatusActive, username).Code)
	assert.Equal(t, 404, managedStatus(t, e, 999999, user.StatusActive, user.StatusDisabled, "missing").Code)
	for _, body := range []string{`{}`, `{"status":2,"confirm_username":"user2"}`, `{"expected_status":0,"confirm_username":"user2"}`, `{"status":1,"expected_status":0,"confirm_username":"user2"}`} {
		assert.Equal(t, 422, accountManagementRequest(e, 1, "POST", "/system/accounts/2/status", body, false, false).Code)
	}
	for _, status := range []user.Status{user.StatusEmailConfirmationRequired, user.StatusAccountLocked} {
		s := db.NewReadSession()
		_, err := s.ID(2).Cols("status").Update(&user.User{Status: status})
		require.NoError(t, err)
		require.NoError(t, s.Close())
		assert.Equal(t, 403, managedStatus(t, e, 2, status, user.StatusActive, username).Code)
	}
	assert.Equal(t, before, countManagementEvents(t), "failed attempts never leave successful-operation journal entries")
}
func TestSystemAccountsRevokeAccessDoesNotSuspend(t *testing.T) {
	e := accountManagementTestServer(t)
	response := accountManagementRequest(e, 1, "POST", "/system/accounts/2/revoke-access", managementJSON(t, models.AccountAccessRevoke{ConfirmUsername: managedUsername(t, 2)}), false, false)
	require.Equal(t, 200, response.Code, response.Body.String())
	result := models.AccountManagementResult{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	assert.Equal(t, user.StatusActive, result.Status)
	s := db.NewReadSession()
	defer s.Close()
	_, err := user.GetUserByIDForAuth(s, 2)
	require.NoError(t, err)
	sessions, err := s.Where("user_id = ?", 2).Count(new(models.Session))
	require.NoError(t, err)
	assert.Zero(t, sessions)
	// A legitimate new sign-in is still possible for an active account.
	write := db.NewSession()
	defer write.Close()
	_, err = models.CreateSession(write, 2, "isolated regression", "127.0.0.1", false, nil)
	require.NoError(t, err)
	require.NoError(t, write.Commit())
}
