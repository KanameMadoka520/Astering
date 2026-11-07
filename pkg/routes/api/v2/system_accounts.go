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
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/accountadmin"
	"github.com/KanameMadoka520/Astering/pkg/modules/humabridge"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

func init() { AddRouteRegistrar(RegisterSystemAccountRoutes) }

type accountManagementAccessBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         struct {
		CanManageAccounts bool  `json:"can_manage_accounts" required:"true" doc:"Explicit ASTERING_SUPERADMIN_IDS grant; never grants access to private business resources or licensed administration."`
		CurrentUserID     int64 `json:"current_user_id" required:"true" doc:"Currently authenticated active human account."`
	}
}
type accountManagementBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.AccountManagementSnapshot
}
type accountManagementResultBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         *models.AccountManagementResult
}
type accountManagementEventsBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         Paginated[*models.AccountAdminEvent]
}

func systemAccountHuman(ctx context.Context) (*user.User, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil {
		return nil, huma.Error401Unauthorized("account_authentication_required")
	}
	if (*ec).Get("api_token") != nil {
		return nil, huma.Error403Forbidden("account_human_session_required")
	}
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	u, ok := a.(*user.User)
	if !ok || u == nil || u.HasResourceOnlyPermissions() {
		return nil, huma.Error403Forbidden("account_human_session_required")
	}
	active, err := instanceusage.ActiveHuman(ctx, u.ID)
	if err != nil {
		return nil, huma.Error503ServiceUnavailable("account_verification_unavailable")
	}
	if !active {
		return nil, huma.Error403Forbidden("account_human_session_required")
	}
	return u, nil
}

func RegisterSystemAccountRoutes(api huma.API) {
	tags := []string{"system"}
	Register(api, huma.Operation{
		OperationID: "system-accounts-access", Method: http.MethodGet, Path: "/system/accounts/access", Tags: tags,
		Summary:     "Read Astering account-operations capability",
		Description: "Active human browser sessions only. Explicit ASTERING_SUPERADMIN_IDS is independent of usage/SMTP grants and licensed instance-admin roles. Internal resource-only agent execution, bots, API tokens and shares are refused. No private business-resource access is granted.",
	}, func(ctx context.Context, _ *struct{}) (*accountManagementAccessBody, error) {
		u, err := systemAccountHuman(ctx)
		if err != nil {
			return nil, err
		}
		out := &accountManagementAccessBody{CacheControl: "no-store"}
		out.Body.CurrentUserID = u.ID
		if accountadmin.Configured(u.ID) {
			s := db.NewReadSession()
			defer s.Close()
			db.SetSessionContext(ctx, s)
			if _, err = models.RequireAccountSuperadmin(s, u); err != nil {
				return nil, accountManagementError(err)
			}
			out.Body.CanManageAccounts = true
		}
		return out, nil
	})
	Register(api, huma.Operation{
		OperationID: "system-accounts-list", Method: http.MethodGet, Path: "/system/accounts", Tags: tags,
		Summary:     "Read Astering managed-account usage and access metadata",
		Description: "Explicit active deployment superadministrators only; never returns emails, private content, credential values or provider settings. Reuses the documented bounded usage snapshot while rereading statuses, protected flags and session/API-token counts per request. Counts include directly owned bots. This capability does not grant the independent usage-reader grant or licensed admin features.",
	}, systemAccountsList)
	Register(api, huma.Operation{
		OperationID: "system-accounts-status", Method: http.MethodPost, Path: "/system/accounts/{id}/status", Tags: tags,
		Summary:       "Activate or suspend an ordinary Astering account",
		Description:   "Explicit deployment superadministrators may switch ordinary human accounts only between active and disabled. Exact current username and expected status prevent stale confirmation. Self, configured superadministrators, bots, pending verification, locked and deletion-scheduled targets are protected. Both suspension and activation atomically revoke existing sessions/API tokens/OAuth codes for the account and owned bots, record an operational journal and cancel Arona jobs after commit, including credentials retained by older or CLI suspension paths. Business data, project shares and existing public links remain intact. Activation never restores old credentials or jobs. Not exposed to agent tools or MCP.",
		DefaultStatus: http.StatusOK,
	}, func(ctx context.Context, in *struct {
		ID   int64 `path:"id" minimum:"1"`
		Body models.AccountStatusChange
	}) (*accountManagementResultBody, error) {
		return commitAccountManagement(ctx, func(s *xorm.Session, u *user.User) (*models.AccountManagementResult, error) {
			return models.ChangeManagedAccountStatus(s, u, in.ID, in.Body)
		})
	})
	Register(api, huma.Operation{
		OperationID: "system-accounts-revoke-access", Method: http.MethodPost, Path: "/system/accounts/{id}/revoke-access", Tags: tags,
		Summary:       "Revoke an ordinary account's active credentials and Arona jobs",
		Description:   "Exact current username confirmation required. Atomically removes sessions, API tokens and outstanding OAuth codes for the account and directly owned bots, including existing JWT session validity; records a journal and cancels Arona jobs after commit. Does not change password, public links, permissions or business data. An active account may sign in again. Self, configured superadministrators, bot and deletion-scheduled targets are protected. No agent/MCP access.",
		DefaultStatus: http.StatusOK,
	}, func(ctx context.Context, in *struct {
		ID   int64 `path:"id" minimum:"1"`
		Body models.AccountAccessRevoke
	}) (*accountManagementResultBody, error) {
		return commitAccountManagement(ctx, func(s *xorm.Session, u *user.User) (*models.AccountManagementResult, error) {
			return models.RevokeManagedAccountAccess(s, u, in.ID, in.Body)
		})
	})
	Register(api, huma.Operation{
		OperationID: "system-accounts-events", Method: http.MethodGet, Path: "/system/accounts/events", Tags: tags,
		Summary:     "Read the Astering account-operation journal",
		Description: "Explicit deployment superadministrators only. Immutable operational events contain historical actor/target usernames, status changes, revoked counts and optional short reasons. They do not contain business content, IPs, emails or credentials and remain after account deletion. Paginated newest first.",
	}, systemAccountsEvents)
}

