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

package apiv2

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/xorm"
)

type aiNoteArgs struct {
	ID               int64   `json:"id"`
	ExpectedRevision int64   `json:"expected_revision"`
	Title            *string `json:"title"`
	Content          *string `json:"content"`
	AppendContent    *string `json:"append_content"`
	Pinned           *bool   `json:"pinned"`
	Page             int     `json:"page"`
	PerPage          int     `json:"per_page"`
	Query            string  `json:"query"`
	Offset           int     `json:"offset"`
	MaxChars         int     `json:"max_chars"`
	SegmentID        int64   `json:"segment_id"`
	AfterID          int64   `json:"after_id"`
	Latest           bool    `json:"latest"`
}

func (e *aiExecution) noteActor(name string, id int64) (web.Auth, error) {
	principal := user.WithPersonalNotesAgentAccess(e.auth, name, id)
	actor, ok := principal.(*user.User)
	if !ok || !actor.PersonalNotesAgentAllows(name, id) {
		return nil, tcyai.ToolFailure("FORBIDDEN", "Personal notes require the original human's active browser session. Project scopes, bots and API tokens never grant note access.")
	}
	return actor, nil
}

func aiNoteError(err error) error {
	var noteError models.ErrAsterNote
	if !errors.As(err, &noteError) {
		return err
	}
	switch noteError.Status {
	case http.StatusConflict:
		return tcyai.ToolFailure("STATE_CONFLICT", "The note changed. Read its current revision and prepare a new reviewed operation; never overwrite a newer draft.")
	case http.StatusNotFound:
		return tcyai.ToolFailure("NOT_FOUND", "The requested personal note or segment was not found for this account.")
	case http.StatusForbidden:
		return tcyai.ToolFailure("FORBIDDEN", "The original active human session does not authorize this personal-note operation.")
	default:
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "The note title, text or revision does not meet the note's storage requirements.")
	}
}

func aiNoteMetadata(note *models.AsterNote) *models.AsterNote {
	metadata := *note
	metadata.Content = ""
	metadata.ExpectedRevision = 0
	return &metadata
}

func aiNoteBefore(name string, note *models.AsterNote) (string, error) {
	metadata, err := json.Marshal(aiNoteMetadata(note))
	if err != nil {
		return "", err
	}
	var snapshot map[string]any
	if err = json.Unmarshal(metadata, &snapshot); err != nil {
		return "", err
	}
	snapshot["content_sha256"] = fmt.Sprintf("%x", sha256.Sum256([]byte(note.Content)))
	if name == "update_note" {
		// Runtime also compares Before, not just Version. Keep editorial review
		// independent from ongoing ASR while delete reviews retain these fields.
		delete(snapshot, "segment_count")
		delete(snapshot, "transcript_bytes")
		delete(snapshot, "updated")
	}
	return marshalAI([]map[string]any{snapshot})
}

func aiNoteVersion(before string, raw json.RawMessage) string {
	// Bind the approval to the exact proposal as well as the complete current
	// content digest. Only deletion consumes original transcripts: an editorial
	// update must remain valid while independent immutable ASR text is appended.
	return fmt.Sprintf("%x", sha256.Sum256(append([]byte(before+"\n"), raw...)))
}

