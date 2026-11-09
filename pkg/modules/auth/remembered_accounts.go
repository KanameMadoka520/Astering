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

package auth

import (
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
)

// SwitchRememberedAccount mints credentials only after locking and revalidating
// the device binding, live SID, and active human account. A revoked SID cannot be
// recreated by a stale remembered-account cookie.
func SwitchRememberedAccount(raw, sid string) (*IssuedUserToken, error) {
	s := db.NewSession()
	defer s.Close()
	if err := models.ReserveCredentialTransaction(s); err != nil {
		return nil, err
	}
	sess, u, err := models.LockRememberedAccount(s, raw, sid)
	if err != nil {
		return nil, err
	}
	refresh, err := models.RotateRefreshToken(s, sess)
	if err != nil {
		return nil, err
	}
	if err = models.UpdateSessionLastActive(s, sid); err != nil {
		return nil, err
	}
	token, err := NewUserJWTAuthtoken(u, sid)
	if err != nil {
		return nil, err
	}
	if err = s.Commit(); err != nil {
		return nil, err
	}
	ttl := config.ServiceJWTTTL.GetInt64()
	if sess.IsLongSession {
		ttl = config.ServiceJWTTTLLong.GetInt64()
	}
	return &IssuedUserToken{
		AccessToken:  token,
		RefreshToken: refresh,
		CookieMaxAge: int(ttl),
	}, nil
}

func RememberedDeviceLifetime() time.Duration {
	return time.Duration(config.ServiceJWTTTLLong.GetInt64()) * time.Second
}
