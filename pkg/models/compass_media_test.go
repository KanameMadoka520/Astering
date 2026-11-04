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
	"fmt"
	"image"
	"image/png"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func compassTestImage(t *testing.T, s *xorm.Session, uid int64) *files.File {
	t.Helper()
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, image.NewRGBA(image.Rect(0, 0, 3, 2))))
	f, err := files.CreateWithSession(s, bytes.NewReader(b.Bytes()), "compass.png", 0, &user.User{ID: uid})
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	return f
}
func TestCompassImagesSanitization(t *testing.T) {
	content, ids, err := sanitizeCompassContent(`<p>hello<img src="https://evil.test/x" onerror="bad()"><img data-compass-image="17" src="javascript:bad()" alt="a &amp; b" width="1200"><img data-compass-image="17"><img data-compass-image="9223372036854775809"><svg onload="bad()"></svg></p>`)
	require.NoError(t, err)
	require.Equal(t, []int64{17}, ids)
	require.NotContains(t, content, "src=")
	require.NotContains(t, content, "onerror")
	require.NotContains(t, content, "svg")
	require.NotContains(t, content, "922337")
	require.Contains(t, content, `data-compass-image="17"`)
	require.Contains(t, content, `alt="a &amp; b"`)
	var large strings.Builder
	for i := 1; i <= 101; i++ {
		fmt.Fprintf(&large, `<img data-compass-image="%d">`, i)
	}
	_, _, err = sanitizeCompassContent(large.String())
	require.Error(t, err)
	content, _, err = sanitizeCompassContent(`<img data-compass-image="1" alt="` + strings.Repeat("x", 600) + `">`)
	require.NoError(t, err)
	require.NotContains(t, content, strings.Repeat("x", 501))
}
func TestCompassImagesHistoryAndDriveProtection(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	c := compassTestSpace(t, s, 0)
	f := compassTestImage(t, s, 1)
	// Own drafts are visible to the author but not unrelated accounts.
	_, err := GetCompassImage(s, a, c.ID, f.ID)
	require.NoError(t, err)
	_, err = GetCompassImage(s, &user.User{ID: 2}, c.ID, f.ID)
	require.Error(t, err)
	e := compassTestEntry(t, s, c.ID)
	e.Content = fmt.Sprintf(`<p>with image</p><img data-compass-image="%d" alt="photo">`, f.ID)
	require.NoError(t, e.Update(s, a))
	require.Equal(t, 1, e.ImageCount)
	usages, err := DriveUsages(s, a, f.ID)
	require.NoError(t, err)
	require.Len(t, usages, 1)
	require.Equal(t, "compass_entry", usages[0].Kind)
	e.Content = "<p>revised without picture</p>"
	require.NoError(t, e.Update(s, a))
	require.Zero(t, e.ImageCount)
	usages, err = DriveUsages(s, a, f.ID)
	require.NoError(t, err)
	require.Equal(t, "compass_history", usages[0].Kind)
	_, err = GetCompassImage(s, a, c.ID, f.ID)
	require.NoError(t, err)
	restored, err := RestoreCompassRevision(s, a, e.ID, 2, e.Revision)
	require.NoError(t, err)
	require.Equal(t, 1, restored.ImageCount)
	d, err := GetDriveItem(s, a, f.ID)
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, a, f.ID, DriveChange{Revision: d.Revision, Action: "trash"})
	require.ErrorIs(t, err, ErrDriveConfirm)
	d, err = GetDriveItem(s, a, f.ID)
	require.NoError(t, err)
	d, err = ChangeDriveItem(s, a, f.ID, DriveChange{Revision: d.Revision, Action: "trash", Confirm: true})
	require.NoError(t, err)
	_, err = GetCompassImage(s, a, c.ID, f.ID)
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, a, f.ID, DriveChange{Revision: d.Revision, Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.ErrorIs(t, err, ErrDriveInUse)
	restored.State = "trashed"
	require.NoError(t, restored.Update(s, a))
	require.NoError(t, restored.Delete(s, a))
	usages, err = DriveUsages(s, a, f.ID)
	require.NoError(t, err)
	require.Empty(t, usages)
	mounted, err := s.Where("space_id = ? AND file_id = ?", c.ID, f.ID).Exist(&compassMedia{})
	require.NoError(t, err)
	require.False(t, mounted)
	require.NoError(t, f.LoadFileMetaByID(s)) // Unlink never deletes the original.
}
func TestCompassImagesTeamMembershipAndBackground(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	member := &user.User{ID: 2}
	c := compassTestSpace(t, s, 1)
	f := compassTestImage(t, s, 1)
	c.BackgroundFileID = f.ID
	c.BackgroundFocusX = 20
	require.NoError(t, c.Update(s, a))
	require.Equal(t, int64(2), c.Revision)
	_, err := GetCompassImage(s, member, c.ID, f.ID)
	require.NoError(t, err)
	e := compassTestEntry(t, s, c.ID)
	e.Content = fmt.Sprintf(`<img data-compass-image="%d">`, f.ID)
	require.NoError(t, e.Update(s, member))
	c.BackgroundFileID = 0
	require.NoError(t, c.Update(s, a))
	_, err = s.Where("team_id = ? AND user_id = ?", 1, 1).Delete(&TeamMember{})
	require.NoError(t, err)
	_, err = GetCompassImage(s, a, c.ID, f.ID)
	require.Error(t, err)
	_, err = GetCompassImage(s, member, c.ID, f.ID)
	require.NoError(t, err)
	e.Title = "edited after uploader departure"
	require.NoError(t, e.Update(s, member))
	usages, err := DriveUsages(s, a, f.ID)
	require.NoError(t, err)
	require.Len(t, usages, 1)
	require.True(t, usages[0].Restricted)
	require.Empty(t, usages[0].Title)
	private := &CompassSpace{Title: "member private", Theme: "aurora"}
	require.NoError(t, private.Create(s, member))
	require.Error(t, ensureCompassImage(s, member, private.ID, f.ID))
}
func TestCompassImagesRejectInvalidReferences(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	c := compassTestSpace(t, s, 0)
	foreign := compassTestImage(t, s, 2)
	require.Error(t, ensureCompassImage(s, a, c.ID, foreign.ID))
	for _, mime := range []string{"image/svg+xml", "image/png"} {
		f, err := files.CreateWithMimeAndSession(s, bytes.NewReader([]byte("<svg onload='bad()'/>")), "fake.png", 0, a, mime, true)
		require.NoError(t, err)
		require.NoError(t, files.AddToDrive(s, f))
		require.Error(t, ensureCompassImage(s, a, c.ID, f.ID))
	}
	f := compassTestImage(t, s, 1)
	_, err := s.Where("file_id = ?", f.ID).Cols("trashed_at").Update(&files.DriveFile{TrashedAt: time.Now()})
	require.NoError(t, err)
	require.Error(t, ensureCompassImage(s, a, c.ID, f.ID))
	_, err = GetCompassImage(s, a, c.ID, f.ID)
	require.Error(t, err)
}
