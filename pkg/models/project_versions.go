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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"slices"
	"strconv"
	"strings"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/license"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

// currentVersionAccess deliberately bypasses session memoization and repeatable-read snapshots.
// Its locking reads share the transaction with the project mutation guard.
func versionReadAccess(s *xorm.Session, a web.Auth, projectID int64) (*Project, int, error) {
	if _, share := a.(*LinkSharing); share {
		return nil, 0, ErrGenericForbidden{}
	}
	return currentProjectReadPermission(s, a, projectID)
}
func initialVersionAccess(s *xorm.Session, a web.Auth, projectID int64) (int, error) {
	if a == nil {
		return 0, ErrGenericForbidden{}
	}
	if account, ok := a.(*user.User); ok && account == nil {
		return 0, ErrGenericForbidden{}
	}
	if _, share := a.(*LinkSharing); share || a.GetID() <= 0 {
		return 0, ErrGenericForbidden{}
	}
	p := &Project{ID: projectID}
	can, level, err := p.CanRead(s, a)
	if err != nil {
		return 0, err
	}
	if !can {
		return 0, ErrGenericForbidden{}
	}
	return level, nil
}
func currentProjectReadPermission(s *xorm.Session, a web.Auth, projectID int64) (*Project, int, error) {
	if share, ok := a.(*LinkSharing); ok {
		return currentSharedProjectReadPermission(s, share, projectID)
	}

	u, ok := a.(*user.User)
	if !ok || u == nil || u.ID <= 0 || projectID <= 0 {
		return nil, 0, ErrGenericForbidden{}
	}
	users := []*user.User{}
	ownerIDs := builder.Select("bot_owner_id").From("users").Where(builder.Eq{"id": u.ID})
	err := sharedVersionRows(s, "users", builder.Or(builder.Eq{"id": u.ID}, builder.In("id", ownerIDs)), "id", &users)
	if err != nil {
		return nil, 0, err
	}
	identities := map[int64]*user.User{}
	for _, identity := range users {
		identities[identity.ID] = identity
	}
	freshUser := identities[u.ID]
	if freshUser == nil || (user.CheckUserCanAuthenticate(freshUser) != nil && !accountMaintenanceAllowsInactive(s, u, freshUser.ID)) {
		return nil, 0, ErrGenericForbidden{}
	}
	if freshUser.IsBot() {
		owner := identities[freshUser.BotOwnerID]
		if owner == nil || owner.IsBot() || (user.CheckUserCanAuthenticate(owner) != nil && !accountMaintenanceAllowsInactive(s, u, owner.ID)) {
			return nil, 0, ErrGenericForbidden{}
		}
	}
	var exists bool
	p := &Project{}
	exists, err = routineCurrentRead(s).ID(projectID).Get(p)
	if err != nil {
		return nil, 0, err
	}
	if !exists {
		return nil, 0, ErrProjectDoesNotExist{ID: projectID}
	}
	if license.IsFeatureEnabled(license.FeatureAdminPanel) && freshUser.IsAdmin && !u.HasResourceOnlyPermissions() {
		return p, int(PermissionAdmin), nil
	}
	grants, chain, err := currentProjectMemberGrants(s, u.ID, projectID)
	if err != nil {
		return nil, 0, err
	}
	nearest := -1
	for _, ancestor := range chain {
		level, had := grants[ancestor.AncestorID]
		if !had {
			continue
		}
		if level == PermissionAdmin {
			return p, int(PermissionAdmin), nil
		}
		if nearest < 0 {
			nearest = int(level)
		}
	}
	if nearest < 0 {
		return nil, 0, ErrGenericForbidden{}
	}
	return p, nearest, nil
}

func currentSharedProjectReadPermission(s *xorm.Session, share *LinkSharing, projectID int64) (*Project, int, error) {
	if share == nil || share.ProjectID != projectID {
		return nil, 0, ErrGenericForbidden{}
	}
	fresh := &LinkSharing{}
	exists, err := routineCurrentRead(s).ID(share.ID).Get(fresh)
	if err != nil {
		return nil, 0, err
	}
	if !exists || fresh.ProjectID != projectID || fresh.Permission.isValid() != nil {
		return nil, 0, ErrGenericForbidden{}
	}
	p := &Project{}
	exists, err = routineCurrentRead(s).ID(projectID).Get(p)
	if err != nil {
		return nil, 0, err
	}
	if !exists {
		return nil, 0, ErrProjectDoesNotExist{ID: projectID}
	}
	return p, int(fresh.Permission), nil
}

