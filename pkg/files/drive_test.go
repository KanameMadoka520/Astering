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

package files

import (
	"bytes"
	"errors"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type driveFailRemoveStorage struct{ FileStorage }

func (*driveFailRemoveStorage) Remove(string) error { return errors.New("simulated storage outage") }
func TestDrivePurgeStorageFailureCanBeRetried(t *testing.T) {
	initFixtures(t)
	s := db.NewSession()
	f, err := CreateWithSession(s, bytes.NewReader([]byte("retain until purged")), "retry.txt", 0, &testauth{id: 1})
	require.NoError(t, err)
	require.NoError(t, AddToDrive(s, f))
	require.NoError(t, f.PurgeFromDrive(s))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	original := storage
	t.Cleanup(func() { storage = original })
	storage = &driveFailRemoveStorage{FileStorage: original}
	require.ErrorContains(t, FinishDrivePurge(f.ID), "simulated storage outage")
	read := db.NewReadSession()
	d := &DriveFile{}
	exists, err := read.Where("file_id = ?", f.ID).Get(d)
	require.NoError(t, err)
	assert.True(t, exists)
	assert.True(t, d.Purging)
	require.NoError(t, f.LoadFileMetaByID(read))
	require.NoError(t, read.Close())
	storage = original
	require.NoError(t, FinishDrivePurge(f.ID))
	require.NoError(t, FinishDrivePurge(f.ID), "a completed deletion is idempotent")
	read = db.NewReadSession()
	defer read.Close()
	exists, err = read.Where("file_id = ?", f.ID).Exist(&DriveFile{})
	require.NoError(t, err)
	assert.False(t, exists)
	require.Error(t, f.LoadFileByID())
}
