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

package apiv2

import (
	"context"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/keyvalue"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/builder"
	"xorm.io/xorm/contexts"
)

type liveNoteAuthProbeKey struct{}
type liveNoteAuthProbe struct {
	queries int
	bound   bool
	cancel  context.CancelFunc
}
type liveNoteAuthObserver struct{}

var liveNoteAuthObserverOnce sync.Once

func (liveNoteAuthObserver) BeforeProcess(hook *contexts.ContextHook) (context.Context, error) {
	probe, _ := hook.Ctx.Value(liveNoteAuthProbeKey{}).(*liveNoteAuthProbe)
	if probe != nil {
		probe.queries++
		deadline, bounded := hook.Ctx.Deadline()
		probe.bound = bounded && time.Until(deadline) > 0 && time.Until(deadline) <= 5*time.Second
		if probe.queries == 2 {
			// The session SELECT already succeeded. Cancellation must also reach the
			// following current-user SELECT instead of validating a stale identity.
			probe.cancel()
		}
	}
	return hook.Ctx, nil
}

func (liveNoteAuthObserver) AfterProcess(*contexts.ContextHook) error { return nil }

func liveNoteAuthClaims() *auth.UserTokenClaims {
	return &auth.UserTokenClaims{
		UserID:    1,
		SessionID: "550e8400-e29b-41d4-a716-446655440001",
		ExpiresAt: time.Now().Add(time.Hour),
	}
}

func TestLiveNotesSessionContextCancelsDatabaseIdentityRecheck(t *testing.T) {
	aiBucketFixtures(t)
	claims := liveNoteAuthClaims()
	require.NoError(t, auth.CheckUserTokenSessionContext(context.Background(), claims))
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, checkLiveNoteSession(ctx, claims), context.Canceled)

	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	liveNoteAuthObserverOnce.Do(func() { engine.AddHook(liveNoteAuthObserver{}) })
	ctx, cancel = context.WithCancel(context.Background())
	defer cancel()
	probe := &liveNoteAuthProbe{cancel: cancel}
	ctx = context.WithValue(ctx, liveNoteAuthProbeKey{}, probe)
	require.ErrorIs(t, checkLiveNoteSession(ctx, claims), context.Canceled)
	assert.Equal(t, 2, probe.queries, "the caller context must reach both credential and current-user queries")
	assert.True(t, probe.bound, "the live wire must bound credential checks to at most five seconds")
}

func TestLiveNotesSessionContextRejectsForeignMissingAndDisabledIdentities(t *testing.T) {
	for _, scenario := range []string{
		"foreign-session",
		"missing-session",
		"disabled-account",
	} {
		t.Run(scenario, func(t *testing.T) {
			aiBucketFixtures(t)
			claims := liveNoteAuthClaims()
			switch scenario {
			case "foreign-session":
				claims.UserID = 2
			case "missing-session":
				claims.SessionID = uuid.NewString()
			case "disabled-account":
				s := db.NewSession()
				defer s.Close()
				_, err := s.ID(claims.UserID).Cols("status").Update(&user.User{Status: user.StatusDisabled})
				require.NoError(t, err)
				require.NoError(t, s.Commit())
			}
			require.ErrorIs(t, auth.CheckUserTokenSessionContext(context.Background(), claims), auth.ErrUserTokenRejected)
		})
	}
}

func TestLiveNotesSessionContextBypassesCachedSuccessAfterRevocation(t *testing.T) {
	aiBucketFixtures(t)
	claims := liveNoteAuthClaims()
	cacheKey, err := user.SessionAuthCacheKey(claims.UserID, claims.SessionID)
	require.NoError(t, err)
	t.Cleanup(func() { require.NoError(t, keyvalue.Del(cacheKey)) })
	require.NoError(t, auth.CheckUserTokenSession(claims))
	_, cached, err := keyvalue.Get(cacheKey)
	require.NoError(t, err)
	require.True(t, cached, "exercise a real previously successful cache entry")

	s := db.NewSession()
	defer s.Close()
	deleted, err := s.ID(claims.SessionID).Delete(&models.Session{})
	require.NoError(t, err)
	require.EqualValues(t, 1, deleted)
	require.NoError(t, s.Commit())
	// Leave the old entry in place deliberately: live credential validation must
	// not depend on a contextless cache call, even while that cache says success.
	require.NoError(t, auth.CheckUserTokenSession(claims), "legacy cached callers keep their existing behavior")
	require.ErrorIs(t, checkLiveNoteSession(context.Background(), claims), auth.ErrUserTokenRejected)
}

func TestLiveNotesCanceledFinalDoesNotPersistOrAcknowledgeText(t *testing.T) {
	_, _, note := liveNotesFixture(t)
	claims := liveNoteAuthClaims()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	actor := user.WithSessionCredential(&user.User{ID: claims.UserID}, claims.SessionID)
	acknowledged := false
	sink := liveNoteDeltaSink(ctx, actor, note.ID, 0, claims, func(any) error {
		acknowledged = true
		return nil
	})
	require.ErrorIs(t, sink(tcyai.LiveSpeechDelta{
		ID:      uuid.NewString(),
		Text:    "Never acknowledged after cancellation.",
		Final:   true,
		StartMS: 0,
		EndMS:   100,
	}), auth.ErrUserTokenRejected)
	assert.False(t, acknowledged)
	db.AssertCount(t, "aster_note_segments", builder.Eq{"note_id": note.ID}, 0)
}