func (e *aiExecution) prepareNotes(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{
		Units:      1,
		ProjectIDs: []int64{},
		After:      string(raw),
	}
	var args aiNoteArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return op, err
	}
	actor, err := e.noteActor(name, args.ID)
	if err != nil {
		return op, err
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	if name == "list_notes" || name == "create_note" {
		if _, err = models.RequireAsterNotesHuman(s, actor, false); err != nil {
			return op, aiNoteError(err)
		}
		op.Before = "null"
	} else {
		// The read grant is separately scoped; a mutation grant cannot be reused
		// for arbitrary note reads, transcript appends or microphone endpoints.
		reader, readErr := e.noteActor("get_note", args.ID)
		if readErr != nil {
			return op, readErr
		}
		note := &models.AsterNote{ID: args.ID}
		if !tcyai.IsWriteTool(name) {
			if _, _, err = note.CanRead(s, reader); err != nil {
				return op, aiNoteError(err)
			}
			return op, nil
		}
		if err = note.ReadOne(s, reader); err != nil {
			return op, aiNoteError(err)
		}
		if tcyai.IsWriteTool(name) && (args.ExpectedRevision < 1 || args.ExpectedRevision != note.Revision) {
			return op, tcyai.ToolFailure("STATE_CONFLICT", "Provide the explicit current note revision; the note changed or the revision is missing.")
		}
		op.Before, err = aiNoteBefore(name, note)
		if err != nil {
			return op, err
		}
	}
	op.Version = aiNoteVersion(op.Before, raw)
	return op, nil
}

type aiNoteTextPage struct {
	Text       string `json:"text"`
	Offset     int    `json:"offset"`
	NextOffset int    `json:"next_offset"`
	Total      int    `json:"total"`
	HasMore    bool   `json:"has_more"`
}

func aiNotePage(content string, offset, limit int) aiNoteTextPage {
	if limit < 1 {
		limit = 8000
	}
	if limit > 32000 {
		limit = 32000
	}
	total := utf8.RuneCountInString(content)
	offset = min(max(offset, 0), total)
	end := min(offset+limit, total)
	startByte, endByte, position := len(content), len(content), 0
	for index := range content {
		if position == offset {
			startByte = index
		}
		if position == end {
			endByte = index
			break
		}
		position++
	}
	return aiNoteTextPage{
		Text:       content[startByte:endByte],
		Offset:     offset,
		NextOffset: end,
		Total:      total,
		HasMore:    end < total,
	}
}

