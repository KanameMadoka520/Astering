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

package instanceusage

import (
	"context"
	"os"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
)

// CanView has no fallback to the SMTP allowlist or the licensed administrator role.
// Reading it on every request makes explicit empty values and removals revoke immediately.
func CanView(uid int64) bool {
	if uid <= 0 {
		return false
	}
	for _, value := range strings.Split(os.Getenv("ASTERING_USAGE_ADMIN_IDS"), ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err == nil && id > 0 && id == uid {
			return true
		}
	}
	return false
}

// ActiveHuman re-reads only identity metadata, so stale JWT role/status claims
// cannot keep a disabled, removed or bot account authorized.
func ActiveHuman(ctx context.Context, uid int64) (bool, error) {
	if uid <= 0 {
		return false, nil
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	identity := struct {
		ID         int64
		Status     user.Status
		BotOwnerID int64
	}{}
	found, err := s.Table("users").Select("id, status, bot_owner_id").Where("id = ?", uid).Get(&identity)
	return found && identity.Status == user.StatusActive && identity.BotOwnerID == 0, err
}
