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
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
	"github.com/labstack/echo/v5"
)

const deviceAccountCookie = "__Host-aster_device_accounts"
const developmentDeviceAccountCookie = "aster_device_accounts_dev"

func init() { AddRouteRegistrar(RegisterAccountSessionRoutes) }

type rememberedAccountsBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		Accounts []*models.RememberedAccount `json:"accounts" readOnly:"true" doc:"Only active logins explicitly remembered by this browser; no email, role, or account content."`
		Limit    int                         `json:"limit" readOnly:"true" doc:"Maximum number of accounts remembered on one device."`
	}
}

type rememberedSessionInput struct {
	Body struct {
		SessionID string `json:"session_id" required:"true" minLength:"36" maxLength:"36" doc:"A login returned by the device account list. Arbitrary account IDs are not accepted."`
	}
}

func RegisterAccountSessionRoutes(api huma.API) {
	tags := []string{"auth"}
	Register(api, huma.Operation{
		OperationID: "auth-account-sessions-list",
		Summary:     "List accounts remembered on this device",
		Description: "Requires the separate HttpOnly device credential and same-origin account intent header. Returns minimum identity information, never refresh tokens. Accounts with revoked/expired logins or disabled/deleted users are omitted.",
		Method:      http.MethodGet,
		Path:        "/user/account-sessions",
		Tags:        tags,
		Security:    publicSecurity,
	}, accountSessionsList)
	Register(api, huma.Operation{
		OperationID:   "auth-account-sessions-remember",
		Summary:       "Remember the current account for switching",
		Description:   "Requires a current human browser login and same-origin account intent. Binds its existing SID to this device; maximum five accounts. No password or recoverable refresh token is saved.",
		Method:        http.MethodPost,
		Path:          "/user/account-sessions/remember",
		Tags:          tags,
		DefaultStatus: http.StatusOK,
	}, accountSessionsRemember)
	Register(api, huma.Operation{
		OperationID:   "auth-account-sessions-switch",
		Summary:       "Switch to a remembered device account",
		Description:   "Validates the HttpOnly device credential and live SID under credential locks, rotates the legacy refresh cookies, and returns a short access token. All tabs on this origin share the selected account. Requires same-origin account intent.",
		Method:        http.MethodPost,
		Path:          "/user/account-sessions/switch",
		Tags:          tags,
		Security:      publicSecurity,
		DefaultStatus: http.StatusOK,
	}, accountSessionsSwitch)
	Register(api, huma.Operation{
		OperationID:   "auth-account-sessions-forget",
		Summary:       "Remove one account from this device",
		Description:   "Revokes only the remembered login proved by this device credential, preserving other devices. Requires same-origin account intent.",
		Method:        http.MethodPost,
		Path:          "/user/account-sessions/forget",
		Tags:          tags,
		Security:      publicSecurity,
		DefaultStatus: http.StatusNoContent,
	}, accountSessionsForget)
	Register(api, huma.Operation{
		OperationID:   "auth-account-sessions-clear",
		Summary:       "Sign out every account remembered on this device",
		Description:   "Revokes every remembered SID for this HttpOnly device credential and clears its cookie. Does not affect other devices. Requires same-origin account intent.",
		Method:        http.MethodPost,
		Path:          "/user/account-sessions/clear",
		Tags:          tags,
		Security:      publicSecurity,
		DefaultStatus: http.StatusNoContent,
	}, accountSessionsClear)
}

// The device cookie is an authentication secret. SameSite alone is insufficient
// against sibling sites; reject cross-origin and ambiguous cookie requests even
// when deployment CORS happens to allow that origin.
func accountSessionContext(ctx context.Context) (*echo.Context, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil {
		return nil, huma.Error403Forbidden("device_account_same_origin_required")
	}
	ec.Response().Header().Set("Cache-Control", "no-store")
	req := ec.Request()
	if req.Header.Get("X-Astering-Account-Intent") != "manage" {
		return nil, huma.Error403Forbidden("device_account_same_origin_required")
	}
	expected, err := url.Parse(config.ServicePublicURL.GetString())
	if err != nil || expected.Host == "" {
		return nil, huma.Error403Forbidden("device_account_same_origin_required")
	}
	source := req.Header.Get("Origin")
	if source == "" {
		source = req.Referer()
	}
	if source != "" {
		parsed, parseErr := url.Parse(source)
		if parseErr != nil || parsed.User != nil || parsed.Scheme != expected.Scheme || !strings.EqualFold(parsed.Host, expected.Host) {
			return nil, huma.Error403Forbidden("device_account_same_origin_required")
		}
	} else if req.Header.Get("Sec-Fetch-Site") != "same-origin" {
		return nil, huma.Error403Forbidden("device_account_same_origin_required")
	}
	return ec, nil
}

