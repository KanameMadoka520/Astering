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
	"net/http"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/xorm"
)

// AsterNoteOrganization is a private, resumable, tool-free model job. Original
// transcript rows are immutable; the job snapshots their high-water mark only.
// Article source is snapshotted because editorial content can change meanwhile.
type AsterNoteOrganization struct {
	ID             int64     `xorm:"bigint autoincr pk" json:"id" readOnly:"true" doc:"Organization job identifier."`
	OwnerID        int64     `xorm:"bigint not null index(aster_note_org_owner)" json:"-"`
	NoteID         int64     `xorm:"bigint not null index(aster_note_org_note)" json:"note_id" readOnly:"true" doc:"Private source note."`
	SessionID      string    `xorm:"varchar(100) not null" json:"-"`
	ConnectionID   string    `xorm:"varchar(80) not null" json:"connection_id" doc:"This account's selected text-model connection."`
	Model          string    `xorm:"varchar(150) not null" json:"model" readOnly:"true" doc:"Model requested from the selected connection."`
	Source         string    `xorm:"varchar(20) not null" json:"source" enum:"transcript,article" doc:"Original immutable transcript or a snapshot of the saved article."`
	SourceRevision int64     `xorm:"bigint not null" json:"source_revision" readOnly:"true" doc:"Article revision when this job was created; applying always checks the current revision separately."`
	SourceEndID    int64     `xorm:"bigint not null" json:"source_end_id" readOnly:"true" doc:"Last immutable transcript segment included in this job. Later recording is not silently added."`
	SourceArticle  string    `xorm:"longtext not null" json:"-"`
	SourceBytes    int64     `xorm:"bigint not null" json:"source_bytes" readOnly:"true" doc:"Logical original text bytes, not a provider token count."`
	StorageBytes   int64     `xorm:"bigint not null default 0" json:"storage_bytes" readOnly:"true" doc:"Logical UTF-8 bytes of temporary source snapshot, checkpoints, result, and error, counted in personal note storage."`
	ProcessedBytes int64     `xorm:"bigint not null default 0" json:"processed_bytes" readOnly:"true" doc:"Original text bytes whose map summaries were durably saved."`
	Status         string    `xorm:"varchar(20) not null" json:"status" enum:"queued,running,completed,failed,cancelled,interrupted" readOnly:"true" doc:"Durable lifecycle. Interrupted means the server restarted; explicit retry resumes saved checkpoints."`
	Phase          string    `xorm:"varchar(20) not null" json:"phase" readOnly:"true" doc:"Current preparation, map, reduce, or completed phase."`
	CompletedSteps int64     `xorm:"bigint not null default 0" json:"completed_steps" readOnly:"true" doc:"Successfully checkpointed model requests."`
	Level          int64     `xorm:"bigint not null default 0" json:"level" readOnly:"true" doc:"Hierarchical merge level, zero while mapping original text."`
	Attempt        int64     `xorm:"bigint not null" json:"attempt" readOnly:"true" doc:"Execution generation. Cancelled or stale workers cannot publish into another attempt."`
	InputTokens    int64     `xorm:"bigint not null default 0" json:"input_tokens" readOnly:"true" doc:"Provider-reported cumulative input tokens."`
	OutputTokens   int64     `xorm:"bigint not null default 0" json:"output_tokens" readOnly:"true" doc:"Provider-reported cumulative output tokens."`
	UsagePartial   bool      `xorm:"not null default false" json:"usage_partial" readOnly:"true" doc:"Some provider requests did not report usage."`
	Result         string    `xorm:"longtext not null" json:"result,omitempty" readOnly:"true" doc:"Completed Markdown preview. Never automatically replaces the article."`
	Error          string    `xorm:"text not null" json:"error,omitempty" readOnly:"true" doc:"Sanitized actionable failure detail; original text remains intact."`
	Work           string    `xorm:"longtext not null" json:"-"`
	Created        time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"Creation time."`
	Updated        time.Time `xorm:"updated not null" json:"updated" readOnly:"true" doc:"Last durable checkpoint."`
}

func (*AsterNoteOrganization) TableName() string { return "aster_note_organizations" }

// ValidateAsterNoteOrganizationScope is a bounded read-side lifecycle check.
// It never refreshes a revoked credential or grants tools to the model job.
func ValidateAsterNoteOrganizationScope(s *xorm.Session, actor *user.User, noteID int64) error {
	if _, err := requireOrganizationOwner(s, actor, noteID, false, false); err != nil {
		return err
	}
	return validateCurrentCredentialProof(s, actor)
}

// StopAsterNoteOrganizationForAccessLoss only finalizes lifecycle metadata of
// the already admitted attempt. It cannot write source, preview or note content,
// create rows, or resurrect a user-deleted/cancelled/retried job.
func StopAsterNoteOrganizationForAccessLoss(s *xorm.Session, ownerID, jobID, attempt int64) error {
	row := &AsterNoteOrganization{}
	found, err := s.Where("id = ? AND owner_id = ? AND attempt = ? AND status IN (?,?)", jobID, ownerID, attempt, "queued", "running").Cols("id", "error", "storage_bytes").Get(row)
	if err != nil || !found {
		return err
	}
	row.StorageBytes -= int64(len(row.Error))
	row.Error = "note_organization_access_revoked"
	row.StorageBytes += int64(len(row.Error))
	row.Status = "failed"
	_, err = s.Where("id = ? AND owner_id = ? AND attempt = ? AND status IN (?,?)", jobID, ownerID, attempt, "queued", "running").Cols("status", "error", "storage_bytes").Update(row)
	return err
}

func requireOrganizationOwner(s *xorm.Session, a web.Auth, noteID int64, write, includeContent bool) (*AsterNote, error) {
	if actor, ok := a.(*user.User); !ok || actor.HasPersonalNotesAgentAccess() {
		return nil, asterNoteError(http.StatusForbidden, "note_human_session_required")
	}
	return loadOwnedAsterNote(s, a, noteID, write, includeContent)
}

func CreateAsterNoteOrganization(s *xorm.Session, a web.Auth, noteID int64, source, connectionID, model string) (*AsterNoteOrganization, error) {
	note, err := requireOrganizationOwner(s, a, noteID, true, true)
	if err != nil {
		return nil, err
	}
	if source != "article" && source != "transcript" {
		return nil, asterNoteError(http.StatusUnprocessableEntity, "note_organization_source_invalid")
	}
	active, err := s.Where("note_id = ? AND status IN (?,?)", noteID, "queued", "running").Exist(&AsterNoteOrganization{})
	if err != nil {
		return nil, err
	}
	if active {
		return nil, asterNoteError(http.StatusConflict, "note_organization_busy")
	}
	actor := a.(*user.User)
	job := &AsterNoteOrganization{
		OwnerID:        note.OwnerID,
		NoteID:         note.ID,
		SessionID:      actor.CredentialScope().SessionID,
		ConnectionID:   connectionID,
		Model:          model,
		Source:         source,
		SourceRevision: note.Revision,
		Status:         "queued",
		Phase:          "map",
		Attempt:        1,
	}
	if source == "article" {
		job.SourceArticle = note.Content
		job.SourceBytes = note.ContentBytes
	} else {
		last := &AsterNoteSegment{}
		_, err = s.Where("note_id = ?", noteID).OrderBy("id DESC").Limit(1).Get(last)
		if err != nil {
			return nil, err
		}
		job.SourceEndID = last.ID
		job.SourceBytes = note.TranscriptBytes
	}
	if job.SourceBytes == 0 {
		return nil, asterNoteError(http.StatusUnprocessableEntity, "note_organization_source_empty")
	}
	// One resumable result per note avoids unbounded invisible temporary histories.
	if _, err = s.Where("note_id = ?", noteID).Delete(&AsterNoteOrganization{}); err != nil {
		return nil, err
	}
	job.StorageBytes = int64(len(job.SourceArticle))
	_, err = s.Insert(job)
	return job, err
}

func ReadAsterNoteOrganization(s *xorm.Session, a web.Auth, noteID, jobID int64) (*AsterNoteOrganization, error) {
	if _, err := requireOrganizationOwner(s, a, noteID, false, false); err != nil {
		return nil, err
	}
	job := &AsterNoteOrganization{}
	q := s.Where("note_id = ?", noteID)
	if jobID > 0 {
		q = q.And("id = ?", jobID)
	}
	exists, err := q.OrderBy("id DESC").Limit(1).Get(job)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, nil
	}
	return job, nil
}

func ChangeAsterNoteOrganization(s *xorm.Session, a web.Auth, noteID, jobID int64, action string) (*AsterNoteOrganization, error) {
	if _, err := requireOrganizationOwner(s, a, noteID, true, false); err != nil {
		return nil, err
	}
	job, err := ReadAsterNoteOrganization(s, a, noteID, jobID)
	if err != nil {
		return nil, err
	}
	if job == nil {
		return nil, asterNoteError(http.StatusNotFound, "note_organization_not_found")
	}
	switch action {
	case "discard":
		if job.Status == "queued" || job.Status == "running" {
			return nil, asterNoteError(http.StatusConflict, "note_organization_busy")
		}
		_, err := s.ID(job.ID).Delete(&AsterNoteOrganization{})
		return nil, err
	case "cancel":
		if job.Status != "running" && job.Status != "queued" {
			return job, nil
		}
		job.Status = "cancelled"
	case "retry":
		if job.Status != "failed" && job.Status != "interrupted" && job.Status != "cancelled" {
			return nil, asterNoteError(http.StatusConflict, "note_organization_busy")
		}
		job.Status = "queued"
		job.StorageBytes -= int64(len(job.Error))
		job.Error = ""
		job.Attempt++
		job.SessionID = a.(*user.User).CredentialScope().SessionID
	default:
		return nil, asterNoteError(http.StatusUnprocessableEntity, "note_organization_action_invalid")
	}
	_, err = s.ID(job.ID).Cols("status", "error", "attempt", "session_id", "storage_bytes").Update(job)
	return job, err
}

func ApplyAsterNoteOrganization(s *xorm.Session, a web.Auth, noteID, jobID, expectedRevision int64, mode string) (*AsterNote, error) {
	note, err := requireOrganizationOwner(s, a, noteID, true, true)
	if err != nil {
		return nil, err
	}
	job, err := ReadAsterNoteOrganization(s, a, noteID, jobID)
	if err != nil {
		return nil, err
	}
	if job == nil || job.Status != "completed" {
		return nil, asterNoteError(http.StatusConflict, "note_organization_not_completed")
	}
	if expectedRevision != note.Revision {
		return nil, asterNoteError(http.StatusConflict, "note_revision_conflict")
	}
	switch mode {
	case "replace":
		note.Content = job.Result
	case "append":
		if note.Content != "" {
			note.Content += "\n\n"
		}
		note.Content += job.Result
	default:
		return nil, asterNoteError(http.StatusUnprocessableEntity, "note_organization_action_invalid")
	}
	note.ExpectedRevision = expectedRevision
	if err := note.Update(s, a); err != nil {
		return nil, err
	}
	return note, nil
}

// SaveAsterNoteOrganizationCheckpoint is generation-fenced. It cannot resurrect
// deleted notes, cancellation, or an explicit retry under another session.
func SaveAsterNoteOrganizationCheckpoint(s *xorm.Session, a web.Auth, job *AsterNoteOrganization) error {
	if _, err := requireOrganizationOwner(s, a, job.NoteID, true, false); err != nil {
		return err
	}
	job.StorageBytes = int64(len(job.SourceArticle) + len(job.Work) + len(job.Result) + len(job.Error))
	columns := []string{
		"status",
		"phase",
		"completed_steps",
		"level",
		"processed_bytes",
		"input_tokens",
		"output_tokens",
		"usage_partial",
		"result",
		"error",
		"work",
		"storage_bytes",
		"model",
	}
	if job.Status == "completed" {
		columns = append(columns, "source_article")
	}
	affected, err := s.Where("id = ? AND owner_id = ? AND attempt = ? AND status IN (?,?)", job.ID, job.OwnerID, job.Attempt, "queued", "running").Cols(columns...).Update(job)
	if err != nil {
		return err
	}
	if affected != 1 {
		return asterNoteError(http.StatusConflict, "note_organization_stale")
	}
	return nil
}
