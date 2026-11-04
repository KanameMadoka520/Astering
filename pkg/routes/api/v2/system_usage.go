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
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterSystemUsageRoutes) }

type systemUsageAccessBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		CanViewUsage bool `json:"can_view_usage" required:"true" doc:"Explicit operational-usage grant; never grants resource access or account management."`
	}
}

type systemUsageBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         *instanceusage.AccountUsageSnapshot
}

type systemUsageInput struct {
	Page    int    `query:"page" default:"1" minimum:"1" doc:"1-based page number."`
	PerPage int    `query:"per_page" default:"25" minimum:"1" doc:"Capped at 100 and the configured service.maxitemsperpage."`
	Q       string `query:"q" maxLength:"250" doc:"Case-insensitive username or display-name search; does not search emails or resource content."`
	Status  string `query:"status" default:"all" enum:"all,active,email_confirmation_required,disabled,account_locked"`
	Role    string `query:"role" default:"all" enum:"all,human,bot,instance_admin,usage_admin" doc:"Read-only flags; instance_admin does not imply license availability."`
	Anomaly string `query:"anomaly" default:"all" enum:"all,flagged" doc:"Filter documented project-volume hints; never changes or limits accounts."`
	SortBy  string `query:"sort_by" default:"id" enum:"id,username,created,projects_owned,projects_created_24h,projects_created_7d,tasks_owned,tasks_created,file_bytes,ai_bytes"`
	OrderBy string `query:"order_by" default:"asc" enum:"asc,desc"`
}

func systemUsageHuman(ctx context.Context) (int64, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil {
		return 0, huma.Error401Unauthorized("invalid or missing authentication")
	}
	if (*ec).Get("api_token") != nil {
		return 0, huma.Error403Forbidden("operational usage requires an active human session")
	}
	a, err := authFromCtx(ctx)
	if err != nil {
		return 0, err
	}
	u, ok := a.(*user.User)
	if !ok || u.ID <= 0 {
		return 0, huma.Error403Forbidden("operational usage requires an active human session")
	}
	active, err := instanceusage.ActiveHuman(ctx, u.ID)
	if err != nil {
		return 0, huma.Error503ServiceUnavailable("usage authorization unavailable")
	}
	if !active {
		return 0, huma.Error403Forbidden("operational usage requires an active human session")
	}
	return u.ID, nil
}

func RegisterSystemUsageRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID: "system-usage-access",
		Method:      http.MethodGet,
		Path:        "/system/usage/access",
		Tags:        []string{"system"},
		Summary:     "Read operational usage permissions",
		Description: "Active human sessions only; API tokens, bots and inactive accounts are forbidden. ASTERING_USAGE_ADMIN_IDS is the only grant, with no SMTP or instance-admin fallback. Empty or absent configuration grants nobody. This independent read-only capability never changes licensed admin gates or resource permissions.",
	}, func(ctx context.Context, _ *struct{}) (*systemUsageAccessBody, error) {
		uid, err := systemUsageHuman(ctx)
		if err != nil {
			return nil, err
		}
		out := &systemUsageAccessBody{CacheControl: "no-store"}
		out.Body.CanViewUsage = instanceusage.CanView(uid)
		return out, nil
	})
	Register(api, huma.Operation{
		OperationID: "system-usage-users",
		Method:      http.MethodGet,
		Path:        "/system/usage/users",
		Tags:        []string{"system"},
		Summary:     "Read account usage aggregates",
		Description: "Explicit usage administrators only; no account changes or resource access. Returns only basic account identity/status and aggregate counts/bytes, never emails, resource titles, filenames, credentials or conversation content. SQL aggregates and canonical encrypted-file metadata are cached for at most 30 seconds. AI values with ai_scan_complete=false are incomplete lower bounds. Database failures return 503; byte totals exclude previews, database storage, backups and orphans. Overview covers all persisted accounts before filters.",
	}, systemUsageUsers)
}

func systemUsageUsers(ctx context.Context, in *systemUsageInput) (*systemUsageBody, error) {
	uid, err := systemUsageHuman(ctx)
	if err != nil {
		return nil, err
	}
	if !instanceusage.CanView(uid) {
		return nil, huma.Error403Forbidden("operational usage access is not granted")
	}
	perPage := in.PerPage
	if maximum := config.ServiceMaxItemsPerPage.GetInt(); maximum > 0 {
		perPage = min(perPage, maximum)
	}
	result, err := instanceusage.Read(ctx, instanceusage.AccountUsageQuery{
		Page:    in.Page,
		PerPage: perPage,
		Q:       in.Q,
		Status:  in.Status,
		Role:    in.Role,
		Anomaly: in.Anomaly,
		SortBy:  in.SortBy,
		OrderBy: in.OrderBy,
	})
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("usage snapshot unavailable")
	}
	return &systemUsageBody{
		CacheControl: "no-store",
		Body:         result,
	}, nil
}