// currentProjectMemberGrants retains nearest-ancestor permissions and sticky
// inherited administrator access using only current shared-lock reads.
func currentProjectMemberGrants(s *xorm.Session, userID, projectID int64) (map[int64]Permission, []*ProjectAncestor, error) {
	chain := []*ProjectAncestor{}
	if err := sharedVersionRows(s, "project_ancestors", builder.Eq{"project_id": projectID}, "depth, ancestor_id", &chain); err != nil {
		return nil, nil, err
	}
	ids := []int64{}
	for _, ancestor := range chain {
		ids = append(ids, ancestor.AncestorID)
	}
	if len(ids) == 0 {
		ids = append(ids, projectID)
		chain = append(chain, &ProjectAncestor{
			AncestorID: projectID,
			ProjectID:  projectID,
		})
	}
	projects := []*Project{}
	if err := sharedVersionRows(s, "projects", builder.In("id", ids), "id", &projects); err != nil {
		return nil, nil, err
	}
	grants := map[int64]Permission{}
	for _, candidate := range projects {
		if candidate.OwnerID == userID {
			grants[candidate.ID] = PermissionAdmin
		}
	}
	links := []*ProjectUser{}
	if err := sharedVersionRows(s, "users_projects", builder.And(builder.In("project_id", ids), builder.Eq{"user_id": userID}), "project_id, id", &links); err != nil {
		return nil, nil, err
	}
	setGrant := func(id int64, level Permission) {
		if level.isValid() != nil {
			return
		}
		previous, had := grants[id]
		if !had || level > previous {
			grants[id] = level
		}
	}
	for _, link := range links {
		setGrant(link.ProjectID, link.Permission)
	}
	members := []*TeamMember{}
	if err := sharedVersionRows(s, "team_members", builder.Eq{"user_id": userID}, "team_id, id", &members); err != nil {
		return nil, nil, err
	}
	teamIDs := []int64{}
	for _, member := range members {
		teamIDs = append(teamIDs, member.TeamID)
	}
	if len(teamIDs) > 0 {
		teams := []*TeamProject{}
		if err := sharedVersionRows(s, "team_projects", builder.And(builder.In("project_id", ids), builder.In("team_id", teamIDs)), "project_id, id", &teams); err != nil {
			return nil, nil, err
		}
		for _, link := range teams {
			setGrant(link.ProjectID, link.Permission)
		}
	}
	return grants, chain, nil
}

func readVersionRow(s *xorm.Session, projectID, versionID int64) (*ProjectVersion, error) {
	version := &ProjectVersion{}
	exists, err := routineCurrentRead(s).Where("id = ? AND project_id = ?", versionID, projectID).Get(version)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, versionError("project_version_missing", "This project checkpoint does not exist.")
	}
	return version, nil
}
func versionPagination(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 24
	}
	if perPage > 100 {
		perPage = 100
	}
	return page, perPage
}

func versionPageOffset(page, perPage int, total int64) (int, bool) {
	// Reject out-of-range pages before multiplication, including calls from
	// internal services that do not pass through the HTTP query bounds.
	if total <= 0 || int64(page) > (total-1)/int64(perPage)+1 || page-1 > int(^uint(0)>>1)/perPage {
		return 0, false
	}
	return (page - 1) * perPage, true
}

