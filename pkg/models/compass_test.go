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
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/builder"
	"xorm.io/xorm"
)

//nolint:gosmopolitan // Verify real Chinese writing survives storage and search.
func compassTestSpace(t *testing.T, s *xorm.Session, team int64) *CompassSpace {
	t.Helper()
	c := &CompassSpace{Title: "星图", Theme: "aurora", TeamID: team}
	require.NoError(t, c.Create(s, &user.User{ID: 1}))
	return c
}

//nolint:gosmopolitan // Verify Unicode text and tags.
func compassTestEntry(t *testing.T, s *xorm.Session, space int64) *CompassEntry {
	t.Helper()
	e := &CompassEntry{SpaceID: space, Kind: "principle", Title: "自由与创造", Content: "<p>保持自己的方向。</p>", Theme: "inherit", State: "active", Tags: []string{"研究", "长期"}, Category: "方向"}
	require.NoError(t, e.Create(s, &user.User{ID: 1}))
	return e
}

//nolint:gosmopolitan // Exercise sanitization and history with Chinese content.
func TestCompassLifecycle(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	c := compassTestSpace(t, s, 0)
	e := compassTestEntry(t, s, c.ID)
	require.Equal(t, int64(1), e.Revision)
	created := e.Created
	stale := *e
	e.Content = "<p>持续创造 <strong>勇气</strong><script>bad()</script><img src=x onerror=bad()></p>"
	require.NoError(t, e.Update(s, a))
	require.Equal(t, int64(2), e.Revision)
	require.NotContains(t, e.Content, "script")
	require.NotContains(t, e.Content, "img")
	require.Contains(t, e.Content, "<strong>勇气</strong>")
	require.ErrorAs(t, stale.Update(s, a), &ErrCompass{})
	require.Equal(t, created, e.Created)
	require.NoError(t, e.Update(s, a))
	require.Equal(t, int64(2), e.Revision)
	old, err := ReadCompassRevision(s, a, e.ID, 1)
	require.NoError(t, err)
	require.Contains(t, old.Content, "保持自己的方向")
	restored, err := RestoreCompassRevision(s, a, e.ID, 1, 2)
	require.NoError(t, err)
	require.Equal(t, int64(3), restored.Revision)
	require.Equal(t, old.Content, restored.Content)
	revisions, count, err := ListCompassRevisions(s, a, e.ID, 1, 2)
	require.NoError(t, err)
	require.EqualValues(t, 3, count)
	require.Len(t, revisions, 2)
	require.Empty(t, revisions[0].Snapshot)
	require.Error(t, restored.Delete(s, a))
	restored.Pinned = true
	restored.State = "trashed"
	require.NoError(t, restored.Update(s, a))
	require.False(t, restored.Pinned)
	staleDelete := &CompassEntry{ID: e.ID, Revision: 1}
	require.Error(t, staleDelete.Delete(s, a))
	require.NoError(t, restored.Delete(s, a))
	n, err := s.Where("entry_id = ?", e.ID).Count(&CompassRevision{})
	require.NoError(t, err)
	require.Zero(t, n)
}
func TestCompassPersonalPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	other := &user.User{ID: 2}
	_, adminErr := s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, adminErr)
	c := compassTestSpace(t, s, 0)
	e := compassTestEntry(t, s, c.ID)
	can, p, err := (&CompassSpace{ID: c.ID}).CanRead(s, a)
	require.NoError(t, err)
	require.True(t, can)
	require.Equal(t, 2, p)
	can, _, err = (&CompassSpace{ID: c.ID}).CanRead(s, other)
	require.NoError(t, err)
	require.False(t, can)
	can, err = (&CompassSpace{ID: c.ID}).CanUpdate(s, a)
	require.NoError(t, err)
	require.True(t, can)
	can, err = (&CompassSpace{ID: c.ID}).CanUpdate(s, other)
	require.NoError(t, err)
	require.False(t, can)
	can, err = (&CompassSpace{TeamID: 0}).CanCreate(s, a)
	require.NoError(t, err)
	require.True(t, can)
	can, err = (&CompassSpace{TeamID: 0}).CanCreate(s, &LinkSharing{ID: 1, ProjectID: 1, Permission: PermissionAdmin})
	require.NoError(t, err)
	require.False(t, can)
	for _, check := range []func(*xorm.Session, *user.User) (bool, error){
		func(s *xorm.Session, a *user.User) (bool, error) {
			return (&CompassEntry{SpaceID: c.ID}).CanCreate(s, a)
		},
		func(s *xorm.Session, a *user.User) (bool, error) { return (&CompassEntry{ID: e.ID}).CanUpdate(s, a) },
		func(s *xorm.Session, a *user.User) (bool, error) { return (&CompassEntry{ID: e.ID}).CanDelete(s, a) },
	} {
		can, err = check(s, a)
		require.NoError(t, err)
		require.True(t, can)
		can, err = check(s, other)
		require.NoError(t, err)
		require.False(t, can)
	}
	can, _, err = (&CompassEntry{ID: e.ID}).CanRead(s, a)
	require.NoError(t, err)
	require.True(t, can)
	can, _, err = (&CompassEntry{ID: e.ID}).CanRead(s, other)
	require.NoError(t, err)
	require.False(t, can)
	_, err = ReadCompassRevision(s, other, e.ID, 1)
	require.Error(t, err)
	_, _, _, err = (&CompassEntry{SpaceID: c.ID}).ReadAll(s, other, "", 1, 10)
	require.Error(t, err)
	// A malicious body cannot change ownership or move a writing into another space.
	c.OwnerID = 2
	c.TeamID = 1
	c.Title = "Changed"
	require.NoError(t, c.Update(s, a))
	require.EqualValues(t, 1, c.OwnerID)
	require.Zero(t, c.TeamID)
	e.SpaceID = 999
	e.CreatedByID = 2
	e.Title = "Changed"
	require.NoError(t, e.Update(s, a))
	require.Equal(t, c.ID, e.SpaceID)
	require.EqualValues(t, 1, e.CreatedByID)
}
func TestCompassTeamPermissions(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	admin := &user.User{ID: 1}
	member := &user.User{ID: 2}
	outsider := &user.User{ID: 3}
	c := compassTestSpace(t, s, 1)
	e := compassTestEntry(t, s, c.ID)
	can, err := (&CompassSpace{TeamID: 1}).CanCreate(s, member)
	require.NoError(t, err)
	require.False(t, can)
	can, _, err = (&CompassSpace{ID: c.ID}).CanRead(s, member)
	require.NoError(t, err)
	require.True(t, can)
	can, _, err = (&CompassSpace{ID: c.ID}).CanRead(s, outsider)
	require.NoError(t, err)
	require.False(t, can)
	can, err = (&CompassSpace{ID: c.ID}).CanUpdate(s, member)
	require.NoError(t, err)
	require.False(t, can)
	can, err = (&CompassSpace{ID: c.ID}).CanUpdate(s, admin)
	require.NoError(t, err)
	require.True(t, can)
	e.Title = "Shared principle"
	require.NoError(t, e.Update(s, member))
	require.EqualValues(t, 2, e.UpdatedByID)
	e.State = "trashed"
	require.NoError(t, e.Update(s, member))
	can, err = e.CanDelete(s, member)
	require.NoError(t, err)
	require.False(t, can)
	require.Error(t, e.Delete(s, member))
	_, err = s.Where("team_id = ? AND user_id = ?", 1, 2).Delete(&TeamMember{})
	require.NoError(t, err)
	require.Error(t, e.ReadOne(s, member))
	_, err = ReadCompassRevision(s, member, e.ID, 1)
	require.Error(t, err)
	// Space creator does not keep access after leaving the team, either.
	_, err = s.Where("team_id = ? AND user_id = ?", 1, 1).Delete(&TeamMember{})
	require.NoError(t, err)
	require.Error(t, e.ReadOne(s, admin))
}

