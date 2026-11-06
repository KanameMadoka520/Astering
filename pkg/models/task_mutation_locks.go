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

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// LockProjectViewsForTaskMutation acquires the same globally ordered view locks
// used by bulk task updates. Call it before locking any task or attachment rows.
// The caller must recheck each task's source project after acquiring its row lock.
func LockProjectViewsForTaskMutation(s *xorm.Session, projectIDs ...int64) error {
	_, err := lockProjectViewsForPositionUpdate(s, projectIDs...)
	return err
}

// lockTasksForProjectMutation resolves the complete source/destination scope
// before any view, task or file row is locked. A task moved while the project
// gate was being acquired must be retried with its new scope; acquiring another
// project here would invert the globally ascending lock order.
func lockTasksForProjectMutation(s *xorm.Session, taskIDs []int64, additionalProjectIDs ...int64) (map[int64]int64, error) {
	ids := slices.Clone(taskIDs)
	slices.Sort(ids)
	ids = slices.Compact(ids)
	projects := slices.Clone(additionalProjectIDs)
	sources := make(map[int64]int64, len(ids))
	for _, id := range ids {
		task := &Task{}
		exists, err := s.Unscoped().ID(id).Get(task)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, ErrTaskDoesNotExist{ID: id}
		}
		sources[id] = task.ProjectID
		projects = append(projects, task.ProjectID)
	}
	if err := LockProjectViewsForTaskMutation(s, projects...); err != nil {
		return nil, err
	}
	for _, id := range ids {
		task := &Task{}
		exists, err := routineCurrentRead(s).Unscoped().ID(id).Get(task)
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, ErrTaskDoesNotExist{ID: id}
		}
		if task.ProjectID != sources[id] {
			return nil, versionError("project_mutation_scope_changed", "A task moved while this operation was waiting. Reload it and retry.")
		}
	}
	return sources, nil
}

func lockViewProjectsForMutation(s *xorm.Session, viewIDs ...int64) error {
	projects := make([]int64, 0, len(viewIDs))
	for _, id := range viewIDs {
		view := &ProjectView{}
		exists, err := s.ID(id).Get(view)
		if err != nil {
			return err
		}
		if !exists {
			return &ErrProjectViewDoesNotExist{ProjectViewID: id}
		}
		projects = append(projects, view.ProjectID)
	}
	return LockProjectsForVersionMutation(s, projects...)
}

func lockProjectSubtreeForMutation(s *xorm.Session, projectID int64, additionalProjectIDs ...int64) error {
	rows := []*ProjectAncestor{}
	if err := s.Where("ancestor_id = ?", projectID).Find(&rows); err != nil {
		return err
	}
	projects := append(slices.Clone(additionalProjectIDs), projectID)
	for _, row := range rows {
		projects = append(projects, row.ProjectID)
	}
	if err := LockProjectsForVersionMutation(s, projects...); err != nil {
		return err
	}
	current := []*ProjectAncestor{}
	if err := routineCurrentRead(s).Where("ancestor_id = ?", projectID).Find(&current); err != nil {
		return err
	}
	known := make(map[int64]bool, len(projects))
	for _, id := range projects {
		known[id] = true
	}
	for _, row := range current {
		if !known[row.ProjectID] {
			return versionError("project_mutation_scope_changed", "The project hierarchy changed while this operation was waiting. Reload it and retry.")
		}
	}
	return nil
}

