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
	"io"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/stretchr/testify/require"
)

func reserveNoteOrganizationFixture(t *testing.T, uid int64) *NoteOrganizationReservation {
	t.Helper()
	reservation, err := ReserveNoteOrganizationStart(context.Background(), uid)
	require.NoError(t, err)
	t.Cleanup(reservation.Abort)
	return reservation
}

func TestNoteOrganizationCapacitySeparatesAccountsAndOwnsClaimedReservations(t *testing.T) {
	const uid int64 = 94401
	first := reserveNoteOrganizationFixture(t, uid)
	second := reserveNoteOrganizationFixture(t, uid)
	zero := &NoteOrganizationReservation{}
	zero.Abort()
	require.Error(t, zero.claim(uid))
	_, err := ReserveNoteOrganizationStart(context.Background(), uid)
	require.Equal(t, NoteOrganizationCapacityError{Account: true}, err)
	reserveNoteOrganizationFixture(t, uid+1)
	require.NoError(t, first.claim(uid))
	first.Abort()
	_, err = ReserveNoteOrganizationStart(context.Background(), uid)
	require.Equal(t, NoteOrganizationCapacityError{Account: true}, err, "request cancellation cannot release a worker-owned slot")
	require.Error(t, first.claim(uid), "a capacity lease can only be transferred once")
	first.release()
	first.release()
	reserveNoteOrganizationFixture(t, uid)
	second.Abort()
	copyOfSecond := *second
	copyOfSecond.Abort()
	second.Abort()
	reserveNoteOrganizationFixture(t, uid)
}

func TestNoteOrganizationCapacityBoundsInstanceAndRecoversAbortedReservations(t *testing.T) {
	reservations := make([]*NoteOrganizationReservation, 0, noteOrganizationTotalCapacity)
	for index := range noteOrganizationTotalCapacity {
		reservations = append(reservations, reserveNoteOrganizationFixture(t, 94500+int64(index)))
	}
	_, err := ReserveNoteOrganizationStart(context.Background(), 94600)
	require.Equal(t, NoteOrganizationCapacityError{}, err)
	reservations[0].Abort()
	reserveNoteOrganizationFixture(t, 94600)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = ReserveNoteOrganizationStart(ctx, 94601)
	require.ErrorIs(t, err, context.Canceled)
}

func TestNoteOrganizationCapacityPreservesWorkerAndReleasesDuplicateStart(t *testing.T) {
	actor, job := organizationFixture(t, 94610, "Keep this original while the provider is working.")
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	c := Connection{
		ID:              "fixture",
		Protocol:        "openai-chat",
		BaseURL:         server.URL,
		Model:           "model",
		ContextWindow:   10000,
		MaxOutputTokens: 2048,
		NonStreaming:    true,
	}
	lease := reserveNoteOrganizationFixture(t, actor.ID)
	require.NoError(t, StartNoteOrganization(context.Background(), actor, job, c, lease))
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("provider was not called")
	}
	duplicate := reserveNoteOrganizationFixture(t, actor.ID)
	require.EqualError(t, StartNoteOrganization(context.Background(), actor, job, c, duplicate), "note_organization_busy")
	// A duplicate start releases its own claim, while Abort on the successful
	// request must not release the running provider's reservation.
	lease.Abort()
	available := reserveNoteOrganizationFixture(t, actor.ID)
	_, err := ReserveNoteOrganizationStart(context.Background(), actor.ID)
	require.Equal(t, NoteOrganizationCapacityError{Account: true}, err)
	_, finish, err := RegisterAccountRun(context.Background(), actor.ID)
	require.NoError(t, err, "notes capacity must not block independent chat/account admission")
	finish()
	available.Abort()
	CancelNoteOrganization(actor.ID, job.ID, job.Attempt)
	finished := awaitOrganization(t, actor, job.ID)
	require.Equal(t, "cancelled", finished.Status)
	require.Eventually(t, func() bool {
		noteOrganizationCapacity.Lock()
		defer noteOrganizationCapacity.Unlock()
		return noteOrganizationCapacity.accounts[accountKey(actor.ID)] == 0
	}, time.Second, time.Millisecond)
	reserveNoteOrganizationFixture(t, actor.ID)
	reserveNoteOrganizationFixture(t, actor.ID)
}
