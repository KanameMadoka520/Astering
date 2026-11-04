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

package models

import (
	"bytes"
	"context"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestDrivePermissionsAndReferences(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	owner := &user.User{ID: 1}
	other := &user.User{ID: 2}
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte("drive regression")), "reusable.txt", 0, owner)
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	item := &DriveItem{DriveFile: files.DriveFile{FileID: f.ID}}
	ok, _, err := item.CanRead(s, owner)
	require.NoError(t, err)
	assert.True(t, ok)
	ok, _, err = item.CanRead(s, other)
	require.NoError(t, err)
	assert.False(t, ok)
	ok, _, err = item.CanRead(s, &LinkSharing{ID: 1})
	require.NoError(t, err)
	assert.False(t, ok)
	ok, err = item.CanCreate(s, &LinkSharing{ID: 1})
	require.NoError(t, err)
	assert.False(t, ok)
	_, err = GetDriveItem(s, other, f.ID)
	require.ErrorIs(t, err, ErrDriveMissing)
	_, err = LockDriveItem(s, other, f.ID, 1)
	require.ErrorIs(t, err, ErrDriveMissing)
	ta, err := AttachDriveFile(s, owner, f.ID, 1, 1)
	require.NoError(t, err)
	assert.Equal(t, f.ID, ta.FileID)
	repeated, err := AttachDriveFile(s, owner, f.ID, 2, 1)
	require.NoError(t, err)
	assert.Equal(t, ta.ID, repeated.ID)
	usages, err := DriveUsages(s, owner, f.ID)
	require.NoError(t, err)
	require.Len(t, usages, 1)
	assert.Equal(t, "/tasks/1", usages[0].URL)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 1, Action: "trash", Confirm: true})
	require.ErrorIs(t, err, ErrDriveChanged)
	// Both ordinary unlink implementations retain a managed original.
	require.NoError(t, f.Delete(s))
	require.NoError(t, f.DeleteOnCommit(s))
	require.NoError(t, f.LoadFileMetaByID(s))
	require.NoError(t, ta.Delete(s, owner))
	require.NoError(t, f.LoadFileMetaByID(s))
	require.NoError(t, f.LoadFileByID())
	require.NoError(t, f.File.Close())
	itemData, err := ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 3, Action: "trash", Confirm: true})
	require.NoError(t, err)
	assert.False(t, itemData.TrashedAt.IsZero())
	_, err = AttachDriveFile(s, owner, f.ID, 4, 1)
	require.ErrorIs(t, err, ErrDriveTrashed)
	// Failed operations are normally rolled back by the HTTP transaction; this test keeps
	// one session, so account for its locking write when moving to the next assertion.
	restored, err := ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 5, Action: "restore"})
	require.NoError(t, err)
	assert.True(t, restored.TrashedAt.IsZero())
	_, err = AttachDriveFile(s, owner, f.ID, 6, 1)
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 7, Action: "trash"})
	require.ErrorIs(t, err, ErrDriveConfirm)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 8, Action: "trash", Confirm: true})
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 9, Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.ErrorIs(t, err, ErrDriveInUse)
}
func TestDrivePurgeRequiresTrashAndExactName(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	owner := &user.User{ID: 1}
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte("disposable drive file")), "remove.txt", 0, owner)
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 1, Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.ErrorIs(t, err, ErrDriveConfirm)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 2, Action: "trash"})
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 3, Action: "purge", Confirm: true, ConfirmName: "wrong"})
	require.ErrorIs(t, err, ErrDriveConfirm)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: 4, Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.NoError(t, err)
	d, err := GetDriveItem(s, owner, f.ID)
	require.NoError(t, err)
	assert.True(t, d.Purging)
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	require.NoError(t, files.FinishDrivePurge(f.ID))
	require.Error(t, f.LoadFileByID())
}
func TestDriveRestrictedUsageDoesNotDiscloseTitles(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	usages, err := DriveUsages(s, &user.User{ID: 1}, 1)
	require.NoError(t, err)
	restricted := 0
	for _, u := range usages {
		if u.Restricted {
			restricted++
			assert.Empty(t, u.Title)
			assert.Empty(t, u.URL)
		}
	}
	assert.Positive(t, restricted)
}