func lockTeamProjectScopesForMutation(s *xorm.Session, teamID int64) error {
	projectsFor := func(current bool) ([]int64, error) {
		grants := []*TeamProject{}
		var err error
		if current {
			err = sharedVersionRows(s, "team_projects", builder.Eq{"team_id": teamID}, "id", &grants)
		} else {
			err = s.Where("team_id = ?", teamID).Find(&grants)
		}
		if err != nil {
			return nil, err
		}
		projectIDs := make([]int64, 0, len(grants))
		for _, grant := range grants {
			projectIDs = append(projectIDs, grant.ProjectID)
		}
		if len(projectIDs) == 0 {
			return projectIDs, nil
		}
		ancestors := []*ProjectAncestor{}
		if current {
			err = sharedVersionRows(s, "project_ancestors", builder.In("ancestor_id", projectIDs), "project_id, ancestor_id", &ancestors)
		} else {
			err = s.In("ancestor_id", projectIDs).Find(&ancestors)
		}
		if err != nil {
			return nil, err
		}
		for _, ancestor := range ancestors {
			projectIDs = append(projectIDs, ancestor.ProjectID)
		}
		slices.Sort(projectIDs)
		return slices.Compact(projectIDs), nil
	}
	before, err := projectsFor(false)
	if err != nil {
		return err
	}
	if err := LockProjectsForVersionMutation(s, before...); err != nil {
		return err
	}
	if db.Type() == schemas.SQLITE {
		if _, err := s.Table(new(Team)).Where("id = ?", teamID).Update(map[string]any{"id": teamID}); err != nil {
			return err
		}
	}
	team := &Team{}
	exists, err := routineCurrentRead(s).ID(teamID).Get(team)
	if err != nil {
		return err
	}
	if !exists {
		return ErrTeamDoesNotExist{TeamID: teamID}
	}
	after, err := projectsFor(true)
	if err != nil {
		return err
	}
	if !slices.Equal(before, after) {
		return versionError("project_mutation_scope_changed", "The team's project access changed while this operation was waiting. Retry the complete operation.")
	}
	return nil
}

func requireCurrentProjectPermission(s *xorm.Session, a web.Auth, projectID int64, permission Permission) error {
	_, level, err := currentProjectReadPermission(s, a, projectID)
	if err != nil {
		return err
	}
	if level < int(permission) {
		return ErrGenericForbidden{}
	}
	return nil
}

func requireCurrentProjectAdmin(s *xorm.Session, a web.Auth, projectID int64) error {
	if _, share := a.(*LinkSharing); share {
		return ErrGenericForbidden{}
	}
	return requireCurrentProjectPermission(s, a, projectID, PermissionAdmin)
}

func requireCurrentProjectWrite(s *xorm.Session, a web.Auth, projectID int64) error {
	project, level, err := currentProjectReadPermission(s, a, projectID)
	if err != nil {
		return err
	}
	if level < int(PermissionWrite) {
		return ErrGenericForbidden{}
	}
	if project.IsArchived {
		return ErrProjectIsArchived{ProjectID: projectID}
	}
	return nil
}

func lockAuthorizedViewForMutation(s *xorm.Session, a web.Auth, viewID int64) error {
	if err := lockViewProjectsForMutation(s, viewID); err != nil {
		return err
	}
	view, err := GetProjectViewByID(routineCurrentRead(s), viewID)
	if err != nil {
		return err
	}
	if view.ProjectID < 0 {
		allowed, err := view.CanUpdate(s, a)
		if err != nil {
			return err
		}
		if !allowed {
			return ErrGenericForbidden{}
		}
		return nil
	}
	return requireCurrentProjectWrite(s, a, view.ProjectID)
}

func lockAuthorizedTasksForProjectMutation(s *xorm.Session, a web.Auth, taskIDs []int64, additionalProjectIDs ...int64) error {
	sources, err := lockTasksForProjectMutation(s, taskIDs, additionalProjectIDs...)
	if err != nil {
		return err
	}
	projects := slices.Clone(additionalProjectIDs)
	for _, projectID := range sources {
		projects = append(projects, projectID)
	}
	slices.Sort(projects)
	for _, projectID := range slices.Compact(projects) {
		if projectID <= 0 {
			continue
		}
		project, level, err := currentProjectReadPermission(s, a, projectID)
		if err != nil {
			return err
		}
		if level < int(PermissionWrite) {
			return ErrGenericForbidden{}
		}
		if project.IsArchived {
			return ErrProjectIsArchived{ProjectID: projectID}
		}
	}
	return nil
}
