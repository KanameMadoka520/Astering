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
	"fmt"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/richtext"
	"xorm.io/builder"
	"xorm.io/xorm"
)

func readSavedVersionEntity(s *xorm.Session, version *ProjectVersion, kind, id string) (versionEntityData, bool, error) {
	if version.SchemaVersion != projectVersionSchema {
		return versionEntityData{}, false, versionError("project_version_schema", "This checkpoint uses an unsupported content schema.")
	}
	entries := []*projectVersionEntity{}
	err := sharedVersionRows(s, "project_version_entities", builder.Eq{
		"version_id": version.ID,
		"kind":       kind,
		"entity_id":  id,
	}, "id", &entries)
	if err != nil || len(entries) == 0 {
		return versionEntityData{}, false, err
	}
	entry := entries[0]
	objects := []*projectVersionObject{}
	err = sharedVersionRows(s, "project_version_objects", builder.Eq{
		"id":         entry.ObjectID,
		"project_id": version.ProjectID,
	}, "id", &objects)
	if err != nil {
		return versionEntityData{}, false, err
	}
	if len(objects) == 0 {
		return versionEntityData{}, false, versionError("project_version_corrupt", "Saved content is missing.")
	}
	raw, err := decodeProjectVersionObject(objects[0], entry)
	return versionEntityData{
		Kind:  kind,
		ID:    id,
		Title: entry.Title,
		Raw:   raw,
		Hash:  entry.Hash,
	}, true, err
}
func currentVersionEntity(s *xorm.Session, projectID int64, kind, id string) (json.RawMessage, error) {
	numeric, _ := strconv.ParseInt(id, 10, 64)
	switch kind {
	case "project", "announcement":
		return currentVersionProjectContent(s, projectID, numeric, kind)
	case "task", "routine", "attachment", "reminder":
		return currentVersionTaskContent(s, projectID, numeric, kind)
	case "view", "bucket":
		return currentVersionViewContent(s, projectID, numeric, kind)
	case "assignee", "label", "relation", "position":
		return currentVersionLinkContent(s, projectID, kind, id)
	}
	return nil, versionError("project_version_invalid", "Unknown entity kind.")
}

func packCurrentVersionEntity(value any, exists bool, err error) (json.RawMessage, error) {
	if err != nil || !exists {
		return nil, err
	}
	return json.Marshal(value)
}

func currentVersionTaskInProject(s *xorm.Session, projectID, taskID int64) (*Task, error) {
	t := &Task{}
	exists, err := routineCurrentRead(s).Where("id = ? AND project_id = ?", taskID, projectID).Get(t)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}
	return t, nil
}

func currentVersionViewInProject(s *xorm.Session, projectID, viewID int64) (*ProjectView, error) {
	v := &ProjectView{}
	exists, err := routineCurrentRead(s).Where("id = ? AND project_id = ?", viewID, projectID).Get(v)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}
	return v, nil
}

func currentVersionProjectContent(s *xorm.Session, projectID, numeric int64, kind string) (json.RawMessage, error) {
	switch kind {
	case "project":
		if numeric != projectID {
			return nil, nil
		}
		p := &Project{}
		exists, err := routineCurrentRead(s).ID(projectID).Get(p)
		return packCurrentVersionEntity(versionProjectContent{
			Title:              p.Title,
			Description:        p.Description,
			Identifier:         p.Identifier,
			HexColor:           p.HexColor,
			BackgroundFileID:   p.BackgroundFileID,
			BackgroundBlurHash: p.BackgroundBlurHash,
		}, exists, err)
	case "announcement":
		if numeric != projectID {
			return nil, nil
		}
		a := &ProjectAnnouncement{}
		exists, err := routineCurrentRead(s).ID(projectID).Get(a)
		a.Revision = 0
		a.Updated = time.Time{}
		a.UpdatedByID = 0
		return packCurrentVersionEntity(newVersionAnnouncementContent(a), exists, err)

	}
	return nil, versionError("project_version_invalid", "Unknown entity kind.")
}

func currentVersionTaskContent(s *xorm.Session, projectID, numeric int64, kind string) (json.RawMessage, error) {
	switch kind {
	case "task":
		t, err := currentVersionTaskInProject(s, projectID, numeric)
		if err != nil || t == nil {
			return nil, err
		}
		return json.Marshal(newVersionTaskContent(t))
	case "routine":
		t, err := currentVersionTaskInProject(s, projectID, numeric)
		if err != nil || t == nil {
			return nil, err
		}
		r := &TaskRoutine{}
		exists, err := routineCurrentRead(s).ID(numeric).Get(r)
		r.Revision = 0
		r.Created = time.Time{}
		r.Updated = time.Time{}
		return packCurrentVersionEntity(newVersionRoutineContent(r), exists, err)
	case "attachment":
		a := &TaskAttachment{}
		exists, err := routineCurrentRead(s).ID(numeric).Get(a)
		if err != nil || !exists {
			return nil, err
		}
		t, err := currentVersionTaskInProject(s, projectID, a.TaskID)
		if err != nil || t == nil {
			return nil, err
		}
		f := &files.File{ID: a.FileID}
		if err = f.LoadFileMetaByID(s); err != nil {
			return nil, err
		}
		return json.Marshal(versionAttachmentContent{
			ID:          a.ID,
			TaskID:      a.TaskID,
			FileID:      a.FileID,
			Name:        f.Name,
			Mime:        f.Mime,
			Size:        f.Size,
			CreatedByID: a.CreatedByID,
			Created:     a.Created,
		})
	case "reminder":
		r := &TaskReminder{}
		exists, err := routineCurrentRead(s).ID(numeric).Get(r)
		if err != nil || !exists {
			return nil, err
		}
		t, err := currentVersionTaskInProject(s, projectID, r.TaskID)
		if err != nil || t == nil {
			return nil, err
		}
		return json.Marshal(versionReminderContent{
			TaskID:         r.TaskID,
			Reminder:       r.Reminder,
			RelativePeriod: r.RelativePeriod,
			RelativeTo:     r.RelativeTo,
		})

	}
	return nil, versionError("project_version_invalid", "Unknown entity kind.")
}

