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

package tcyai

import (
	"context"
	"errors"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/mattn/go-sqlite3"
	"xorm.io/xorm/schemas"
)

// readBackgroundCurrentAccount is the bounded lifecycle boundary shared by
// committed-deletion cleanup and durable-worker authorization. Neither owns an
// HTTP request; cleanup must still verify deletion after that request is gone.
//
//nolint:contextcheck // The context-free lifecycle bridge needs its own two-second background deadline, independent of browser cancellation.
func readBackgroundCurrentAccount(uid int64) (*user.User, bool, error) {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	return readCurrentAccount(ctx, uid)
}

// readCurrentAccount retries only an identified transient SQLite read lock.
// Every attempt uses a fresh non-transactional session, so a committed suspension
// or deletion is observed after unlocking. No status or absence is cached, and
// authorization/other database errors are never retried or treated as deletion.
// Callers provide one total deadline, including all attempts and backoff.
func readCurrentAccount(ctx context.Context, uid int64) (*user.User, bool, error) {
	for {
		if err := ctx.Err(); err != nil {
			return nil, false, err
		}
		identity, exists, err := readCurrentAccountAttempt(ctx, uid)
		var contention sqlite3.Error
		if err == nil || db.Type() != schemas.SQLITE || !errors.As(err, &contention) || (contention.Code != sqlite3.ErrBusy && contention.Code != sqlite3.ErrLocked) {
			return identity, exists, err
		}
		timer := time.NewTimer(10 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, false, ctx.Err()
		case <-timer.C:
		}
	}
}

func readCurrentAccountAttempt(ctx context.Context, uid int64) (*user.User, bool, error) {
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	identity := &user.User{}
	exists, err := s.Select("id, status, bot_owner_id").ID(uid).Get(identity)
	return identity, exists, err
}
