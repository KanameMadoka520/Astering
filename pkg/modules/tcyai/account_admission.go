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

	"github.com/google/uuid"
)

var ErrAccountAccessRevoked = errors.New("AI account access was revoked; sign in again before starting another run")

type accountRunAdmissionContextKey struct{}
type accountRunAdmission struct {
	key        accountStoreKey
	generation uint64
}

// Both maps use conversations.Mutex. Generations are only created for accounts
// actually revoked in this process and never reset, so delayed requests cannot
// encounter an ABA generation after a worker finishes or an account reactivates.
var accountRunGenerations = map[accountStoreKey]uint64{}
var accountEphemeralRuns = map[accountStoreKey]map[string]context.CancelFunc{}

// WithAccountRunAdmission must run before validating the original browser
// credential under the users-row lock. Start/review/compact compare this fence
// and register the live worker under the same mutex used by cancellation.
// The private context key cannot be supplied through JSON, headers or JWT.
func WithAccountRunAdmission(ctx context.Context, uid int64) context.Context {
	conversations.Lock()
	defer conversations.Unlock()
	key := accountKey(uid)
	return context.WithValue(ctx, accountRunAdmissionContextKey{}, accountRunAdmission{key: key, generation: accountRunGenerations[key]})
}

func checkAccountRunAdmissionLocked(ctx context.Context, uid int64) error {
	if accountDeleted(uid) {
		return ErrAccountDeleted
	}
	admission, ok := ctx.Value(accountRunAdmissionContextKey{}).(accountRunAdmission)
	if !ok {
		// Trusted internal callers do not impersonate an admitted HTTP request.
		return nil
	}
	key := accountKey(uid)
	if admission.key != key || accountRunGenerations[key] != admission.generation {
		return ErrAccountAccessRevoked
	}
	return nil
}

// RegisterAccountRun applies the same fence to the legacy synchronous agent
// loop. The returned cleanup always removes its cancellation slot on completion;
// it does not create a conversation or retain prompts/provider credentials.
func RegisterAccountRun(ctx context.Context, uid int64) (context.Context, func(), error) {
	conversations.Lock()
	defer conversations.Unlock()
	if err := checkAccountRunAdmissionLocked(ctx, uid); err != nil {
		return ctx, nil, err
	}
	key, id := accountKey(uid), uuid.NewString()
	jobCtx, cancel := context.WithCancel(ctx)
	if accountEphemeralRuns[key] == nil {
		accountEphemeralRuns[key] = map[string]context.CancelFunc{}
	}
	accountEphemeralRuns[key][id] = cancel
	done, watchDone := make(chan struct{}), make(chan struct{})
	go func() { defer close(watchDone); watchAccount(jobCtx, uid, cancel, done) }()
	var finishOnce sync.Once
	return jobCtx, func() {
		finishOnce.Do(func() {
			cancel()
			close(done)
			<-watchDone
			conversations.Lock()
			delete(accountEphemeralRuns[key], id)
			if len(accountEphemeralRuns[key]) == 0 {
				delete(accountEphemeralRuns, key)
			}
			conversations.Unlock()
		})
	}, nil
}