func currentVersionViewContent(s *xorm.Session, projectID, numeric int64, kind string) (json.RawMessage, error) {
	switch kind {
	case "view":
		v, err := currentVersionViewInProject(s, projectID, numeric)
		if err != nil || v == nil {
			return nil, err
		}
		v.Created = time.Time{}
		v.Updated = time.Time{}
		return json.Marshal(newVersionViewContent(v))
	case "bucket":
		b := &Bucket{}
		exists, err := routineCurrentRead(s).ID(numeric).Get(b)
		if err != nil || !exists {
			return nil, err
		}
		v, err := currentVersionViewInProject(s, projectID, b.ProjectViewID)
		if err != nil || v == nil {
			return nil, err
		}
		b.Created = time.Time{}
		b.Updated = time.Time{}
		return json.Marshal(newVersionBucketContent(b))

	}
	return nil, versionError("project_version_invalid", "Unknown entity kind.")
}

func currentVersionLinkContent(s *xorm.Session, projectID int64, kind, id string) (json.RawMessage, error) {
	parts := strings.Split(id, ":")
	if len(parts) < 2 {
		return nil, versionError("project_version_invalid", "Invalid entity identity.")
	}
	taskID, _ := strconv.ParseInt(parts[0], 10, 64)
	otherID, _ := strconv.ParseInt(parts[1], 10, 64)
	t, err := currentVersionTaskInProject(s, projectID, taskID)
	if err != nil || t == nil {
		return nil, err
	}
	switch kind {
	case "assignee":
		exists, err := routineCurrentRead(s).Where("task_id = ? AND user_id = ?", taskID, otherID).Exist(new(TaskAssginee))
		return packCurrentVersionEntity(versionLinkContent{
			TaskID:  taskID,
			OtherID: otherID,
		}, exists, err)
	case "label":
		exists, err := routineCurrentRead(s).Where("task_id = ? AND label_id = ?", taskID, otherID).Exist(new(LabelTask))
		return packCurrentVersionEntity(versionLinkContent{
			TaskID:  taskID,
			OtherID: otherID,
		}, exists, err)
	case "relation":
		other, err := currentVersionTaskInProject(s, projectID, otherID)
		if err != nil || other == nil {
			return nil, err
		}
		if len(parts) != 3 {
			return nil, versionError("project_version_invalid", "Invalid relation identity.")
		}
		k := RelationKind(parts[2])
		exists, err := routineCurrentRead(s).Where("task_id = ? AND other_task_id = ? AND relation_kind = ?", taskID, otherID, k).Exist(new(TaskRelation))
		return packCurrentVersionEntity(versionLinkContent{
			TaskID:  taskID,
			OtherID: otherID,
			Kind:    k,
		}, exists, err)
	case "position":
		v, err := currentVersionViewInProject(s, projectID, otherID)
		if err != nil || v == nil {
			return nil, err
		}
		p := &TaskPosition{}
		positionExists, err := routineCurrentRead(s).Where("task_id = ? AND project_view_id = ?", taskID, otherID).Get(p)
		if err != nil {
			return nil, err
		}
		b := &TaskBucket{}
		bucketExists, err := routineCurrentRead(s).Where("task_id = ? AND project_view_id = ?", taskID, otherID).Get(b)
		return packCurrentVersionEntity(versionPlacementContent{
			TaskID:               taskID,
			ViewID:               otherID,
			BucketID:             b.BucketID,
			Position:             p.Position,
			RepeatReturnMode:     b.RepeatReturnMode,
			RepeatReturnBucketID: b.RepeatReturnBucketID,
		}, positionExists || bucketExists, err)
	}
	return nil, versionError("project_version_invalid", "Unknown entity kind.")
}

// Historical rendering uses its own project-authorized media route; removed task attachment routes cannot serve it.
// Canonical stored bytes and hashes stay immutable.
func renderSavedVersionContent(s *xorm.Session, version *ProjectVersion, kind string, content map[string]any) error {
	if kind != "task" || content == nil {
		return nil
	}
	description, ok := content["description"].(string)
	if !ok || description == "" {
		return nil
	}
	var rewriteErr error
	content["description"] = richtext.RewriteAttachmentImages(description, config.ServicePublicURL.GetString(), func(taskID, attachmentID int64) string {
		entity, exists, err := readSavedVersionEntity(s, version, "attachment", strconv.FormatInt(attachmentID, 10))
		if err != nil {
			rewriteErr = err
			return ""
		}
		if !exists {
			return ""
		}
		var attachment versionAttachmentContent
		if err = json.Unmarshal(entity.Raw, &attachment); err != nil {
			rewriteErr = err
			return ""
		}
		if attachment.TaskID != taskID {
			return ""
		}
		return fmt.Sprintf("/api/v2/projects/%d/versions/%d/files/%d", version.ProjectID, version.ID, attachment.FileID)
	}, config.ServiceAPIURL.GetString())
	return rewriteErr
}