func ListProjectVersions(s *xorm.Session, a web.Auth, projectID int64, page, perPage int) ([]*ProjectVersionSummary, int64, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, 0, err
	}
	page, perPage = versionPagination(page, perPage)
	total, err := s.Where("project_id = ?", projectID).Count(new(ProjectVersion))
	if err != nil {
		return nil, 0, err
	}
	offset, inRange := versionPageOffset(page, perPage, total)
	if !inRange {
		return []*ProjectVersionSummary{}, total, nil
	}
	rows := []*ProjectVersion{}
	if err = s.Where("project_id = ?", projectID).OrderBy("sequence DESC").Limit(perPage, offset).Find(&rows); err != nil {
		return nil, 0, err
	}
	out := make([]*ProjectVersionSummary, 0, len(rows))
	for _, row := range rows {
		out = append(out, row.summary())
	}
	return out, total, nil
}
func CreateProjectVersion(s *xorm.Session, a web.Auth, projectID int64, name, requestID string) (*ProjectVersionSummary, error) {
	if level, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	} else if level < int(PermissionWrite) {
		return nil, ErrGenericForbidden{}
	}
	name = strings.TrimSpace(name)
	if name == "" || utf8.RuneCountInString(name) > 160 || !versionRequestValid(requestID) {
		return nil, versionError("project_version_invalid", "Use a nonempty checkpoint name up to 160 characters and a unique request ID.")
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return nil, err
	}
	if _, level, err := versionReadAccess(s, a, projectID); err != nil {
		return nil, err
	} else if level < int(PermissionWrite) {
		return nil, ErrGenericForbidden{}
	}
	old := &ProjectVersion{}
	exists, err := routineCurrentRead(s).Where("project_id = ? AND created_by_id = ? AND request_id = ? AND kind = ?", projectID, a.GetID(), requestID, "manual").Get(old)
	if err != nil {
		return nil, err
	}
	if exists {
		if old.Name != name {
			return nil, versionError("project_version_request_conflict", "This request ID was already used for a different checkpoint.")
		}
		return old.summary(), nil
	}
	snapshot, err := captureProjectVersion(s, projectID)
	if err != nil {
		return nil, err
	}
	return saveProjectVersionSnapshot(s, a, snapshot, name, "manual", requestID, 0)
}
func ReadProjectVersion(s *xorm.Session, a web.Auth, projectID, versionID int64) (*ProjectVersionSummary, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	}
	row, err := readVersionRow(s, projectID, versionID)
	if err != nil {
		return nil, err
	}
	return row.summary(), nil
}
func ListProjectVersionEntities(s *xorm.Session, a web.Auth, projectID, versionID int64, kind string, page, perPage int) ([]ProjectVersionEntityIndex, int64, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, 0, err
	}
	if _, err := readVersionRow(s, projectID, versionID); err != nil {
		return nil, 0, err
	}
	page, perPage = versionPagination(page, perPage)
	query := func() *xorm.Session {
		q := s.Where("version_id = ?", versionID)
		if kind != "" {
			q = q.And("kind = ?", kind)
		}
		return q
	}
	total, err := query().Count(new(projectVersionEntity))
	if err != nil {
		return nil, 0, err
	}
	offset, inRange := versionPageOffset(page, perPage, total)
	if !inRange {
		return []ProjectVersionEntityIndex{}, total, nil
	}
	entries := []*projectVersionEntity{}
	if err = query().OrderBy("kind, entity_id").Limit(perPage, offset).Find(&entries); err != nil {
		return nil, 0, err
	}
	result := make([]ProjectVersionEntityIndex, 0, len(entries))
	for _, entry := range entries {
		result = append(result, ProjectVersionEntityIndex{
			Kind:        entry.Kind,
			EntityID:    entry.EntityID,
			Title:       entry.Title,
			ContentHash: entry.Hash,
		})
	}
	return result, total, nil
}
func ReadProjectVersionEntity(s *xorm.Session, a web.Auth, projectID, versionID int64, kind, entityID string) (*ProjectVersionEntityContent, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return nil, err
	}
	if _, _, err := versionReadAccess(s, a, projectID); err != nil {
		return nil, err
	}
	version, err := readVersionRow(s, projectID, versionID)
	if err != nil {
		return nil, err
	}
	entity, saved, err := readSavedVersionEntity(s, version, kind, entityID)
	if err != nil {
		return nil, err
	}
	current, err := currentVersionEntity(s, projectID, kind, entityID)
	if err != nil {
		return nil, err
	}
	if !saved && current == nil {
		return nil, versionError("project_version_missing", "This checkpoint entity does not exist.")
	}
	result := &ProjectVersionEntityContent{
		ProjectID:   projectID,
		VersionID:   versionID,
		Kind:        kind,
		EntityID:    entityID,
		ContentHash: entity.Hash,
	}
	if saved {
		if err = json.Unmarshal(entity.Raw, &result.Content); err != nil {
			return nil, err
		}
		if err = renderSavedVersionContent(s, version, kind, result.Content); err != nil {
			return nil, err
		}
	}
	if current != nil {
		if err = json.Unmarshal(current, &result.CurrentContent); err != nil {
			return nil, err
		}
	}
	return result, nil
}

