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
	"net/http"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/web"
)

// ProjectVersion contains only immutable checkpoint metadata, never account or project ACL snapshots.
type ProjectVersion struct {
	ID                    int64     `xorm:"bigint autoincr pk"`
	ProjectID             int64     `xorm:"bigint not null index unique(project_version_sequence)"`
	Sequence              int64     `xorm:"bigint not null unique(project_version_sequence)"`
	Name                  string    `xorm:"varchar(160) not null"`
	Kind                  string    `xorm:"varchar(24) not null"`
	RestoredFromVersionID int64     `xorm:"bigint not null default 0"`
	ContentHash           string    `xorm:"varchar(64) not null"`
	SchemaVersion         int       `xorm:"not null"`
	Created               time.Time `xorm:"created not null"`
	CreatedByID           int64     `xorm:"bigint not null"`
	CreatorUsername       string    `xorm:"varchar(250) not null"`
	CreatorName           string    `xorm:"varchar(250) not null"`
	RequestID             string    `xorm:"varchar(80) not null index"`
	TaskCount             int64     `xorm:"bigint not null"`
	ViewCount             int64     `xorm:"bigint not null"`
	BucketCount           int64     `xorm:"bigint not null"`
	AttachmentCount       int64     `xorm:"bigint not null"`
	FileCount             int64     `xorm:"bigint not null"`
	ReferencedFileBytes   int64     `xorm:"bigint not null"`
	ContentBytes          int64     `xorm:"bigint not null"`
	NewObjectBytes        int64     `xorm:"bigint not null"`
	RestoreReceipt        string    `xorm:"longtext"`
}

func (*ProjectVersion) TableName() string { return "project_versions" }

type projectVersionCounter struct {
	ProjectID int64 `xorm:"bigint pk"`
	Sequence  int64 `xorm:"bigint not null"`
}

func (*projectVersionCounter) TableName() string { return "project_version_counters" }

type projectVersionObject struct {
	ID           int64  `xorm:"bigint autoincr pk"`
	ProjectID    int64  `xorm:"bigint not null unique(project_version_object)"`
	Hash         string `xorm:"varchar(64) not null unique(project_version_object)"`
	Encoding     string `xorm:"varchar(12) not null"`
	ContentBytes int64  `xorm:"bigint not null"`
	Payload      []byte `xorm:"longblob not null"`
}

func (*projectVersionObject) TableName() string { return "project_version_objects" }

type projectVersionEntity struct {
	ID        int64  `xorm:"bigint autoincr pk"`
	VersionID int64  `xorm:"bigint not null index unique(project_version_entity)"`
	Kind      string `xorm:"varchar(24) not null unique(project_version_entity)"`
	EntityID  string `xorm:"varchar(100) not null unique(project_version_entity)"`
	ObjectID  int64  `xorm:"bigint not null index"`
	Hash      string `xorm:"varchar(64) not null"`
	Title     string `xorm:"text"`
}

func (*projectVersionEntity) TableName() string { return "project_version_entities" }

type projectVersionTaskRef struct {
	ID        int64 `xorm:"bigint autoincr pk"`
	VersionID int64 `xorm:"bigint not null unique(project_version_task_ref)"`
	ProjectID int64 `xorm:"bigint not null index"`
	TaskID    int64 `xorm:"bigint not null index unique(project_version_task_ref)"`
}

func (*projectVersionTaskRef) TableName() string { return "project_version_task_refs" }

