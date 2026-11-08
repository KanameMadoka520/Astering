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
	"slices"
	"strings"
	"time"
	"unicode"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/google/uuid"
	"xorm.io/builder"
	"xorm.io/xorm"
)

const (
	AsterNoteContentLimit = 8 * 1024 * 1024
	AsterNoteSegmentLimit = 64 * 1024
)

// AsterNote keeps editable Markdown independent from immutable final ASR segments.
// Ownership is personal: administrator, team and bot-owner roles never grant access.
type AsterNote struct {
	ID               int64     `xorm:"bigint autoincr pk" json:"id" readOnly:"true" doc:"Server-assigned personal note identifier."`
	OwnerID          int64     `xorm:"bigint not null index(aster_notes_owner_updated)" json:"-"`
	Title            string    `xorm:"varchar(250) not null" json:"title" minLength:"1" maxLength:"250" doc:"Personal note title, up to 250 Unicode characters."`
	Content          string    `xorm:"longtext not null" json:"content,omitempty" maxLength:"8388608" doc:"Editable Markdown, at most 8 MiB UTF-8. Omitted from lists; raw transcript segments are independent."`
	Pinned           bool      `xorm:"not null default false" json:"pinned" doc:"Pinned notes appear before other notes."`
	Revision         int64     `xorm:"bigint not null" json:"revision" readOnly:"true" doc:"Editorial revision. Transcript appends do not change this value."`
	ContentBytes     int64     `xorm:"bigint not null default 0" json:"content_bytes" readOnly:"true" doc:"UTF-8 Markdown bytes; not allocated database disk space."`
	TitleBytes       int64     `xorm:"bigint not null default 0" json:"-"`
	TranscriptBytes  int64     `xorm:"bigint not null default 0" json:"transcript_bytes" readOnly:"true" doc:"UTF-8 bytes of independently retained transcript text; no audio is stored."`
	SegmentCount     int64     `xorm:"bigint not null default 0" json:"segment_count" readOnly:"true" doc:"Number of immutable final transcript segments."`
	Excerpt          string    `xorm:"text not null" json:"excerpt" readOnly:"true" doc:"Server-derived preview of the editable text, at most 180 Unicode characters."`
	Created          time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"Original note creation time."`
	Updated          time.Time `xorm:"updated not null index(aster_notes_owner_updated)" json:"updated" readOnly:"true" doc:"Last editorial save or transcript append."`
	ExpectedRevision int64     `xorm:"-" json:"expected_revision,omitempty" minimum:"1" doc:"Required on editorial update; stale or missing values return 409."`
	FilterPinned     *bool     `xorm:"-" json:"-"`
	web.CRUDable     `xorm:"-" json:"-"`
	web.Permissions  `xorm:"-" json:"-"`
}

func (*AsterNote) TableName() string { return "aster_notes" }

type AsterNoteSegment struct {
	NoteID          int64     `xorm:"bigint not null unique(aster_note_client) index(aster_note_cursor) index(aster_note_end)" json:"note_id" readOnly:"true" doc:"Containing note, always taken from the request path."`
	ID              int64     `xorm:"bigint autoincr pk index(aster_note_cursor)" json:"id" readOnly:"true" doc:"Server-assigned cursor; segments are returned in ascending ID order."`
	ClientID        string    `xorm:"varchar(36) not null unique(aster_note_client)" json:"client_id" format:"uuid" doc:"Client-generated UUID. Reusing it with identical text and times returns the original segment."`
	Text            string    `xorm:"longtext not null" json:"text" minLength:"1" maxLength:"65536" doc:"Immutable final transcript text, at most 64 KiB UTF-8."`
	StartMS         int64     `xorm:"bigint not null" json:"start_ms" minimum:"0" doc:"Start offset in the recording timeline, in milliseconds; not a wall-clock timestamp."`
	EndMS           int64     `xorm:"bigint not null index(aster_note_end)" json:"end_ms" minimum:"0" doc:"End offset in milliseconds; must be greater than or equal to start_ms."`
	TimingEstimated bool      `xorm:"not null default false" json:"timing_estimated,omitempty" doc:"True when the provider lacked precise timestamps and recording offsets were estimated."`
	Created         time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"Server timestamp of the first durable append."`
}

