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
	"strconv"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/richtext"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

type projectVersionRestoreReceipt struct {
	InputHash string                       `json:"input_hash"`
	Result    *ProjectVersionRestoreResult `json:"result"`
}

func projectVersionRestoreInputHash(in ProjectVersionRestoreInput) (string, error) {
	raw, err := json.Marshal(in)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(raw)
	return hex.EncodeToString(sum[:]), nil
}

func RestoreProjectVersion(s *xorm.Session, a web.Auth, projectID, versionID int64, in ProjectVersionRestoreInput) (*ProjectVersionRestoreResult, error) {
	if level, err := initialVersionAccess(s, a, projectID); err != nil {
		return nil, err
	} else if level < int(PermissionAdmin) {
		return nil, ErrGenericForbidden{}
	}
	if !versionRequestValid(in.RequestID) || len(in.ExpectedCurrentHash) != 64 || len(in.PlanHash) != 64 {
		return nil, versionError("project_version_invalid", "Use the hashes from a fresh preview and a unique request ID.")
	}
	inputHash, err := projectVersionRestoreInputHash(in)
	if err != nil {
		return nil, err
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return nil, err
	}
	p, level, err := versionReadAccess(s, a, projectID)
	if err != nil {
		return nil, err
	}
	if level < int(PermissionAdmin) {
		return nil, ErrGenericForbidden{}
	}
	if previous, exists, err := readProjectVersionRestoreReceipt(s, a, projectID, versionID, in.RequestID, inputHash); err != nil {
		return nil, err
	} else if exists {
		return previous, nil
	}
	source, current, target, err := prepareProjectVersionRestore(s, a, p, versionID, in)
	if err != nil {
		return nil, err
	}
	before, err := saveProjectVersionSnapshot(s, a, current, versionRestoreName("Before restore", source), "before_restore", "", versionID)
	if err != nil {
		return nil, err
	}
	mapping, changed, removed, err := applyProjectVersionSnapshot(s, a, current, target)
	if err != nil {
		return nil, err
	}
	actual, err := captureProjectVersion(s, projectID)
	if err != nil {
		return nil, err
	}
	if err = verifyProjectVersionResult(s, target, actual, mapping); err != nil {
		return nil, err
	}
	restored, err := saveProjectVersionSnapshot(s, a, actual, versionRestoreName("Restored", source), "restored", in.RequestID, versionID)
	if err != nil {
		return nil, err
	}
	result := &ProjectVersionRestoreResult{
		ProjectID:             projectID,
		RestoredFromVersionID: versionID,
		BeforeVersionID:       before.ID,
		Version:               restored,
		CurrentHash:           actual.Hash,
		ChangedTaskIDs:        changed,
		RemovedTaskIDs:        removed,
		IDMap:                 mapping,
		Verified:              true,
	}
	receipt, err := json.Marshal(projectVersionRestoreReceipt{
		InputHash: inputHash,
		Result:    result,
	})
	if err != nil {
		return nil, err
	}
	if _, err = s.ID(restored.ID).Cols("restore_receipt").Update(&ProjectVersion{RestoreReceipt: string(receipt)}); err != nil {
		return nil, err
	}
	return result, nil
}
func readProjectVersionRestoreReceipt(s *xorm.Session, a web.Auth, projectID, versionID int64, requestID, inputHash string) (*ProjectVersionRestoreResult, bool, error) {
	old := &ProjectVersion{}
	exists, err := routineCurrentRead(s).Where("project_id = ? AND created_by_id = ? AND request_id = ? AND kind = ?", projectID, a.GetID(), requestID, "restored").Get(old)
	if err != nil {
		return nil, false, err
	}
	if exists {
		if old.RestoredFromVersionID != versionID || old.RestoreReceipt == "" {
			return nil, false, versionError("project_version_request_conflict", "This request ID was already used for another restore.")
		}
		var receipt projectVersionRestoreReceipt
		if err = json.Unmarshal([]byte(old.RestoreReceipt), &receipt); err != nil {
			return nil, false, err
		}
		if receipt.InputHash != inputHash || receipt.Result == nil {
			return nil, false, versionError("project_version_request_conflict", "This request ID was already used with a different restore request.")
		}
		return receipt.Result, true, nil
	}
	return nil, false, nil
}