func PreviewProjectVersion(s *xorm.Session, a web.Auth, projectID, versionID int64, page, perPage int) (*ProjectVersionPreview, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return nil, err
	}
	p, level, err := versionReadAccess(s, a, projectID)
	if err != nil {
		return nil, err
	}
	version, err := readVersionRow(s, projectID, versionID)
	if err != nil {
		return nil, err
	}
	current, err := captureProjectVersion(s, projectID)
	if err != nil {
		return nil, err
	}
	target, err := loadProjectVersionSnapshot(s, version)
	if err != nil {
		return nil, err
	}
	preview, err := buildProjectVersionPreview(s, a, p, current, target, versionID)
	if err != nil {
		return nil, err
	}
	preview.CanRestore = preview.CanRestore && level >= int(PermissionAdmin)
	page, perPage = versionPagination(page, perPage)
	preview.Changes.Page = page
	preview.Changes.PerPage = perPage
	preview.Changes.TotalPages = (preview.Changes.Total + int64(perPage) - 1) / int64(perPage)
	start, inRange := versionPageOffset(page, perPage, int64(len(preview.Changes.Items)))
	if !inRange {
		preview.Changes.Items = []ProjectVersionChange{}
	} else {
		end := start + min(perPage, len(preview.Changes.Items)-start)
		preview.Changes.Items = preview.Changes.Items[start:end]
	}
	return preview, nil
}
func buildProjectVersionPreview(s *xorm.Session, a web.Auth, p *Project, current, target *versionSnapshot, versionID int64) (*ProjectVersionPreview, error) {
	preview := &ProjectVersionPreview{
		ProjectID:       p.ID,
		TargetVersionID: versionID,
		CurrentHash:     current.Hash,
		TargetHash:      target.Hash,
		Conflicts:       []ProjectVersionConflict{},
		Preserved:       ProjectVersionPreserved{Permissions: true},
		Changes:         ProjectVersionChanges{Items: []ProjectVersionChange{}},
	}
	commentAttachments, err := projectVersionCommentAttachments(s, p.ID, target.TaskIDs)
	if err != nil {
		return nil, err
	}
	for id := range commentAttachments {
		if _, saved := target.Entities[versionEntityKey("attachment", strconv.FormatInt(id, 10))]; !saved {
			preview.Preserved.CommentAttachments++
		}
	}
	keys := map[string]bool{}
	for key := range current.Entities {
		keys[key] = true
	}
	for key := range target.Entities {
		keys[key] = true
	}
	ordered := []string{}
	for key := range keys {
		ordered = append(ordered, key)
	}
	slices.Sort(ordered)
	for _, key := range ordered {
		before, had := current.Entities[key]
		after, has := target.Entities[key]
		if had && has && before.Hash == after.Hash {
			continue
		}
		entity := after
		operation := "update"
		if !has {
			entity = before
			operation = "remove"
		} else if !had {
			operation = "add"
		}
		if operation == "remove" && entity.Kind == "attachment" {
			id, _ := strconv.ParseInt(entity.ID, 10, 64)
			if commentAttachments[id] {
				continue
			}
		}
		change := ProjectVersionChange{
			Kind:      entity.Kind,
			EntityID:  entity.ID,
			Title:     entity.Title,
			Operation: operation,
			Fields:    changedVersionFields(before.Raw, after.Raw),
		}
		preview.Changes.Items = append(preview.Changes.Items, change)
		countVersionChange(&preview.Summary, change)
	}
	preview.Changes.Total = int64(len(preview.Changes.Items))
	if p.IsArchived {
		preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
			Code:     "project_version_archived",
			Kind:     "project",
			EntityID: strconv.FormatInt(p.ID, 10),
			Message:  "Unarchive this project before restoring its content.",
		})
	}
	if err := addProjectVersionResourceConflicts(s, p, target, preview); err != nil {
		return nil, err
	}
	factTaskIDs := slices.Clone(current.TaskIDs)
	for _, id := range target.TaskIDs {
		task := &Task{}
		exists, err := routineCurrentRead(s).Unscoped().ID(id).Get(task)
		if err != nil {
			return nil, err
		}
		if exists && task.ProjectID != p.ID {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_task_moved",
				Kind:     "task",
				EntityID: strconv.FormatInt(id, 10),
				Message:  "A saved task now belongs to another project; it will not be moved or exposed by this restore.",
			})
			continue
		}
		factTaskIDs = append(factTaskIDs, id)
	}
	if err := addProjectVersionFileConflicts(s, target, preview); err != nil {
		return nil, err
	}
	if err := addProjectVersionLinkConflicts(s, a, p.ID, target, preview); err != nil {
		return nil, err
	}
	allTaskIDs := factTaskIDs
	slices.Sort(allTaskIDs)
	allTaskIDs = slices.Compact(allTaskIDs)
	if len(allTaskIDs) > 0 {
		var err error
		preview.Preserved.Comments, err = s.In("task_id", allTaskIDs).Count(new(TaskComment))
		if err != nil {
			return nil, err
		}
		preview.Preserved.Checkins, err = s.In("task_id", allTaskIDs).Count(new(TaskRoutineCheckin))
		if err != nil {
			return nil, err
		}
		preview.Preserved.Progress, err = s.In("task_id", allTaskIDs).Count(new(TaskRoutineProgress))
		if err != nil {
			return nil, err
		}
		preview.Preserved.TimeEntries, err = s.In("task_id", allTaskIDs).Count(new(TimeEntry))
		if err != nil {
			return nil, err
		}
	}
	plan := struct {
		ProjectID, VersionID, ActorID int64
		CurrentHash, TargetHash       string
		Changes                       []ProjectVersionChange
		Conflicts                     []ProjectVersionConflict
	}{
		ProjectID:   p.ID,
		VersionID:   versionID,
		ActorID:     a.GetID(),
		CurrentHash: current.Hash,
		TargetHash:  target.Hash,
		Changes:     preview.Changes.Items,
		Conflicts:   preview.Conflicts,
	}
	raw, err := json.Marshal(plan)
	if err != nil {
		return nil, err
	}
	sum := sha256.Sum256(raw)
	preview.PlanHash = hex.EncodeToString(sum[:])
	preview.CanRestore = len(preview.Conflicts) == 0
	return preview, nil
}
func addProjectVersionFileConflicts(s *xorm.Session, target *versionSnapshot, preview *ProjectVersionPreview) error {
	fileIDs := make([]int64, 0, len(target.Files))
	for id := range target.Files {
		fileIDs = append(fileIDs, id)
	}
	slices.Sort(fileIDs)
	for _, id := range fileIDs {
		f := &files.File{ID: id}
		if err := f.LoadFileMetaByID(s); err != nil {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_file_missing",
				Kind:     "attachment",
				EntityID: strconv.FormatInt(id, 10),
				Message:  "A saved original file is missing.",
			})
			continue
		}
		if err := f.LoadFileByID(); err != nil {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_file_missing",
				Kind:     "attachment",
				EntityID: strconv.FormatInt(id, 10),
				Message:  "A saved original file is not readable from storage.",
			})
			continue
		}
		if err := f.File.Close(); err != nil {
			return err
		}
		d := &files.DriveFile{}
		exists, err := routineCurrentRead(s).Where("file_id = ?", id).Get(d)
		if err != nil {
			return err
		}
		if exists && d.Purging {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_file_missing",
				Kind:     "attachment",
				EntityID: strconv.FormatInt(id, 10),
				Message:  "A saved original file is being permanently deleted.",
			})
		}
	}
	return nil
}