func (*AsterNoteSegment) TableName() string { return "aster_note_segments" }

type ErrAsterNote struct {
	Status  int
	Message string
}

func (e ErrAsterNote) Error() string { return e.Message }
func (e ErrAsterNote) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: e.Status,
		Message:  e.Message,
	}
}

func asterNoteError(status int, message string) error {
	return ErrAsterNote{
		Status:  status,
		Message: message,
	}
}

// RequireAsterNotesHuman is shared by HTTP and live-ASR persistence. Mutable
// writes additionally lock/recheck the original credential before taking a note lock.
func RequireAsterNotesHuman(s *xorm.Session, a web.Auth, write bool) (*user.User, error) {
	actor, ok := a.(*user.User)
	if !ok || actor == nil || actor.ID <= 0 || actor.IsBot() || actor.HasResourceOnlyPermissions() || actor.CredentialScope().APITokenID > 0 {
		return nil, asterNoteError(http.StatusForbidden, "note_human_session_required")
	}
	if write {
		if err := LockCredentialIssue(s, actor); err != nil {
			return nil, err
		}
	}
	current := &user.User{}
	found, err := s.ID(actor.ID).Get(current)
	if err != nil {
		return nil, err
	}
	if !found || current.IsBot() || current.Status != user.StatusActive {
		return nil, asterNoteError(http.StatusForbidden, "note_human_session_required")
	}
	return actor, nil
}

func loadOwnedAsterNote(s *xorm.Session, a web.Auth, id int64, write, includeContent bool) (*AsterNote, error) {
	actor, err := RequireAsterNotesHuman(s, a, write)
	if err != nil {
		return nil, err
	}
	if id <= 0 {
		return nil, asterNoteError(http.StatusNotFound, "note_not_found")
	}
	query := s
	if write {
		query = routineCurrentRead(s)
	}
	if !includeContent {
		query = query.Omit("content")
	}
	row := &AsterNote{}
	found, err := query.Where("id = ? AND owner_id = ?", id, actor.ID).Get(row)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, asterNoteError(http.StatusNotFound, "note_not_found")
	}
	return row, nil
}

func (n *AsterNote) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	_, err := RequireAsterNotesHuman(s, a, false)
	return err == nil, err
}
func (n *AsterNote) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	_, err := loadOwnedAsterNote(s, a, n.ID, false, false)
	if err != nil {
		return false, 0, err
	}
	return true, int(PermissionAdmin), nil
}
func (n *AsterNote) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	_, err := loadOwnedAsterNote(s, a, n.ID, false, false)
	return err == nil, err
}
func (n *AsterNote) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	return n.CanUpdate(s, a)
}

func (n *AsterNote) normalize() error {
	n.Title = strings.TrimSpace(n.Title)
	if !utf8.ValidString(n.Title) || utf8.RuneCountInString(n.Title) < 1 || utf8.RuneCountInString(n.Title) > 250 || strings.ContainsAny(n.Title, "\r\n\x00") {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_title")
	}
	if !utf8.ValidString(n.Content) || len(n.Content) > AsterNoteContentLimit || strings.ContainsRune(n.Content, '\x00') {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_content")
	}
	n.TitleBytes = int64(len(n.Title))
	n.ContentBytes = int64(len(n.Content))
	n.Excerpt = asterNoteExcerpt(n.Content)
	return nil
}