func prepareProjectVersionRestore(s *xorm.Session, a web.Auth, p *Project, versionID int64, in ProjectVersionRestoreInput) (*ProjectVersion, *versionSnapshot, *versionSnapshot, error) {
	projectID := p.ID
	source, err := readVersionRow(s, projectID, versionID)
	if err != nil {
		return nil, nil, nil, err
	}
	if err = LockProjectViewsForTaskMutation(s, projectID); err != nil {
		return nil, nil, nil, err
	}
	current, err := captureProjectVersion(s, projectID)
	if err != nil {
		return nil, nil, nil, err
	}
	target, err := loadProjectVersionSnapshot(s, source)
	if err != nil {
		return nil, nil, nil, err
	}
	preview, err := buildProjectVersionPreview(s, a, p, current, target, versionID)
	if err != nil {
		return nil, nil, nil, err
	}
	if preview.CurrentHash != in.ExpectedCurrentHash || preview.PlanHash != in.PlanHash {
		return nil, nil, nil, versionError("project_version_stale_preview", "Project content changed after this preview. Review the new differences before restoring.")
	}
	if len(preview.Conflicts) > 0 {
		return nil, nil, nil, versionError(preview.Conflicts[0].Code, preview.Conflicts[0].Message)
	}
	if _, level, err := versionReadAccess(s, a, projectID); err != nil {
		return nil, nil, nil, err
	} else if level < int(PermissionAdmin) {
		return nil, nil, nil, ErrGenericForbidden{}
	}
	return source, current, target, nil
}

func versionMapID(mapping map[string]int64, id int64) int64 {
	if id == 0 {
		return 0
	}
	return mapping[strconv.FormatInt(id, 10)]
}
func applyProjectVersionSnapshot(s *xorm.Session, a web.Auth, current, target *versionSnapshot) (ProjectVersionIDMap, []int64, []int64, error) {
	mapping := ProjectVersionIDMap{
		Tasks:       map[string]int64{},
		Views:       map[string]int64{},
		Buckets:     map[string]int64{},
		Attachments: map[string]int64{},
	}
	entities := sortedVersionEntities(target)
	project := versionProjectContent{}
	if err := json.Unmarshal(target.Entities[versionEntityKey("project", strconv.FormatInt(target.ProjectID, 10))].Raw, &project); err != nil {
		return mapping, nil, nil, err
	}
	if err := restoreProjectVersionViews(s, target, mapping, entities); err != nil {
		return mapping, nil, nil, err
	}
	if err := restoreProjectVersionBuckets(s, a, target, mapping, entities); err != nil {
		return mapping, nil, nil, err
	}
	changed, err := restoreProjectVersionTasks(s, a, target, mapping, entities)
	if err != nil {
		return mapping, nil, nil, err
	}
	removed, err := hideProjectVersionMissingTasks(s, current, target)
	if err != nil {
		return mapping, nil, nil, err
	}
	if err = restoreProjectVersionAttachments(s, target, mapping, changed, entities); err != nil {
		return mapping, nil, nil, err
	}
	if err = restoreProjectVersionInlineMedia(s, mapping, entities); err != nil {
		return mapping, nil, nil, err
	}
	if err = restoreProjectVersionPlacements(s, current, mapping, entities); err != nil {
		return mapping, nil, nil, err
	}
	if err = restoreProjectVersionViewDefaults(s, current, target, mapping, entities); err != nil {
		return mapping, nil, nil, err
	}
	if err := restoreProjectVersionTaskDetails(s, a, target, mapping); err != nil {
		return mapping, nil, nil, err
	}
	updatedProject := &Project{
		Title:              project.Title,
		Description:        project.Description,
		Identifier:         project.Identifier,
		HexColor:           project.HexColor,
		BackgroundFileID:   project.BackgroundFileID,
		BackgroundBlurHash: project.BackgroundBlurHash,
	}
	if _, err := s.ID(target.ProjectID).Cols("title", "description", "identifier", "hex_color", "background_file_id", "background_blur_hash").Update(updatedProject); err != nil {
		return mapping, nil, nil, err
	}
	return mapping, changed, removed, nil
}
func restoreProjectVersionViews(s *xorm.Session, target *versionSnapshot, mapping ProjectVersionIDMap, entities []versionEntityData) error {
	for _, entity := range entities {
		if entity.Kind != "view" {
			continue
		}
		var view ProjectView
		if err := json.Unmarshal(entity.Raw, &view); err != nil {
			return err
		}
		sourceID := view.ID
		existing := &ProjectView{}
		exists, err := routineCurrentRead(s).ID(sourceID).Get(existing)
		if err != nil {
			return err
		}
		if exists && existing.ProjectID != target.ProjectID {
			return versionError("project_version_view_moved", "A saved view identity now belongs to another project.")
		}
		view.ProjectID = target.ProjectID
		view.DefaultBucketID = 0
		view.DoneBucketID = 0
		if exists {
			if _, err = s.ID(sourceID).Cols("title", "view_kind", "filter", "position", "bucket_configuration_mode", "bucket_configuration", "default_bucket_id", "done_bucket_id").Update(&view); err != nil {
				return err
			}
		} else {
			view.ID = 0
			if _, err = s.Insert(&view); err != nil {
				return err
			}
		}
		mapping.Views[entity.ID] = view.ID
	}
	return nil
}

