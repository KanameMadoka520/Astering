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
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAutomationBackgroundJWTUsesExplicitDeadlineWithoutChangingLoginTTL(t *testing.T) {
	secret, ttl := config.ServiceSecret.GetString(), config.ServiceJWTTTLShort.GetInt64()
	config.ServiceSecret.Set("background-token-fixture")
	config.ServiceJWTTTLShort.Set(600)
	t.Cleanup(func() { config.ServiceSecret.Set(secret); config.ServiceJWTTTLShort.Set(ttl) })
	identity := &user.User{
		ID:       1,
		Username: "account-owner",
	}
	deadline := time.Now().Add(2 * time.Hour)
	token, err := NewBackgroundUserJWTAuthtoken(identity, "owned-service-session", deadline)
	require.NoError(t, err)
	claims, err := ParseUserToken(token)
	require.NoError(t, err)
	assert.EqualValues(t, 1, claims.UserID)
	assert.Equal(t, "owned-service-session", claims.SessionID)
	assert.WithinDuration(t, deadline, claims.ExpiresAt, time.Second)
	normal, err := NewUserJWTAuthtoken(identity, "browser-session")
	require.NoError(t, err)
	normalClaims, err := ParseUserToken(normal)
	require.NoError(t, err)
	assert.WithinDuration(t, time.Now().Add(600*time.Second), normalClaims.ExpiresAt, time.Second)
	for _, expiry := range []time.Time{
		time.Now().Add(-time.Second),
		time.Now().Add(24*time.Hour + 2*time.Minute),
	} {
		_, err = NewBackgroundUserJWTAuthtoken(identity, "owned-service-session", expiry)
		require.Error(t, err)
	}
	_, err = NewBackgroundUserJWTAuthtoken(identity, "", deadline)
	require.Error(t, err)
	_, err = NewBackgroundUserJWTAuthtoken(nil, "owned-service-session", deadline)
	require.Error(t, err)
}