type ProjectVersionActor struct {
	ID       int64  `json:"id" doc:"Account that saved this checkpoint."`
	Username string `json:"username" doc:"Username at the time of saving."`
	Name     string `json:"name" doc:"Display name at the time of saving."`
}
type ProjectVersionSummary struct {
	ID                    int64               `json:"id" doc:"Immutable saved checkpoint ID."`
	ProjectID             int64               `json:"project_id" doc:"Current project controlling access to this checkpoint."`
	Sequence              int64               `json:"sequence" doc:"Monotonically increasing checkpoint number within the project."`
	Name                  string              `json:"name" doc:"Explicit checkpoint name or automatic recovery label."`
	Kind                  string              `json:"kind" enum:"manual,before_restore,restored" doc:"User-saved or automatic pre/post restore checkpoint."`
	RestoredFromVersionID int64               `json:"restored_from_version_id" doc:"Source checkpoint for an automatic restored version, otherwise zero."`
	ContentHash           string              `json:"content_hash" doc:"SHA-256 of the canonical checkpoint entity manifest."`
	SchemaVersion         int                 `json:"schema_version" doc:"Version of the explicit content schema, independent from the application version."`
	Created               time.Time           `json:"created" doc:"When the checkpoint was atomically saved."`
	CreatedBy             ProjectVersionActor `json:"created_by" doc:"Historical attribution, not an access grant."`
	TaskCount             int64               `json:"task_count" doc:"Number of saved active tasks."`
	ViewCount             int64               `json:"view_count" doc:"Number of saved project views."`
	BucketCount           int64               `json:"bucket_count" doc:"Number of saved manual view buckets."`
	AttachmentCount       int64               `json:"attachment_count" doc:"Number of saved task attachment relationships."`
	FileCount             int64               `json:"file_count" doc:"Distinct referenced original files; file bytes are never copied."`
	ReferencedFileBytes   int64               `json:"referenced_file_bytes" doc:"Sum of distinct referenced original file sizes; shared files are counted once here."`
	ContentBytes          int64               `json:"content_bytes" doc:"Uncompressed canonical entity JSON bytes in this checkpoint."`
	NewObjectBytes        int64               `json:"new_object_bytes" doc:"New compressed entity bytes introduced when this checkpoint was created; excludes database indexes."`
}

func (v *ProjectVersion) summary() *ProjectVersionSummary {
	return &ProjectVersionSummary{
		ID:                    v.ID,
		ProjectID:             v.ProjectID,
		Sequence:              v.Sequence,
		Name:                  v.Name,
		Kind:                  v.Kind,
		RestoredFromVersionID: v.RestoredFromVersionID,
		ContentHash:           v.ContentHash,
		SchemaVersion:         v.SchemaVersion,
		Created:               v.Created,
		CreatedBy: ProjectVersionActor{
			ID:       v.CreatedByID,
			Username: v.CreatorUsername,
			Name:     v.CreatorName,
		},
		TaskCount:           v.TaskCount,
		ViewCount:           v.ViewCount,
		BucketCount:         v.BucketCount,
		AttachmentCount:     v.AttachmentCount,
		FileCount:           v.FileCount,
		ReferencedFileBytes: v.ReferencedFileBytes,
		ContentBytes:        v.ContentBytes,
		NewObjectBytes:      v.NewObjectBytes,
	}
}

