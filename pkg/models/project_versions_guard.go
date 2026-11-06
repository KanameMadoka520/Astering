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
	"runtime"
	"slices"
	"sync"
	"weak"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/core"
	"xorm.io/xorm/schemas"
)

type projectVersionTransactionLocks struct {
	mu        sync.Mutex
	exclusive map[int64]bool
	maximumID int64
}

// Weak transaction keys neither retain closed sessions nor confuse a reused
// session's next transaction with the row locks released by Commit/Rollback.
var projectVersionTransactionScopes sync.Map // weak.Pointer[core.Tx] -> *projectVersionTransactionLocks

func projectVersionTransactionScope(s *xorm.Session) *projectVersionTransactionLocks {
	if !s.IsInTx() || s.Tx() == nil {
		return &projectVersionTransactionLocks{exclusive: map[int64]bool{}}
	}
	key := weak.Make(s.Tx())
	state := &projectVersionTransactionLocks{exclusive: map[int64]bool{}}
	actual, loaded := projectVersionTransactionScopes.LoadOrStore(key, state)
	if !loaded {
		runtime.AddCleanup(s.Tx(), func(key weak.Pointer[core.Tx]) { projectVersionTransactionScopes.Delete(key) }, key)
	}
	return actual.(*projectVersionTransactionLocks)
}

// LockProjectsForVersionMutation locks every target exclusively and its ACL
// ancestors in shared mode, globally by project ID, before view/task/file locks.
// Independent sibling projects can proceed together. A hierarchy or task move
// discovered after locking is retried; the transaction never chases a new lower
// project ID while holding a higher one.
func LockProjectsForVersionMutation(s *xorm.Session, projectIDs ...int64) error {
	targets := slices.Clone(projectIDs)
	slices.Sort(targets)
	targets = slices.Compact(targets)
	targets = slices.DeleteFunc(targets, func(id int64) bool { return id <= 0 })
	if len(targets) == 0 {
		return nil
	}
	if !s.IsInTx() {
		return versionError("project_mutation_transaction_required", "Project mutations and consistent history reads require an active transaction.")
	}
	before := []*ProjectAncestor{}
	if err := s.In("project_id", targets).OrderBy("project_id, ancestor_id").Find(&before); err != nil {
		return err
	}
	requested := make(map[int64]bool, len(targets)+len(before))
	for _, id := range targets {
		requested[id] = true
	}
	for _, ancestor := range before {
		if _, exists := requested[ancestor.AncestorID]; !exists {
			requested[ancestor.AncestorID] = false
		}
	}
	ordered := make([]int64, 0, len(requested))
	for id := range requested {
		ordered = append(ordered, id)
	}
	slices.Sort(ordered)
	state := projectVersionTransactionScope(s)
	state.mu.Lock()
	defer state.mu.Unlock()
	for _, id := range ordered {
		exclusive := requested[id]
		previous, held := state.exclusive[id]
		if held && (previous || !exclusive) {
			continue
		}
		if id < state.maximumID {
			return versionError("project_mutation_scope_changed", "This operation needs another project lock. Reload and retry the complete operation.")
		}
		switch {
		case db.Type() == schemas.SQLITE:
			// SQLite serializes writers database-wide and has no row/shared lock.
			affected, err := s.Table(new(Project)).Where("id = ?", id).Update(map[string]any{"id": id})
			if err != nil {
				return err
			}
			if affected == 0 && exclusive {
				return ErrProjectDoesNotExist{ID: id}
			}
		case exclusive:
			row := &Project{}
			exists, err := s.ForUpdate().ID(id).Get(row)
			if err != nil {
				return err
			}
			if !exists {
				return ErrProjectDoesNotExist{ID: id}
			}
		default:
			rows := []*Project{}
			if err := sharedVersionRows(s, "projects", builder.Eq{"id": id}, "id", &rows); err != nil {
				return err
			}
			// A legacy dangling parent is not an ACL grant. The existing child
			// gate and closure recheck still protect it; missing target projects
			// remain strict so unarchiving an orphan keeps its existing semantics.
		}
		state.exclusive[id] = exclusive
		state.maximumID = max(state.maximumID, id)
	}
	after := []*ProjectAncestor{}
	if err := sharedVersionRows(s, "project_ancestors", builder.In("project_id", targets), "project_id, ancestor_id", &after); err != nil {
		return err
	}
	if len(before) != len(after) {
		return versionError("project_mutation_scope_changed", "The project hierarchy changed while this operation was waiting. Reload and retry.")
	}
	for index, ancestor := range before {
		current := after[index]
		if ancestor.ProjectID != current.ProjectID || ancestor.AncestorID != current.AncestorID || ancestor.Depth != current.Depth {
			return versionError("project_mutation_scope_changed", "The project hierarchy changed while this operation was waiting. Reload and retry.")
		}
	}
	return nil
}
