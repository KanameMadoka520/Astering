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
	"encoding/json"
	"strconv"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

func addProjectVersionResourceConflicts(s *xorm.Session, p *Project, target *versionSnapshot, preview *ProjectVersionPreview) error {
	var project versionProjectContent
	if err := json.Unmarshal(target.Entities[versionEntityKey("project", strconv.FormatInt(p.ID, 10))].Raw, &project); err != nil {
		return err
	}
	if project.Identifier != "" {
		other := &Project{}
		exists, err := routineCurrentRead(s).Where("identifier = ? AND id <> ?", project.Identifier, p.ID).Get(other)
		if err != nil {
			return err
		}
		if exists {
			preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
				Code:     "project_version_identifier_unavailable",
				Kind:     "project",
				EntityID: strconv.FormatInt(p.ID, 10),
				Message:  "The saved project identifier is currently in use; restoring will not modify another project.",
			})
		}
	}
	for _, entity := range sortedVersionEntities(target) {
		switch entity.Kind {
		case "view":
			id, _ := strconv.ParseInt(entity.ID, 10, 64)
			view := &ProjectView{}
			exists, err := routineCurrentRead(s).ID(id).Get(view)
			if err != nil {
				return err
			}
			if exists && view.ProjectID != p.ID {
				preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
					Code:     "project_version_view_moved",
					Kind:     "view",
					EntityID: entity.ID,
					Message:  "A saved view identity now belongs to another project.",
				})
			}
		case "bucket":
			id, _ := strconv.ParseInt(entity.ID, 10, 64)
			var saved versionBucketContent
			if err := json.Unmarshal(entity.Raw, &saved); err != nil {
				return err
			}
			bucket := &Bucket{}
			exists, err := routineCurrentRead(s).ID(id).Get(bucket)
			if err != nil {
				return err
			}
			if !exists {
				continue
			}
			available, err := projectVersionBucketIdentityAvailable(s, target, bucket, saved.ProjectViewID)
			if err != nil {
				return err
			}
			if !available {
				preview.Conflicts = append(preview.Conflicts, ProjectVersionConflict{
					Code:     "project_version_bucket_moved",
					Kind:     "bucket",
					EntityID: entity.ID,
					Message:  "A saved bucket identity now belongs to another project.",
				})
			}
		}
	}
	return nil
}

func projectVersionBucketIdentityAvailable(s *xorm.Session, target *versionSnapshot, bucket *Bucket, savedViewID int64) (bool, error) {
	view := &ProjectView{}
	exists, err := routineCurrentRead(s).ID(bucket.ProjectViewID).Get(view)
	if err != nil {
		return false, err
	}
	if exists {
		return view.ProjectID == target.ProjectID, nil
	}
	// Older view deletion left bucket rows behind. Only the saved original
	// view proves that an orphan still belongs to this project's checkpoint.
	if bucket.ProjectViewID != savedViewID {
		return false, nil
	}
	entity, saved := target.Entities[versionEntityKey("view", strconv.FormatInt(savedViewID, 10))]
	if !saved {
		return false, nil
	}
	var savedView versionViewContent
	if err = json.Unmarshal(entity.Raw, &savedView); err != nil {
		return false, err
	}
	return savedView.ID == savedViewID && savedView.ProjectID == target.ProjectID, nil
}

// Restoring a saved relationship is not authority to resurrect another
// account's private label. Own/bot labels and labels still used in this guarded
// project remain available; external resources otherwise need sharing first.
func projectVersionLabelAvailable(s *xorm.Session, a web.Auth, projectID, labelID int64) (bool, error) {
	label := &Label{}
	exists, err := routineCurrentRead(s).ID(labelID).Get(label)
	if err != nil || !exists {
		return false, err
	}
	if label.CreatedByID == a.GetID() {
		return true, nil
	}
	creators := []*user.User{}
	if err = sharedVersionRows(s, "users", builder.Eq{"id": label.CreatedByID}, "id", &creators); err != nil {
		return false, err
	}
	caller, ok := a.(*user.User)
	if ok && len(creators) > 0 && creators[0].IsBotOwnedBy(caller) {
		return true, nil
	}
	links := []*LabelTask{}
	err = routineCurrentRead(s).Table(new(LabelTask)).Select("label_tasks.*").Join("INNER", "tasks", "tasks.id = label_tasks.task_id").Where("label_tasks.label_id = ? AND tasks.project_id = ? AND tasks.deleted_at IS NULL", labelID, projectID).Limit(1).Find(&links)
	return len(links) > 0, err
}
