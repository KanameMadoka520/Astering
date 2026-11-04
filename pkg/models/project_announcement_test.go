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
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestProjectAnnouncementLifecycle(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: 1}
	n := &ProjectAnnouncement{ProjectID: 1}
	require.NoError(t, n.ReadOne(s, u))
	require.Zero(t, n.Revision)
	n.Title = "Short notice"
	n.Content = `<p>Safe <strong>text</strong><script>bad()</script><img src=x onerror=bad()><a href="javascript:bad()">bad</a></p>`
	require.NoError(t, n.Update(s, u))
	require.Equal(t, int64(1), n.Revision)
	require.Contains(t, n.Content, "<strong>text</strong>")
	require.NotContains(t, n.Content, "<script")
	require.NotContains(t, n.Content, "<img")
	require.NotContains(t, n.Content, "javascript:")
	p, err := GetProjectSimpleByID(s, 1)
	require.NoError(t, err)
	require.Equal(t, "Lorem Ipsum", p.Description)
	require.ErrorAs(t, (&ProjectAnnouncement{ProjectID: 1, Title: "stale"}).Update(s, u), &ErrProjectAnnouncementConflict{})
	n.Content = ""
	require.NoError(t, n.Update(s, u))
	require.Equal(t, "Short notice", n.Title)
	n.Title = ""
	require.NoError(t, n.Update(s, u))
	require.Equal(t, int64(3), n.Revision)
	n.ProjectID = 2
	require.Error(t, n.Update(s, u))
	n = &ProjectAnnouncement{ProjectID: 9}
	read, _, err := n.CanRead(s, u)
	require.NoError(t, err)
	require.True(t, read)
	write, err := n.CanUpdate(s, u)
	require.NoError(t, err)
	require.False(t, write)
	_, err = s.ID(1).Cols("is_archived").Update(&Project{IsArchived: true})
	require.NoError(t, err)
	require.Error(t, (&ProjectAnnouncement{ProjectID: 1, Revision: 3}).Update(s, u))
}
