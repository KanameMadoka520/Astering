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

package personalstorage

import (
	"context"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestPersonalStorageConfirmationBindsIdentitySessionTargetAndExpiry(t *testing.T) {
	config.InitDefaultConfig()
	original := config.ServiceSecret.GetString()
	config.ServiceSecret.Set("isolated-storage-confirmation-secret")
	t.Cleanup(func() { config.ServiceSecret.Set(original) })
	now := time.Now().UTC()
	value := confirmation{
		StorageSelection: StorageSelection{
			Kind:     "file",
			ID:       "42",
			Revision: "7",
			Action:   "purge",
		},
		UID:     1,
		Session: "first-login-session",
		Name:    "reviewed-file.txt",
		Usages:  referenceFingerprint(nil),
		Expires: now.Add(previewLifetime).Unix(),
	}
	token, err := signConfirmation(value)
	require.NoError(t, err)
	read, err := readConfirmation(token, 1, "first-login-session", now)
	require.NoError(t, err)
	assert.Equal(t, value, read)
	for _, identity := range []struct {
		uid     int64
		session string
	}{
		{
			uid:     2,
			session: "first-login-session",
		},
		{
			uid:     1,
			session: "another-login-session",
		},
	} {
		_, err = readConfirmation(token, identity.uid, identity.session, now)
		require.Error(t, err)
	}
	_, err = readConfirmation(token, 1, "first-login-session", now.Add(previewLifetime+time.Second))
	require.Error(t, err)
	parts := strings.Split(token, ".")
	parts[0] = "e30"
	_, err = readConfirmation(strings.Join(parts, "."), 1, "first-login-session", now)
	require.Error(t, err)
	config.ServiceSecret.Set("rotated-storage-confirmation-secret")
	_, err = readConfirmation(token, 1, "first-login-session", now)
	require.Error(t, err)
}

func TestPersonalStoragePurgeDoesNotClaimUnknownPreviewRemoval(t *testing.T) {
	before := files.StoredUsage{
		OriginalBytes:    100,
		OriginalComplete: true,
		PreviewBytes:     40,
		Complete:         true,
		PreviewsComplete: true,
	}
	freed, complete := measuredPurgeBytes(before, files.StoredUsage{OriginalComplete: true})
	assert.EqualValues(t, 100, freed, "a failed post-delete preview probe must never be mistaken for zero remaining cache")
	assert.False(t, complete)
	freed, complete = measuredPurgeBytes(before, files.StoredUsage{PreviewsComplete: true})
	assert.EqualValues(t, 40, freed, "unknown original metadata must not count as a removed original")
	assert.False(t, complete)
	freed, complete = measuredPurgeBytes(before, files.StoredUsage{
		OriginalComplete: true,
		PreviewsComplete: true,
	})
	assert.EqualValues(t, 140, freed)
	assert.True(t, complete)
	freed, complete = measuredPurgeBytes(before, files.StoredUsage{
		OriginalComplete: true,
		PreviewBytes:     17,
		PreviewsComplete: true,
	})
	assert.EqualValues(t, 123, freed)
	assert.False(t, complete, "a remaining derivative must be surfaced as incomplete cleanup")
}

func TestPersonalStorageTargetGuardsCancelAndRelease(t *testing.T) {
	unlock, err := lockTarget(context.Background(), "1:file:42")
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err = lockTarget(ctx, "1:file:42")
	require.ErrorIs(t, err, context.Canceled)
	other, err := lockTarget(context.Background(), "2:file:42")
	require.NoError(t, err)
	other()
	unlock()
	executionGuards.Lock()
	defer executionGuards.Unlock()
	assert.Empty(t, executionGuards.targets, "target locks live only while requests overlap")
}

func TestPersonalStorageRejectsNonCanonicalFileIDs(t *testing.T) {
	for _, value := range []string{
		"../42",
		"0",
		"-1",
		"042",
		"42/..",
		"+42",
		"",
	} {
		_, err := fileID(value)
		require.Error(t, err)
	}
	id, err := fileID("42")
	require.NoError(t, err)
	assert.EqualValues(t, 42, id)
}
