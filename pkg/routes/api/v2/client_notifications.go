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

package apiv2

import (
	"context"
	"net/http"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

type clientNotificationGrantBody struct {
	Token      string    `json:"token" doc:"Notification-only bearer secret, returned once; never a web login or refresh token."`
	TokenID    int64     `json:"token_id" doc:"Revoke through the existing human API-token management endpoint."`
	UserID     int64     `json:"user_id"`
	ExpiresAt  time.Time `json:"expires_at" doc:"Independent 30-day grant. Revoking the originating browser session does not revoke this grant."`
	ServerTime time.Time `json:"server_time"`
	Scope      string    `json:"scope" doc:"Always client:notifications_snapshot, one read-only metadata endpoint."`
}

func init() { AddRouteRegistrar(RegisterClientNotificationRoutes) }

func RegisterClientNotificationRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "client-notification-token-create",
		Summary:     "Authorize Android background notification metadata",
		Description: "An active human browser session may authorize one installation for 30 days. The token can only GET the notification snapshot, cannot renew itself, and is independently revocable in API tokens. Same-install retries rotate that installation's old notification-only grant atomically. At most ten active installations are allowed; the display name never identifies a grant for deletion. No general API or web-login token is returned.",
		Method:      http.MethodPost,
		Path:        "/user/client/notifications/token",
		Tags:        []string{"client"},
	}, clientNotificationTokenCreate)
	Register(api, huma.Operation{
		OperationID: "client-notifications-snapshot",
		Summary:     "Read private Android notification metadata",
		Description: "Minimal read-only snapshot of tasks assigned to, created by, or effectively followed by the current human account, within its actual project ACLs. Includes a seven-day window, actual deadlines and current routine reminders, and authorized unread notification metadata without raw event text. Every list is capped and exposes completeness; missing rows in an incomplete section must never cancel existing alarms. Nothing is marked read or edited. Instance administration does not expand resource access.",
		Method:      http.MethodGet,
		Path:        "/client/notifications/snapshot",
		Tags:        []string{"client"},
	}, clientNotificationsSnapshot)
}

func clientNotificationTokenCreate(ctx context.Context, in *struct {
	Body struct {
		InstallationID string `json:"installation_id" format:"uuid" doc:"Persistent random installation UUID; grouping metadata only, never authentication proof."`
		DeviceName     string `json:"device_name" minLength:"1" maxLength:"80" doc:"User-visible device label without control characters."`
	}
}) (*struct {
	CacheControl string `header:"Cache-Control"`
	Body         clientNotificationGrantBody
}, error) {
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	actor, err := user.GetFromAuth(a)
	ec := humabridge.EchoContextFrom(ctx)
	if err != nil || actor == nil || actor.IsBot() || actor.HasResourceOnlyPermissions() || actor.CredentialScope().SessionID == "" || actor.CredentialScope().APITokenID != 0 || ec == nil || (*ec).Get("api_token") != nil {
		return nil, huma.Error403Forbidden("notification_human_session_required")
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	now := time.Now().UTC()
	grant, err := models.IssueClientNotificationGrant(s, actor, in.Body.InstallationID, in.Body.DeviceName, now)
	if err != nil {
		return nil, translateDomainError(err)
	}
	if err := s.Commit(); err != nil {
		return nil, translateDomainError(err)
	}
	events.DispatchPending(ctx, s)
	return &struct {
		CacheControl string `header:"Cache-Control"`
		Body         clientNotificationGrantBody
	}{
		CacheControl: "no-store",
		Body: clientNotificationGrantBody{
			Token:      grant.Token,
			TokenID:    grant.ID,
			UserID:     grant.OwnerID,
			ExpiresAt:  grant.ExpiresAt,
			ServerTime: now,
			Scope:      "client:notifications_snapshot",
		},
	}, nil
}

func clientNotificationsSnapshot(ctx context.Context, _ *struct{}) (*struct {
	CacheControl string `header:"Cache-Control"`
	Body         models.ClientNotificationSnapshot
}, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	actor, err := user.GetFromAuth(a)
	if err != nil || actor == nil || actor.IsBot() || actor.HasResourceOnlyPermissions() {
		return nil, huma.Error403Forbidden("notification_human_account_required")
	}
	now := time.Now().UTC()
	validUntil := now.Add(24 * time.Hour)
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil {
		return nil, huma.Error401Unauthorized("missing_authentication")
	}
	if token, ok := (*ec).Get("api_token").(*models.APIToken); ok {
		if token.OwnerID != actor.ID || !token.ExpiresAt.After(now) {
			return nil, huma.Error403Forbidden("notification_grant_invalid")
		}
		if token.ExpiresAt.Before(validUntil) {
			validUntil = token.ExpiresAt
		}
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	value, err := models.GetClientNotificationSnapshot(s, actor, now, validUntil)
	if err != nil {
		return nil, translateDomainError(err)
	}
	return &struct {
		CacheControl string `header:"Cache-Control"`
		Body         models.ClientNotificationSnapshot
	}{
		CacheControl: "no-store",
		Body:         *value,
	}, nil
}
