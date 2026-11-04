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
	"os"
	"path/filepath"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestInstanceUsageExplicitGrant(t *testing.T) {
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "2")
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "3")
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "7, invalid, 0, -1, 12")
	assert.True(t, CanView(7))
	assert.True(t, CanView(12))
	for _, id := range []int64{0, -1, 2, 3, 8} {
		assert.False(t, CanView(id))
	}
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "")
	assert.False(t, CanView(7))
	assert.False(t, CanView(2))
	require.NoError(t, os.Unsetenv("ASTERING_USAGE_ADMIN_IDS"))
	assert.False(t, CanView(2))
}

func writeMetadataFixture(t *testing.T, name string, size int) {
	t.Helper()
	require.NoError(t, os.MkdirAll(filepath.Dir(name), 0700))
	// Deliberately invalid ciphertext: counting must not read/decrypt the content.
	require.NoError(t, os.WriteFile(name, []byte(strings.Repeat("x", size)), 0000))
}

func TestInstanceUsageMetadataOnly(t *testing.T) {
	base := t.TempDir()
	ai := filepath.Join(base, ".tcymc-ai")
	conversation := "11111111-2222-4333-8444-555555555555.enc"
	writeMetadataFixture(t, filepath.Join(ai, "2.enc"), 17)
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "2", ".mcp-settings"), 13)
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "2", conversation), 29)
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "2", "attachments", strings.Repeat("a", 64)+".enc"), 31)
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "2", "private-title.enc"), 99)
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "3", conversation), 501)
	s := newMetadataScanner(context.Background(), base)
	defer s.close()
	row := &InstanceUserUsage{ID: 2}
	s.scan(row)
	assert.True(t, row.AIScanComplete)
	assert.EqualValues(t, 1, row.AIConversations)
	assert.EqualValues(t, 29, row.AIConversationBytes)
	assert.EqualValues(t, 31, row.AIAttachmentBytes)
	assert.EqualValues(t, 30, row.AISettingsBytes)
	assert.EqualValues(t, 90, row.AIBytes)
	missing := &InstanceUserUsage{ID: 4}
	s.scan(missing)
	assert.True(t, missing.AIScanComplete)
	assert.Zero(t, missing.AIBytes)
}

func TestInstanceUsageMetadataRejectsSymlinksAndIncomplete(t *testing.T) {
	base := t.TempDir()
	ai := filepath.Join(base, ".tcymc-ai")
	conversation := "11111111-2222-4333-8444-555555555555.enc"
	writeMetadataFixture(t, filepath.Join(ai, "conversations", "3", conversation), 501)
	require.NoError(t, os.Symlink("3", filepath.Join(ai, "conversations", "2")))
	s := newMetadataScanner(context.Background(), base)
	row := &InstanceUserUsage{ID: 2}
	s.scan(row)
	assert.False(t, row.AIScanComplete)
	assert.Zero(t, row.AIConversations)
	assert.Zero(t, row.AIBytes)
	s.close()

	require.NoError(t, os.Remove(filepath.Join(ai, "conversations", "2")))
	require.NoError(t, os.Mkdir(filepath.Join(ai, "conversations", "2"), 0700))
	require.NoError(t, os.Symlink(filepath.Join("..", "3", conversation), filepath.Join(ai, "conversations", "2", conversation)))
	s = newMetadataScanner(context.Background(), base)
	defer s.close()
	row = &InstanceUserUsage{ID: 2}
	s.scan(row)
	assert.False(t, row.AIScanComplete)
	assert.Zero(t, row.AIConversationBytes)

	s.remaining = 0
	row = &InstanceUserUsage{ID: 3}
	s.scan(row)
	assert.False(t, row.AIScanComplete)
	assert.Zero(t, row.AIBytes)
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	s.ctx = canceled
	row = &InstanceUserUsage{ID: 3}
	s.scan(row)
	assert.False(t, row.AIScanComplete)
}

func TestInstanceUsageFiltersAndAttributionDefinitions(t *testing.T) {
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "2, 3")
	now := time.Now().UTC()
	value := &snapshot{
		users: []InstanceUserUsage{
			{
				ID:          1,
				Username:    "alpha",
				Name:        "First",
				UsageCounts: UsageCounts{FileBytes: 500},
				Anomalies:   []string{},
			},
			{
				ID:          2,
				Username:    "Beta",
				Name:        "Second",
				UsageCounts: UsageCounts{FileBytes: 900},
				Anomalies:   []string{"projects_owned_1000"},
			},
			{
				ID:          3,
				Username:    "bot-gamma",
				IsBot:       true,
				Status:      2,
				UsageCounts: UsageCounts{FileBytes: 900},
				Anomalies:   []string{},
			},
		},
		overview: AccountUsageOverview{AsOf: now},
	}
	result := page(value, AccountUsageQuery{
		Page:    1,
		PerPage: 1,
		SortBy:  "file_bytes",
		OrderBy: "desc",
	})
	require.Len(t, result.Items, 1)
	assert.EqualValues(t, 2, result.Items[0].ID)
	assert.EqualValues(t, 3, result.TotalPages)
	assert.Equal(t, now, result.AsOf)
	result = page(value, AccountUsageQuery{
		Q:       "SECOND",
		Role:    "usage_admin",
		Status:  "active",
		Anomaly: "flagged",
	})
	require.Len(t, result.Items, 1)
	assert.EqualValues(t, 2, result.Items[0].ID)
	assert.True(t, result.Items[0].IsUsageAdmin)
	result = page(value, AccountUsageQuery{Role: "bot"})
	require.Len(t, result.Items, 1)
	assert.False(t, result.Items[0].IsUsageAdmin)
	result = page(value, AccountUsageQuery{Page: int(^uint(0) >> 1)})
	assert.Empty(t, result.Items)
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "")
	assert.Empty(t, page(value, AccountUsageQuery{Role: "usage_admin"}).Items, "cached rows cannot preserve revoked grants")
	assert.Empty(t, anomalies(UsageCounts{ProjectsOwned: 999}))
	assert.Equal(t, []string{"projects_owned_1000", "projects_created_24h_100", "projects_created_7d_500"}, anomalies(UsageCounts{
		ProjectsOwned:      1000,
		ProjectsCreated24h: 100,
		ProjectsCreated7d:  500,
	}))
}

func TestInstanceUsageCacheCoalescesAndHonorsCancellation(t *testing.T) {
	cache := &snapshotCache{}
	var calls atomic.Int64
	started := make(chan struct{})
	release := make(chan struct{})
	load := func(ctx context.Context) (*snapshot, error) {
		if calls.Add(1) == 1 {
			close(started)
		}
		<-release
		return &snapshot{overview: AccountUsageOverview{AsOf: time.Now()}}, ctx.Err()
	}
	var wg sync.WaitGroup
	wg.Add(1)
	go func() {
		defer wg.Done()
		_, err := cache.get(context.Background(), "one", load)
		assert.NoError(t, err)
	}()
	<-started
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := cache.get(ctx, "one", load)
	require.ErrorIs(t, err, context.Canceled)
	close(release)
	wg.Wait()
	_, err = cache.get(context.Background(), "one", load)
	require.NoError(t, err)
	assert.EqualValues(t, 1, calls.Load())
	_, err = cache.get(context.Background(), "two", load)
	require.NoError(t, err)
	assert.EqualValues(t, 2, calls.Load(), "a different storage root must not reuse another snapshot")
}