func addProjectVersionLinkConflicts(s *xorm.Session, a web.Auth, projectID int64, target *versionSnapshot, preview *ProjectVersionPreview) error {
	for _, entity := range sortedVersionEntities(target) {
		if entity.Kind == "label" {
			var link versionLinkContent
			if err := json.Unmarshal(entity.Raw, &link); err != nil {
				return err
			}
			exists, err := routineCurrentRead(s).ID(link.OtherID).Exist(new(Label))
			if err != nil {
				return err
			}
			if !exists {
				preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
					Code:     "project_version_label_missing",
					Kind:     "label",
					EntityID: entity.ID,
					Message:  "A saved label no longer exists; restoring never recreates external resources.",
				})
			} else {
				available, err := projectVersionLabelAvailable(s, a, projectID, link.OtherID)
				if err != nil {
					return err
				}
				if !available {
					preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
						Code:     "project_version_label_unavailable",
						Kind:     "label",
						EntityID: entity.ID,
						Message:  "A saved label is no longer available in this project or owned by this account.",
					})
				}
			}
			continue
		}
		if entity.Kind != "assignee" {
			continue
		}
		var link versionLinkContent
		if err := json.Unmarshal(entity.Raw, &link); err != nil {
			return err
		}
		if _, _, err := versionReadAccess(s, &user.User{ID: link.OtherID}, projectID); err != nil {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_assignee_unavailable",
				Kind:     "assignee",
				EntityID: entity.ID,
				Message:  "A saved assignee no longer has access; restoring never restores member permissions.",
			})
		}
	}
	return nil
}

