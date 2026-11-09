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
	"sync"
)

const (
	noteOrganizationAccountCapacity = 2
	noteOrganizationTotalCapacity   = 32
)

type NoteOrganizationCapacityError struct {
	Account bool
}

func (e NoteOrganizationCapacityError) Error() string {
	if e.Account {
		return "note_organization_capacity_account"
	}
	return "note_organization_capacity_instance"
}

var noteOrganizationCapacity = struct {
	sync.Mutex
	accounts map[accountStoreKey]int
	total    int
}{accounts: map[accountStoreKey]int{}}

// NoteOrganizationReservation is a process-local capacity lease, never accepted
// from a browser. Reservations already count toward capacity before DB commit.
type NoteOrganizationReservation struct {
	lease *noteOrganizationLease
}

type noteOrganizationLease struct {
	mu       sync.Mutex
	key      accountStoreKey
	claimed  bool
	released bool
	once     sync.Once
}

func ReserveNoteOrganizationStart(ctx context.Context, uid int64) (*NoteOrganizationReservation, error) {
	if uid <= 0 {
		return nil, ErrAccountAccessRevoked
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	conversations.Lock()
	err := checkAccountRunAdmissionLocked(ctx, uid)
	conversations.Unlock()
	if err != nil {
		return nil, err
	}
	key := accountKey(uid)
	noteOrganizationCapacity.Lock()
	defer noteOrganizationCapacity.Unlock()
	if noteOrganizationCapacity.accounts[key] >= noteOrganizationAccountCapacity {
		return nil, NoteOrganizationCapacityError{Account: true}
	}
	if noteOrganizationCapacity.total >= noteOrganizationTotalCapacity {
		return nil, NoteOrganizationCapacityError{}
	}
	noteOrganizationCapacity.accounts[key]++
	noteOrganizationCapacity.total++
	return &NoteOrganizationReservation{lease: &noteOrganizationLease{key: key}}, nil
}

func (r *NoteOrganizationReservation) free() {
	lease := r.lease
	lease.once.Do(func() {
		noteOrganizationCapacity.Lock()
		defer noteOrganizationCapacity.Unlock()
		noteOrganizationCapacity.accounts[lease.key]--
		if noteOrganizationCapacity.accounts[lease.key] == 0 {
			delete(noteOrganizationCapacity.accounts, lease.key)
		}
		noteOrganizationCapacity.total--
	})
}

// Abort releases a request-owned reservation after transaction/validation errors.
// Once a worker claims it, only the worker's actual teardown can release it.
func (r *NoteOrganizationReservation) Abort() {
	if r == nil || r.lease == nil {
		return
	}
	lease := r.lease
	lease.mu.Lock()
	if lease.claimed || lease.released {
		lease.mu.Unlock()
		return
	}
	lease.released = true
	lease.mu.Unlock()
	r.free()
}

func (r *NoteOrganizationReservation) claim(uid int64) error {
	if r == nil || r.lease == nil {
		return errors.New("note_organization_reservation_invalid")
	}
	lease := r.lease
	lease.mu.Lock()
	defer lease.mu.Unlock()
	if lease.claimed || lease.released || lease.key != accountKey(uid) {
		return errors.New("note_organization_reservation_invalid")
	}
	lease.claimed = true
	return nil
}

func (r *NoteOrganizationReservation) release() {
	lease := r.lease
	lease.mu.Lock()
	lease.released = true
	lease.mu.Unlock()
	r.free()
}

func claimNoteOrganizationReservation(ctx context.Context, uid int64, reservations []*NoteOrganizationReservation) (*NoteOrganizationReservation, error) {
	var reservation *NoteOrganizationReservation
	if len(reservations) > 1 {
		return nil, errors.New("note_organization_reservation_invalid")
	}
	if len(reservations) == 1 {
		reservation = reservations[0]
	}
	if reservation == nil {
		var err error
		reservation, err = ReserveNoteOrganizationStart(ctx, uid)
		if err != nil {
			return nil, err
		}
	}
	if err := reservation.claim(uid); err != nil {
		reservation.Abort()
		return nil, err
	}
	return reservation, nil
}
