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
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInstanceUsageInvalidationCannotRestoreInflightSnapshot(t *testing.T) {
	Invalidate()
	t.Cleanup(Invalidate)
	entered, release, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var calls atomic.Int64
	load := func(ctx context.Context) (*snapshot, error) {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		n := calls.Add(1)
		if n == 1 {
			close(entered)
			<-release
		}
		return &snapshot{overview: AccountUsageOverview{Users: n, AsOf: time.Now()}}, nil
	}
	go func() {
		defer close(finished)
		_, err := cachedSnapshot.get(context.Background(), "invalidation-fixture", load)
		assert.NoError(t, err)
	}()
	<-entered
	Invalidate()
	close(release)
	<-finished
	result, err := cachedSnapshot.get(context.Background(), "invalidation-fixture", load)
	require.NoError(t, err)
	assert.EqualValues(t, 2, calls.Load(), "an older in-flight collection must not cache stale status after a committed mutation")
	assert.EqualValues(t, 2, result.overview.Users)
}
