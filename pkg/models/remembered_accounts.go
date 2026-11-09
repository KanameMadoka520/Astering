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
	"encoding/hex"
	"errors"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/utils"
	"xorm.io/builder"
	"xorm.io/xorm"
)

const MaxRememberedAccounts = 5

var ErrRememberedAccountLimit = errors.New("this device already remembers five accounts")

// AsterAccountDevice stores only a hash of the separate HttpOnly switch credential.
// It never stores a password, access token, or recoverable refresh token.
type AsterAccountDevice struct {
	ID      string    `xorm:"varchar(64) pk" json:"-"`
	Expires time.Time `xorm:"not null index" json:"-"`
}

func (*AsterAccountDevice) TableName() string { return "aster_account_devices" }

type AsterRememberedAccount struct {
	ID        int64  `xorm:"bigint autoincr pk" json:"-"`
	DeviceID  string `xorm:"varchar(64) not null unique(aster_device_session) index" json:"-"`
	SessionID string `xorm:"varchar(36) not null unique(aster_device_session) index" json:"-"`
}

func (*AsterRememberedAccount) TableName() string { return "aster_remembered_accounts" }

type RememberedAccount struct {
	SessionID  string    `json:"session_id" readOnly:"true" doc:"The remembered login on this device; not an authentication secret."`
	UserID     int64     `json:"user_id" readOnly:"true" doc:"The account identity; account data is not included."`
	Username   string    `json:"username" readOnly:"true" doc:"The public login name."`
	Name       string    `json:"name" readOnly:"true" doc:"The account display name."`
	LastActive time.Time `json:"last_active" readOnly:"true" doc:"When this login was last used."`
}