func (e *aiExecution) readNotes(ctx context.Context, name string, args aiNoteArgs) (string, error) {
	actor, err := e.noteActor(name, args.ID)
	if err != nil {
		return "", err
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	switch name {
	case "list_notes":
		page := max(args.Page, 1)
		perPage := args.PerPage
		if perPage < 1 || perPage > 25 {
			perPage = 25
		}
		maximum := config.ServiceMaxItemsPerPage.GetInt()
		if maximum > 0 {
			perPage = min(perPage, maximum)
		}
		items, _, total, err := (&models.AsterNote{FilterPinned: args.Pinned}).ReadAll(s, actor, args.Query, page, perPage)
		if err != nil {
			return "", aiNoteError(err)
		}
		return marshalAI(map[string]any{
			"items":       items,
			"page":        page,
			"per_page":    perPage,
			"total":       total,
			"total_pages": (total + int64(perPage) - 1) / int64(perPage),
		})
	case "get_note":
		note := &models.AsterNote{ID: args.ID}
		if err = note.ReadOne(s, actor); err != nil {
			return "", aiNoteError(err)
		}
		if (args.Offset > 0 && args.ExpectedRevision < 1) || (args.ExpectedRevision > 0 && args.ExpectedRevision != note.Revision) {
			return "", tcyai.ToolFailure("STATE_CONFLICT", "The article changed between pages. Restart at offset 0 and keep the first page's expected_revision for every continuation.")
		}
		return marshalAI(map[string]any{
			"note_id":      note.ID,
			"note":         aiNoteMetadata(note),
			"content_page": aiNotePage(note.Content, args.Offset, args.MaxChars),
		})
	case "list_note_segments":
		return readAINoteSegments(s, actor, args)
	}
	return "", tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown personal-note read tool.")
}

func readAINoteSegments(s *xorm.Session, actor web.Auth, args aiNoteArgs) (string, error) {
	if args.SegmentID > 0 {
		segment, err := models.ReadAsterNoteSegment(s, actor, args.ID, args.SegmentID)
		if err != nil {
			return "", aiNoteError(err)
		}
		page := aiNotePage(segment.Text, args.Offset, args.MaxChars)
		segment.Text = ""
		return marshalAI(map[string]any{
			"note_id":   args.ID,
			"segment":   segment,
			"text_page": page,
		})
	}
	perPage := args.PerPage
	if perPage < 1 || perPage > 10 {
		perPage = 10
	}
	page, err := models.ListAsterNoteSegments(s, actor, args.ID, args.AfterID, perPage, args.Latest)
	if err != nil {
		return "", aiNoteError(err)
	}
	items := make([]map[string]any, 0, len(page.Items))
	for _, segment := range page.Items {
		preview := aiNotePage(segment.Text, 0, 1000)
		items = append(items, map[string]any{
			"id":               segment.ID,
			"note_id":          segment.NoteID,
			"text":             preview.Text,
			"text_chars":       preview.Total,
			"next_text_offset": preview.NextOffset,
			"text_truncated":   preview.HasMore,
			"start_ms":         segment.StartMS,
			"end_ms":           segment.EndMS,
			"timing_estimated": segment.TimingEstimated,
			"created":          segment.Created,
		})
	}
	return marshalAI(map[string]any{
		"note_id":     args.ID,
		"items":       items,
		"total":       page.Total,
		"has_more":    page.HasMore,
		"next_cursor": page.NextCursor,
		"from_end":    page.FromEnd,
	})
}

func applyAINoteFields(note *models.AsterNote, args aiNoteArgs) {
	if args.Title != nil {
		note.Title = *args.Title
	}
	if args.Content != nil {
		note.Content = *args.Content
	}
	if args.AppendContent != nil {
		note.Content += *args.AppendContent
	}
	if args.Pinned != nil {
		note.Pinned = *args.Pinned
	}
	note.ExpectedRevision = args.ExpectedRevision
}

func (e *aiExecution) mutateNotes(ctx context.Context, name string, raw json.RawMessage, args aiNoteArgs) (string, error) {
	op := tcyai.CurrentOperation(ctx)
	if op == nil || !op.Approved || op.Version == "" {
		return "", tcyai.ToolFailure("REVIEW_REQUIRED", "Every personal-note write requires the user's approval of its exact prepared preview.")
	}
	actor, err := e.noteActor(name, args.ID)
	if err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	before := "null"
	note := &models.AsterNote{}
	if name != "create_note" {
		note, err = models.ReadAsterNoteForToolMutation(s, actor, args.ID)
		if err != nil {
			return "", aiNoteError(err)
		}
		if args.ExpectedRevision < 1 || args.ExpectedRevision != note.Revision {
			return "", tcyai.ToolFailure("STATE_CONFLICT", "The note revision changed; read it and prepare a new reviewed operation.")
		}
		before, err = aiNoteBefore(name, note)
		if err != nil {
			return "", err
		}
	}
	if aiNoteVersion(before, raw) != op.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The note, original transcripts or proposal changed after review. Prepare and review a fresh operation.")
	}
	applyAINoteFields(note, args)
	switch name {
	case "create_note":
		err = note.Create(s, actor)
	case "update_note":
		err = note.Update(s, actor)
	case "delete_note":
		err = note.Delete(s, actor)
	default:
		return "", tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown personal-note mutation.")
	}
	if err != nil {
		return "", aiNoteError(err)
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{
			Code:      "WRITE_UNCERTAIN",
			Message:   "Database commit was not confirmed. Read the note before any new change; this operation will not be replayed.",
			Uncertain: true,
		}
	}
	op.Verified = true
	result := map[string]any{
		"note_id": note.ID,
		"success": true,
	}
	if name == "delete_note" {
		result["deleted"] = true
		result["revision"] = note.Revision
	} else {
		result["note"] = aiNoteMetadata(note)
	}
	return marshalAI(result)
}

func (e *aiExecution) executeNotes(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	var args aiNoteArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", err
	}
	if !tcyai.IsWriteTool(name) {
		return e.readNotes(ctx, name, args)
	}
	return e.mutateNotes(ctx, name, raw, args)
}
