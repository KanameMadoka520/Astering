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

package webtests

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setUserStatus(t *testing.T, id int64, status user.Status) {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	require.NoError(t, user.SetUserStatus(s, &user.User{ID: id}, status))
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
}

// Admins freeze accounts by requiring email confirmation.
func TestEmailUnconfirmedAccountCannotAuthenticate(t *testing.T) {
	t.Run("api token", func(t *testing.T) {
		e, err := setupTestEnv()
		require.NoError(t, err)
		setUserStatus(t, 1, user.StatusEmailConfirmationRequired)

		rec := apiTokenReq(e, http.MethodGet, "/api/v1/tasks", "tk_2eef46f40ebab3304919ab2e7e39993f75f29d2e", "")
		assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
	})

	t.Run("refresh token", func(t *testing.T) {
		e, err := setupTestEnv()
		require.NoError(t, err)
		setUserStatus(t, 1, user.StatusEmailConfirmationRequired)

		rec := refreshRequest(e, "testtoken_session1")
		assert.Equal(t, http.StatusPreconditionFailed, rec.Code, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), `"token":"`)
		db.AssertMissing(t, "sessions", map[string]interface{}{"id": "550e8400-e29b-41d4-a716-446655440001"})
	})

	t.Run("oauth code exchange", func(t *testing.T) {
		e, err := setupTestEnv()
		require.NoError(t, err)
		codeVerifier := "dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk"
		h := sha256.Sum256([]byte(codeVerifier))
		code := getAuthorizationCode(t, e, base64.RawURLEncoding.EncodeToString(h[:]), "xyz")
		setUserStatus(t, 1, user.StatusEmailConfirmationRequired)

		rec := doTokenRequest(e, map[string]string{
			"grant_type":    "authorization_code",
			"code":          code,
			"client_id":     "vikunja",
			"redirect_uri":  "vikunja-flutter://callback",
			"code_verifier": codeVerifier,
		})
		assert.Equal(t, http.StatusPreconditionFailed, rec.Code, rec.Body.String())
		assert.NotContains(t, rec.Body.String(), "access_token")
	})
}

func TestSystemAccountsReactivationRevokesLegacyCredentials(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "1")
	s := db.NewSession()
	bot := &user.User{Username: "bot-legacy-recovery", BotOwnerID: 2, Status: user.StatusActive}
	_, err = s.Insert(bot)
	require.NoError(t, err)
	ownerToken := &models.APIToken{Title: "legacy owner access", ExpiresAt: time.Now().Add(time.Hour), APIPermissions: models.APIPermissions{"tasks": {"read_all"}}}
	require.NoError(t, ownerToken.Create(s, &testuser2))
	botToken := &models.APIToken{Title: "legacy bot access", OwnerID: bot.ID, ExpiresAt: time.Now().Add(time.Hour), APIPermissions: models.APIPermissions{"tasks": {"read_all"}}}
	require.NoError(t, botToken.Create(s, &testuser2))
	_, err = models.CreateSession(s, bot.ID, "legacy bot session", "127.0.0.1", false, nil)
	require.NoError(t, err)
	for _, id := range []int64{2, bot.ID} {
		_, err = models.CreateOAuthCode(s, id, "legacy-client", "https://example.com/callback", "challenge", "S256")
		require.NoError(t, err)
	}
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	require.NoError(t, s.Close())

	oldJWT := humaTokenFor(t, &testuser2)
	rec := humaRequest(t, e, http.MethodGet, "/api/v2/user", "", oldJWT, "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	for _, token := range []string{ownerToken.Token, botToken.Token} {
		rec = humaRequest(t, e, http.MethodGet, "/api/v2/tasks", "", token, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	}
	// The legacy/CLI operation retains credential rows. Restoring through the
	// managed endpoint must revoke those rows, not silently reactivate them.
	setUserStatus(t, 2, user.StatusDisabled)
	s = db.NewReadSession()
	ids := []int64{2, bot.ID}
	sessions, err := s.In("user_id", ids).Count(new(models.Session))
	require.NoError(t, err)
	require.Positive(t, sessions)
	tokens, err := s.In("owner_id", ids).Count(new(models.APIToken))
	require.NoError(t, err)
	require.GreaterOrEqual(t, tokens, int64(2))
	require.NoError(t, s.Close())
	canceled := []int64{}
	previous := models.SetAccountRunRevoker(func(id int64) { canceled = append(canceled, id) })
	t.Cleanup(func() { models.SetAccountRunRevoker(previous) })
	rec = humaRequest(t, e, http.MethodPost, "/api/v2/system/accounts/2/status",
		`{"status":0,"expected_status":2,"confirm_username":"user2","reason":"legacy recovery"}`, humaTokenFor(t, &testuser1), "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	result := models.AccountManagementResult{}
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
	assert.Equal(t, user.StatusActive, result.Status)
	assert.Equal(t, sessions, result.RevokedSessions)
	assert.Equal(t, tokens, result.RevokedAPITokens)
	assert.ElementsMatch(t, ids, canceled, "only committed restoration cancels the account and owned-bot runs")

	for _, version := range []string{"v1", "v2"} {
		rec = humaRequest(t, e, http.MethodGet, "/api/"+version+"/user", "", oldJWT, "")
		assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		for _, token := range []string{ownerToken.Token, botToken.Token} {
			rec = humaRequest(t, e, http.MethodGet, "/api/"+version+"/tasks", "", token, "")
			assert.Equal(t, http.StatusUnauthorized, rec.Code, rec.Body.String())
		}
	}
	s = db.NewReadSession()
	defer s.Close()
	n, err := s.In("user_id", ids).Count(new(models.OAuthCode))
	require.NoError(t, err)
	assert.Zero(t, n, "legacy OAuth authorization codes must be removed too")
	journal := &models.AccountAdminEvent{}
	exists, err := s.ID(result.EventID).Get(journal)
	require.NoError(t, err)
	require.True(t, exists)
	assert.Equal(t, "status_changed", journal.Action)
	assert.Equal(t, user.StatusDisabled, journal.OldStatus)
	assert.Equal(t, user.StatusActive, journal.NewStatus)
	assert.Equal(t, sessions, journal.RevokedSessions)
	assert.Equal(t, tokens, journal.RevokedAPITokens)
	db.AssertExists(t, "projects", map[string]interface{}{"id": 2}, false)
	rec = humaRequest(t, e, http.MethodPost, "/api/v2/login", `{"username":"user2","password":"12345678"}`, "", "")
	require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), `"token":"`, "restoration permits a fresh login rather than recovering old access")
}