func restoreProjectVersionBuckets(s *xorm.Session, a web.Auth, target *versionSnapshot, mapping ProjectVersionIDMap, entities []versionEntityData) error {
	for _, entity := range entities {
		if entity.Kind != "bucket" {
			continue
		}
		var bucket Bucket
		if err := json.Unmarshal(entity.Raw, &bucket); err != nil {
			return err
		}
		sourceID := bucket.ID
		savedViewID := bucket.ProjectViewID
		bucket.ProjectViewID = versionMapID(mapping.Views, bucket.ProjectViewID)
		if bucket.ProjectViewID == 0 {
			return versionError("project_version_corrupt", "Saved bucket has no saved view.")
		}
		existing := &Bucket{}
		exists, err := routineCurrentRead(s).ID(sourceID).Get(existing)
		if err != nil {
			return err
		}
		if exists {
			available, err := projectVersionBucketIdentityAvailable(s, target, existing, savedViewID)
			if err != nil {
				return err
			}
			if !available {
				return versionError("project_version_bucket_moved", "A saved bucket identity now belongs to another project.")
			}
			if _, err = s.ID(sourceID).Cols("title", "project_view_id", "limit", "position").Update(&bucket); err != nil {
				return err
			}
		} else {
			bucket.ID = 0
			bucket.CreatedByID = a.GetID()
			if _, err = s.Insert(&bucket); err != nil {
				return err
			}
		}
		mapping.Buckets[entity.ID] = bucket.ID
	}
	return nil
}