func changedVersionFields(before, after json.RawMessage) []string {
	old, next := map[string]json.RawMessage{}, map[string]json.RawMessage{}
	_ = json.Unmarshal(before, &old)
	_ = json.Unmarshal(after, &next)
	keys := map[string]bool{}
	for key := range old {
		keys[key] = true
	}
	for key := range next {
		keys[key] = true
	}
	result := []string{}
	for key := range keys {
		if string(old[key]) != string(next[key]) {
			result = append(result, key)
		}
	}
	slices.Sort(result)
	return result
}
func countVersionChange(summary *ProjectVersionDiffSummary, change ProjectVersionChange) {
	switch change.Kind {
	case "project", "announcement":
		summary.ProjectChanged = true
	case "task":
		switch change.Operation {
		case "add":
			summary.AddedTasks++
		case "update":
			summary.UpdatedTasks++
		case "remove":
			summary.RemovedTasks++
		}
	case "view":
		switch change.Operation {
		case "add":
			summary.AddedViews++
		case "update":
			summary.UpdatedViews++
		case "remove":
			summary.RemovedViews++
		}
	case "bucket":
		switch change.Operation {
		case "add":
			summary.AddedBuckets++
		case "update":
			summary.UpdatedBuckets++
		case "remove":
			summary.RemovedBuckets++
		}
	case "attachment":
		switch change.Operation {
		case "add":
			summary.AddedAttachments++
		case "update":
			summary.UpdatedAttachments++
		case "remove":
			summary.RemovedAttachments++
		}
	}
}
func DeleteProjectVersion(s *xorm.Session, a web.Auth, projectID, versionID int64, confirmName string) error {
	if level, err := initialVersionAccess(s, a, projectID); err != nil {
		return err
	} else if level < int(PermissionAdmin) {
		return ErrGenericForbidden{}
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return err
	}
	if _, level, err := versionReadAccess(s, a, projectID); err != nil {
		return err
	} else if level < int(PermissionAdmin) {
		return ErrGenericForbidden{}
	}
	version, err := readVersionRow(s, projectID, versionID)
	if err != nil {
		return err
	}
	if confirmName != version.Name {
		return versionError("project_version_invalid", "Type the checkpoint name to confirm removal of its history references.")
	}
	return deleteProjectVersionRows(s, projectID, versionID)
}
func deleteProjectVersionRows(s *xorm.Session, projectID, versionID int64) error {
	for _, model := range []any{
		&projectVersionEntity{},
		&projectVersionTaskRef{},
		&files.ProjectVersionFileRef{},
	} {
		if _, err := s.Where("version_id = ?", versionID).Delete(model); err != nil {
			return err
		}
	}
	if _, err := s.Where("id = ? AND project_id = ?", versionID, projectID).Delete(new(ProjectVersion)); err != nil {
		return err
	}
	objects := []*projectVersionObject{}
	if err := routineCurrentRead(s).Where("project_id = ?", projectID).Find(&objects); err != nil {
		return err
	}
	for _, object := range objects {
		used, err := routineCurrentRead(s).Where("object_id = ?", object.ID).Exist(new(projectVersionEntity))
		if err != nil {
			return err
		}
		if !used {
			if _, err = s.ID(object.ID).Delete(new(projectVersionObject)); err != nil {
				return err
			}
		}
	}
	return nil
}
func FileReferencedInProjectVersions(s *xorm.Session, fileID int64) (bool, error) {
	return files.ReferencedByProjectVersion(s, fileID)
}
func TaskReferencedInProjectVersions(s *xorm.Session, taskID int64) (bool, error) {
	return routineCurrentRead(s).Where("task_id = ?", taskID).Exist(new(projectVersionTaskRef))
}

