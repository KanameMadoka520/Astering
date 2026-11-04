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
	"context"
	"fmt"
	"sync"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

func TestTeamMemberLastAdmin(t *testing.T) {
	for _, operation := range []string{"delete", "demote"} {
		t.Run(operation, func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			defer events.CleanupPending(s)
			tm := &TeamMember{TeamID: 1, Username: "user1"}
			var err error
			if operation == "delete" {
				err = tm.Delete(s, &user.User{ID: 1})
			} else {
				err = tm.Update(s, &user.User{ID: 1})
			}
			require.Error(t, err)
			assert.True(t, IsErrCannotRemoveLastTeamAdmin(err))
			assert.Equal(t, 6011, err.(ErrCannotRemoveLastTeamAdmin).HTTPError().Code)
			// Even committing a refused model operation must not have changed membership.
			require.NoError(t, s.Commit())
			db.AssertExists(t, "team_members", map[string]interface{}{"team_id": 1, "user_id": 1, "admin": true}, false)
		})
	}
	t.Run("nonmember delete remains idempotent with only one team member", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		require.NoError(t, (&TeamMember{TeamID: 1, Username: "user2"}).Delete(s, &user.User{ID: 1}))
		require.NoError(t, (&TeamMember{TeamID: 1, Username: "user3"}).Delete(s, &user.User{ID: 1}))
		require.NoError(t, s.Commit())
		events.CleanupPending(s)
		db.AssertExists(t, "team_members", map[string]interface{}{"team_id": 1, "user_id": 1, "admin": true}, false)
	})
	t.Run("ordinary member can leave", func(t *testing.T) {
		db.LoadAndAssertFixtures(t)
		s := db.NewSession()
		defer s.Close()
		defer events.CleanupPending(s)
		require.NoError(t, (&TeamMember{TeamID: 1, Username: "user2"}).Delete(s, &user.User{ID: 2}))
		require.NoError(t, s.Commit())
		db.AssertMissing(t, "team_members", map[string]interface{}{"team_id": 1, "user_id": 2})
	})
	for _, auth := range []web.Auth{&user.User{ID: 2}, &user.User{ID: 3}, &LinkSharing{ID: 1}} {
		t.Run(fmt.Sprintf("permission-%T-%d", auth, auth.GetID()), func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			s := db.NewSession()
			defer s.Close()
			tm := &TeamMember{TeamID: 1, Username: "user1"}
			allowed, err := tm.CanDelete(s, auth)
			require.NoError(t, err)
			assert.False(t, allowed)
			allowed, err = tm.CanUpdate(s, auth)
			require.NoError(t, err)
			assert.False(t, allowed)
			assert.True(t, IsErrGenericForbidden(tm.Delete(s, auth)))
			assert.True(t, IsErrGenericForbidden(tm.Update(s, auth)))
		})
	}
}

func TestTeamMemberAdminGuardPreservesAccess(t *testing.T) {
	t.Run("refused last admin removal does not clean up", func(t *testing.T) {
		f := setupAccessLoss(t)
		team := f.shareViaTeam(t)
		// User2 becomes the only team admin, and has subscriptions/assignments/webhooks.
		_, err := f.s.Where("team_id = ? AND user_id = ?", team.ID, 2).Cols("admin").Update(&TeamMember{Admin: true})
		require.NoError(t, err)
		_, err = f.s.Where("team_id = ? AND user_id = ?", team.ID, 1).Cols("admin").Update(&TeamMember{Admin: false})
		require.NoError(t, err)
		events.CleanupPending(f.s)
		before := events.CountDispatchedEvents("team.member.removed")
		err = (&TeamMember{TeamID: team.ID, Username: "user2"}).Delete(f.s, f.member)
		require.True(t, IsErrCannotRemoveLastTeamAdmin(err))
		f.assertWebhooksKept(t)
		events.DispatchPending(context.Background(), f.s)
		assert.Equal(t, before, events.CountDispatchedEvents("team.member.removed"))
		db.AssertExists(t, "task_assignees", map[string]interface{}{"task_id": f.task.ID, "user_id": 2}, false)
		db.AssertExists(t, "subscriptions", map[string]interface{}{"entity_type": SubscriptionEntityTask, "entity_id": f.task.ID, "user_id": 2}, false)
	})
	t.Run("permission revoked after CanDelete does not clean up", func(t *testing.T) {
		f := setupAccessLoss(t)
		team := f.shareViaTeam(t)
		tm := &TeamMember{TeamID: team.ID, Username: "user2"}
		allowed, err := tm.CanDelete(f.s, f.owner)
		require.NoError(t, err)
		require.True(t, allowed)
		// Simulate the state now visible under the mutation lock after a stale CanDelete.
		_, err = f.s.Where("team_id = ? AND user_id = ?", team.ID, 2).Cols("admin").Update(&TeamMember{Admin: true})
		require.NoError(t, err)
		_, err = f.s.Where("team_id = ? AND user_id = ?", team.ID, 1).Cols("admin").Update(&TeamMember{Admin: false})
		require.NoError(t, err)
		events.CleanupPending(f.s)
		before := events.CountDispatchedEvents("team.member.removed")
		require.True(t, IsErrGenericForbidden(tm.Delete(f.s, f.owner)))
		require.True(t, IsErrGenericForbidden(tm.Update(f.s, f.owner)))
		f.assertWebhooksKept(t)
		events.DispatchPending(context.Background(), f.s)
		assert.Equal(t, before, events.CountDispatchedEvents("team.member.removed"))
		db.AssertExists(t, "team_members", map[string]interface{}{"team_id": team.ID, "user_id": 2, "admin": true}, false)
	})
	t.Run("later transaction failure rolls back cleanup", func(t *testing.T) {
		f := setupAccessLoss(t)
		team := f.shareViaTeam(t)
		require.NoError(t, f.s.Commit())
		events.CleanupPending(f.s)
		s := db.NewSession()
		defer s.Close()
		before := events.CountDispatchedEvents("team.member.removed")
		require.NoError(t, (&TeamMember{TeamID: team.ID, Username: "user2"}).Delete(s, f.owner))
		require.NoError(t, s.Rollback())
		events.CleanupPending(s)
		events.DispatchPending(context.Background(), s)
		assert.Equal(t, before, events.CountDispatchedEvents("team.member.removed"))
		db.AssertExists(t, "team_members", map[string]interface{}{"team_id": team.ID, "user_id": 2}, false)
		db.AssertExists(t, "webhooks", map[string]interface{}{"id": f.webhookP}, false)
		db.AssertExists(t, "webhooks", map[string]interface{}{"id": f.webhookC}, false)
		db.AssertExists(t, "task_assignees", map[string]interface{}{"task_id": f.task.ID, "user_id": 2}, false)
	})
}

