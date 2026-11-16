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

package models

import (
	"net/http"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/google/uuid"
	"xorm.io/builder"
	"xorm.io/xorm"
)

const clientNotificationTitlePrefix = "Astering Android notifications ["

// ClientNotificationError contains fixed, non-private input or capacity errors.
type ClientNotificationError struct {
	Message string
	Status  int
}

func (e ClientNotificationError) Error() string { return e.Message }
func (e ClientNotificationError) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: e.Status,
		Code:     20005,
		Message:  e.Message,
	}
}

// IsClientNotificationGrant recognizes only this exact read-only permission.
// Titles are display metadata, never authentication proof or extra permissions.
func IsClientNotificationGrant(token *APIToken) bool {
	return token != nil && len(token.APIPermissions) == 1 && len(token.APIPermissions["client"]) == 1 &&
		token.APIPermissions["client"][0] == "notifications_snapshot" && strings.HasPrefix(token.Title, clientNotificationTitlePrefix)
}

// IssueClientNotificationGrant uses the existing credential transaction and API
// token storage. Same-install retries rotate only that installation's grant;
// they cannot delete a general API token or another account/device's token.
func IssueClientNotificationGrant(s *xorm.Session, actor *user.User, installation, name string, now time.Time) (*APIToken, error) {
	if actor == nil || actor.ID <= 0 || actor.IsBot() || actor.HasResourceOnlyPermissions() || actor.CredentialScope().SessionID == "" || actor.CredentialScope().APITokenID != 0 {
		return nil, ErrGenericForbidden{}
	}
	parsed, err := uuid.Parse(installation)
	if err != nil || parsed == uuid.Nil || parsed.String() != installation || utf8.RuneCountInString(name) < 1 || utf8.RuneCountInString(name) > 80 || strings.TrimSpace(name) != name || strings.ContainsFunc(name, unicode.IsControl) {
		return nil, ClientNotificationError{
			Message: "Use a canonical installation UUID and a device name of 1–80 characters without control characters.",
			Status:  http.StatusBadRequest,
		}
	}
	if err := LockCredentialIssue(s, actor); err != nil {
		return nil, err
	}
	rows := []*APIToken{}
	if err := s.Where(builder.Eq{"owner_id": actor.ID}).Find(&rows); err != nil {
		return nil, err
	}
	installationPrefix := clientNotificationTitlePrefix + installation + "] "
	retire := []*APIToken{}
	active := 0
	for _, row := range rows {
		if !IsClientNotificationGrant(row) {
			continue
		}
		if !row.ExpiresAt.After(now) || strings.HasPrefix(row.Title, installationPrefix) {
			retire = append(retire, row)
			continue
		}
		active++
	}
	if active >= 10 {
		return nil, ClientNotificationError{
			Message: "At most 10 Android notification devices may be authorized. Revoke an unused device in API tokens first.",
			Status:  http.StatusConflict,
		}
	}
	grant := &APIToken{
		Title: installationPrefix + name,
		APIPermissions: APIPermissions{
			"client": {"notifications_snapshot"},
		},
		OwnerID:   actor.ID,
		ExpiresAt: now.UTC().Add(30 * 24 * time.Hour),
	}
	if err := grant.Create(s, actor); err != nil {
		return nil, err
	}
	for _, row := range retire {
		if err := row.Delete(s, actor); err != nil {
			return nil, err
		}
	}
	return grant, nil
}
