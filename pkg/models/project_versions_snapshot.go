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
	"bytes"
	"compress/gzip"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

const projectVersionSchema = 1

type versionProjectContent struct {
	Title              string `json:"title"`
	Description        string `json:"description"`
	Identifier         string `json:"identifier"`
	HexColor           string `json:"hex_color"`
	BackgroundFileID   int64  `json:"background_file_id"`
	BackgroundBlurHash string `json:"background_blur_hash"`
}
type versionAttachmentContent struct {
	ID          int64     `json:"id"`
	TaskID      int64     `json:"task_id"`
	FileID      int64     `json:"file_id"`
	Name        string    `json:"name"`
	Mime        string    `json:"mime"`
	Size        uint64    `json:"size"`
	CreatedByID int64     `json:"created_by_id"`
	Created     time.Time `json:"created"`
}
type versionPlacementContent struct {
	TaskID               int64   `json:"task_id"`
	ViewID               int64   `json:"view_id"`
	BucketID             int64   `json:"bucket_id"`
	Position             float64 `json:"position"`
	RepeatReturnMode     string  `json:"repeat_return_mode"`
	RepeatReturnBucketID int64   `json:"repeat_return_bucket_id"`
}
type versionTaskContent struct {
	ID                     int64          `json:"id"`
	Title                  string         `json:"title"`
	Description            string         `json:"description"`
	ProjectID              int64          `json:"project_id"`
	Done                   bool           `json:"done"`
	DoneAt                 time.Time      `json:"done_at"`
	DueDate                time.Time      `json:"due_date"`
	RepeatAfter            int64          `json:"repeat_after"`
	RepeatMode             TaskRepeatMode `json:"repeat_mode"`
	Priority               int64          `json:"priority"`
	StartDate              time.Time      `json:"start_date"`
	EndDate                time.Time      `json:"end_date"`
	AllDay                 bool           `json:"all_day"`
	AllDayStart            string         `json:"all_day_start"`
	AllDayEnd              string         `json:"all_day_end"`
	HexColor               string         `json:"hex_color"`
	PercentDone            float64        `json:"percent_done"`
	Index                  int64          `json:"index"`
	CoverImageAttachmentID int64          `json:"cover_image_attachment_id"`
	Created                time.Time      `json:"created"`
	CreatorID              int64          `json:"creator_id"`
	CalendarUID            string         `json:"calendar_uid"`
}

func newVersionTaskContent(t *Task) versionTaskContent {
	return versionTaskContent{
		ID:                     t.ID,
		Title:                  t.Title,
		Description:            t.Description,
		ProjectID:              t.ProjectID,
		Done:                   t.Done,
		DoneAt:                 t.DoneAt,
		DueDate:                t.DueDate,
		RepeatAfter:            t.RepeatAfter,
		RepeatMode:             t.RepeatMode,
		Priority:               t.Priority,
		StartDate:              t.StartDate,
		EndDate:                t.EndDate,
		AllDay:                 t.AllDay,
		AllDayStart:            t.AllDayStart,
		AllDayEnd:              t.AllDayEnd,
		HexColor:               t.HexColor,
		PercentDone:            t.PercentDone,
		Index:                  t.Index,
		CoverImageAttachmentID: t.CoverImageAttachmentID,
		Created:                t.Created,
		CreatorID:              t.CreatedByID,
		CalendarUID:            t.UID,
	}
}
func (c versionTaskContent) task() Task {
	return Task{
		ID:                     c.ID,
		Title:                  c.Title,
		Description:            c.Description,
		ProjectID:              c.ProjectID,
		Done:                   c.Done,
		DoneAt:                 c.DoneAt,
		DueDate:                c.DueDate,
		RepeatAfter:            c.RepeatAfter,
		RepeatMode:             c.RepeatMode,
		Priority:               c.Priority,
		StartDate:              c.StartDate,
		EndDate:                c.EndDate,
		AllDay:                 c.AllDay,
		AllDayStart:            c.AllDayStart,
		AllDayEnd:              c.AllDayEnd,
		HexColor:               c.HexColor,
		PercentDone:            c.PercentDone,
		Index:                  c.Index,
		CoverImageAttachmentID: c.CoverImageAttachmentID,
		Created:                c.Created,
		CreatedByID:            c.CreatorID,
		UID:                    c.CalendarUID,
	}
}

