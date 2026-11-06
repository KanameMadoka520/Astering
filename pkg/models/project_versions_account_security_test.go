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
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func projectVersionAccountFixture(t *testing.T) (*xorm.Session, *user.User) {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	t.Cleanup(func() { events.CleanupPending(s); require.NoError(t, s.Close()) })
	notifications.Fake()
	t.Cleanup(notifications.Unfake)
	owner := &user.User{Username: "project-history-account-owner", Email: "history-owner@example.invalid", Password: "not-used-for-authentication"}
	_, err := s.Insert(owner)
	require.NoError(t, err)
	return s, owner
}

func TestProjectVersionsSecurityAccountDeletionKeepsSharedProjectAndHistory(t *testing.T) {
	s, owner := projectVersionAccountFixture(t)
	project := &Project{Title: "Shared work survives its original owner's deletion"}
	require.NoError(t, project.Create(s, owner))
	task := &Task{Title: "Retain this shared task", ProjectID: project.ID}
	require.NoError(t, task.Create(s, owner))
	version, err := CreateProjectVersion(s, owner, project.ID, "Shared project checkpoint", "account-shared-checkpoint")
	require.NoError(t, err)
	member, err := user.GetUserByID(s, 2)
	require.NoError(t, err)
	grant := &ProjectUser{ProjectID: project.ID, Username: member.Username, Permission: PermissionRead}
	require.NoError(t, grant.Create(s, owner))
	require.NoError(t, DeleteUser(s, owner))
	stored := &Project{}
	exists, err := s.ID(project.ID).Get(stored)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, member.ID, stored.OwnerID, "the existing read-only-member fallback must explicitly transfer ownership")
	retained := &ProjectUser{}
	exists, err = s.Where("project_id = ? AND user_id = ?", project.ID, member.ID).Get(retained)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, PermissionAdmin, retained.Permission)
	require.Equal(t, task.Title, projectVersionAuditTask(t, s, task.ID).Title)
	_, err = ReadProjectVersion(s, member, project.ID, version.ID)
	require.NoError(t, err, "the current owner keeps legitimate access to retained history")
}

func TestProjectVersionsSecurityAccountDeletionLocksBotAndHumanProjectsTogether(t *testing.T) {
	s, owner := projectVersionAccountFixture(t)
	project := &Project{Title: "Earlier human-owned project"}
	require.NoError(t, project.Create(s, owner))
	bot := &BotUser{User: user.User{Username: "bot-history-account"}}
	require.NoError(t, bot.Create(s, owner))
	// Older installations can contain directly bot-owned projects. Their larger
	// ID is deleted recursively before the human's smaller ID, so a single
	// predeclared account scope must prevent late lower-ID project locking.
	legacy := &Project{Title: "Legacy bot-owned project", OwnerID: bot.ID}
	insertTestProject(t, s, legacy)
	require.Greater(t, legacy.ID, project.ID)
	_, err := s.Insert(&Task{ProjectID: legacy.ID, CreatedByID: bot.ID, Title: "Bot work"})
	require.NoError(t, err)
	require.NoError(t, DeleteUser(s, owner))
	for _, id := range []int64{project.ID, legacy.ID} {
		exists, err := s.ID(id).Exist(new(Project))
		require.NoError(t, err)
		require.False(t, exists)
	}
	for _, id := range []int64{owner.ID, bot.ID} {
		exists, err := s.ID(id).Exist(new(user.User))
		require.NoError(t, err)
		require.False(t, exists)
	}
}

func TestProjectVersionsSecurityConcurrentAccountDeletionRejectsScopeGrowth(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner := projectVersionAccountFixture(t)
	project := &Project{Title: "Account deletion initially sees only this project"}
	require.NoError(t, project.Create(s, owner))
	otherOwner, err := user.GetUserByID(s, 2)
	require.NoError(t, err)
	other := &Project{Title: "A new grant changes the account's deletion scope"}
	require.NoError(t, other.Create(s, otherOwner))
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	done := make(chan error, 1)
	go func() {
		deletion := db.NewSession()
		defer deletion.Close()
		defer events.CleanupPending(deletion)
		db.SetSessionContext(ctx, deletion)
		err := DeleteUser(deletion, owner)
		if err == nil {
			err = deletion.Commit()
		}
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("account deletion never reached its first project gate")
	}
	grantSession := db.NewSession()
	defer grantSession.Close()
	defer events.CleanupPending(grantSession)
	grant := &ProjectUser{ProjectID: other.ID, Username: owner.Username, Permission: PermissionRead}
	require.NoError(t, grant.Create(grantSession, otherOwner))
	require.NoError(t, grantSession.Commit())
	require.NoError(t, blocker.Rollback())
	select {
	case err = <-done:
		var conflict *ProjectVersionError
		require.ErrorAs(t, err, &conflict, "scope growth must become an explicit retryable conflict: %v", err)
		require.Equal(t, "project_mutation_scope_changed", conflict.Code)
	case <-ctx.Done():
		t.Fatal("account deletion did not reject its changed project scope")
	}
	check := db.NewReadSession()
	defer check.Close()
	exists, err := check.ID(owner.ID).Exist(new(user.User))
	require.NoError(t, err)
	require.True(t, exists, "the rejected deletion must leave the account intact")
	exists, err = check.ID(project.ID).Exist(new(Project))
	require.NoError(t, err)
	require.True(t, exists)
	exists, err = check.Where("project_id = ? AND user_id = ?", other.ID, owner.ID).Exist(new(ProjectUser))
	require.NoError(t, err)
	require.True(t, exists)
}