func accountManagementError(err error) error {
	if models.IsAccountAdminError(err) || user.IsErrLastAdmin(err) {
		return translateDomainError(err)
	}
	return huma.Error503ServiceUnavailable("account_operation_unavailable")
}

func cappedAccountPageSize(requested int) int {
	requested = max(1, min(requested, 100))
	if maximum := config.ServiceMaxItemsPerPage.GetInt(); maximum > 0 {
		requested = min(requested, maximum)
	}
	return requested
}
func systemAccountsList(ctx context.Context, in *systemUsageInput) (*accountManagementBody, error) {
	u, err := systemAccountHuman(ctx)
	if err != nil {
		return nil, err
	}
	result, err := models.ReadManagedAccounts(ctx, u, instanceusage.AccountUsageQuery{
		Page: in.Page, PerPage: cappedAccountPageSize(in.PerPage), Q: in.Q, Status: in.Status, Role: in.Role,
		Anomaly: in.Anomaly, SortBy: in.SortBy, OrderBy: in.OrderBy,
	})
	if err != nil {
		return nil, accountManagementError(err)
	}
	return &accountManagementBody{CacheControl: "no-store", Body: result}, nil
}
func systemAccountsEvents(ctx context.Context, in *struct {
	Page     int   `query:"page" default:"1" minimum:"1" maximum:"10000000"`
	PerPage  int   `query:"per_page" default:"25" minimum:"1" maximum:"100"`
	TargetID int64 `query:"target_id" minimum:"0" doc:"Optional account ID; zero returns all account operations."`
}) (*accountManagementEventsBody, error) {
	u, err := systemAccountHuman(ctx)
	if err != nil {
		return nil, err
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	perPage := cappedAccountPageSize(in.PerPage)
	items, total, err := models.ReadAccountAdminEvents(s, u, in.TargetID, in.Page, perPage)
	if err != nil {
		return nil, accountManagementError(err)
	}
	return &accountManagementEventsBody{CacheControl: "no-store", Body: NewPaginated(items, total, in.Page, perPage)}, nil
}

func commitAccountManagement(ctx context.Context, action func(*xorm.Session, *user.User) (*models.AccountManagementResult, error)) (*accountManagementResultBody, error) {
	u, err := systemAccountHuman(ctx)
	if err != nil {
		return nil, err
	}
	// Authorize before opening the write transaction/SQLite reservation so an
	// unprivileged user cannot acquire account-wide writer locks by probing IDs.
	gate := db.NewReadSession()
	db.SetSessionContext(ctx, gate)
	_, err = models.RequireAccountSuperadmin(gate, u)
	_ = gate.Close()
	if err != nil {
		return nil, accountManagementError(err)
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	if db.Type() == schemas.SQLITE {
		// Obtain SQLite's writer slot before establishing any WAL read snapshot.
		if _, err = s.Table(new(user.User)).Where("id = ?", 0).Update(map[string]any{"id": int64(0)}); err != nil {
			return nil, accountManagementError(err)
		}
	}
	result, err := action(s, u)
	if err != nil {
		_ = s.Rollback()
		return nil, accountManagementError(err)
	}
	if err = s.Commit(); err != nil {
		return nil, accountManagementError(err)
	}
	events.DispatchPending(ctx, s)
	return &accountManagementResultBody{CacheControl: "no-store", Body: result}, nil
}