func deviceAccountToken(ec *echo.Context) string {
	name := deviceAccountCookie
	publicURL, _ := url.Parse(config.ServicePublicURL.GetString())
	if publicURL.Scheme != "https" {
		name = developmentDeviceAccountCookie
	}
	cookie, err := ec.Cookie(name)
	if err != nil {
		return ""
	}
	return cookie.Value
}
func setDeviceAccountCookie(ec *echo.Context, token string, expires time.Time) {
	publicURL, _ := url.Parse(config.ServicePublicURL.GetString())
	name, path := deviceAccountCookie, "/"
	if publicURL.Scheme != "https" {
		name = developmentDeviceAccountCookie
		path = strings.TrimRight(publicURL.Path, "/") + "/api/v2/user/account-sessions"
	}
	maxAge := int(time.Until(expires).Seconds())
	if token == "" {
		maxAge = -1
	}
	ec.SetCookie(&http.Cookie{ //nolint:gosec // Plain HTTP installations remain usable; HTTPS deployment uses Secure.
		Name:     name,
		Value:    token,
		Path:     path,
		MaxAge:   maxAge,
		Expires:  expires,
		HttpOnly: true,
		Secure:   publicURL.Scheme == "https",
		SameSite: http.SameSiteLaxMode,
	})
}
func accountSessionsList(ctx context.Context, _ *struct{}) (*rememberedAccountsBody, error) {
	ec, err := accountSessionContext(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	accounts, err := models.ListRememberedAccounts(s, deviceAccountToken(ec))
	if err != nil {
		return nil, translateDomainError(err)
	}
	out := &rememberedAccountsBody{CacheControl: "no-store"}
	out.Body.Accounts, out.Body.Limit = accounts, models.MaxRememberedAccounts
	return out, nil
}
func accountSessionsRemember(ctx context.Context, _ *struct{}) (*rememberedAccountsBody, error) {
	ec, err := accountSessionContext(ctx)
	if err != nil {
		return nil, err
	}
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	actor, ok := a.(*user.User)
	if !ok || actor.IsBot() || actor.HasResourceOnlyPermissions() || ec.Get("api_token") != nil || auth.SessionIDFromContext(ec) == "" {
		return nil, huma.Error403Forbidden("device_account_human_session_required")
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	token, expires, err := models.RememberAccount(s, deviceAccountToken(ec), actor, auth.SessionIDFromContext(ec), auth.RememberedDeviceLifetime())
	if errors.Is(err, models.ErrRememberedAccountLimit) {
		return nil, huma.Error409Conflict("device_account_limit")
	}
	if err != nil {
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, err
	}
	events.DispatchPending(ctx, s)
	setDeviceAccountCookie(ec, token, expires)
	accounts, err := models.ListRememberedAccounts(s, token)
	if err != nil {
		return nil, translateDomainError(err)
	}
	out := &rememberedAccountsBody{CacheControl: "no-store"}
	out.Body.Accounts, out.Body.Limit = accounts, models.MaxRememberedAccounts
	return out, nil
}
func accountSessionsSwitch(ctx context.Context, in *rememberedSessionInput) (*authTokenBody, error) {
	ec, err := accountSessionContext(ctx)
	if err != nil {
		return nil, err
	}
	token, err := auth.SwitchRememberedAccount(deviceAccountToken(ec), in.Body.SessionID)
	if err != nil {
		return nil, translateDomainError(err)
	}
	auth.WriteUserAuthCookies(ec, token)
	out := &authTokenBody{CacheControl: "no-store"}
	out.Body.Token = token.AccessToken
	return out, nil
}
func accountSessionsForget(ctx context.Context, in *rememberedSessionInput) (*emptyBody, error) {
	if len(in.Body.SessionID) != 36 {
		return nil, huma.Error400BadRequest("device_account_login_required")
	}
	return forgetDeviceAccounts(ctx, in.Body.SessionID)
}
func accountSessionsClear(ctx context.Context, _ *struct{}) (*emptyBody, error) {
	return forgetDeviceAccounts(ctx, "")
}
func forgetDeviceAccounts(ctx context.Context, sid string) (*emptyBody, error) {
	ec, err := accountSessionContext(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	if err = models.ForgetRememberedAccounts(s, deviceAccountToken(ec), sid); err != nil {
		return nil, translateDomainError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, err
	}
	events.DispatchPending(ctx, s)
	if sid == "" {
		setDeviceAccountCookie(ec, "", time.Unix(0, 0))
		auth.ClearRefreshTokenCookie(ec)
	}
	return &emptyBody{}, nil
}