// ProjectVersionFileDownload is authorized against the current project and an exact immutable media reference.
type ProjectVersionFileDownload struct{ File *files.File }

func ReadProjectVersionFile(s *xorm.Session, a web.Auth, projectID, versionID, fileID int64) (*ProjectVersionFileDownload, error) {
	if _, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	}
	if _, err := readVersionRow(s, projectID, versionID); err != nil {
		return nil, err
	}
	exists, err := s.Where("project_id = ? AND version_id = ? AND file_id = ?", projectID, versionID, fileID).Exist(new(files.ProjectVersionFileRef))
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, versionError("project_version_missing", "This original is not referenced by this checkpoint.")
	}
	f := &files.File{ID: fileID}
	if err = f.LoadFileMetaByID(s); err != nil {
		return nil, versionError("project_version_file_missing", "This original file is missing.")
	}
	return &ProjectVersionFileDownload{File: f}, nil
}

func deleteAllProjectVersions(s *xorm.Session, projectID int64) error {
	versions := []*ProjectVersion{}
	if err := routineCurrentRead(s).Where("project_id = ?", projectID).Find(&versions); err != nil {
		return err
	}
	for _, version := range versions {
		for _, model := range []any{
			new(projectVersionEntity),
			new(projectVersionTaskRef),
			new(files.ProjectVersionFileRef),
		} {
			if _, err := s.Where("version_id = ?", version.ID).Delete(model); err != nil {
				return err
			}
		}
	}
	for _, model := range []any{
		new(ProjectVersion),
		new(projectVersionObject),
		new(projectVersionCounter),
	} {
		if _, err := s.Where("project_id = ?", projectID).Delete(model); err != nil {
			return err
		}
	}
	return nil
}
func projectVersionDriveUsages(s *xorm.Session, a web.Auth, fileID int64) ([]DriveUsage, error) {
	refs := []*files.ProjectVersionFileRef{}
	if err := sharedVersionRows(s, "project_version_file_refs", builder.Eq{"file_id": fileID}, "project_id, version_id", &refs); err != nil {
		return nil, err
	}
	ids := []int64{}
	for _, ref := range refs {
		ids = append(ids, ref.VersionID)
	}
	versions := map[int64]*ProjectVersion{}
	for chunk := range slices.Chunk(ids, 400) {
		rows := []*ProjectVersion{}
		if err := s.In("id", chunk).Find(&rows); err != nil {
			return nil, err
		}
		for _, row := range rows {
			versions[row.ID] = row
		}
	}
	result := []DriveUsage{}
	for _, ref := range refs {
		usage := DriveUsage{
			Kind:       "project_history",
			Restricted: true,
		}
		p := &Project{ID: ref.ProjectID}
		can, _, err := p.CanRead(s, a)
		if err != nil {
			return nil, err
		}
		if version := versions[ref.VersionID]; can && version != nil && version.ProjectID == ref.ProjectID {
			usage.Restricted = false
			usage.Title = p.Title + " · " + version.Name
			usage.URL = fmt.Sprintf("/projects/%d/versions?version=%d", ref.ProjectID, ref.VersionID)
		}
		result = append(result, usage)
	}
	return result, nil
}
