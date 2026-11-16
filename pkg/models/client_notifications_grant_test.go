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

// Astering additions provide notification-only background capabilities.

package models

import (
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestClientNotificationGrantChecksOriginalHumanCredentialAfterAuthentication(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	installation := uuid.NewString()
	for _, actor := range []*user.User{
		{ID: 1},
		user.WithSessionCredential(&user.User{ID: 1}, "revoked-session-not-in-database"),
		user.WithAPITokenCredential(&user.User{ID: 1}, 1),
		user.WithSessionCredential(&user.User{
			ID:         1,
			BotOwnerID: 2,
		}, "some-session"),
		user.RestrictToResourcePermissions(user.WithSessionCredential(&user.User{ID: 1}, "some-session")).(*user.User),
	} {
		s := db.NewSession()
		_, err := IssueClientNotificationGrant(s, actor, installation, "Fixture", time.Now())
		require.Error(t, err)
		require.NoError(t, s.Close())
	}
	// A principal authenticated just before revocation cannot mint a durable grant
	// after the source SID disappears, even though it still has the same user ID.
	s := db.NewSession()
	session := &Session{
		ID:         uuid.NewString(),
		UserID:     1,
		TokenHash:  uuid.NewString(),
		LastActive: time.Now(),
	}
	_, err := s.Insert(session)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	actor := user.WithSessionCredential(&user.User{ID: 1}, session.ID)
	s = db.NewSession()
	_, err = s.ID(session.ID).Delete(&Session{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	s = db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	_, err = IssueClientNotificationGrant(s, actor, installation, "Fixture", time.Now())
	require.Error(t, err)
}
