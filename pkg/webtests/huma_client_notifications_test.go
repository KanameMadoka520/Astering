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

// Astering additions provide notification-only background capabilities.

package webtests

import (
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type clientGrantHTTP struct {
	Token      string    `json:"token"`
	TokenID    int64     `json:"token_id"`
	UserID     int64     `json:"user_id"`
	ExpiresAt  time.Time `json:"expires_at"`
	ServerTime time.Time `json:"server_time"`
	Scope      string    `json:"scope"`
}

func TestClientNotificationHTTPGrantExactPermissionRotationAndRevocation(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	human := humaTokenFor(t, &testuser1)
	installation := uuid.NewString()
	issue := func(ownerToken string, installation string) clientGrantHTTP {
		t.Helper()
		body, err := json.Marshal(map[string]string{
			"installation_id": installation,
			"device_name":     "Offline fixture phone",
		})
		require.NoError(t, err)
		rec := humaRequest(t, e, http.MethodPost, "/api/v2/user/client/notifications/token", string(body), ownerToken, "")
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		require.Equal(t, "no-store", rec.Header().Get("Cache-Control"))
		var grant clientGrantHTTP
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &grant))
		return grant
	}
	first := issue(human, installation)
	require.NotEmpty(t, first.Token)
	assert.Equal(t, "client:notifications_snapshot", first.Scope)
	assert.EqualValues(t, 1, first.UserID)
	assert.InDelta(t, (30 * 24 * time.Hour).Seconds(), first.ExpiresAt.Sub(first.ServerTime).Seconds(), 1)
	read := humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", first.Token, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	assert.Equal(t, "no-store", read.Header().Get("Cache-Control"))
	var snapshot models.ClientNotificationSnapshot
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &snapshot))
	assert.EqualValues(t, 1, snapshot.UserID)
	legacyToken := "tk_2eef46f40ebab3304919ab2e7e39993f75f29d2e" // Existing fixture #1, not a deployment credential.
	legacyValidation := humaRequest(t, e, http.MethodGet, "/api/v2/token/test", "", legacyToken, "")
	assert.Equal(t, http.StatusOK, legacyValidation.Code, "ordinary API-token validation behavior must remain unchanged")
	permission := &models.APIToken{
		APIPermissions: models.APIPermissions{
			"client": {"notifications_snapshot"},
		},
	}
	for _, route := range e.Router().Routes() {
		want := route.Method == http.MethodGet && route.Path == "/api/v2/client/notifications/snapshot"
		assert.Equal(t, want, permission.CanUseRoute(route.Path, route.Method), route.Method+" "+route.Path)
	}
	for _, method := range []string{
		http.MethodPost,
		http.MethodPut,
		http.MethodPatch,
		http.MethodDelete,
	} {
		assert.False(t, permission.CanUseRoute("/api/v2/client/notifications/snapshot", method))
	}
	for _, denied := range []struct {
		method string
		path   string
		body   string
	}{
		{
			method: http.MethodGet,
			path:   "/api/v2/token/test",
		},
		{
			method: http.MethodGet,
			path:   "/api/v1/token/test",
		},
		{
			method: http.MethodGet,
			path:   "/api/v2/tasks/1",
		},
		{
			method: http.MethodGet,
			path:   "/api/v2/notifications",
		},
		{
			method: http.MethodGet,
			path:   "/api/v2/tokens",
		},
		{
			method: http.MethodPost,
			path:   "/api/v2/user/client/notifications/token",
			body:   `{"installation_id":"` + installation + `","device_name":"Forged"}`,
		},
		{
			method: http.MethodDelete,
			path:   "/api/v2/tokens/" + strconv.FormatInt(first.TokenID, 10),
		},
		{
			method: http.MethodPut,
			path:   "/api/v2/tasks/1",
			body:   `{"title":"MUST-NOT-WRITE"}`,
		},
	} {
		rec := humaRequest(t, e, denied.method, denied.path, denied.body, first.Token, "")
		assert.NotEqual(t, http.StatusOK, rec.Code, denied.path)
		assert.True(t, rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized, rec.Body.String())
	}
	rotated := issue(human, installation)
	assert.NotEqual(t, first.TokenID, rotated.TokenID)
	assert.NotEqual(t, first.Token, rotated.Token)
	rec := humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", first.Token, "")
	assert.True(t, rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized, rec.Body.String())
	secondUser := issue(humaTokenFor(t, &testuser2), installation)
	assert.EqualValues(t, 2, secondUser.UserID)
	expiring := db.NewSession()
	_, err = expiring.ID(secondUser.TokenID).Cols("expires_at").Update(&models.APIToken{ExpiresAt: time.Now().Add(-time.Minute)})
	require.NoError(t, err)
	require.NoError(t, expiring.Commit())
	require.NoError(t, expiring.Close())
	expired := humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", secondUser.Token, "")
	assert.True(t, expired.Code == http.StatusForbidden || expired.Code == http.StatusUnauthorized, expired.Body.String())
	rec = humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", rotated.Token, "")
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// A different human cannot revoke another account's notification authorization.
	rec = humaRequest(t, e, http.MethodDelete, "/api/v2/tokens/"+strconv.FormatInt(rotated.TokenID, 10), "", humaTokenFor(t, &testuser2), "")
	assert.Equal(t, http.StatusForbidden, rec.Code, rec.Body.String())
	// The independent grant survives the source browser session's revocation.
	s := db.NewSession()
	_, err = s.ID(testSessionID(&testuser1)).Delete(&models.Session{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	rec = humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", rotated.Token, "")
	assert.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
	// Explicit human revocation uses a fresh verified login session.
	freshSession := &models.Session{
		ID:         uuid.NewString(),
		UserID:     1,
		TokenHash:  uuid.NewString(),
		LastActive: time.Now(),
	}
	s = db.NewSession()
	_, err = s.Insert(freshSession)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	freshHuman, err := auth.NewUserJWTAuthtoken(&testuser1, freshSession.ID)
	require.NoError(t, err)
	rec = humaRequest(t, e, http.MethodDelete, "/api/v2/tokens/"+strconv.FormatInt(rotated.TokenID, 10), "", freshHuman, "")
	require.Equal(t, http.StatusNoContent, rec.Code, rec.Body.String())
	rec = humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", rotated.Token, "")
	assert.True(t, rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized, rec.Body.String())
}

func TestClientNotificationHTTPDeviceLimitAndAccountDisable(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	human := humaTokenFor(t, &testuser1)
	var first clientGrantHTTP
	for index := 0; index < 11; index++ {
		body := `{"installation_id":"` + uuid.NewString() + `","device_name":"Fixture"}`
		rec := humaRequest(t, e, http.MethodPost, "/api/v2/user/client/notifications/token", body, human, "")
		if index == 10 {
			require.Equal(t, http.StatusConflict, rec.Code, rec.Body.String())
			continue
		}
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		if index == 0 {
			require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &first))
		}
	}
	s := db.NewSession()
	_, err = s.ID(1).Cols("status").Update(&user.User{Status: user.StatusDisabled})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	rec := humaRequest(t, e, http.MethodGet, "/api/v2/client/notifications/snapshot", "", first.Token, "")
	assert.True(t, rec.Code == http.StatusForbidden || rec.Code == http.StatusUnauthorized, rec.Body.String())
}