func restoreProjectVersionTasks(s *xorm.Session, a web.Auth, target *versionSnapshot, mapping ProjectVersionIDMap, entities []versionEntityData) ([]int64, error) {
	changed := []int64{}
	for _, entity := range entities {
		if entity.Kind != "task" {
			continue
		}
		var content versionTaskContent
		if err := json.Unmarshal(entity.Raw, &content); err != nil {
			return nil, err
		}
		task := content.task()
		sourceID := task.ID
		existing := &Task{}
		exists, err := routineCurrentRead(s).Unscoped().ID(sourceID).Get(existing)
		if err != nil {
			return nil, err
		}
		if exists && existing.ProjectID != target.ProjectID {
			return nil, versionError("project_version_task_moved", "A saved task now belongs to another project.")
		}
		if err = validateTaskForCreation(&task); err != nil {
			return nil, err
		}
		task.ProjectID = target.ProjectID
		task.CoverImageAttachmentID = 0
		if exists {
			task.ID = sourceID
			task.Created = existing.Created
			task.CreatedByID = existing.CreatedByID
			task.Index = existing.Index
			task.UID = existing.UID
			if _, err = s.Unscoped().ID(task.ID).Cols("title", "description", "done", "done_at", "due_date", "repeat_after", "repeat_mode", "priority", "start_date", "end_date", "all_day", "all_day_start", "all_day_end", "hex_color", "percent_done", "cover_image_attachment_id").Update(&task); err != nil {
				return nil, err
			}
			if _, err = s.Unscoped().Table(new(Task)).Where("id = ?", task.ID).Update(map[string]any{"deleted_at": nil}); err != nil {
				return nil, err
			}
		} else {
			// The global identity is genuinely absent. Reusing it preserves task
			// URLs and literal links/filters that cannot safely be guessed and
			// rewritten. A concurrent insertion still fails the unique key and
			// rolls back the complete restore.
			task.ID = sourceID
			task.CreatedByID = a.GetID()
			creatorExists, creatorErr := s.ID(content.CreatorID).Exist(new(user.User))
			if creatorErr != nil {
				return nil, creatorErr
			}
			if creatorExists {
				task.CreatedByID = content.CreatorID
			}
			task.UID = content.CalendarUID
			if task.Created.IsZero() {
				task.Created = time.Now()
			}
			task.Updated = time.Now()
			task.Index, err = reserveTaskIndexes(s, target.ProjectID, 1)
			if err != nil {
				return nil, err
			}
			if _, err = s.NoAutoTime().Insert(&task); err != nil {
				return nil, err
			}
		}
		mapping.Tasks[entity.ID] = task.ID
		changed = append(changed, task.ID)
	}
	return changed, nil
}

func hideProjectVersionMissingTasks(s *xorm.Session, current, target *versionSnapshot) ([]int64, error) {
	removed := []int64{}
	for _, id := range current.TaskIDs {
		if _, present := target.Entities[versionEntityKey("task", strconv.FormatInt(id, 10))]; present {
			continue
		}
		if _, err := s.ID(id).Delete(new(Task)); err != nil {
			return nil, err
		}
		removed = append(removed, id)
	}
	return removed, nil
}

func restoreProjectVersionAttachments(s *xorm.Session, target *versionSnapshot, mapping ProjectVersionIDMap, changed []int64, entities []versionEntityData) error {
	// Attachments needed by retained comments keep their relationship as well as their original file.
	// A checkpoint can revive a currently soft-deleted task. Its later comments
	// and attachment rows are absent from the active-content snapshot, so inspect
	// the restored task scope directly rather than only current.Entities.
	keptByComments, err := projectVersionCommentAttachments(s, target.ProjectID, target.TaskIDs)
	if err != nil {
		return err
	}
	for _, entity := range entities {
		if entity.Kind != "attachment" {
			continue
		}
		var content versionAttachmentContent
		if err := json.Unmarshal(entity.Raw, &content); err != nil {
			return err
		}
		taskID := versionMapID(mapping.Tasks, content.TaskID)
		attachment := &TaskAttachment{}
		exists, err := routineCurrentRead(s).Where("task_id = ? AND file_id = ?", taskID, content.FileID).OrderBy("id").Get(attachment)
		if err != nil {
			return err
		}
		if !exists {
			attachment = &TaskAttachment{
				TaskID:      taskID,
				FileID:      content.FileID,
				CreatedByID: content.CreatedByID,
			}
			if _, err = s.Insert(attachment); err != nil {
				return err
			}
		}
		mapping.Attachments[entity.ID] = attachment.ID
	}
	if len(changed) > 0 {
		attachments := []*TaskAttachment{}
		if err = routineCurrentRead(s).In("task_id", changed).Find(&attachments); err != nil {
			return err
		}
		neededAttachments := make(map[int64]bool, len(mapping.Attachments))
		for _, id := range mapping.Attachments {
			neededAttachments[id] = true
		}
		for _, attachment := range attachments {
			if keptByComments[attachment.ID] || neededAttachments[attachment.ID] {
				continue
			}
			if _, err := s.ID(attachment.ID).Delete(new(TaskAttachment)); err != nil {
				return err
			}
		}
	}
	return nil
}

