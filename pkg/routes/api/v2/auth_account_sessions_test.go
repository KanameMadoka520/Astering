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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"
)

func accountSessionFixture(t *testing.T) *echo.Echo {
	t.Helper()
	aiBucketFixtures(t)
	original := config.ServicePublicURL.GetString()
	config.ServicePublicURL.Set("https://accounts.example.test/")
	t.Cleanup(func() { config.ServicePublicURL.Set(original) })
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			if sid := c.Request().Header.Get("X-Test-SID"); sid != "" {
				s := db.NewReadSession()
				sess, err := models.GetSessionByID(s, sid)
				if err == nil {
					u, getErr := user.GetUserByID(s, sess.UserID)
					if getErr == nil {
						c.Set("api_user", user.WithSessionCredential(u, sid))
						c.Set("user", &jwt.Token{Claims: jwt.MapClaims{"sid": sid, "id": float64(u.ID)}})
					}
				}
				_ = s.Close()
			}
			return next(c)
		}
	})
	RegisterAccountSessionRoutes(NewAPI(e, e.Group(GroupPrefix)))
	return e
}

func accountSessionRequest(t *testing.T, e *echo.Echo, action, sid string, device *http.Cookie, target string) *httptest.ResponseRecorder {
	t.Helper()
	method, body := http.MethodPost, ""
	if action == "" {
		method = http.MethodGet
	} else {
		action = "/" + action
	}
	if target != "" {
		body = `{"session_id":"` + target + `"}`
	}
	req := httptest.NewRequest(method, GroupPrefix+"/user/account-sessions"+action, strings.NewReader(body))
	req.Header.Set("X-Astering-Account-Intent", "manage")
	req.Header.Set("Origin", "https://accounts.example.test")
	req.Header.Set("Content-Type", "application/json")
	if sid != "" {
		req.Header.Set("X-Test-SID", sid)
	}
	if device != nil {
		req.AddCookie(device)
	}
	out := httptest.NewRecorder()
	e.ServeHTTP(out, req)
	return out
}

func rememberFixtureAccount(t *testing.T, e *echo.Echo, uid int64, device *http.Cookie) (*http.Cookie, string) {
	t.Helper()
	token, err := auth.IssueUserToken(context.Background(), &user.User{ID: uid}, "Account boundary test", "127.0.0.1", true, nil)
	require.NoError(t, err)
	claims, err := auth.ParseUserToken(token.AccessToken)
	require.NoError(t, err)
	out := accountSessionRequest(t, e, "remember", claims.SessionID, device, "")
	require.Equal(t, http.StatusOK, out.Code, out.Body.String())
	cookies := out.Result().Cookies()
	require.Len(t, cookies, 1)
	require.Equal(t, deviceAccountCookie, cookies[0].Name)
	require.True(t, cookies[0].HttpOnly)
	require.True(t, cookies[0].Secure)
	require.Equal(t, "/", cookies[0].Path)
	require.Empty(t, cookies[0].Domain, "Host prefix rejects sibling-domain cookie fixation")
	require.NotContains(t, out.Body.String(), cookies[0].Value)
	require.NotContains(t, out.Body.String(), "email")
	require.NotContains(t, out.Body.String(), "is_admin")
	return cookies[0], claims.SessionID
}

func TestAccountSessionSwitchRotatesLegacyCookiesAndPreservesDeviceCredential(t *testing.T) {
	e := accountSessionFixture(t)
	device, sid1 := rememberFixtureAccount(t, e, 1, nil)
	device2, sid2 := rememberFixtureAccount(t, e, 2, device)
	require.Equal(t, device.Value, device2.Value, "native refresh rotation never needs to rewrite the independent device cookie")
	listed := accountSessionRequest(t, e, "", "", device, "")
	require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
	require.Contains(t, listed.Body.String(), sid1)
	require.Contains(t, listed.Body.String(), sid2)
	require.Equal(t, "no-store", listed.Header().Get("Cache-Control"))
	switched := accountSessionRequest(t, e, "switch", "", device, sid1)
	require.Equal(t, http.StatusOK, switched.Code, switched.Body.String())
	cookies := switched.Result().Cookies()
	require.Len(t, cookies, 2, "old Android clients accept exactly two legacy refresh cookies")
	paths := map[string]bool{}
	for _, c := range cookies {
		require.Equal(t, auth.RefreshTokenCookieName, c.Name)
		require.True(t, c.HttpOnly)
		require.True(t, c.Secure)
		paths[c.Path] = true
	}
	require.True(t, paths[auth.RefreshTokenPathV1])
	require.True(t, paths[auth.RefreshTokenPathV2])
	var body struct {
		Token string `json:"token"`
	}
	require.NoError(t, json.Unmarshal(switched.Body.Bytes(), &body))
	claims, err := auth.ParseUserToken(body.Token)
	require.NoError(t, err)
	require.EqualValues(t, 1, claims.UserID)
	require.Equal(t, sid1, claims.SessionID)
	refreshed, err := auth.RefreshSession(cookies[0].Value)
	require.NoError(t, err)
	require.Equal(t, sid1, refreshed.SessionID)
	again := accountSessionRequest(t, e, "switch", "", device, sid2)
	require.Equal(t, http.StatusOK, again.Code, again.Body.String())
	require.Equal(t, http.StatusNoContent, accountSessionRequest(t, e, "forget", "", device, sid1).Code)
	require.Error(t, auth.CheckUserTokenSession(claims), "remove must invalidate already-admitted access tokens immediately")
	require.Equal(t, http.StatusUnauthorized, accountSessionRequest(t, e, "switch", "", device, sid1).Code)
	require.Equal(t, http.StatusNoContent, accountSessionRequest(t, e, "clear", "", device, "").Code)
	require.Equal(t, http.StatusUnauthorized, accountSessionRequest(t, e, "switch", "", device, sid2).Code)
}

