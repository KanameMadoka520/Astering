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
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestRememberedAccountBoundAndRevokedAdmittedProof(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	raw := ""
	for index, uid := range []int64{1, 2, 3, 6, 7, 8} {
		s := db.NewSession()
		sess, err := CreateSession(s, uid, "Remembered account bound", "127.0.0.1", true, nil)
		require.NoError(t, err)
		require.NoError(t, s.Commit())
		require.NoError(t, s.Close())
		s = db.NewSession()
		actor := user.WithSessionCredential(&user.User{ID: uid}, sess.ID)
		token, _, err := RememberAccount(s, raw, actor, sess.ID, 24*time.Hour)
		if index == 5 {
			require.ErrorIs(t, err, ErrRememberedAccountLimit)
			require.NoError(t, s.Rollback())
		} else {
			require.NoError(t, err)
			raw = token
			require.NoError(t, s.Commit())
			events.DispatchPending(context.Background(), s)
		}
		require.NoError(t, s.Close())
	}
	s := db.NewSession()
	defer s.Close()
	accounts, err := ListRememberedAccounts(s, raw)
	require.NoError(t, err)
	require.Len(t, accounts, 5)
	require.NoError(t, s.Rollback())
}

func TestRememberedAccountCannotRememberForeignOrRevokedSession(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	own := "550e8400-e29b-41d4-a716-446655440001"
	foreign := "550e8400-e29b-41d4-a716-446655440003"
	actor := user.WithSessionCredential(&user.User{ID: 1}, own)
	_, _, err := RememberAccount(s, "", actor, foreign, time.Hour)
	require.Error(t, err)
	require.NoError(t, s.Rollback())
	s = db.NewSession()
	defer s.Close()
	_, err = DeleteSessionByID(s, own)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	s = db.NewSession()
	defer s.Close()
	_, _, err = RememberAccount(s, "", actor, own, time.Hour)
	require.Error(t, err, "an admitted JWT must be rechecked under the user lock")
}

func TestRememberedAccountCleanupPreservesLiveBindingsAndSessions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	devices := []*AsterAccountDevice{
		{
			ID:      "active-device",
			Expires: time.Now().Add(time.Hour),
		},
		{
			ID:      "expired-device",
			Expires: time.Now().Add(-time.Hour),
		},
	}
	inserted, err := s.Insert(devices)
	require.NoError(t, err)
	require.EqualValues(t, len(devices), inserted)
	const liveSID = "550e8400-e29b-41d4-a716-446655440001"
	bindings := []*AsterRememberedAccount{
		{
			DeviceID:  "active-device",
			SessionID: liveSID,
		},
		{
			DeviceID:  "expired-device",
			SessionID: liveSID,
		},
		{
			DeviceID:  "missing-device",
			SessionID: liveSID,
		},
		{
			DeviceID:  "active-device",
			SessionID: "missing-session",
		},
	}
	inserted, err = s.Insert(bindings)
	require.NoError(t, err)
	require.EqualValues(t, len(bindings), inserted)
	_, err = GetSessionByID(s, liveSID)
	require.NoError(t, err, "the fixture login must exist before orphan cleanup")
	active := &AsterAccountDevice{}
	exists, err := s.ID("active-device").Get(active)
	require.NoError(t, err)
	require.True(t, exists, "the active device must have been persisted")
	require.True(t, active.Expires.After(time.Now()), "stored expiry must remain in the future: %s", active.Expires)
	require.NoError(t, cleanupRememberedAccounts(s))
	active = &AsterAccountDevice{}
	exists, err = s.ID("active-device").Get(active)
	require.NoError(t, err)
	require.True(t, exists, "expiry cleanup must preserve the active device")
	exists, err = s.ID("expired-device").Exist(&AsterAccountDevice{})
	require.NoError(t, err)
	require.False(t, exists, "expiry cleanup must delete the expired device")
	remaining := []*AsterRememberedAccount{}
	require.NoError(t, s.Find(&remaining))
	require.Len(t, remaining, 1)
	require.Equal(t, "active-device", remaining[0].DeviceID)
	require.Equal(t, liveSID, remaining[0].SessionID)
	_, err = GetSessionByID(s, liveSID)
	require.NoError(t, err, "device cleanup must not sign out a live login")
}