// A short preview must not allocate copies of a potentially 8 MiB article.
func asterNoteExcerpt(content string) string {
	const limit = 180
	var preview strings.Builder
	preview.Grow(limit * utf8.UTFMax)
	length := 0
	space := false
	for _, value := range content {
		if unicode.IsSpace(value) {
			space = length > 0
			continue
		}
		if space {
			preview.WriteByte(' ')
			length++
			if length == limit {
				break
			}
		}
		preview.WriteRune(value)
		length++
		if length == limit {
			break
		}
		space = false
	}
	return preview.String()
}

func (n *AsterNote) Create(s *xorm.Session, a web.Auth) error {
	actor, err := RequireAsterNotesHuman(s, a, true)
	if err != nil {
		return err
	}
	if err := n.normalize(); err != nil {
		return err
	}
	n.ID = 0
	n.OwnerID = actor.ID
	n.Revision = 1
	n.ExpectedRevision = 0
	n.TranscriptBytes = 0
	n.SegmentCount = 0
	n.Created = time.Time{}
	n.Updated = time.Time{}
	_, err = s.Insert(n)
	return err
}

func (n *AsterNote) ReadOne(s *xorm.Session, a web.Auth) error {
	row, err := loadOwnedAsterNote(s, a, n.ID, false, true)
	if err != nil {
		return err
	}
	*n = *row
	return nil
}

func (n *AsterNote) Update(s *xorm.Session, a web.Auth) error {
	current, err := loadOwnedAsterNote(s, a, n.ID, true, true)
	if err != nil {
		return err
	}
	if n.ExpectedRevision < 1 || n.ExpectedRevision != current.Revision {
		return asterNoteError(http.StatusConflict, "note_revision_conflict")
	}
	if err := n.normalize(); err != nil {
		return err
	}
	if current.Title == n.Title && current.Content == n.Content && current.Pinned == n.Pinned {
		*n = *current
		return nil
	}
	current.Title = n.Title
	current.Content = n.Content
	current.Pinned = n.Pinned
	current.TitleBytes = n.TitleBytes
	current.ContentBytes = n.ContentBytes
	current.Excerpt = n.Excerpt
	expected := current.Revision
	current.Revision++
	affected, err := s.Where("id = ? AND owner_id = ? AND revision = ?", current.ID, current.OwnerID, expected).
		Cols("title", "content", "pinned", "title_bytes", "content_bytes", "excerpt", "revision").Update(current)
	if err != nil {
		return err
	}
	if affected != 1 {
		return asterNoteError(http.StatusConflict, "note_revision_conflict")
	}
	*n = *current
	return nil
}

func (n *AsterNote) Delete(s *xorm.Session, a web.Auth) error {
	current, err := loadOwnedAsterNote(s, a, n.ID, true, false)
	if err != nil {
		return err
	}
	if _, err := s.Where("note_id = ?", current.ID).Delete(&AsterNoteSegment{}); err != nil {
		return err
	}
	_, err = s.Where("id = ? AND owner_id = ?", current.ID, current.OwnerID).Delete(&AsterNote{})
	return err
}

func asterNotePage(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	maximum := config.ServiceMaxItemsPerPage.GetInt()
	if maximum < 1 {
		maximum = 50
	}
	if perPage < 1 || perPage > maximum {
		perPage = maximum
	}
	return page, perPage
}

func (n *AsterNote) ReadAll(s *xorm.Session, a web.Auth, search string, page, perPage int) (any, int, int64, error) {
	actor, err := RequireAsterNotesHuman(s, a, false)
	if err != nil {
		return nil, 0, 0, err
	}
	cond := builder.And(builder.Eq{"owner_id": actor.ID})
	if n.FilterPinned != nil {
		cond = cond.And(builder.Eq{"pinned": *n.FilterPinned})
	}
	if search != "" {
		cond = cond.And(builder.Or(db.ILIKE("title", search), db.ILIKE("content", search)))
	}
	total, err := s.Where(cond).Count(&AsterNote{})
	if err != nil {
		return nil, 0, 0, err
	}
	page, perPage = asterNotePage(page, perPage)
	items := []*AsterNote{}
	err = s.Where(cond).Omit("content").OrderBy("pinned DESC, updated DESC, id DESC").Limit(perPage, (page-1)*perPage).Find(&items)
	return items, len(items), total, err
}

