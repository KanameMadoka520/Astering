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
	"maps"
	"sync"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/xorm"
)

// Only account deletion and provisioning of an already-created user's inbox
// establish this private, transaction-local maintenance scope. It bypasses only
// the inactive status, never existence, ownership, sharing or license checks.
// No context/header/JWT/JSON field or exported setter can grant this capability.
// Xorm sessions are already single-writer objects; scopes nest for owned bots.
var projectAccountMaintenance sync.Map

func withProjectAccountMaintenance(s *xorm.Session, uid int64, work func() error) error {
	if uid <= 0 || !s.IsInTx() {
		return ErrGenericForbidden{}
	}
	previous, existed := projectAccountMaintenance.Load(s)
	identities := map[int64]bool{}
	if existed {
		maps.Copy(identities, previous.(map[int64]bool))
	}
	identities[uid] = true
	projectAccountMaintenance.Store(s, identities)
	defer func() {
		if existed {
			projectAccountMaintenance.Store(s, previous)
		} else {
			projectAccountMaintenance.Delete(s)
		}
	}()
	return work()
}

func accountMaintenanceAllowsInactive(s *xorm.Session, actor *user.User, uid int64) bool {
	if actor == nil || actor.HasResourceOnlyPermissions() {
		return false
	}
	proof := actor.CredentialScope()
	if proof.SessionID != "" || proof.APITokenID > 0 {
		return false
	}
	value, ok := projectAccountMaintenance.Load(s)
	return ok && value.(map[int64]bool)[uid]
}
