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

package models

import (
	"context"
	"errors"
	"slices"
	"strings"
	"sync"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/modules/accountadmin"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// AccountAdminEvent is an Astering operational journal. It contains no business
// content, emails, IPs, provider configuration, credentials or password hashes.
type AccountAdminEvent struct {
	ID               int64       `xorm:"bigint autoincr pk" json:"id" readOnly:"true"`
	ActorID          int64       `xorm:"bigint not null index" json:"actor_id" readOnly:"true"`
	ActorUsername    string      `xorm:"varchar(250) not null" json:"actor_username" readOnly:"true"`
	TargetID         int64       `xorm:"bigint not null index" json:"target_id" readOnly:"true"`
	TargetUsername   string      `xorm:"varchar(250) not null" json:"target_username" readOnly:"true"`
	Action           string      `xorm:"varchar(24) not null" json:"action" readOnly:"true" doc:"status_changed or access_revoked."`
	OldStatus        user.Status `xorm:"not null" json:"old_status" readOnly:"true"`
	NewStatus        user.Status `xorm:"not null" json:"new_status" readOnly:"true"`
	RevokedSessions  int64       `xorm:"bigint not null" json:"revoked_sessions" readOnly:"true" doc:"Deleted user and owned-bot login sessions."`
	RevokedAPITokens int64       `xorm:"bigint not null" json:"revoked_api_tokens" readOnly:"true" doc:"Deleted user and owned-bot API tokens."`
	Reason           string      `xorm:"varchar(250) not null" json:"reason" readOnly:"true" doc:"Optional operational note; never include credentials or private content."`
	Created          time.Time   `xorm:"created not null index" json:"created" readOnly:"true" doc:"UTC operation timestamp."`
}

func (*AccountAdminEvent) TableName() string { return "account_admin_events" }

type AccountManagementUser struct {
	instanceusage.InstanceUserUsage
	IsSuperadmin    bool   `json:"is_superadmin" required:"true" doc:"Explicitly listed deployment superadministrator, not an instance-admin or usage grant."`
	IsProtected     bool   `json:"is_protected" required:"true" doc:"Both operational mutations are forbidden for this viewer and target."`
	CanChangeStatus bool   `json:"can_change_status" required:"true" doc:"Only active/disabled ordinary human accounts may be changed."`
	CanRevokeAccess bool   `json:"can_revoke_access" required:"true" doc:"Whether account and owned-bot sessions/tokens may be revoked."`
	ProtectedReason string `json:"protected_reason" required:"true" doc:"self, superadmin, bot, instance_admin, deletion_scheduled, verification_required, locked, or empty."`
	Sessions        int64  `json:"sessions" required:"true" doc:"Current session rows for this account and its owned bots; not online-user count."`
	APITokens       int64  `json:"api_tokens" required:"true" doc:"Current API token rows, including owned bots; no secrets are returned."`
	Bots            int64  `json:"bots" required:"true" doc:"Number of directly owned bot accounts."`
}

type AccountManagementSnapshot struct {
	Items       []AccountManagementUser            `json:"items" required:"true"`
	Total       int64                              `json:"total" required:"true"`
	Page        int                                `json:"page" required:"true"`
	PerPage     int                                `json:"per_page" required:"true"`
	TotalPages  int64                              `json:"total_pages" required:"true"`
	AsOf        time.Time                          `json:"as_of" required:"true" doc:"Usage collection timestamp; management flags, statuses and credentials are reread per request."`
	Overview    instanceusage.AccountUsageOverview `json:"overview" required:"true"`
	Definitions []string                           `json:"definitions" required:"true"`
}

type AccountManagementResult struct {
	UserID           int64       `json:"user_id" required:"true"`
	Status           user.Status `json:"status" required:"true"`
	RevokedSessions  int64       `json:"revoked_sessions" required:"true"`
	RevokedAPITokens int64       `json:"revoked_api_tokens" required:"true"`
	EventID          int64       `json:"event_id" required:"true" doc:"Atomic operational journal entry."`
}

type AccountStatusChange struct {
	Status          user.Status `json:"status" required:"true" enum:"0,2" doc:"0 active or 2 disabled. Email verification and security locks cannot be bypassed."`
	ExpectedStatus  user.Status `json:"expected_status" required:"true" minimum:"0" maximum:"3" doc:"Status shown when opening confirmation; stale state returns 409."`
	ConfirmUsername string      `json:"confirm_username" required:"true" minLength:"1" maxLength:"250" doc:"Exact current target username, required to confirm identity."`
	Reason          string      `json:"reason,omitempty" maxLength:"250" doc:"Optional short operational reason; do not enter secrets."`
}
type AccountAccessRevoke struct {
	ConfirmUsername string `json:"confirm_username" required:"true" minLength:"1" maxLength:"250" doc:"Exact current target username."`
	Reason          string `json:"reason,omitempty" maxLength:"250" doc:"Optional short operational reason; do not enter secrets."`
}

type AccountAdminError struct {
	Key    string
	Status int
}

func (e *AccountAdminError) Error() string { return e.Key }
func (e *AccountAdminError) HTTPError() web.HTTPError {
	return web.HTTPError{HTTPCode: e.Status, Message: e.Key}
}
func accountError(key string, status int) error { return &AccountAdminError{Key: key, Status: status} }

// RequireAccountSuperadmin checks current identity and the explicit deployment
// allow-list; it cannot inherit licensed cross-resource access or agent scope.
func RequireAccountSuperadmin(s *xorm.Session, a web.Auth) (*user.User, error) {
	actor, ok := a.(*user.User)
	if !ok || actor == nil || actor.HasResourceOnlyPermissions() || !accountadmin.Configured(actor.ID) {
		return nil, accountError("account_management_forbidden", 403)
	}
	fresh := &user.User{}
	found, err := routineCurrentRead(s).ID(actor.ID).Get(fresh)
	if err != nil {
		return nil, err
	}
	if !found || fresh.IsBot() || fresh.Status != user.StatusActive || !fresh.DeletionScheduledAt.IsZero() {
		return nil, accountError("account_management_forbidden", 403)
	}
	if actor.CredentialScope().APITokenID > 0 {
		return nil, accountError("account_management_forbidden", 403)
	}
	if err := validateCurrentCredentialProof(s, actor); err != nil {
		return nil, accountError("account_management_forbidden", 403)
	}
	return fresh, nil
}

func accountManagementFlags(viewer int64, target *user.User) (protected bool, status bool, revoke bool, reason string) {
	switch {
	case target.ID == viewer:
		return true, false, false, "self"
	case accountadmin.Configured(target.ID):
		return true, false, false, "superadmin"
	case target.IsBot():
		return true, false, false, "bot"
	case !target.DeletionScheduledAt.IsZero():
		return true, false, false, "deletion_scheduled"
	case target.IsAdmin:
		// The original administrator lifecycle belongs to its existing licensed
		// management path. This independent capability never changes that role
		// or races another administrator into removing the last reachable one.
		return false, false, true, "instance_admin"
	case target.Status == user.StatusEmailConfirmationRequired:
		return false, false, true, "verification_required"
	case target.Status == user.StatusAccountLocked:
		return false, false, true, "locked"
	case target.Status != user.StatusActive && target.Status != user.StatusDisabled:
		return true, false, false, "locked"
	default:
		return false, true, true, ""
	}
}

// ReadManagedAccounts reuses aggregate collection without extending the separate
// usage-reader grant. Mutation controls and credential counts are always fresh.
func ReadManagedAccounts(ctx context.Context, a web.Auth, query instanceusage.AccountUsageQuery) (*AccountManagementSnapshot, error) {
	s := db.NewReadSession()
	db.SetSessionContext(ctx, s)
	actor, err := RequireAccountSuperadmin(s, a)
	_ = s.Close()
	if err != nil {
		return nil, err
	}
	snapshot, err := instanceusage.Read(ctx, query)
	if err != nil {
		return nil, err
	}
	s = db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	// Recheck after a potentially slow aggregate scan.
	if _, err = RequireAccountSuperadmin(s, a); err != nil {
		return nil, err
	}
	out := &AccountManagementSnapshot{
		Items: make([]AccountManagementUser, 0, len(snapshot.Items)),
		Total: snapshot.Total, Page: snapshot.Page, PerPage: snapshot.PerPage,
		TotalPages: snapshot.TotalPages, AsOf: snapshot.AsOf,
		Overview: snapshot.Overview, Definitions: snapshot.Definitions,
	}
	ids := make([]int64, 0, len(snapshot.Items))
	for _, row := range snapshot.Items {
		ids = append(ids, row.ID)
	}
	users := []*user.User{}
	if err = s.Where(builder.Or(builder.In("id", ids), builder.In("bot_owner_id", ids))).OrderBy("id").Find(&users); err != nil {
		return nil, err
	}
	current := map[int64]*user.User{}
	owned := map[int64]int64{}
	owners := map[int64]int64{}
	all := []int64{}
	for _, u := range users {
		current[u.ID] = u
		all = append(all, u.ID)
		if u.BotOwnerID > 0 {
			owned[u.BotOwnerID]++
			owners[u.ID] = u.BotOwnerID
		}
	}
	type credentialCount struct {
		UserID int64
		Count  int64
	}
	sessions := []credentialCount{}
	tokens := []credentialCount{}
	if err = s.Table(new(Session)).Select("user_id, COUNT(*) AS count").In("user_id", all).GroupBy("user_id").Find(&sessions); err != nil {
		return nil, err
	}
	if err = s.Table(new(APIToken)).Select("owner_id AS user_id, COUNT(*) AS count").In("owner_id", all).GroupBy("owner_id").Find(&tokens); err != nil {
		return nil, err
	}
	sessionCount, tokenCount := map[int64]int64{}, map[int64]int64{}
	for _, row := range sessions {
		sessionCount[row.UserID] += row.Count
		if owner := owners[row.UserID]; owner > 0 {
			sessionCount[owner] += row.Count
		}
	}
	for _, row := range tokens {
		tokenCount[row.UserID] += row.Count
		if owner := owners[row.UserID]; owner > 0 {
			tokenCount[owner] += row.Count
		}
	}
	for _, row := range snapshot.Items {
		u := current[row.ID]
		if u == nil {
			continue
		} // A concurrent deletion cannot retain stale management controls.
		row.Username, row.Name, row.Status = u.Username, u.Name, int(u.Status)
		row.IsBot, row.IsInstanceAdmin, row.DeletionScheduled = u.IsBot(), u.IsAdmin, !u.DeletionScheduledAt.IsZero()
		protected, status, revoke, reason := accountManagementFlags(actor.ID, u)
		out.Items = append(out.Items, AccountManagementUser{
			InstanceUserUsage: row, IsSuperadmin: accountadmin.Configured(u.ID),
			IsProtected: protected, CanChangeStatus: status, CanRevokeAccess: revoke,
			ProtectedReason: reason, Sessions: sessionCount[u.ID], APITokens: tokenCount[u.ID], Bots: owned[u.ID],
		})
	}
	return out, nil
}

var accountRunRevoker struct {
	sync.RWMutex
	fn func(int64)
}

// SetAccountRunRevoker binds optional Arona cancellation without coupling models
// to private stores. It never deletes conversation data or changes ownership.
func SetAccountRunRevoker(fn func(int64)) func(int64) {
	accountRunRevoker.Lock()
	defer accountRunRevoker.Unlock()
	previous := accountRunRevoker.fn
	accountRunRevoker.fn = fn
	return previous
}
func cancelAccountRunsOnCommit(s *xorm.Session, ids []int64) {
	events.OnCommit(s, func() error {
		accountRunRevoker.RLock()
		fn := accountRunRevoker.fn
		accountRunRevoker.RUnlock()
		if fn != nil {
			for _, id := range ids {
				fn(id)
			}
		}
		return nil
	})
}

// Lock all known identities in stable order. The transaction only mutates
// account credentials/status/journal; it never acquires project/file locks.
func lockManagedIdentities(s *xorm.Session, a web.Auth, targetID int64) (*user.User, *user.User, []int64, error) {
	if !s.IsInTx() {
		return nil, nil, nil, accountError("account_transaction_required", 500)
	}
	actor, ok := a.(*user.User)
	if !ok || actor == nil || targetID <= 0 {
		return nil, nil, nil, accountError("account_management_forbidden", 403)
	}
	users := []*user.User{}
	if err := s.Where(builder.Or(builder.In("id", []int64{actor.ID, targetID}), builder.Eq{"bot_owner_id": targetID})).OrderBy("id").Find(&users); err != nil {
		return nil, nil, nil, err
	}
	ids := []int64{}
	for _, u := range users {
		ids = append(ids, u.ID)
		if db.Type() == schemas.SQLITE {
			if _, err := s.Table(new(user.User)).Where("id = ?", u.ID).Update(map[string]any{"id": u.ID}); err != nil {
				return nil, nil, nil, err
			}
		} else {
			if _, err := s.ForUpdate().ID(u.ID).Get(&user.User{}); err != nil {
				return nil, nil, nil, err
			}
		}
	}
	freshActor, err := RequireAccountSuperadmin(s, a)
	if err != nil {
		return nil, nil, nil, err
	}
	target := &user.User{}
	found, err := routineCurrentRead(s).ID(targetID).Get(target)
	if err != nil {
		return nil, nil, nil, err
	}
	if !found {
		return nil, nil, nil, accountError("account_not_found", 404)
	}
	current := []*user.User{}
	if err = routineCurrentRead(s).Where("bot_owner_id = ?", targetID).OrderBy("id").Find(&current); err != nil {
		return nil, nil, nil, err
	}
	affected := []int64{targetID}
	for _, u := range current {
		if !slices.Contains(ids, u.ID) {
			return nil, nil, nil, accountError("account_scope_changed", 409)
		}
		affected = append(affected, u.ID)
	}
	return freshActor, target, affected, nil
}

func revokeManagedCredentials(s *xorm.Session, ids []int64) (sessions int64, tokens int64, err error) {
	tokens, err = s.In("owner_id", ids).Delete(new(APIToken))
	if err != nil {
		return 0, 0, err
	}
	if _, err = s.In("user_id", ids).Delete(new(OAuthCode)); err != nil {
		return 0, 0, err
	}
	for _, id := range ids {
		var affected int64
		if affected, err = deleteAllUserSessions(s, id); err != nil {
			return 0, 0, err
		}
		sessions += affected
	}
	cancelAccountRunsOnCommit(s, slices.Clone(ids))
	return sessions, tokens, nil
}

// ChangeManagedAccountStatus is deliberately limited to active <-> disabled.
// Public registrations, identity-provider verification, security locks, licensed
// roles and resource permissions are unaffected.
func ChangeManagedAccountStatus(s *xorm.Session, a web.Auth, targetID int64, input AccountStatusChange) (*AccountManagementResult, error) {
	if input.Status != user.StatusActive && input.Status != user.StatusDisabled {
		return nil, accountError("account_status_invalid", 400)
	}
	return mutateManagedAccount(s, a, targetID, input.ConfirmUsername, input.Reason, &input)
}
func RevokeManagedAccountAccess(s *xorm.Session, a web.Auth, targetID int64, input AccountAccessRevoke) (*AccountManagementResult, error) {
	return mutateManagedAccount(s, a, targetID, input.ConfirmUsername, input.Reason, nil)
}
func mutateManagedAccount(s *xorm.Session, a web.Auth, targetID int64, confirmation string, reason string, status *AccountStatusChange) (*AccountManagementResult, error) {
	if utf8.RuneCountInString(reason) > 250 {
		return nil, accountError("account_reason_too_long", 400)
	}
	actor, target, affected, err := lockManagedIdentities(s, a, targetID)
	if err != nil {
		return nil, err
	}
	protected, canStatus, canRevoke, _ := accountManagementFlags(actor.ID, target)
	if protected || (status == nil && !canRevoke) || (status != nil && !canStatus) {
		return nil, accountError("account_protected", 403)
	}
	if confirmation == "" || confirmation != target.Username {
		return nil, accountError("account_confirmation_mismatch", 409)
	}
	journal := &AccountAdminEvent{
		ActorID: actor.ID, ActorUsername: actor.Username, TargetID: target.ID, TargetUsername: target.Username,
		Action: "access_revoked", OldStatus: target.Status, NewStatus: target.Status, Reason: strings.TrimSpace(reason),
	}
	if status != nil {
		if target.Status != status.ExpectedStatus {
			return nil, accountError("account_status_changed", 409)
		}
		if target.Status == status.Status {
			return nil, accountError("account_status_unchanged", 409)
		}
		if err = user.SetUserStatus(s, target, status.Status); err != nil {
			return nil, err
		}
		journal.Action, journal.NewStatus = "status_changed", status.Status
	}
	// Older/CLI suspension paths may leave credentials in place. Reactivation
	// must revoke them too, rather than make previously disabled access valid.
	journal.RevokedSessions, journal.RevokedAPITokens, err = revokeManagedCredentials(s, affected)
	if err != nil {
		return nil, err
	}
	if _, err = s.Insert(journal); err != nil {
		return nil, err
	}
	// Force the aggregate's account/status filter snapshot to refresh after the
	// successful commit. Failed transactions leave the old snapshot untouched.
	events.OnCommit(s, func() error { instanceusage.Invalidate(); return nil })
	return &AccountManagementResult{UserID: target.ID, Status: journal.NewStatus,
		RevokedSessions: journal.RevokedSessions, RevokedAPITokens: journal.RevokedAPITokens, EventID: journal.ID}, nil
}

func ReadAccountAdminEvents(s *xorm.Session, a web.Auth, targetID int64, page, perPage int) ([]*AccountAdminEvent, int64, error) {
	if _, err := RequireAccountSuperadmin(s, a); err != nil {
		return nil, 0, err
	}
	rows := []*AccountAdminEvent{}
	query := s.OrderBy("id DESC").Limit(perPage, (page-1)*perPage)
	if targetID > 0 {
		query = query.Where("target_id = ?", targetID)
	}
	total, err := query.FindAndCount(&rows)
	return rows, total, err
}

// IsAccountAdminError allows transport-specific status translation without
// exposing operational database errors or their potentially private metadata.
func IsAccountAdminError(err error) bool {
	var domain *AccountAdminError
	return errors.As(err, &domain)
}
