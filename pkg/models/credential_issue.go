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
	"slices"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// ReserveCredentialTransaction prevents a later SQLite WAL read-to-write upgrade
// against an obsolete snapshot. It never changes an account or its updated time.
func ReserveCredentialTransaction(s *xorm.Session) error {
	if !s.IsInTx() {
		return accountError("account_transaction_required", 500)
	}
	if db.Type() != schemas.SQLITE {
		return nil
	}
	_, err := s.Table(new(user.User)).Where("id = ?", 0).Update(map[string]any{"id": int64(0)})
	return err
}

// LockCredentialIssue serializes credential creation with account suspension and
// revocation. Browser/API authentication proof is rechecked after the user lock,
// so an already authenticated request cannot mint new credentials after revoke.
// Trusted internal callers without proof still require a current active user.
func LockCredentialIssue(s *xorm.Session, actor *user.User, targetIDs ...int64) error {
	if actor == nil || actor.ID <= 0 {
		return ErrGenericForbidden{}
	}
	if err := ReserveCredentialTransaction(s); err != nil {
		return err
	}
	identity := &user.User{}
	found, err := s.ID(actor.ID).Get(identity)
	if err != nil {
		return err
	}
	if !found {
		return user.ErrUserDoesNotExist{UserID: actor.ID}
	}
	ids := append([]int64{actor.ID}, targetIDs...)
	if identity.BotOwnerID > 0 {
		ids = append(ids, identity.BotOwnerID)
	}
	slices.Sort(ids)
	ids = slices.Compact(ids)
	current := map[int64]*user.User{}
	for _, id := range ids {
		if id <= 0 {
			return ErrGenericForbidden{}
		}
		row := &user.User{}
		found, err := routineCurrentRead(s).ID(id).Get(row)
		if err != nil {
			return err
		}
		if !found {
			return user.ErrUserDoesNotExist{UserID: id}
		}
		// Owners may preconfigure credentials for an inactive owned bot; it
		// still cannot authenticate until re-enabled. Only the caller and its
		// own human owner must be currently active.
		if id == actor.ID || id == identity.BotOwnerID {
			if err := user.CheckUserCanAuthenticate(row); err != nil {
				return err
			}
		}
		current[id] = row
	}
	if current[actor.ID].IsBot() {
		ownerID := current[actor.ID].BotOwnerID
		// Bots can authenticate API calls, but cannot use token issuance to
		// escape their current owner's status. Bot owners are immutable.
		if ownerID != actor.ID && !slices.Contains(ids, ownerID) {
			return ErrGenericForbidden{}
		}
	}
	return validateCurrentCredentialProof(s, actor)
}

func validateCurrentCredentialProof(s *xorm.Session, actor *user.User) error {
	proof := actor.CredentialScope()
	if proof.SessionID != "" {
		sess := &Session{}
		found, err := routineCurrentRead(s).Where("id = ? AND user_id = ?", proof.SessionID, actor.ID).Get(sess)
		if err != nil {
			return err
		}
		if !found {
			return ErrGenericForbidden{}
		}
		maximum := sessionMaximumAge(sess)
		if time.Since(sess.LastActive) > maximum {
			return ErrGenericForbidden{}
		}
	}
	if proof.APITokenID > 0 {
		token := &APIToken{}
		found, err := routineCurrentRead(s).Where("id = ? AND owner_id = ?", proof.APITokenID, actor.ID).Get(token)
		if err != nil {
			return err
		}
		if !found || !token.ExpiresAt.After(time.Now()) {
			return ErrGenericForbidden{}
		}
	}
	return nil
}

func sessionMaximumAge(session *Session) time.Duration {
	ttl := config.ServiceJWTTTL.GetInt64()
	if session.IsLongSession {
		ttl = config.ServiceJWTTTLLong.GetInt64()
	}
	return time.Duration(ttl) * time.Second
}