type ProjectVersionChange struct {
	Kind      string   `json:"kind" doc:"Entity kind used for on-demand historical content reads."`
	EntityID  string   `json:"entity_id" doc:"Stable checkpoint-local entity identity; compound identities use a colon separator."`
	Title     string   `json:"title" doc:"Historical or currently authorized display title."`
	Operation string   `json:"operation" enum:"add,update,remove" doc:"Change from current project content to the selected checkpoint."`
	Fields    []string `json:"fields" doc:"Changed top-level whitelist fields; values are fetched on demand."`
}
type ProjectVersionConflict struct {
	Code     string `json:"code" doc:"Stable conflict code; no partial restore is applied."`
	Kind     string `json:"kind" doc:"Affected checkpoint entity kind."`
	EntityID string `json:"entity_id" doc:"Affected checkpoint-local entity identity."`
	Message  string `json:"message" doc:"Safe explanation without inaccessible resource names."`
}
type ProjectVersionChanges struct {
	Items      []ProjectVersionChange `json:"items" doc:"Only this page of actual changes."`
	Total      int64                  `json:"total" doc:"Total changes before pagination."`
	Page       int                    `json:"page" doc:"One-based page."`
	PerPage    int                    `json:"per_page" doc:"Items per page."`
	TotalPages int64                  `json:"total_pages" doc:"Total pages."`
}
type ProjectVersionDiffSummary struct {
	ProjectChanged     bool  `json:"project_changed" doc:"Project content or announcement changes."`
	AddedTasks         int64 `json:"added_tasks" doc:"Tasks that will return or be recreated."`
	UpdatedTasks       int64 `json:"updated_tasks" doc:"Existing tasks whose content will change."`
	RemovedTasks       int64 `json:"removed_tasks" doc:"Current tasks absent from the target; soft-removed with facts retained."`
	AddedViews         int64 `json:"added_views" doc:"Views to recreate."`
	UpdatedViews       int64 `json:"updated_views" doc:"Views to update."`
	RemovedViews       int64 `json:"removed_views" doc:"Views absent from the target."`
	AddedBuckets       int64 `json:"added_buckets" doc:"Buckets to recreate."`
	UpdatedBuckets     int64 `json:"updated_buckets" doc:"Buckets to update."`
	RemovedBuckets     int64 `json:"removed_buckets" doc:"Buckets absent from the target."`
	AddedAttachments   int64 `json:"added_attachments" doc:"Attachment relationships to restore, reusing original bytes."`
	UpdatedAttachments int64 `json:"updated_attachments" doc:"Attachment relationships to update."`
	RemovedAttachments int64 `json:"removed_attachments" doc:"Live attachment relationships absent from the target; originals stay retained."`
}
type ProjectVersionPreserved struct {
	CommentAttachments int64 `json:"comment_attachments" doc:"Current task attachment relationships retained because preserved comments still embed them."`
	Comments           int64 `json:"comments" doc:"Current comments retained unchanged."`
	Checkins           int64 `json:"checkins" doc:"Actual recorded check-ins retained unchanged."`
	Progress           int64 `json:"progress" doc:"Actual periodic progress rows retained unchanged."`
	TimeEntries        int64 `json:"time_entries" doc:"Recorded work-time entries retained unchanged."`
	Permissions        bool  `json:"permissions" doc:"Current ownership, members, shares and inherited access remain unchanged."`
}
type ProjectVersionPreview struct {
	ProjectID       int64                     `json:"project_id" doc:"Authorized current project."`
	TargetVersionID int64                     `json:"target_version_id" doc:"Immutable checkpoint to restore."`
	CurrentHash     string                    `json:"current_hash" doc:"Current canonical content hash; excludes comments, check-ins and volatile timestamps."`
	TargetHash      string                    `json:"target_hash" doc:"Target immutable content hash."`
	PlanHash        string                    `json:"plan_hash" doc:"Binds the exact source, target, actor and complete restore plan; independent of pagination."`
	CanRestore      bool                      `json:"can_restore" doc:"Current actor is a project administrator and the plan has no conflicts."`
	Summary         ProjectVersionDiffSummary `json:"summary" doc:"Counts for the whole plan, not just this page."`
	Preserved       ProjectVersionPreserved   `json:"preserved" doc:"Facts and permissions intentionally outside the rollback scope."`
	Conflicts       []ProjectVersionConflict  `json:"conflicts" doc:"Any conflict prevents the whole restore."`
	Changes         ProjectVersionChanges     `json:"changes" doc:"Paginated content differences."`
}
type ProjectVersionRestoreInput struct {
	ExpectedCurrentHash string `json:"expected_current_hash" minLength:"64" maxLength:"64" doc:"Current hash returned by the reviewed preview."`
	PlanHash            string `json:"plan_hash" minLength:"64" maxLength:"64" doc:"Exact reviewed plan hash; stale previews return 409 without writes."`
	RequestID           string `json:"request_id" minLength:"16" maxLength:"80" doc:"Unique request ID retained for idempotent retry after transport failure."`
}
type ProjectVersionIDMap struct {
	Tasks       map[string]int64 `json:"tasks" doc:"Checkpoint task IDs mapped to live task IDs."`
	Views       map[string]int64 `json:"views" doc:"Checkpoint view IDs mapped to live view IDs."`
	Buckets     map[string]int64 `json:"buckets" doc:"Checkpoint bucket IDs mapped to live bucket IDs."`
	Attachments map[string]int64 `json:"attachments" doc:"Checkpoint attachment IDs mapped to live attachment IDs; inline references are rewritten."`
}
type ProjectVersionRestoreResult struct {
	ProjectID             int64                  `json:"project_id" doc:"Restored project, unchanged identity and permissions."`
	RestoredFromVersionID int64                  `json:"restored_from_version_id" doc:"Reviewed source checkpoint."`
	BeforeVersionID       int64                  `json:"before_version_id" doc:"Automatic checkpoint saved immediately before the restore in the same transaction."`
	Version               *ProjectVersionSummary `json:"version" doc:"New automatic checkpoint of the restored result."`
	CurrentHash           string                 `json:"current_hash" doc:"Canonical hash of the successfully restored content."`
	ChangedTaskIDs        []int64                `json:"changed_task_ids" doc:"Live task details and project lists to refresh locally."`
	RemovedTaskIDs        []int64                `json:"removed_task_ids" doc:"Tasks now soft-removed; invalidate still-mounted editors before refetching."`
	IDMap                 ProjectVersionIDMap    `json:"id_map" doc:"Explicit source-to-live identity mapping."`
	Verified              bool                   `json:"verified" doc:"True only after the complete restore has been validated."`
}
type ProjectVersionEntityIndex struct {
	Kind        string `json:"kind" doc:"Whitelisted entity kind."`
	EntityID    string `json:"entity_id" doc:"Checkpoint-local entity identity."`
	Title       string `json:"title" doc:"Safe historical display title."`
	ContentHash string `json:"content_hash" doc:"Hash of this canonical entity JSON."`
}
type ProjectVersionEntityContent struct {
	ProjectID      int64          `json:"project_id" doc:"Authorized current project."`
	VersionID      int64          `json:"version_id" doc:"Requested immutable checkpoint."`
	Kind           string         `json:"kind" doc:"Whitelisted entity kind."`
	EntityID       string         `json:"entity_id" doc:"Checkpoint-local entity identity."`
	ContentHash    string         `json:"content_hash" doc:"Hash verified before decoding historical content."`
	Content        map[string]any `json:"content" doc:"Explicit historical content whitelist; excludes permissions and credentials."`
	CurrentContent map[string]any `json:"current_content" doc:"Current entity content only if it still belongs to this authorized project; null otherwise."`
}

type ProjectVersionError struct{ Code, Message string }

func (e *ProjectVersionError) Error() string { return e.Message }
func (e *ProjectVersionError) HTTPError() web.HTTPError {
	status := http.StatusConflict
	if e.Code == "project_version_missing" {
		status = http.StatusNotFound
	}
	if e.Code == "project_version_invalid" {
		status = http.StatusUnprocessableEntity
	}
	return web.HTTPError{
		HTTPCode: status,
		Code:     20250,
		Message:  e.Message,
	}
}
func versionError(code, message string) error {
	return &ProjectVersionError{
		Code:    code,
		Message: message,
	}
}

// Keep JSON representation explicit at storage boundaries instead of serializing arbitrary DB models.
type versionEntityData struct {
	Kind, ID, Title string
	Raw             json.RawMessage
	Hash            string
}
type versionSnapshot struct {
	ProjectID int64
	Entities  map[string]versionEntityData
	Hash      string
	Files     map[int64]bool
	TaskIDs   []int64
}