func validateAsterNoteSegment(segment *AsterNoteSegment) error {
	id, err := uuid.Parse(segment.ClientID)
	if err != nil || id == uuid.Nil {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_client_id")
	}
	segment.ClientID = id.String()
	if !utf8.ValidString(segment.Text) || strings.TrimSpace(segment.Text) == "" || len(segment.Text) > AsterNoteSegmentLimit || strings.ContainsRune(segment.Text, '\x00') {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_segment")
	}
	if segment.StartMS < 0 || segment.EndMS < segment.StartMS {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_segment_time")
	}
	return nil
}

// AppendAsterNoteSegment must be called in a short write transaction. A caller
// emits the final segment only after Commit; audio is never retained here.
func AppendAsterNoteSegment(s *xorm.Session, a web.Auth, noteID int64, segment *AsterNoteSegment) error {
	if segment == nil {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_segment")
	}
	note, err := loadOwnedAsterNote(s, a, noteID, true, false)
	if err != nil {
		return err
	}
	if err := validateAsterNoteSegment(segment); err != nil {
		return err
	}
	existing := &AsterNoteSegment{}
	found, err := routineCurrentRead(s).Where("note_id = ? AND client_id = ?", note.ID, segment.ClientID).Get(existing)
	if err != nil {
		return err
	}
	if found {
		if existing.Text != segment.Text || existing.StartMS != segment.StartMS || existing.EndMS != segment.EndMS || existing.TimingEstimated != segment.TimingEstimated {
			return asterNoteError(http.StatusConflict, "note_segment_conflict")
		}
		*segment = *existing
		return nil
	}
	segment.ID = 0
	segment.NoteID = note.ID
	segment.Created = time.Time{}
	if _, err := s.Insert(segment); err != nil {
		return err
	}
	note.TranscriptBytes += int64(len(segment.Text))
	note.SegmentCount++
	if _, err := s.ID(note.ID).Cols("transcript_bytes", "segment_count").Update(note); err != nil {
		return err
	}
	// Read back persisted time precision so the first response matches an idempotent retry.
	_, err = s.ID(segment.ID).Get(segment)
	return err
}

type AsterNoteTranscriptState struct {
	SegmentCount    int64     `json:"segment_count" doc:"Currently committed final transcript segments; independent from editorial revision."`
	TranscriptBytes int64     `json:"transcript_bytes" doc:"Logical UTF-8 final transcript bytes."`
	Updated         time.Time `json:"updated" doc:"Server activity time after the final append."`
}

// ReadAsterNoteTranscriptState allows committed live events to update counters
// without re-reading or retransmitting a potentially large editable article.
func ReadAsterNoteTranscriptState(s *xorm.Session, a web.Auth, noteID int64) (*AsterNoteTranscriptState, error) {
	note, err := loadOwnedAsterNote(s, a, noteID, false, false)
	if err != nil {
		return nil, err
	}
	return &AsterNoteTranscriptState{
		SegmentCount:    note.SegmentCount,
		TranscriptBytes: note.TranscriptBytes,
		Updated:         note.Updated,
	}, nil
}

type AsterNoteSegmentPage struct {
	Items      []*AsterNoteSegment `json:"items" doc:"Immutable final segments in ascending ID order."`
	Total      int64               `json:"total" doc:"All currently persisted segments in this note, not just after the cursor."`
	HasMore    bool                `json:"has_more" doc:"Whether another forward page existed when this page was read."`
	NextCursor int64               `json:"next_cursor" doc:"Last returned ID; send it as after_id. Preserves the input cursor for an empty forward page."`
	FromEnd    bool                `json:"from_end" doc:"True when latest=true selected the newest bounded page instead of a forward cursor. This mode always has_more=false."`
}