type versionLinkContent struct {
	TaskID  int64        `json:"task_id"`
	OtherID int64        `json:"other_id"`
	Kind    RelationKind `json:"relation_kind,omitempty"`
}
type versionReminderContent struct {
	TaskID         int64            `json:"task_id"`
	Reminder       time.Time        `json:"reminder"`
	RelativePeriod int64            `json:"relative_period"`
	RelativeTo     ReminderRelation `json:"relative_to"`
}

func versionEntityKey(kind, id string) string { return kind + "/" + id }
func newVersionSnapshot(projectID int64) *versionSnapshot {
	return &versionSnapshot{
		ProjectID: projectID,
		Entities:  map[string]versionEntityData{},
		Files:     map[int64]bool{},
		TaskIDs:   []int64{},
	}
}
func (snapshot *versionSnapshot) add(kind, id, title string, value any) error {
	raw, err := json.Marshal(value)
	if err != nil {
		return err
	}
	sum := sha256.Sum256(append([]byte(kind+"\x00"), raw...))
	snapshot.Entities[versionEntityKey(kind, id)] = versionEntityData{
		Kind:  kind,
		ID:    id,
		Title: title,
		Raw:   raw,
		Hash:  hex.EncodeToString(sum[:]),
	}
	return nil
}
func (snapshot *versionSnapshot) finish() {
	keys := make([]string, 0, len(snapshot.Entities))
	for key := range snapshot.Entities {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	hash := sha256.New()
	fmt.Fprintf(hash, "astering-project-version:%d\n", projectVersionSchema)
	for _, key := range keys {
		entity := snapshot.Entities[key]
		fmt.Fprintf(hash, "%s\x00%s\n", key, entity.Hash)
	}
	snapshot.Hash = hex.EncodeToString(hash.Sum(nil))
}

// No comments, routine facts, permissions, per-user preferences or changing timestamps enter this whitelist.
func captureProjectVersion(s *xorm.Session, projectID int64) (*versionSnapshot, error) {
	p := &Project{}
	exists, err := routineCurrentRead(s).ID(projectID).Get(p)
	if err == nil && !exists {
		err = ErrProjectDoesNotExist{ID: projectID}
	}
	if err != nil {
		return nil, err
	}
	snapshot := newVersionSnapshot(projectID)
	if err = snapshot.add("project", strconv.FormatInt(projectID, 10), p.Title, versionProjectContent{
		Title:              p.Title,
		Description:        p.Description,
		Identifier:         p.Identifier,
		HexColor:           p.HexColor,
		BackgroundFileID:   p.BackgroundFileID,
		BackgroundBlurHash: p.BackgroundBlurHash,
	}); err != nil {
		return nil, err
	}
	if p.BackgroundFileID > 0 {
		snapshot.Files[p.BackgroundFileID] = true
	}
	tasks := []*Task{}
	if err = sharedVersionRows(s, "tasks", builder.And(builder.Eq{"project_id": projectID}, builder.IsNull{"deleted_at"}), "id", &tasks); err != nil {
		return nil, err
	}
	for _, task := range tasks {
		snapshot.TaskIDs = append(snapshot.TaskIDs, task.ID)
		content := newVersionTaskContent(task)
		if err = snapshot.add("task", strconv.FormatInt(task.ID, 10), task.Title, content); err != nil {
			return nil, err
		}
	}
	if err = captureVersionViews(s, snapshot); err != nil {
		return nil, err
	}
	if err = captureVersionAnnouncement(s, snapshot); err != nil {
		return nil, err
	}
	if len(snapshot.TaskIDs) > 0 {
		if err = captureVersionAttachments(s, snapshot); err != nil {
			return nil, err
		}
		if err = captureVersionTaskDetails(s, snapshot); err != nil {
			return nil, err
		}
	}
	snapshot.finish()
	return snapshot, nil
}

func captureVersionViews(s *xorm.Session, snapshot *versionSnapshot) error {
	var err error
	views := []*ProjectView{}
	if err = sharedVersionRows(s, "project_views", builder.Eq{"project_id": snapshot.ProjectID}, "id", &views); err != nil {
		return err
	}
	viewIDs := []int64{}
	for _, view := range views {
		viewIDs = append(viewIDs, view.ID)
		view.Created = time.Time{}
		view.Updated = time.Time{}
		if err = snapshot.add("view", strconv.FormatInt(view.ID, 10), view.Title, newVersionViewContent(view)); err != nil {
			return err
		}
	}
	if len(viewIDs) > 0 {
		buckets := []*Bucket{}
		if err = sharedVersionRows(s, "buckets", builder.In("project_view_id", viewIDs), "id", &buckets); err != nil {
			return err
		}
		for _, bucket := range buckets {
			bucket.Created = time.Time{}
			bucket.Updated = time.Time{}
			if err = snapshot.add("bucket", strconv.FormatInt(bucket.ID, 10), bucket.Title, newVersionBucketContent(bucket)); err != nil {
				return err
			}
		}
		positions := []*TaskPosition{}
		if err = sharedVersionRows(s, "task_positions", builder.In("project_view_id", viewIDs), "task_id, project_view_id", &positions); err != nil {
			return err
		}
		bucketsByTask := []*TaskBucket{}
		if err = sharedVersionRows(s, "task_buckets", builder.In("project_view_id", viewIDs), "task_id, project_view_id", &bucketsByTask); err != nil {
			return err
		}
		placements := map[string]*versionPlacementContent{}
		for _, position := range positions {
			key := fmt.Sprintf("%d:%d", position.TaskID, position.ProjectViewID)
			placements[key] = &versionPlacementContent{
				TaskID:   position.TaskID,
				ViewID:   position.ProjectViewID,
				Position: position.Position,
			}
		}
		for _, bucket := range bucketsByTask {
			key := fmt.Sprintf("%d:%d", bucket.TaskID, bucket.ProjectViewID)
			placement := placements[key]
			if placement == nil {
				placement = &versionPlacementContent{
					TaskID: bucket.TaskID,
					ViewID: bucket.ProjectViewID,
				}
				placements[key] = placement
			}
			placement.BucketID = bucket.BucketID
			placement.RepeatReturnMode = bucket.RepeatReturnMode
			placement.RepeatReturnBucketID = bucket.RepeatReturnBucketID
		}
		taskSet := map[int64]bool{}
		for _, id := range snapshot.TaskIDs {
			taskSet[id] = true
		}
		for key, placement := range placements {
			if taskSet[placement.TaskID] {
				if err = snapshot.add("position", key, "", placement); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

func captureVersionAnnouncement(s *xorm.Session, snapshot *versionSnapshot) error {
	var err error
	announcement := &ProjectAnnouncement{}
	announcements := []*ProjectAnnouncement{}
	err = sharedVersionRows(s, "project_announcements", builder.Eq{"project_id": snapshot.ProjectID}, "project_id", &announcements)
	exists := len(announcements) > 0
	if exists {
		announcement = announcements[0]
	}
	if err != nil {
		return err
	}
	if exists {
		announcement.Revision = 0
		announcement.Updated = time.Time{}
		announcement.UpdatedByID = 0
		if err = snapshot.add("announcement", strconv.FormatInt(snapshot.ProjectID, 10), announcement.Title, newVersionAnnouncementContent(announcement)); err != nil {
			return err
		}
	}
	return nil
}

func captureVersionAttachments(s *xorm.Session, snapshot *versionSnapshot) error {
	var err error

	attachments := []*TaskAttachment{}
	if err = sharedVersionRows(s, "task_attachments", builder.In("task_id", snapshot.TaskIDs), "id", &attachments); err != nil {
		return err
	}
	fileIDs := []int64{}
	for _, attachment := range attachments {
		fileIDs = append(fileIDs, attachment.FileID)
	}
	originals := []*files.File{}
	if len(fileIDs) > 0 {
		if err = s.In("id", fileIDs).OrderBy("id").Find(&originals); err != nil {
			return err
		}
	}
	originalByID := map[int64]*files.File{}
	for _, f := range originals {
		originalByID[f.ID] = f
	}
	for _, attachment := range attachments {
		f := originalByID[attachment.FileID]
		if f == nil {
			return versionError("project_version_file_missing", "An attached original file is missing.")
		}
		snapshot.Files[f.ID] = true
		content := versionAttachmentContent{
			ID:          attachment.ID,
			TaskID:      attachment.TaskID,
			FileID:      f.ID,
			Name:        f.Name,
			Mime:        f.Mime,
			Size:        f.Size,
			CreatedByID: attachment.CreatedByID,
			Created:     attachment.Created,
		}
		if err = snapshot.add("attachment", strconv.FormatInt(attachment.ID, 10), f.Name, content); err != nil {
			return err
		}
	}
	return nil
}

func captureVersionTaskDetails(s *xorm.Session, snapshot *versionSnapshot) error {
	var err error

	routines := []*TaskRoutine{}
	if err = sharedVersionRows(s, "task_routines", builder.In("task_id", snapshot.TaskIDs), "task_id", &routines); err != nil {
		return err
	}
	for _, routine := range routines {
		routine.Revision = 0
		routine.Created = time.Time{}
		routine.Updated = time.Time{}
		if err = snapshot.add("routine", strconv.FormatInt(routine.TaskID, 10), "", newVersionRoutineContent(routine)); err != nil {
			return err
		}
	}
	assignees := []*TaskAssginee{}
	if err = sharedVersionRows(s, "task_assignees", builder.In("task_id", snapshot.TaskIDs), "task_id, user_id", &assignees); err != nil {
		return err
	}
	for _, assignee := range assignees {
		content := versionLinkContent{
			TaskID:  assignee.TaskID,
			OtherID: assignee.UserID,
		}
		if err = snapshot.add("assignee", fmt.Sprintf("%d:%d", assignee.TaskID, assignee.UserID), "", content); err != nil {
			return err
		}
	}
	labels := []*LabelTask{}
	if err = sharedVersionRows(s, "label_tasks", builder.In("task_id", snapshot.TaskIDs), "task_id, label_id", &labels); err != nil {
		return err
	}
	for _, label := range labels {
		content := versionLinkContent{
			TaskID:  label.TaskID,
			OtherID: label.LabelID,
		}
		if err = snapshot.add("label", fmt.Sprintf("%d:%d", label.TaskID, label.LabelID), "", content); err != nil {
			return err
		}
	}
	reminders := []*TaskReminder{}
	if err = sharedVersionRows(s, "task_reminders", builder.In("task_id", snapshot.TaskIDs), "task_id, id", &reminders); err != nil {
		return err
	}
	for _, reminder := range reminders {
		content := versionReminderContent{
			TaskID:         reminder.TaskID,
			Reminder:       reminder.Reminder,
			RelativePeriod: reminder.RelativePeriod,
			RelativeTo:     reminder.RelativeTo,
		}
		if err = snapshot.add("reminder", strconv.FormatInt(reminder.ID, 10), "", content); err != nil {
			return err
		}
	}
	relations := []*TaskRelation{}
	if err = sharedVersionRows(s, "task_relations", builder.And(builder.In("task_id", snapshot.TaskIDs), builder.In("other_task_id", snapshot.TaskIDs)), "task_id, other_task_id, relation_kind", &relations); err != nil {
		return err
	}
	for _, relation := range relations {
		content := versionLinkContent{
			TaskID:  relation.TaskID,
			OtherID: relation.OtherTaskID,
			Kind:    relation.RelationKind,
		}
		if err = snapshot.add("relation", fmt.Sprintf("%d:%d:%s", relation.TaskID, relation.OtherTaskID, relation.RelationKind), "", content); err != nil {
			return err
		}
	}
	return nil
}

func loadProjectVersionSnapshot(s *xorm.Session, version *ProjectVersion) (*versionSnapshot, error) {
	if version.SchemaVersion != projectVersionSchema {
		return nil, versionError("project_version_schema", "This checkpoint uses an unsupported content schema.")
	}
	entries := []*projectVersionEntity{}
	if err := sharedVersionRows(s, "project_version_entities", builder.Eq{"version_id": version.ID}, "kind, entity_id", &entries); err != nil {
		return nil, err
	}
	snapshot := newVersionSnapshot(version.ProjectID)
	objectIDs := []int64{}
	for _, entry := range entries {
		objectIDs = append(objectIDs, entry.ObjectID)
	}
	objects := []*projectVersionObject{}
	for chunk := range slices.Chunk(objectIDs, 400) {
		rows := []*projectVersionObject{}
		if err := sharedVersionRows(s, "project_version_objects", builder.And(builder.In("id", chunk), builder.Eq{"project_id": version.ProjectID}), "id", &rows); err != nil {
			return nil, err
		}
		objects = append(objects, rows...)
	}
	byID := map[int64]*projectVersionObject{}
	for _, object := range objects {
		byID[object.ID] = object
	}
	for _, entry := range entries {
		raw, err := decodeProjectVersionObject(byID[entry.ObjectID], entry)
		if err != nil {
			return nil, err
		}
		snapshot.Entities[versionEntityKey(entry.Kind, entry.EntityID)] = versionEntityData{
			Kind:  entry.Kind,
			ID:    entry.EntityID,
			Title: entry.Title,
			Raw:   raw,
			Hash:  entry.Hash,
		}
		if entry.Kind == "task" {
			id, _ := strconv.ParseInt(entry.EntityID, 10, 64)
			snapshot.TaskIDs = append(snapshot.TaskIDs, id)
		}
	}
	refs := []*files.ProjectVersionFileRef{}
	if err := sharedVersionRows(s, "project_version_file_refs", builder.Eq{"version_id": version.ID}, "file_id", &refs); err != nil {
		return nil, err
	}
	for _, ref := range refs {
		snapshot.Files[ref.FileID] = true
	}
	snapshot.finish()
	if snapshot.Hash != version.ContentHash {
		return nil, versionError("project_version_corrupt", "Saved checkpoint manifest failed its integrity check.")
	}
	return snapshot, nil
}

func saveProjectVersionSnapshot(s *xorm.Session, a web.Auth, snapshot *versionSnapshot, name, kind, requestID string, source int64) (*ProjectVersionSummary, error) {
	counter := &projectVersionCounter{ProjectID: snapshot.ProjectID}
	exists, err := routineCurrentRead(s).ID(snapshot.ProjectID).Get(counter)
	if err != nil {
		return nil, err
	}
	if !exists {
		if _, err = s.Insert(counter); err != nil {
			return nil, err
		}
	}
	counter.Sequence++
	if _, err = s.ID(snapshot.ProjectID).Cols("sequence").Update(counter); err != nil {
		return nil, err
	}
	actor, err := user.GetUserByID(s, a.GetID())
	if err != nil {
		return nil, err
	}
	version := &ProjectVersion{
		ProjectID:             snapshot.ProjectID,
		Sequence:              counter.Sequence,
		Name:                  name,
		Kind:                  kind,
		RestoredFromVersionID: source,
		ContentHash:           snapshot.Hash,
		SchemaVersion:         projectVersionSchema,
		CreatedByID:           actor.ID,
		CreatorUsername:       actor.Username,
		CreatorName:           actor.Name,
		RequestID:             requestID,
	}
	entries, err := prepareVersionEntities(s, snapshot, version)
	if err != nil {
		return nil, err
	}
	fileIDs, err := prepareVersionOriginals(s, snapshot, version)
	if err != nil {
		return nil, err
	}
	if _, err = s.Insert(version); err != nil {
		return nil, err
	}
	for _, entry := range entries {
		entry.VersionID = version.ID
	}
	if len(entries) > 0 {
		for chunk := range slices.Chunk(entries, 400) {
			if _, err = s.Insert(chunk); err != nil {
				return nil, err
			}
		}
	}
	for _, id := range fileIDs {
		if _, err = s.Insert(&files.ProjectVersionFileRef{
			ProjectID: snapshot.ProjectID,
			VersionID: version.ID,
			FileID:    id,
		}); err != nil {
			return nil, err
		}
	}
	for _, id := range snapshot.TaskIDs {
		if _, err = s.Insert(&projectVersionTaskRef{
			ProjectID: snapshot.ProjectID,
			VersionID: version.ID,
			TaskID:    id,
		}); err != nil {
			return nil, err
		}
	}
	return version.summary(), nil
}
func prepareVersionEntities(s *xorm.Session, snapshot *versionSnapshot, version *ProjectVersion) ([]*projectVersionEntity, error) {
	var err error
	entries := []*projectVersionEntity{}
	existingObjects := []*projectVersionObject{}
	hashes := []string{}
	for _, entity := range snapshot.Entities {
		hashes = append(hashes, entity.Hash)
	}
	for chunk := range slices.Chunk(hashes, 400) {
		rows := []*projectVersionObject{}
		if err = routineCurrentRead(s).Where("project_id = ?", snapshot.ProjectID).In("hash", chunk).Find(&rows); err != nil {
			return nil, err
		}
		existingObjects = append(existingObjects, rows...)
	}
	byHash := map[string]*projectVersionObject{}
	for _, object := range existingObjects {
		byHash[object.Hash] = object
	}
	for _, entity := range sortedVersionEntities(snapshot) {
		object, exists := byHash[entity.Hash]
		if !exists {
			var compressed bytes.Buffer
			writer := gzip.NewWriter(&compressed)
			if _, err = writer.Write(entity.Raw); err != nil {
				return nil, err
			}
			if err = writer.Close(); err != nil {
				return nil, err
			}
			object = &projectVersionObject{
				ProjectID:    snapshot.ProjectID,
				Hash:         entity.Hash,
				Encoding:     "gzip",
				ContentBytes: int64(len(entity.Raw)),
				Payload:      compressed.Bytes(),
			}
			if _, err = s.Insert(object); err != nil {
				return nil, err
			}
			byHash[entity.Hash] = object
			version.NewObjectBytes += int64(len(object.Payload))
		}
		version.ContentBytes += object.ContentBytes
		entries = append(entries, &projectVersionEntity{
			Kind:     entity.Kind,
			EntityID: entity.ID,
			ObjectID: object.ID,
			Hash:     entity.Hash,
			Title:    entity.Title,
		})
		switch entity.Kind {
		case "task":
			version.TaskCount++
		case "view":
			version.ViewCount++
		case "bucket":
			version.BucketCount++
		case "attachment":
			version.AttachmentCount++
		}
	}
	return entries, nil
}

func prepareVersionOriginals(s *xorm.Session, snapshot *versionSnapshot, version *ProjectVersion) ([]int64, error) {
	var err error
	fileIDs := make([]int64, 0, len(snapshot.Files))
	for id := range snapshot.Files {
		fileIDs = append(fileIDs, id)
	}
	slices.Sort(fileIDs)
	for _, id := range fileIDs {
		if err = files.LockOriginalForReference(s, id); err != nil {
			return nil, versionError("project_version_file_missing", "A referenced original is missing or being permanently deleted.")
		}
		f := &files.File{ID: id}
		if err = f.LoadFileMetaByID(s); err != nil {
			return nil, versionError("project_version_file_missing", "A referenced original file is missing.")
		}
		if err = f.LoadFileByID(); err != nil {
			return nil, versionError("project_version_file_missing", "A referenced original file cannot be read from storage.")
		}
		if err = f.File.Close(); err != nil {
			return nil, err
		}
		d := &files.DriveFile{}
		exists, err := routineCurrentRead(s).Where("file_id = ?", id).Get(d)
		if err != nil {
			return nil, err
		}
		if exists && d.Purging {
			return nil, versionError("project_version_file_missing", "A referenced original file is being permanently deleted.")
		}
		if err = addProjectVersionFileSize(version, f.Size); err != nil {
			return nil, err
		}
		version.FileCount++
	}
	return fileIDs, nil
}

func addProjectVersionFileSize(version *ProjectVersion, size uint64) error {
	if size > math.MaxInt64 {
		return versionError("project_version_invalid", "Referenced original file sizes exceed supported storage limits.")
	}
	fileSize := int64(size)
	if version.ReferencedFileBytes > math.MaxInt64-fileSize {
		return versionError("project_version_invalid", "Referenced original file sizes exceed supported storage limits.")
	}
	version.ReferencedFileBytes += fileSize
	return nil
}

func sortedVersionEntities(snapshot *versionSnapshot) []versionEntityData {
	keys := make([]string, 0, len(snapshot.Entities))
	for key := range snapshot.Entities {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	out := make([]versionEntityData, 0, len(keys))
	for _, key := range keys {
		out = append(out, snapshot.Entities[key])
	}
	return out
}
func versionRequestValid(requestID string) bool {
	return len(requestID) >= 16 && len(requestID) <= 80 && !strings.ContainsAny(requestID, "\x00\n\r")
}

func decodeProjectVersionObject(object *projectVersionObject, entry *projectVersionEntity) (json.RawMessage, error) {
	if object == nil || object.Hash != entry.Hash || object.Encoding != "gzip" || object.ContentBytes < 0 || object.ContentBytes > 256*1024*1024 {
		return nil, versionError("project_version_corrupt", "A saved content object is missing or invalid.")
	}
	reader, err := gzip.NewReader(bytes.NewReader(object.Payload))
	if err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(reader, object.ContentBytes+1))
	closeErr := reader.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	sum := sha256.Sum256(append([]byte(entry.Kind+"\x00"), raw...))
	if int64(len(raw)) != object.ContentBytes || hex.EncodeToString(sum[:]) != entry.Hash {
		return nil, versionError("project_version_corrupt", "Saved content failed its integrity check.")
	}
	return raw, nil
}
