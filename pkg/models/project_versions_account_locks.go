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
	"slices"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/builder"
	"xorm.io/xorm"
)

func currentProjectMutationUserExists(s *xorm.Session, userID int64) error {
	rows := []*user.User{}
	if err := sharedVersionRows(s, "users", builder.Eq{"id": userID}, "id", &rows); err != nil {
		return err
	}
	if len(rows) == 0 {
		return user.ErrUserDoesNotExist{UserID: userID}
	}
	return nil
}

// accountProjectMutationScope enumerates only identifiers. The second pass uses
// current reads after account/project gates, never an old MySQL read view.
func accountProjectMutationScope(s *xorm.Session, userID int64, current bool) (userIDs, projectIDs []int64, err error) {
	read := func(table string, cond builder.Cond, dest any) error {
		if current {
			return sharedVersionRows(s, table, cond, "id", dest)
		}
		return s.Table(table).Where(cond).Find(dest)
	}
	userIDs = []int64{userID}
	knownUsers := map[int64]bool{userID: true}
	frontier := []int64{userID}
	for len(frontier) > 0 {
		bots := []*user.User{}
		if err = read("users", builder.In("bot_owner_id", frontier), &bots); err != nil {
			return nil, nil, err
		}
		frontier = nil
		for _, bot := range bots {
			if knownUsers[bot.ID] {
				continue
			}
			knownUsers[bot.ID] = true
			userIDs = append(userIDs, bot.ID)
			frontier = append(frontier, bot.ID)
		}
	}
	projects := []*Project{}
	if err = read("projects", builder.In("owner_id", userIDs), &projects); err != nil {
		return nil, nil, err
	}
	for _, project := range projects {
		projectIDs = append(projectIDs, project.ID)
	}
	grants := []*ProjectUser{}
	if err = read("users_projects", builder.In("user_id", userIDs), &grants); err != nil {
		return nil, nil, err
	}
	for _, grant := range grants {
		projectIDs = append(projectIDs, grant.ProjectID)
	}
	memberships := []*TeamMember{}
	if err = read("team_members", builder.In("user_id", userIDs), &memberships); err != nil {
		return nil, nil, err
	}
	teamIDs := []int64{}
	for _, member := range memberships {
		teamIDs = append(teamIDs, member.TeamID)
	}
	if len(teamIDs) > 0 {
		teamGrants := []*TeamProject{}
		if err = read("team_projects", builder.In("team_id", teamIDs), &teamGrants); err != nil {
			return nil, nil, err
		}
		for _, grant := range teamGrants {
			projectIDs = append(projectIDs, grant.ProjectID)
		}
	}
	assignments := []*TaskAssginee{}
	if err = read("task_assignees", builder.In("user_id", userIDs), &assignments); err != nil {
		return nil, nil, err
	}
	if len(assignments) > 0 {
		taskIDs := []int64{}
		for _, assignment := range assignments {
			taskIDs = append(taskIDs, assignment.TaskID)
		}
		tasks := []*Task{}
		if err = read("tasks", builder.In("id", taskIDs), &tasks); err != nil {
			return nil, nil, err
		}
		for _, task := range tasks {
			projectIDs = append(projectIDs, task.ProjectID)
		}
	}
	if len(projectIDs) > 0 {
		closure := []*ProjectAncestor{}
		if current {
			err = sharedVersionRows(s, "project_ancestors", builder.In("ancestor_id", projectIDs), "project_id, ancestor_id", &closure)
		} else {
			err = s.In("ancestor_id", projectIDs).Find(&closure)
		}
		if err != nil {
			return nil, nil, err
		}
		for _, ancestor := range closure {
			projectIDs = append(projectIDs, ancestor.ProjectID)
		}
	}
	slices.Sort(userIDs)
	slices.Sort(projectIDs)
	return slices.Compact(userIDs), slices.Compact(projectIDs), nil
}

func lockAccountProjectsForMutation(s *xorm.Session, userID int64) error {
	users, projects, err := accountProjectMutationScope(s, userID, false)
	if err != nil {
		return err
	}
	if err = LockProjectsForVersionMutation(s, projects...); err != nil {
		return err
	}
	// New grants, assignments, projects and bots take a shared target-user lock
	// after their project gate. Once these account rows are exclusive, the scope
	// cannot grow between the current-read recheck and removal.
	for _, id := range users {
		account := &user.User{}
		if _, err = routineCurrentRead(s).ID(id).Get(account); err != nil {
			return err
		}
	}
	currentUsers, currentProjects, err := accountProjectMutationScope(s, userID, true)
	if err != nil {
		return err
	}
	if !slices.Equal(users, currentUsers) || !slices.Equal(projects, currentProjects) {
		return versionError("project_mutation_scope_changed", "The account's project or bot access changed while deletion was waiting. Retry the complete deletion.")
	}
	return nil
}