func ListAsterNoteSegments(s *xorm.Session, a web.Auth, noteID, afterID int64, perPage int, latest bool) (*AsterNoteSegmentPage, error) {
	if _, err := loadOwnedAsterNote(s, a, noteID, false, false); err != nil {
		return nil, err
	}
	if afterID < 0 || (latest && afterID > 0) {
		return nil, asterNoteError(http.StatusUnprocessableEntity, "note_invalid_cursor")
	}
	if perPage < 1 || perPage > 100 {
		perPage = 100
	}
	total, err := s.Where("note_id = ?", noteID).Count(&AsterNoteSegment{})
	if err != nil {
		return nil, err
	}
	rows := []*AsterNoteSegment{}
	if latest {
		if err := s.Where("note_id = ?", noteID).OrderBy("id DESC").Limit(perPage).Find(&rows); err != nil {
			return nil, err
		}
		slices.Reverse(rows)
	} else if err := s.Where("note_id = ? AND id > ?", noteID, afterID).OrderBy("id ASC").Limit(perPage + 1).Find(&rows); err != nil {
		return nil, err
	}
	page := &AsterNoteSegmentPage{
		Items:      rows,
		Total:      total,
		HasMore:    !latest && len(rows) > perPage,
		NextCursor: afterID,
		FromEnd:    latest,
	}
	if page.HasMore {
		page.Items = rows[:perPage]
	}
	if len(page.Items) > 0 {
		page.NextCursor = page.Items[len(page.Items)-1].ID
	}
	return page, nil
}

// AsterNoteRecordingOffset allows a new live session to continue the note's
// timeline without reading transcript text or assuming wall-clock continuity.
func AsterNoteRecordingOffset(s *xorm.Session, a web.Auth, noteID int64) (int64, error) {
	if _, err := loadOwnedAsterNote(s, a, noteID, false, false); err != nil {
		return 0, err
	}
	latest := &AsterNoteSegment{}
	found, err := s.Where("note_id = ?", noteID).Cols("end_ms").OrderBy("end_ms DESC").Limit(1).Get(latest)
	if err != nil || !found {
		return 0, err
	}
	return latest.EndMS, nil
}

// DeleteAsterNotesForAccount runs inside the existing account deletion transaction.
func DeleteAsterNotesForAccount(s *xorm.Session, ownerID int64) error {
	owned := builder.Select("id").From("aster_notes").Where(builder.Eq{"owner_id": ownerID})
	if _, err := s.Where(builder.In("note_id", owned)).Delete(&AsterNoteSegment{}); err != nil {
		return err
	}
	_, err := s.Where("owner_id = ?", ownerID).Delete(&AsterNote{})
	return err
}

type AsterNoteStorage struct {
	Count           int64
	ContentBytes    int64
	TranscriptBytes int64
	TextBytes       int64
}

// AsterNotesStorage reports logical UTF-8 text lengths only, not database blocks.
// The caller authorizes the account; this helper never returns titles or bodies.
func AsterNotesStorage(s *xorm.Session, ownerID int64) (*AsterNoteStorage, error) {
	if ownerID <= 0 {
		return nil, asterNoteError(http.StatusForbidden, "note_human_session_required")
	}
	count, err := s.Where("owner_id = ?", ownerID).Count(&AsterNote{})
	if err != nil {
		return nil, err
	}
	sums, err := s.Where("owner_id = ?", ownerID).SumsInt(&AsterNote{}, "title_bytes", "content_bytes", "transcript_bytes")
	if err != nil {
		return nil, err
	}
	return &AsterNoteStorage{
		Count:           count,
		ContentBytes:    sums[1],
		TranscriptBytes: sums[2],
		TextBytes:       sums[0] + sums[1] + sums[2],
	}, nil
}