func restoreProjectVersionInlineMedia(s *xorm.Session, mapping ProjectVersionIDMap, entities []versionEntityData) error {
	for _, entity := range entities {
		if entity.Kind != "task" {
			continue
		}
		var content versionTaskContent
		if err := json.Unmarshal(entity.Raw, &content); err != nil {
			return err
		}
		taskID := mapping.Tasks[entity.ID]
		description := richtext.RewriteAttachmentImages(content.Description, config.ServicePublicURL.GetString(), func(tid, aid int64) string {
			mappedTask := versionMapID(mapping.Tasks, tid)
			mappedAttachment := versionMapID(mapping.Attachments, aid)
			if mappedTask == 0 || mappedAttachment == 0 {
				return ""
			}
			return fmt.Sprintf("/api/v2/tasks/%d/attachments/%d", mappedTask, mappedAttachment)
		}, config.ServiceAPIURL.GetString())
		coverID := versionMapID(mapping.Attachments, content.CoverImageAttachmentID)
		if _, err := s.ID(taskID).Cols("description", "cover_image_attachment_id").Update(&Task{
			Description:            description,
			CoverImageAttachmentID: coverID,
		}); err != nil {
			return err
		}
	}
	return nil
}

func restoreProjectVersionPlacements(s *xorm.Session, current *versionSnapshot, mapping ProjectVersionIDMap, entities []versionEntityData) error {
	oldViews := []int64{}
	for _, entity := range sortedVersionEntities(current) {
		if entity.Kind == "view" {
			id, _ := strconv.ParseInt(entity.ID, 10, 64)
			oldViews = append(oldViews, id)
		}
	}
	if len(oldViews) > 0 {
		for _, model := range []any{
			new(TaskPosition),
			new(TaskBucket),
		} {
			if _, err := s.In("project_view_id", oldViews).Delete(model); err != nil {
				return err
			}
		}
	}
	for _, entity := range entities {
		if entity.Kind != "position" {
			continue
		}
		var content versionPlacementContent
		if err := json.Unmarshal(entity.Raw, &content); err != nil {
			return err
		}
		taskID, viewID := versionMapID(mapping.Tasks, content.TaskID), versionMapID(mapping.Views, content.ViewID)
		if taskID == 0 || viewID == 0 {
			return versionError("project_version_corrupt", "A saved placement has no saved task or view.")
		}
		if _, err := s.Insert(&TaskPosition{
			TaskID:        taskID,
			ProjectViewID: viewID,
			Position:      content.Position,
		}); err != nil {
			return err
		}
		if content.BucketID > 0 {
			bucketID := versionMapID(mapping.Buckets, content.BucketID)
			if bucketID == 0 {
				return versionError("project_version_corrupt", "A saved placement has no saved bucket.")
			}
			if _, err := s.Insert(&TaskBucket{
				TaskID:               taskID,
				ProjectViewID:        viewID,
				BucketID:             bucketID,
				RepeatReturnMode:     content.RepeatReturnMode,
				RepeatReturnBucketID: versionMapID(mapping.Buckets, content.RepeatReturnBucketID),
			}); err != nil {
				return err
			}
		}
	}
	return nil
}