// LockRememberedAccount uses the same device -> user -> SID lock order as
// remember/forget. Refresh and account revocation never acquire device locks.
func LockRememberedAccount(s *xorm.Session, raw, sid string) (*Session, *user.User, error) {
	if len(raw) != 64 || len(sid) != 36 {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	hash := HashSessionToken(raw)
	device := &AsterAccountDevice{}
	exists, err := routineCurrentRead(s).ID(hash).Get(device)
	if err != nil {
		return nil, nil, err
	}
	if !exists || !device.Expires.After(time.Now()) {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	binding := &AsterRememberedAccount{}
	exists, err = routineCurrentRead(s).Where("device_id = ? AND session_id = ?", hash, sid).Get(binding)
	if err != nil {
		return nil, nil, err
	}
	if !exists {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	// The owner is immutable; this initial read only chooses the user lock.
	sess, err := GetSessionByID(s, sid)
	if err != nil {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	if err = LockCredentialIssue(s, &user.User{ID: sess.UserID}); err != nil {
		return nil, nil, err
	}
	current := &Session{}
	exists, err = routineCurrentRead(s).ID(sid).Get(current)
	if err != nil {
		return nil, nil, err
	}
	if !exists || current.UserID != sess.UserID || time.Since(current.LastActive) > sessionMaximumAge(current) {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	u := &user.User{}
	exists, err = routineCurrentRead(s).ID(current.UserID).Get(u)
	if err != nil {
		return nil, nil, err
	}
	if !exists {
		return nil, nil, &ErrInvalidRefreshToken{}
	}
	if err = user.CheckUserCanAuthenticate(u); err != nil {
		return nil, nil, err
	}
	if u.IsBot() {
		return nil, nil, ErrGenericForbidden{}
	}
	return current, u, nil
}

// RememberAccount binds only the authenticated actor's existing browser SID.
func RememberAccount(s *xorm.Session, raw string, actor *user.User, sid string, lifetime time.Duration) (token string, expires time.Time, err error) {
	if actor == nil || actor.IsBot() || actor.HasResourceOnlyPermissions() || actor.CredentialScope().SessionID != sid || sid == "" {
		return "", expires, ErrGenericForbidden{}
	}
	if err = ReserveCredentialTransaction(s); err != nil {
		return "", expires, err
	}
	device := &AsterAccountDevice{}
	if len(raw) == 64 {
		_, err = routineCurrentRead(s).ID(HashSessionToken(raw)).Get(device)
		if err != nil {
			return "", expires, err
		}
	}
	if device.ID == "" || !device.Expires.After(time.Now()) {
		random, randomErr := utils.CryptoRandomBytes(32)
		if randomErr != nil {
			return "", expires, randomErr
		}
		raw = hex.EncodeToString(random)
		device = &AsterAccountDevice{
			ID:      HashSessionToken(raw),
			Expires: time.Now().Add(lifetime),
		}
		if _, err = s.Insert(device); err != nil {
			return "", expires, err
		}
	}
	// Read the bounded set immediately after the device lock, before taking any
	// user/SID lock. This starts a fresh MySQL snapshot and avoids cross-user SID
	// locks (two devices may contain the same two users in a different order).
	bindings := []*AsterRememberedAccount{}
	if err = routineCurrentRead(s).Where("device_id = ?", device.ID).Find(&bindings); err != nil {
		return "", expires, err
	}
	selection, err := selectRememberedBindings(s, bindings, actor.ID, sid)
	if err != nil {
		return "", expires, err
	}
	if err = LockCredentialIssue(s, actor); err != nil {
		return "", expires, err
	}
	current := &Session{}
	exists, readErr := routineCurrentRead(s).ID(sid).Get(current)
	if readErr != nil {
		return "", expires, readErr
	}
	if !exists || current.UserID != actor.ID || time.Since(current.LastActive) > sessionMaximumAge(current) {
		return "", expires, ErrGenericForbidden{}
	}
	if !selection.already && selection.count >= MaxRememberedAccounts {
		return "", expires, ErrRememberedAccountLimit
	}
	for _, b := range selection.obsolete {
		if _, err = s.ID(b.ID).Delete(&AsterRememberedAccount{}); err != nil {
			return "", expires, err
		}
	}
	// Only the same actor's old SIDs are revoked under that actor's user lock.
	for _, oldSID := range selection.replaced {
		if _, err = DeleteSessionByID(s, oldSID); err != nil && !IsErrSessionNotFound(err) {
			return "", expires, err
		}
	}
	if !selection.already {
		if _, err = s.Insert(&AsterRememberedAccount{
			DeviceID:  device.ID,
			SessionID: sid,
		}); err != nil {
			return "", expires, err
		}
	}
	return raw, device.Expires, nil
}

type rememberedBindingSelection struct {
	count    int
	already  bool
	obsolete []*AsterRememberedAccount
	replaced []string
}

func selectRememberedBindings(s *xorm.Session, bindings []*AsterRememberedAccount, actorID int64, sid string) (selection rememberedBindingSelection, err error) {
	for _, binding := range bindings {
		old, readErr := GetSessionByID(s, binding.SessionID)
		if readErr != nil && !IsErrSessionNotFound(readErr) {
			return selection, readErr
		}
		switch {
		case readErr != nil || time.Since(old.LastActive) > sessionMaximumAge(old):
			selection.obsolete = append(selection.obsolete, binding)
		case old.UserID == actorID:
			if old.ID == sid {
				selection.already = true
				continue
			}
			selection.obsolete = append(selection.obsolete, binding)
			selection.replaced = append(selection.replaced, old.ID)
		default:
			selection.count++
		}
	}
	return selection, nil
}

func ListRememberedAccounts(s *xorm.Session, raw string) ([]*RememberedAccount, error) {
	result := []*RememberedAccount{}
	if len(raw) != 64 {
		return result, nil
	}
	device := &AsterAccountDevice{}
	exists, err := s.ID(HashSessionToken(raw)).Get(device)
	if err != nil || !exists || !device.Expires.After(time.Now()) {
		return result, err
	}
	bindings := []*AsterRememberedAccount{}
	if err = s.Where("device_id = ?", device.ID).Asc("id").Find(&bindings); err != nil {
		return nil, err
	}
	for _, binding := range bindings {
		sess, getErr := GetSessionByID(s, binding.SessionID)
		if IsErrSessionNotFound(getErr) {
			continue
		}
		if getErr != nil {
			return nil, getErr
		}
		if time.Since(sess.LastActive) > sessionMaximumAge(sess) {
			continue
		}
		u, getErr := user.GetUserByIDForAuth(s, sess.UserID)
		if user.IsErrUserCannotAuthenticate(getErr) || user.IsErrUserDoesNotExist(getErr) {
			continue
		}
		if getErr != nil {
			return nil, getErr
		}
		if u.IsBot() {
			continue
		}
		result = append(result, &RememberedAccount{
			SessionID:  sess.ID,
			UserID:     u.ID,
			Username:   u.Username,
			Name:       u.Name,
			LastActive: sess.LastActive,
		})
	}
	return result, nil
}

// ForgetRememberedAccounts revokes only SIDs proved by this device credential.
// An expired device may still erase its own secrets but can never mint a token.
func ForgetRememberedAccounts(s *xorm.Session, raw, sid string) error {
	if len(raw) != 64 {
		return nil
	}
	if err := ReserveCredentialTransaction(s); err != nil {
		return err
	}
	device := &AsterAccountDevice{}
	exists, err := routineCurrentRead(s).ID(HashSessionToken(raw)).Get(device)
	if err != nil || !exists {
		return err
	}
	bindings := []*AsterRememberedAccount{}
	q := s.Where("device_id = ?", device.ID)
	if sid != "" {
		q = q.And("session_id = ?", sid)
	}
	if err = q.Find(&bindings); err != nil {
		return err
	}
	for _, b := range bindings {
		if _, err = DeleteSessionByID(s, b.SessionID); err != nil && !IsErrSessionNotFound(err) {
			return err
		}
		if _, err = s.ID(b.ID).Delete(&AsterRememberedAccount{}); err != nil {
			return err
		}
	}
	if sid == "" {
		_, err = s.ID(device.ID).Delete(&AsterAccountDevice{})
	}
	return err
}

func cleanupRememberedAccounts(s *xorm.Session) error {
	// Persisted timestamps use UTC. A raw WHERE parameter is not a mapped model
	// field, so XORM does not convert its timezone before the SQLite comparison.
	if _, err := s.Where("expires < ?", time.Now().UTC()).Delete(&AsterAccountDevice{}); err != nil {
		return err
	}
	_, err := s.Where(builder.Or(
		builder.NotIn("device_id", builder.Select("id").From("aster_account_devices")),
		builder.NotIn("session_id", builder.Select("id").From("sessions")),
	)).Delete(&AsterRememberedAccount{})
	return err
}
