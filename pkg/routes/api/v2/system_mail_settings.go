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

	"github.com/KanameMadoka520/Astering/pkg/modules/mailsettings"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterSystemMailSettingsRoutes) }

type settingsAccessBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		CanManageMail bool `json:"can_manage_mail"`
	}
}
type mailSettingsBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         mailsettings.MailSettings
}

func requireMailAdmin(ctx context.Context) error {
	uid, err := aiUser(ctx)
	if err != nil {
		return err
	}
	if !mailsettings.CanManage(uid) {
		return huma.Error403Forbidden(tcylocale.Render(ctx, tcylocale.Error("smtpForbidden")))
	}
	return nil
}
func RegisterSystemMailSettingsRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "system-settings-access",
		Method:      http.MethodGet,
		Path:        "/system/settings-access",
		Tags:        []string{"system"},
		Summary:     "Read custom site-settings permissions",
		Description: "Only authenticated human sessions. ASTERING_SETTINGS_ADMIN_IDS grants custom SMTP settings access " +
			"independently of other administrator roles. The legacy TCYMC_SETTINGS_ADMIN_IDS list is used only when " +
			"the new variable is absent; an explicitly empty new variable revokes these grants.",
	}, func(ctx context.Context, _ *struct{}) (*settingsAccessBody, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		out := &settingsAccessBody{CacheControl: "no-store"}
		out.Body.CanManageMail = mailsettings.CanManage(uid)
		return out, nil
	})
	Register(api, huma.Operation{OperationID: "system-mail-settings", Method: http.MethodGet, Path: "/system/mail-settings", Tags: []string{"system"}, Summary: "Read site SMTP settings", Description: "Site-settings administrators only. Passwords are never returned; has_password indicates their presence. Environment configuration remains the fallback until settings are saved."}, func(ctx context.Context, _ *struct{}) (*mailSettingsBody, error) {
		if err := requireMailAdmin(ctx); err != nil {
			return nil, err
		}
		return &mailSettingsBody{CacheControl: "no-store", Body: mailsettings.Read()}, nil
	})
	Register(api, huma.Operation{OperationID: "system-save-mail-settings", Method: http.MethodPost, Path: "/system/mail-settings", Tags: []string{"system"}, Summary: "Save site SMTP settings", Description: "Site-settings administrators only. Encrypted persistence and atomic live reload; no test email is sent. Blank password preserves it only for the same host and username. Stale revision returns 409; rejected edits leave the current settings intact."}, func(ctx context.Context, in *struct{ Body mailsettings.MailSettings }) (*mailSettingsBody, error) {
		if err := requireMailAdmin(ctx); err != nil {
			return nil, err
		}
		saved, err := mailsettings.Save(in.Body)
		if errors.Is(err, mailsettings.ErrConflict) {
			return nil, huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("smtpConflict")))
		}
		if err != nil {
			var localized *tcylocale.LocalizedError
			if errors.As(err, &localized) {
				return nil, huma.Error400BadRequest(tcylocale.Render(ctx, err))
			}
			return nil, huma.Error500InternalServerError(tcylocale.Render(ctx, tcylocale.Error("smtpSave")))
		}
		return &mailSettingsBody{CacheControl: "no-store", Body: saved}, nil
	})
}