func TestAccountSessionRequiresSameOriginIntent(t *testing.T) {
	e := accountSessionFixture(t)
	for _, scenario := range []string{"no-proof", "cross-origin", "same-site-only", "no-intent", "null-origin"} {
		t.Run(scenario, func(t *testing.T) {
			req := httptest.NewRequest(http.MethodGet, GroupPrefix+"/user/account-sessions", nil)
			req.Header.Set("X-Astering-Account-Intent", "manage")
			switch scenario {
			case "cross-origin":
				req.Header.Set("Origin", "https://sibling.example.test")
			case "same-site-only":
				req.Header.Set("Sec-Fetch-Site", "same-site")
			case "no-intent":
				req.Header.Set("Origin", "https://accounts.example.test")
				req.Header.Del("X-Astering-Account-Intent")
			case "null-origin":
				req.Header.Set("Origin", "null")
			}
			out := httptest.NewRecorder()
			e.ServeHTTP(out, req)
			require.Equal(t, http.StatusForbidden, out.Code, out.Body.String())
			require.Equal(t, "no-store", out.Header().Get("Cache-Control"))
		})
	}
	req := httptest.NewRequest(http.MethodGet, GroupPrefix+"/user/account-sessions", nil)
	req.Header.Set("X-Astering-Account-Intent", "manage")
	req.Header.Set("Sec-Fetch-Site", "same-origin")
	out := httptest.NewRecorder()
	e.ServeHTTP(out, req)
	require.Equal(t, http.StatusOK, out.Code)
}

func TestAccountSessionRejectsForeignDeviceRevocationExpiryAndDisabledUsers(t *testing.T) {
	for _, scenario := range []string{"foreign-device", "revoked", "expired-session", "expired-device", "disabled", "deleted"} {
		t.Run(scenario, func(t *testing.T) {
			e := accountSessionFixture(t)
			device, sid := rememberFixtureAccount(t, e, 1, nil)
			s := db.NewSession()
			switch scenario {
			case "foreign-device":
				device.Value = strings.Repeat("a", 64)
			case "revoked":
				_, err := models.DeleteSessionByID(s, sid)
				require.NoError(t, err)
			case "expired-session":
				_, err := s.ID(sid).Cols("last_active").Update(&models.Session{LastActive: time.Now().Add(-366 * 24 * time.Hour)})
				require.NoError(t, err)
			case "expired-device":
				_, err := s.ID(models.HashSessionToken(device.Value)).Cols("expires").Update(&models.AsterAccountDevice{Expires: time.Now().Add(-time.Hour)})
				require.NoError(t, err)
			case "disabled":
				_, err := s.ID(1).Cols("status").Update(&user.User{Status: user.StatusDisabled})
				require.NoError(t, err)
			case "deleted":
				_, err := s.ID(1).Delete(&user.User{})
				require.NoError(t, err)
			}
			require.NoError(t, s.Commit())
			events.DispatchPending(context.Background(), s)
			require.NoError(t, s.Close())
			out := accountSessionRequest(t, e, "switch", "", device, sid)
			require.NotEqual(t, http.StatusOK, out.Code, out.Body.String())
			require.Empty(t, out.Result().Cookies(), "failed selection must not overwrite another account's refresh cookies")
			listed := accountSessionRequest(t, e, "", "", device, "")
			require.Equal(t, http.StatusOK, listed.Code, listed.Body.String())
			require.NotContains(t, listed.Body.String(), sid)
		})
	}
}

func TestAccountSessionForgetMissingSIDCannotClearOtherAccounts(t *testing.T) {
	e := accountSessionFixture(t)
	device, sid := rememberFixtureAccount(t, e, 1, nil)
	out := accountSessionRequest(t, e, "forget", "", device, "")
	require.NotEqual(t, http.StatusNoContent, out.Code, out.Body.String())
	require.NotEqual(t, http.StatusOK, out.Code, out.Body.String())
	require.Equal(t, http.StatusOK, accountSessionRequest(t, e, "switch", "", device, sid).Code)
}

func TestAccountSessionCookiePrefixTracksPublicHTTPSNotProxyTransport(t *testing.T) {
	original := config.ServicePublicURL.GetString()
	t.Cleanup(func() { config.ServicePublicURL.Set(original) })
	for _, secure := range []bool{true, false} {
		public := "http://localhost:4173/app/"
		if secure {
			public = "https://accounts.example.test/app/"
		}
		config.ServicePublicURL.Set(public)
		out := httptest.NewRecorder()
		// Proxy-to-origin transport remains HTTP for the secure public deployment.
		ec := echo.New().NewContext(httptest.NewRequest(http.MethodPost, "http://127.0.0.1/internal", nil), out)
		setDeviceAccountCookie(ec, strings.Repeat("b", 64), time.Now().Add(time.Hour))
		cookies := out.Result().Cookies()
		require.Len(t, cookies, 1)
		require.True(t, cookies[0].HttpOnly)
		require.Empty(t, cookies[0].Domain)
		require.Equal(t, secure, cookies[0].Secure)
		if secure {
			require.Equal(t, deviceAccountCookie, cookies[0].Name)
			require.Equal(t, "/", cookies[0].Path)
		} else {
			require.Equal(t, developmentDeviceAccountCookie, cookies[0].Name)
			require.Equal(t, "/app/api/v2/user/account-sessions", cookies[0].Path)
		}
	}
}