//nolint:gosmopolitan // Verify exact Chinese tags rather than partial matches.
func TestCompassSearchAndPagination(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	c := compassTestSpace(t, s, 0)
	e := compassTestEntry(t, s, c.ID)
	e.Content = "<p>literal 10%_word &amp; quote</p>"
	e.Pinned = true
	require.NoError(t, e.Update(s, a))
	for range 3 {
		compassTestEntry(t, s, c.ID)
	}
	filter := &CompassEntry{SpaceID: c.ID}
	items, n, total, err := filter.ReadAll(s, a, "", 1, 2)
	require.NoError(t, err)
	require.EqualValues(t, 4, total)
	require.Equal(t, 2, n)
	rows := items.([]*CompassEntry)
	require.Equal(t, e.ID, rows[0].ID)
	require.Empty(t, rows[0].Content)
	_, n, total, err = filter.ReadAll(s, a, "%_", 1, 2)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Equal(t, 1, n)
	filter.FilterTag = "期"
	_, n, _, err = filter.ReadAll(s, a, "", 1, 10)
	require.NoError(t, err)
	require.Zero(t, n)
	filter.FilterTag = "长期"
	_, n, _, err = filter.ReadAll(s, a, "", 1, 10)
	require.NoError(t, err)
	require.Equal(t, 4, n)
	e.State = "trashed"
	require.NoError(t, e.Update(s, a))
	topics, err := ReadCompassTopics(s, a, c.ID)
	require.NoError(t, err)
	require.EqualValues(t, 3, topics.Items[0].Count)
	require.NoError(t, c.ReadOne(s, a))
	require.EqualValues(t, 3, c.EntryCount)
	require.Zero(t, c.PinnedCount)
}

//nolint:gosmopolitan // Exercise multibyte content at the storage boundary.
func TestCompassLargeTextAndCleanup(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	a := &user.User{ID: 1}
	c := compassTestSpace(t, s, 0)
	e := compassTestEntry(t, s, c.ID)
	e.Content = "<p>" + strings.Repeat("未来", 100_000) + "</p>"
	require.NoError(t, e.Update(s, a))
	require.Greater(t, e.ContentBytes, int64(500_000))
	require.LessOrEqual(t, len([]rune(e.Excerpt)), 360)
	e.Content = strings.Repeat("a", 2_097_153)
	require.Error(t, e.Update(s, a))
	require.NoError(t, deleteCompassSpaces(s, builder.Eq{"owner_id": 1, "team_id": 0}))
	require.Error(t, e.ReadOne(s, a))
	n, err := s.Where("entry_id = ?", e.ID).Count(&CompassRevision{})
	require.NoError(t, err)
	require.Zero(t, n)
}