func TestTeamMemberConcurrentAdminLoss(t *testing.T) {
	for _, modes := range [][2]string{{"delete", "delete"}, {"demote", "demote"}, {"delete", "demote"}} {
		t.Run(modes[0]+"-"+modes[1], func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			setup := db.NewSession()
			_, err := setup.Where("team_id = ? AND user_id = ?", 1, 2).Cols("admin").Update(&TeamMember{Admin: true})
			require.NoError(t, err)
			require.NoError(t, (&TeamMember{TeamID: 1, Username: "user3"}).Create(setup, &user.User{ID: 1}))
			require.NoError(t, setup.Commit())
			events.CleanupPending(setup)
			require.NoError(t, setup.Close())

			var ready sync.WaitGroup
			ready.Add(2)
			start := make(chan struct{})
			results := make(chan struct {
				index int
				err   error
			}, 2)
			mutate := func(s *xorm.Session, index int) error {
				tm := &TeamMember{TeamID: 1, Username: fmt.Sprintf("user%d", index+1)}
				auth := &user.User{ID: int64(index + 1)}
				if modes[index] == "delete" {
					return tm.Delete(s, auth)
				}
				return tm.Update(s, auth)
			}
			for index := range 2 {
				go func() {
					s := db.NewSession()
					defer s.Close()
					defer events.CleanupPending(s)
					tm := &TeamMember{TeamID: 1, Username: fmt.Sprintf("user%d", index+1)}
					// Establish both pre-lock RR snapshots as an HTTP Can* call does.
					allowed, operationErr := tm.CanUpdate(s, &user.User{ID: int64(index + 1)})
					if operationErr == nil && !allowed {
						operationErr = ErrGenericForbidden{}
					}
					ready.Done()
					<-start
					if operationErr == nil {
						operationErr = mutate(s, index)
					}
					if operationErr == nil {
						operationErr = s.Commit()
					} else {
						_ = s.Rollback()
					}
					results <- struct {
						index int
						err   error
					}{index, operationErr}
				}()
			}
			ready.Wait()
			close(start)
			var retries []int
			for range 2 {
				result := <-results
				if result.err == nil || IsErrCannotRemoveLastTeamAdmin(result.err) {
					continue
				}
				// SQLite cannot promote two old readers to writers. BUSY/LOCKED is a safe rollback;
				// retry in a fresh transaction only after both original transactions have ended.
				var sqliteErr sqlite3.Error
				require.Equal(t, schemas.SQLITE, db.Type(), "%v", result.err)
				require.ErrorAs(t, result.err, &sqliteErr)
				require.True(t, sqliteErr.Code == sqlite3.ErrBusy || sqliteErr.Code == sqlite3.ErrLocked, "%v", result.err)
				retries = append(retries, result.index)
			}
			for _, index := range retries {
				s := db.NewSession()
				err = mutate(s, index)
				if err == nil {
					require.NoError(t, s.Commit())
				} else {
					require.True(t, IsErrCannotRemoveLastTeamAdmin(err), "%v", err)
					require.NoError(t, s.Rollback())
				}
				events.CleanupPending(s)
				require.NoError(t, s.Close())
			}
			s := db.NewReadSession()
			defer s.Close()
			admins, err := s.Where("team_id = ? AND admin = ?", 1, true).Count(&TeamMember{})
			require.NoError(t, err)
			assert.EqualValues(t, 1, admins)
		})
	}
}
