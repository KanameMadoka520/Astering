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

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/richtext"
	"xorm.io/xorm"
)

// verifyProjectVersionResult compares every saved content entity after identity mapping.
// Immutable attribution/indexes, shared original metadata, CAS clocks and retained facts are not rolled back.
func verifyProjectVersionResult(s *xorm.Session, target, actual *versionSnapshot, mapping ProjectVersionIDMap) error {
	if len(actual.TaskIDs) != len(target.TaskIDs) {
		return versionError("project_version_verification", "Restored task membership does not match the checkpoint.")
	}
	expected := map[string]int{}
	actualValues := map[string]int{}
	for _, entity := range sortedVersionEntities(target) {
		value, err := projectVersionSemanticEntity(entity, &mapping)
		if err != nil {
			return err
		}
		expected[value]++
	}
	protectedAttachments := map[int64]bool{}
	if len(actual.TaskIDs) > 0 {
		comments := []*TaskComment{}
		if err := routineCurrentRead(s).In("task_id", actual.TaskIDs).Find(&comments); err != nil {
			return err
		}
		for _, comment := range comments {
			_ = richtext.FilterAttachmentImages(comment.Comment, config.ServicePublicURL.GetString(), func(taskID, attachmentID int64) bool {
				if taskID == comment.TaskID {
					protectedAttachments[attachmentID] = true
				}
				return false
			}, config.ServiceAPIURL.GetString())
		}
	}
	for _, entity := range sortedVersionEntities(actual) {
		value, err := projectVersionSemanticEntity(entity, nil)
		if err != nil {
			return err
		}
		if expected[value] > actualValues[value] {
			actualValues[value]++
			continue
		}
		switch entity.Kind {
		case "attachment":
			var attachment versionAttachmentContent
			if err = json.Unmarshal(entity.Raw, &attachment); err != nil {
				return err
			}
			if protectedAttachments[attachment.ID] {
				continue
			}
		case "routine":
			var routine TaskRoutine
			if err = json.Unmarshal(entity.Raw, &routine); err != nil {
				return err
			}
			sourceID := ""
			for old, id := range mapping.Tasks {
				if id == routine.TaskID {
					sourceID = old
					break
				}
			}
			if _, had := target.Entities[versionEntityKey("routine", sourceID)]; !had && !routine.Enabled && routine.Paused {
				continue
			}
		case "announcement":
			var announcement ProjectAnnouncement
			if err = json.Unmarshal(entity.Raw, &announcement); err != nil {
				return err
			}
			if _, had := target.Entities[versionEntityKey("announcement", strconv.FormatInt(target.ProjectID, 10))]; !had && announcement.Title == "" && announcement.Content == "" {
				continue
			}
		}
		return versionError("project_version_verification", fmt.Sprintf("Restored %s content differs from the reviewed checkpoint.", entity.Kind))
	}
	for value, count := range expected {
		if actualValues[value] != count {
			return versionError("project_version_verification", "A saved content entity was not restored completely.")
		}
	}
	return nil
}
func projectVersionSemanticEntity(entity versionEntityData, mapping *ProjectVersionIDMap) (string, error) {
	value := map[string]any{}
	if err := json.Unmarshal(entity.Raw, &value); err != nil {
		return "", err
	}
	remap := func(key string, ids map[string]int64) {
		number, ok := value[key].(float64)
		if !ok || number == 0 {
			return
		}
		value[key] = float64(versionMapID(ids, int64(number)))
	}
	if mapping != nil {
		switch entity.Kind {
		case "task":
			remap("id", mapping.Tasks)
			remap("cover_image_attachment_id", mapping.Attachments)
			if description, ok := value["description"].(string); ok {
				value["description"] = richtext.RewriteAttachmentImages(description, config.ServicePublicURL.GetString(), func(taskID, attachmentID int64) string {
					tid, aid := versionMapID(mapping.Tasks, taskID), versionMapID(mapping.Attachments, attachmentID)
					if tid == 0 || aid == 0 {
						return ""
					}
					return fmt.Sprintf("/api/v2/tasks/%d/attachments/%d", tid, aid)
				}, config.ServiceAPIURL.GetString())
			}
		case "view":
			remap("id", mapping.Views)
			remap("default_bucket_id", mapping.Buckets)
			remap("done_bucket_id", mapping.Buckets)
		case "bucket":
			remap("id", mapping.Buckets)
			remap("project_view_id", mapping.Views)
		case "attachment":
			remap("id", mapping.Attachments)
			remap("task_id", mapping.Tasks)
		case "position":
			remap("task_id", mapping.Tasks)
			remap("view_id", mapping.Views)
			remap("bucket_id", mapping.Buckets)
			remap("repeat_return_bucket_id", mapping.Buckets)
		case "routine", "assignee", "label", "reminder", "relation":
			remap("task_id", mapping.Tasks)
			if entity.Kind == "relation" {
				remap("other_id", mapping.Tasks)
			}
		}
	}
	for _, key := range []string{
		"created",
		"updated",
		"created_by",
		"creator_id",
		"created_by_id",
		"calendar_uid",
		"revision",
		"updated_by",
		"updated_by_id",
	} {
		delete(value, key)
	}
	if entity.Kind == "task" {
		delete(value, "index")
	}
	if entity.Kind == "attachment" {
		for _, key := range []string{
			"name",
			"mime",
			"size",
		} {
			delete(value, key)
		}
	}
	raw, err := json.Marshal(value)
	return entity.Kind + "\x00" + string(raw), err
}

func projectVersionCommentAttachments(s *xorm.Session, projectID int64, taskIDs []int64) (map[int64]bool, error) {
	result := map[int64]bool{}
	if len(taskIDs) == 0 {
		return result, nil
	}
	// A historically saved task may now belong to another project. Do not
	// even read its later comment body through the former project's history.
	var scopedIDs []int64
	if err := routineCurrentRead(s).Unscoped().Table(new(Task)).Cols("id").In("id", taskIDs).And("project_id = ?", projectID).Find(&scopedIDs); err != nil {
		return nil, err
	}
	if len(scopedIDs) == 0 {
		return result, nil
	}
	comments := []*TaskComment{}
	if err := routineCurrentRead(s).In("task_id", scopedIDs).Find(&comments); err != nil {
		return nil, err
	}
	attachmentTasks := map[int64]int64{}
	for _, comment := range comments {
		_ = richtext.FilterAttachmentImages(comment.Comment, config.ServicePublicURL.GetString(), func(taskID, attachmentID int64) bool {
			if taskID == comment.TaskID {
				attachmentTasks[attachmentID] = taskID
			}
			return false
		}, config.ServiceAPIURL.GetString())
	}
	if len(attachmentTasks) == 0 {
		return result, nil
	}
	attachmentIDs := make([]int64, 0, len(attachmentTasks))
	for id := range attachmentTasks {
		attachmentIDs = append(attachmentIDs, id)
	}
	attachments := []*TaskAttachment{}
	if err := routineCurrentRead(s).In("id", attachmentIDs).In("task_id", scopedIDs).Find(&attachments); err != nil {
		return nil, err
	}
	for _, attachment := range attachments {
		if attachmentTasks[attachment.ID] == attachment.TaskID {
			result[attachment.ID] = true
		}
	}
	return result, nil
}