func restoreProjectVersionViewDefaults(s *xorm.Session, current, target *versionSnapshot, mapping ProjectVersionIDMap, entities []versionEntityData) error {
	for _, entity := range entities {
		if entity.Kind != "view" {
			continue
		}
		var view ProjectView
		if err := json.Unmarshal(entity.Raw, &view); err != nil {
			return err
		}
		view.ID = mapping.Views[entity.ID]
		view.DefaultBucketID = versionMapID(mapping.Buckets, view.DefaultBucketID)
		view.DoneBucketID = versionMapID(mapping.Buckets, view.DoneBucketID)
		if _, err := s.ID(view.ID).Cols("default_bucket_id", "done_bucket_id").Update(&view); err != nil {
			return err
		}
	}
	for _, entity := range sortedVersionEntities(current) {
		if entity.Kind == "bucket" {
			if _, keep := target.Entities[versionEntityKey("bucket", entity.ID)]; !keep {
				id, _ := strconv.ParseInt(entity.ID, 10, 64)
				if _, err := s.ID(id).Delete(new(Bucket)); err != nil {
					return err
				}
			}
		}
		if entity.Kind == "view" {
			if _, keep := target.Entities[versionEntityKey("view", entity.ID)]; !keep {
				id, _ := strconv.ParseInt(entity.ID, 10, 64)
				if _, err := s.ID(id).Delete(new(ProjectView)); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func restoreProjectVersionTaskDetails(s *xorm.Session, a web.Auth, target *versionSnapshot, mapping ProjectVersionIDMap) error {
	liveIDs := []int64{}
	for _, id := range mapping.Tasks {
		liveIDs = append(liveIDs, id)
	}
	if err := clearProjectVersionTaskLinks(s, liveIDs); err != nil {
		return err
	}
	haveRoutines := map[int64]bool{}
	for _, entity := range sortedVersionEntities(target) {
		switch entity.Kind {
		case "assignee", "label", "relation":
			if err := restoreProjectVersionLink(s, a, entity, mapping); err != nil {
				return err
			}
		case "reminder":
			if err := restoreProjectVersionReminder(s, entity, mapping); err != nil {
				return err
			}
		case "routine":
			id, err := restoreProjectVersionRoutine(s, entity, mapping)
			if err != nil {
				return err
			}
			haveRoutines[id] = true
		}
	}
	if err := pauseProjectVersionMissingRoutines(s, liveIDs, haveRoutines); err != nil {
		return err
	}
	return restoreProjectVersionAnnouncement(s, a, target)
}

func clearProjectVersionTaskLinks(s *xorm.Session, liveIDs []int64) error {
	if len(liveIDs) > 0 {
		for _, model := range []any{
			new(TaskAssginee),
			new(LabelTask),
			new(TaskReminder),
		} {
			if _, err := s.In("task_id", liveIDs).Delete(model); err != nil {
				return err
			}
		}
		if _, err := s.Where(builder.And(builder.In("task_id", liveIDs), builder.In("other_task_id", liveIDs))).Delete(new(TaskRelation)); err != nil {
			return err
		}
	}
	return nil
}

func restoreProjectVersionLink(s *xorm.Session, a web.Auth, entity versionEntityData, mapping ProjectVersionIDMap) error {
	var content versionLinkContent
	if err := json.Unmarshal(entity.Raw, &content); err != nil {
		return err
	}
	taskID := versionMapID(mapping.Tasks, content.TaskID)
	if taskID == 0 {
		return versionError("project_version_corrupt", "A saved relationship has no saved task.")
	}
	var value any
	switch entity.Kind {
	case "assignee":
		value = &TaskAssginee{
			TaskID: taskID,
			UserID: content.OtherID,
		}
	case "label":
		label := &Label{}
		exists, err := s.ID(content.OtherID).Get(label)
		if err != nil {
			return err
		}
		if !exists {
			return versionError("project_version_label_missing", "A saved label no longer exists.")
		}
		value = &LabelTask{
			TaskID:  taskID,
			LabelID: content.OtherID,
		}
	case "relation":
		otherID := versionMapID(mapping.Tasks, content.OtherID)
		if otherID == 0 {
			return versionError("project_version_corrupt", "A saved task relationship has no saved other task.")
		}
		value = &TaskRelation{
			TaskID:       taskID,
			OtherTaskID:  otherID,
			RelationKind: content.Kind,
			CreatedByID:  a.GetID(),
		}
	}
	if _, err := s.Insert(value); err != nil {
		return err
	}
	return nil
}

func restoreProjectVersionReminder(s *xorm.Session, entity versionEntityData, mapping ProjectVersionIDMap) error {
	var content versionReminderContent
	if err := json.Unmarshal(entity.Raw, &content); err != nil {
		return err
	}
	if _, err := s.Insert(&TaskReminder{
		TaskID:         versionMapID(mapping.Tasks, content.TaskID),
		Reminder:       content.Reminder,
		RelativePeriod: content.RelativePeriod,
		RelativeTo:     content.RelativeTo,
	}); err != nil {
		return err
	}
	return nil
}

func restoreProjectVersionRoutine(s *xorm.Session, entity versionEntityData, mapping ProjectVersionIDMap) (int64, error) {
	var routine TaskRoutine
	if err := json.Unmarshal(entity.Raw, &routine); err != nil {
		return 0, err
	}
	routine.TaskID = versionMapID(mapping.Tasks, routine.TaskID)
	previous := &TaskRoutine{}
	exists, err := routineCurrentRead(s).ID(routine.TaskID).Get(previous)
	if err != nil {
		return 0, err
	}
	routine.Revision = previous.Revision + 1
	if exists {
		if _, err = s.ID(routine.TaskID).Cols("enabled", "paused", "timezone", "revision", "period", "reset_hour", "reset_minute", "week_start", "month_day", "target", "unit").Update(&routine); err != nil {
			return 0, err
		}
	} else {
		if _, err = s.Insert(&routine); err != nil {
			return 0, err
		}
	}
	return routine.TaskID, nil
}

func pauseProjectVersionMissingRoutines(s *xorm.Session, liveIDs []int64, haveRoutines map[int64]bool) error {
	for _, id := range liveIDs {
		if !haveRoutines[id] {
			routine := &TaskRoutine{}
			exists, err := routineCurrentRead(s).ID(id).Get(routine)
			if err != nil {
				return err
			}
			if exists {
				routine.Enabled = false
				routine.Paused = true
				routine.Revision++
				if _, err = s.ID(id).Cols("enabled", "paused", "revision").Update(routine); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func restoreProjectVersionAnnouncement(s *xorm.Session, a web.Auth, target *versionSnapshot) error {
	previous := &ProjectAnnouncement{}
	exists, err := routineCurrentRead(s).ID(target.ProjectID).Get(previous)
	if err != nil {
		return err
	}
	announcement := &ProjectAnnouncement{
		ProjectID:   target.ProjectID,
		Revision:    previous.Revision + 1,
		UpdatedByID: a.GetID(),
	}
	if entity, present := target.Entities[versionEntityKey("announcement", strconv.FormatInt(target.ProjectID, 10))]; present {
		var saved ProjectAnnouncement
		if err = json.Unmarshal(entity.Raw, &saved); err != nil {
			return err
		}
		announcement.Title = saved.Title
		announcement.Content = saved.Content
	}
	if exists {
		_, err = s.ID(target.ProjectID).Cols("title", "content", "revision", "updated_by_id").Update(announcement)
	} else if announcement.Title != "" || announcement.Content != "" {
		_, err = s.Insert(announcement)
	}
	return err
}

func versionRestoreName(prefix string, source *ProjectVersion) string {
	r := []rune(fmt.Sprintf("%s · #%d · %s", prefix, source.Sequence, source.Name))
	if len(r) > 160 {
		r = r[:160]
	}
	return string(r)
}
