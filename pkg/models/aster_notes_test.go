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
	"context"
	"fmt"
	"regexp"
	"strings"
	"sync"
	"testing"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	"xorm.io/xorm/contexts"
)

func asterNoteTestCreate(t *testing.T, s *xorm.Session, ownerID int64) *AsterNote {
	t.Helper()
	note := &AsterNote{
		Title:   "Personal research",
		Content: "# Draft\nKeep this editorial text.",
	}
	require.NoError(t, note.Create(s, &user.User{ID: ownerID}))
	return note
}

func asterNoteTestSegment(text string, start, end int64) *AsterNoteSegment {
	return &AsterNoteSegment{
		ClientID: uuid.NewString(),
		Text:     text,
		StartMS:  start,
		EndMS:    end,
	}
}

func TestAsterNoteEditorialAndTranscriptLifecyclesAreIndependent(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	originalContent := note.Content
	stale := *note
	first := asterNoteTestSegment("First final transcript.", 0, 5200)
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, first))
	require.Positive(t, first.ID)
	require.NoError(t, note.ReadOne(s, actor))
	require.EqualValues(t, 1, note.Revision)
	require.Equal(t, originalContent, note.Content)
	require.EqualValues(t, 1, note.SegmentCount)
	require.EqualValues(t, len(first.Text), note.TranscriptBytes)

	// The edit was based on revision 1 before transcription; transcription must not invalidate it.
	stale.Content = "# Edited draft\nA deliberate rewrite."
	stale.ExpectedRevision = stale.Revision
	require.NoError(t, stale.Update(s, actor))
	require.EqualValues(t, 2, stale.Revision)
	second := asterNoteTestSegment("Second final transcript.", 5200, 9300)
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, second))
	require.NoError(t, note.ReadOne(s, actor))
	require.Equal(t, stale.Content, note.Content)
	require.EqualValues(t, 2, note.Revision)
	require.EqualValues(t, 2, note.SegmentCount)
	require.EqualValues(t, len(first.Text)+len(second.Text), note.TranscriptBytes)
	note.ExpectedRevision = note.Revision
	require.NoError(t, note.Update(s, actor))
	require.EqualValues(t, 2, note.Revision, "no-op saves must not invalidate another tab")
	offset, err := AsterNoteRecordingOffset(s, actor, note.ID)
	require.NoError(t, err)
	require.EqualValues(t, 9300, offset)
	stored, err := ListAsterNoteSegments(s, actor, note.ID, 0, 100, false)
	require.NoError(t, err)
	require.EqualValues(t, 2, stored.Total)
	require.Equal(t, first.Text, stored.Items[0].Text)
	require.Equal(t, second.Text, stored.Items[1].Text)
}

func TestAsterNoteRevisionConflictCannotOverwriteLatestDraft(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	old := *note
	note.Content = "Latest intentional draft."
	note.ExpectedRevision = 1
	require.NoError(t, note.Update(s, actor))
	for _, revision := range []int64{
		0,
		1,
		999,
	} {
		attempt := old
		attempt.Content = "Stale competing content."
		attempt.ExpectedRevision = revision
		err := attempt.Update(s, actor)
		require.ErrorContains(t, err, "note_revision_conflict")
		current := &AsterNote{ID: note.ID}
		require.NoError(t, current.ReadOne(s, actor))
		require.Equal(t, note.Content, current.Content)
		require.EqualValues(t, 2, current.Revision)
	}
}

func TestAsterNotePersonalPermissionsDoNotInheritRolesOrShares(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	t.Setenv("ASTERING_SUPERADMIN_IDS", "2")
	s := db.NewSession()
	defer s.Close()
	_, err := s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	for _, principal := range []web.Auth{
		&user.User{
			ID:      2,
			IsAdmin: true,
		},
		&LinkSharing{
			ID:         1,
			ProjectID:  1,
			Permission: PermissionAdmin,
		},
		&user.User{
			ID:         23,
			BotOwnerID: 21,
		},
		user.WithAPITokenCredential(actor, 1),
		user.RestrictToResourcePermissions(actor),
		nil,
	} {
		denied := &AsterNote{ID: note.ID}
		allowed, _, err := denied.CanRead(s, principal)
		require.False(t, allowed)
		require.Error(t, err)
		allowed, err = denied.CanUpdate(s, principal)
		require.False(t, allowed)
		require.Error(t, err)
		allowed, err = denied.CanDelete(s, principal)
		require.False(t, allowed)
		require.Error(t, err)
		require.Error(t, denied.ReadOne(s, principal))
		denied.Title = "Malicious replacement"
		denied.Content = "Not the owner's draft"
		denied.ExpectedRevision = 1
		require.Error(t, denied.Update(s, principal))
		require.Error(t, denied.Delete(s, principal))
		require.Error(t, AppendAsterNoteSegment(s, principal, note.ID, asterNoteTestSegment("wrong owner", 0, 1)))
		_, err = ListAsterNoteSegments(s, principal, note.ID, 0, 100, false)
		require.Error(t, err)
		_, err = ListAsterNoteSegments(s, principal, note.ID, 0, 100, true)
		require.Error(t, err)
		_, err = AsterNoteRecordingOffset(s, principal, note.ID)
		require.Error(t, err)
		_, err = ReadAsterNoteTranscriptState(s, principal, note.ID)
		require.Error(t, err)
	}
	allowed, permission, err := (&AsterNote{ID: note.ID}).CanRead(s, actor)
	require.NoError(t, err)
	require.True(t, allowed)
	require.EqualValues(t, PermissionAdmin, permission)
	allowed, err = (&AsterNote{ID: note.ID}).CanUpdate(s, actor)
	require.NoError(t, err)
	require.True(t, allowed)
	allowed, err = (&AsterNote{ID: note.ID}).CanDelete(s, actor)
	require.NoError(t, err)
	require.True(t, allowed)
	require.NoError(t, note.ReadOne(s, actor))
	require.Equal(t, "Personal research", note.Title)
	rows, _, total, err := (&AsterNote{}).ReadAll(s, &user.User{
		ID:      2,
		IsAdmin: true,
	}, "", 1, 10)
	require.NoError(t, err)
	require.Zero(t, total)
	require.Empty(t, rows)
}

func TestAsterNoteCreateRechecksCurrentHumanAndForcesServerFields(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	for _, principal := range []web.Auth{
		&user.User{ID: 4},
		&user.User{ID: 18},
		&user.User{ID: 23},
		&user.User{ID: 99999},
		&LinkSharing{
			ID:         1,
			Permission: PermissionAdmin,
		},
		user.WithAPITokenCredential(&user.User{ID: 1}, 1),
		nil,
	} {
		note := &AsterNote{Title: "Denied"}
		allowed, err := note.CanCreate(s, principal)
		require.False(t, allowed)
		require.Error(t, err)
		require.Error(t, note.Create(s, principal))
	}
	actor := &user.User{ID: 1}
	note := &AsterNote{
		ID:              300,
		OwnerID:         2,
		Title:           "  Controlled fields  ",
		Content:         "plain markdown",
		Revision:        999,
		SegmentCount:    100,
		TranscriptBytes: 999,
	}
	allowed, err := note.CanCreate(s, actor)
	require.NoError(t, err)
	require.True(t, allowed)
	require.NoError(t, note.Create(s, actor))
	require.NotEqualValues(t, 300, note.ID)
	require.EqualValues(t, 1, note.OwnerID)
	require.EqualValues(t, 1, note.Revision)
	require.Zero(t, note.TranscriptBytes)
	require.Zero(t, note.SegmentCount)
	note.OwnerID = 2
	note.ExpectedRevision = 1
	note.Pinned = true
	require.NoError(t, note.Update(s, actor))
	require.EqualValues(t, 1, note.OwnerID)
}

func TestAsterNoteSegmentIdempotencyNeverDuplicatesOrRewritesText(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	segment := asterNoteTestSegment("Retain the original final text.", 100, 200)
	segment.TimingEstimated = true
	original := *segment
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, segment))
	for range 3 {
		retry := original
		require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, &retry))
		require.Equal(t, segment.ID, retry.ID)
		require.Equal(t, segment.Created, retry.Created)
	}
	for _, mutation := range []func(*AsterNoteSegment){
		func(value *AsterNoteSegment) { value.Text = "Changed after reconnect" },
		func(value *AsterNoteSegment) { value.StartMS++ },
		func(value *AsterNoteSegment) { value.EndMS++ },
		func(value *AsterNoteSegment) { value.TimingEstimated = !value.TimingEstimated },
	} {
		retry := original
		mutation(&retry)
		require.ErrorContains(t, AppendAsterNoteSegment(s, actor, note.ID, &retry), "note_segment_conflict")
	}
	require.NoError(t, note.ReadOne(s, actor))
	require.EqualValues(t, 1, note.SegmentCount)
	require.EqualValues(t, len(original.Text), note.TranscriptBytes)
	otherNote := asterNoteTestCreate(t, s, actor.ID)
	retry := original
	require.NoError(t, AppendAsterNoteSegment(s, actor, otherNote.ID, &retry), "idempotency keys are scoped to their note")
	require.NotEqual(t, retry.ID, segment.ID)
}

func TestAsterNoteForwardCursorAndMaximumRecordingOffset(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	other := asterNoteTestCreate(t, s, actor.ID)
	first := asterNoteTestSegment("First", 0, 10000)
	second := asterNoteTestSegment("Second arriving later with an earlier timestamp", 1, 5000)
	third := asterNoteTestSegment("Third", 11000, 12000)
	for _, target := range []struct {
		id      int64
		segment *AsterNoteSegment
	}{
		{
			id:      note.ID,
			segment: first,
		},
		{
			id:      other.ID,
			segment: asterNoteTestSegment("Another note", 0, 999999),
		},
		{
			id:      note.ID,
			segment: second,
		},
		{
			id:      note.ID,
			segment: third,
		},
	} {
		require.NoError(t, AppendAsterNoteSegment(s, actor, target.id, target.segment))
	}
	page, err := ListAsterNoteSegments(s, actor, note.ID, 0, 2, false)
	require.NoError(t, err)
	require.EqualValues(t, 3, page.Total)
	require.True(t, page.HasMore)
	require.Equal(t, []*AsterNoteSegment{
		first,
		second,
	}, page.Items)
	require.Equal(t, second.ID, page.NextCursor)
	next, err := ListAsterNoteSegments(s, actor, note.ID, page.NextCursor, 2, false)
	require.NoError(t, err)
	require.False(t, next.HasMore)
	require.Equal(t, []*AsterNoteSegment{third}, next.Items)
	empty, err := ListAsterNoteSegments(s, actor, note.ID, next.NextCursor, 2, false)
	require.NoError(t, err)
	require.Empty(t, empty.Items)
	require.Equal(t, next.NextCursor, empty.NextCursor)
	offset, err := AsterNoteRecordingOffset(s, actor, note.ID)
	require.NoError(t, err)
	require.EqualValues(t, 12000, offset)
	_, err = ListAsterNoteSegments(s, actor, note.ID, -1, 2, false)
	require.Error(t, err)
}

//nolint:gosmopolitan // Persist and account for real UTF-8 text rather than ASCII-only lengths.
func TestAsterNoteListingSearchAndLogicalStorage(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := &AsterNote{
		Title:   "研究记录",
		Content: "# 方向\n持续创造",
		Pinned:  true,
	}
	require.NoError(t, note.Create(s, actor))
	second := &AsterNote{
		Title:   "Unpinned",
		Content: "Searchable unique passage",
	}
	require.NoError(t, second.Create(s, actor))
	outsider := asterNoteTestCreate(t, s, 2)
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, asterNoteTestSegment("原始转录", 0, 500)))
	items, _, total, err := (&AsterNote{}).ReadAll(s, actor, "", 1, 1)
	require.NoError(t, err)
	require.EqualValues(t, 2, total)
	rows := items.([]*AsterNote)
	require.Len(t, rows, 1)
	require.Equal(t, note.ID, rows[0].ID)
	require.Empty(t, rows[0].Content, "the list must not load every long Markdown body")
	require.NotEmpty(t, rows[0].Excerpt)
	items, _, total, err = (&AsterNote{}).ReadAll(s, actor, "unique passage", 1, 10)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	require.Equal(t, second.ID, items.([]*AsterNote)[0].ID)
	pinned := false
	_, _, total, err = (&AsterNote{FilterPinned: &pinned}).ReadAll(s, actor, "", 1, 10)
	require.NoError(t, err)
	require.EqualValues(t, 1, total)
	usage, err := AsterNotesStorage(s, actor.ID)
	require.NoError(t, err)
	require.EqualValues(t, 2, usage.Count)
	require.EqualValues(t, len(note.Content)+len(second.Content), usage.ContentBytes)
	require.EqualValues(t, len("原始转录"), usage.TranscriptBytes)
	require.EqualValues(t, len(note.Title)+len(second.Title)+len(note.Content)+len(second.Content)+len("原始转录"), usage.TextBytes)
	require.NoError(t, note.Delete(s, actor))
	require.NoError(t, outsider.ReadOne(s, &user.User{ID: 2}))
	count, err := s.Where("note_id = ?", note.ID).Count(&AsterNoteSegment{})
	require.NoError(t, err)
	require.Zero(t, count)
	usage, err = AsterNotesStorage(s, actor.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, usage.Count)
	require.Zero(t, usage.TranscriptBytes)
}

func TestAsterNoteInvalidSegmentsAndContentAreRejected(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	for _, invalid := range []*AsterNoteSegment{
		nil,
		{
			ClientID: "provider-item-id",
			Text:     "text",
		},
		{
			ClientID: uuid.Nil.String(),
			Text:     "text",
		},
		{
			ClientID: uuid.NewString(),
			Text:     "  ",
		},
		{
			ClientID: uuid.NewString(),
			Text:     "text",
			StartMS:  -1,
		},
		{
			ClientID: uuid.NewString(),
			Text:     "text",
			StartMS:  50,
			EndMS:    49,
		},
		{
			ClientID: uuid.NewString(),
			Text:     strings.Repeat("x", AsterNoteSegmentLimit+1),
		},
	} {
		require.Error(t, AppendAsterNoteSegment(s, actor, note.ID, invalid))
	}
	for _, invalid := range []AsterNote{
		{Title: "   "},
		{Title: "bad\ntitle"},
		{Title: strings.Repeat("x", 251)},
		{
			Title:   "valid",
			Content: strings.Repeat("x", AsterNoteContentLimit+1),
		},
	} {
		require.Error(t, invalid.Create(s, actor))
	}
	count, err := s.Where("note_id = ?", note.ID).Count(&AsterNoteSegment{})
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestAsterNoteRevokedSessionCannotSaveLateTranscript(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	actor := user.WithSessionCredential(&user.User{ID: 2}, "550e8400-e29b-41d4-a716-446655440003")
	seed := db.NewSession()
	note := asterNoteTestCreate(t, seed, actor.ID)
	require.NoError(t, seed.Commit())
	require.NoError(t, seed.Close())
	revoke := db.NewSession()
	_, err := revoke.Where("id = ?", actor.CredentialScope().SessionID).Delete(&Session{})
	require.NoError(t, err)
	require.NoError(t, revoke.Commit())
	require.NoError(t, revoke.Close())
	s := db.NewSession()
	defer s.Close()
	require.Error(t, AppendAsterNoteSegment(s, actor, note.ID, asterNoteTestSegment("Late final", 0, 1)))
	stale := *note
	stale.ExpectedRevision = 1
	stale.Content = "Late save"
	require.Error(t, stale.Update(s, actor))
	count, err := s.Where("note_id = ?", note.ID).Count(&AsterNoteSegment{})
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestAsterNoteAccountDeletionRemovesOnlyOwnedNotesAndSegments(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	notifications.Fake()
	t.Cleanup(notifications.Unfake)
	seed := db.NewSession()
	owned := asterNoteTestCreate(t, seed, 6)
	other := asterNoteTestCreate(t, seed, 1)
	require.NoError(t, AppendAsterNoteSegment(seed, &user.User{ID: 6}, owned.ID, asterNoteTestSegment("Deleted owner's final", 0, 100)))
	require.NoError(t, AppendAsterNoteSegment(seed, &user.User{ID: 1}, other.ID, asterNoteTestSegment("Other owner's final", 0, 200)))
	require.NoError(t, seed.Commit())
	require.NoError(t, seed.Close())
	deletion := db.NewSession()
	require.NoError(t, DeleteUser(deletion, &user.User{ID: 6}))
	require.NoError(t, deletion.Commit())
	require.NoError(t, deletion.Close())
	db.AssertMissing(t, "aster_notes", map[string]interface{}{"id": owned.ID})
	db.AssertMissing(t, "aster_note_segments", map[string]interface{}{"note_id": owned.ID})
	db.AssertExists(t, "aster_notes", map[string]interface{}{"id": other.ID}, false)
	db.AssertExists(t, "aster_note_segments", map[string]interface{}{"note_id": other.ID}, false)
	s := db.NewSession()
	defer s.Close()
	require.Error(t, AppendAsterNoteSegment(s, &user.User{ID: 6}, owned.ID, asterNoteTestSegment("Cannot resurrect deleted content", 0, 1)))
}

type asterNoteProjectionKey struct{}
type asterNoteProjectionProbe struct {
	queries []string
}
type asterNoteProjectionObserver struct{}

var asterNoteProjectionObserverOnce sync.Once

func (asterNoteProjectionObserver) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	probe, _ := c.Ctx.Value(asterNoteProjectionKey{}).(*asterNoteProjectionProbe)
	query := strings.ToLower(strings.TrimSpace(c.SQL))
	if probe != nil && strings.HasPrefix(query, "select ") && strings.Contains(query, "aster_notes") {
		probe.queries = append(probe.queries, query)
	}
	return c.Ctx, nil
}
func (asterNoteProjectionObserver) AfterProcess(*contexts.ContextHook) error { return nil }

func TestAsterNoteTranscriptOperationsNeverLoadLargeEditableContent(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	content := strings.Repeat("R", AsterNoteContentLimit)
	note := &AsterNote{
		Title:   "Large research notes",
		Content: content,
	}
	require.NoError(t, note.Create(s, actor))
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	asterNoteProjectionObserverOnce.Do(func() { engine.AddHook(asterNoteProjectionObserver{}) })
	probe := &asterNoteProjectionProbe{}
	ctx := context.WithValue(context.Background(), asterNoteProjectionKey{}, probe)
	db.SetSessionContext(ctx, s)
	contentColumn := regexp.MustCompile(`\bcontent\b`)
	assertMetadataOnly := func(operation func()) {
		t.Helper()
		probe.queries = nil
		operation()
		require.NotEmpty(t, probe.queries, "the operation must actually authorize/read the note")
		for _, query := range probe.queries {
			projection := strings.SplitN(query, " from ", 2)[0]
			require.NotContains(t, projection, "*", "a wildcard would silently fetch the full article")
			require.False(t, contentColumn.MatchString(projection), "transcript metadata fetched editable article: %s", query)
		}
	}
	assertMetadataOnly(func() {
		allowed, _, err := note.CanRead(s, actor)
		require.NoError(t, err)
		require.True(t, allowed)
		allowed, err = note.CanUpdate(s, actor)
		require.NoError(t, err)
		require.True(t, allowed)
		allowed, err = note.CanDelete(s, actor)
		require.NoError(t, err)
		require.True(t, allowed)
	})
	assertMetadataOnly(func() {
		final := asterNoteTestSegment("A compact final transcript", 0, 1500)
		require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, final))
		state, err := ReadAsterNoteTranscriptState(s, actor, note.ID)
		require.NoError(t, err)
		require.EqualValues(t, 1, state.SegmentCount)
		require.EqualValues(t, len(final.Text), state.TranscriptBytes)
		require.False(t, state.Updated.IsZero())
	})
	assertMetadataOnly(func() {
		offset, err := AsterNoteRecordingOffset(s, actor, note.ID)
		require.NoError(t, err)
		require.EqualValues(t, 1500, offset)
		page, err := ListAsterNoteSegments(s, actor, note.ID, 0, 100, false)
		require.NoError(t, err)
		require.Len(t, page.Items, 1)
	})
	full := &AsterNote{ID: note.ID}
	require.NoError(t, full.ReadOne(s, actor))
	require.Equal(t, content, full.Content, "explicit article reads must retain the complete Markdown")
	full.Title = "Renamed without losing the article"
	full.ExpectedRevision = full.Revision
	require.NoError(t, full.Update(s, actor))
	require.Equal(t, content, full.Content)
	require.EqualValues(t, 2, full.Revision)
	require.EqualValues(t, 1, full.SegmentCount)
	assertMetadataOnly(func() { require.NoError(t, note.Delete(s, actor)) })
	_, err = ReadAsterNoteTranscriptState(s, actor, note.ID)
	require.ErrorContains(t, err, "note_not_found")
}

//nolint:gosmopolitan // Preview length and whitespace must preserve Unicode semantics.
func TestAsterNoteExcerptPreservesUnicodeWhitespaceAndBoundaries(t *testing.T) {
	for _, test := range []struct {
		name    string
		content string
		want    string
	}{
		{
			name: "empty",
		},
		{
			name:    "only Unicode whitespace",
			content: " \t\n\u00a0\u2009\u3000\r ",
		},
		{
			name:    "fold every Unicode whitespace without changing Markdown punctuation",
			content: "\t # 标题\n\n  保留\u00a0👩‍🔬\u2009研究\u3000方向 \r\n",
			want:    "# 标题 保留 👩‍🔬 研究 方向",
		},
		{
			name:    "exactly 180 multibyte runes",
			content: strings.Repeat("星", 180),
			want:    strings.Repeat("星", 180),
		},
		{
			name:    "truncate before the 181st Unicode rune",
			content: strings.Repeat("星", 179) + "🌠尾部不能出现",
			want:    strings.Repeat("星", 179) + "🌠",
		},
		{
			name:    "a normalized separator may be the 180th character",
			content: strings.Repeat("x", 179) + "\n\u3000 next word",
			want:    strings.Repeat("x", 179) + " ",
		},
		{
			name:    "trailing whitespace does not invent a final separator",
			content: strings.Repeat("x", 179) + "\n\u3000\t",
			want:    strings.Repeat("x", 179),
		},
		{
			name:    "maximum article keeps a short preview and complete byte count",
			content: strings.Repeat("x", AsterNoteContentLimit),
			want:    strings.Repeat("x", 180),
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			note := &AsterNote{
				Title:   "Preview test",
				Content: test.content,
			}
			require.NoError(t, note.normalize())
			require.Equal(t, test.want, note.Excerpt)
			require.True(t, utf8.ValidString(note.Excerpt))
			require.LessOrEqual(t, utf8.RuneCountInString(note.Excerpt), 180)
			require.EqualValues(t, len(test.content), note.ContentBytes)
			require.Equal(t, test.content, note.Content)
		})
	}
}

func TestAsterNoteRollbackKeepsTranscriptCountersAndDeletionAtomic(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	actor := &user.User{ID: 1}
	seed := db.NewSession()
	note := asterNoteTestCreate(t, seed, actor.ID)
	first := asterNoteTestSegment("The committed final", 0, 1000)
	require.NoError(t, AppendAsterNoteSegment(seed, actor, note.ID, first))
	require.NoError(t, seed.Commit())
	require.NoError(t, seed.Close())
	uncommitted := db.NewSession()
	second := asterNoteTestSegment("Must not survive rollback", 1000, 2000)
	require.NoError(t, AppendAsterNoteSegment(uncommitted, actor, note.ID, second))
	state, err := ReadAsterNoteTranscriptState(uncommitted, actor, note.ID)
	require.NoError(t, err)
	require.EqualValues(t, 2, state.SegmentCount)
	require.NoError(t, uncommitted.Rollback())
	require.NoError(t, uncommitted.Close())
	check := db.NewReadSession()
	state, err = ReadAsterNoteTranscriptState(check, actor, note.ID)
	require.NoError(t, err)
	require.EqualValues(t, 1, state.SegmentCount)
	require.EqualValues(t, len(first.Text), state.TranscriptBytes)
	page, err := ListAsterNoteSegments(check, actor, note.ID, 0, 100, false)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, first.ID, page.Items[0].ID)
	require.NoError(t, check.Close())

	deletion := db.NewSession()
	require.NoError(t, note.Delete(deletion, actor))
	require.NoError(t, deletion.Rollback())
	require.NoError(t, deletion.Close())
	check = db.NewReadSession()
	defer check.Close()
	require.NoError(t, note.ReadOne(check, actor))
	require.EqualValues(t, 1, note.SegmentCount)
	require.EqualValues(t, len(first.Text), note.TranscriptBytes)
	page, err = ListAsterNoteSegments(check, actor, note.ID, 0, 100, false)
	require.NoError(t, err)
	require.Len(t, page.Items, 1)
	require.Equal(t, first.ID, page.Items[0].ID)
}

func TestAsterNoteLatestTranscriptPageSkipsLongHistoryAndOtherOwners(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, actor.ID)
	other := asterNoteTestCreate(t, s, 2)
	const count = 10007
	rows := make([]*AsterNoteSegment, 0, count*2)
	var ownBytes int64
	for index := 0; index < count; index++ {
		text := fmt.Sprintf("Own record %05d", index)
		ownBytes += int64(len(text))
		rows = append(rows,
			&AsterNoteSegment{
				NoteID:   note.ID,
				ClientID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index*2+1),
				Text:     text,
				StartMS:  int64(index) * 1000,
				EndMS:    int64(index+1) * 1000,
			},
			&AsterNoteSegment{
				NoteID:   other.ID,
				ClientID: fmt.Sprintf("00000000-0000-4000-8000-%012d", index*2+2),
				Text:     "Another owner's private words",
			},
		)
	}
	// Stay below even SQLite's conservative parameter limit when seeding a long history.
	for start := 0; start < len(rows); start += 100 {
		end := min(start+100, len(rows))
		_, err := s.Insert(rows[start:end])
		require.NoError(t, err)
	}
	_, err := s.ID(note.ID).Cols("segment_count", "transcript_bytes").Update(&AsterNote{
		SegmentCount:    count,
		TranscriptBytes: ownBytes,
	})
	require.NoError(t, err)
	_, err = s.ID(other.ID).Cols("segment_count", "transcript_bytes").Update(&AsterNote{
		SegmentCount:    count,
		TranscriptBytes: int64(count * len("Another owner's private words")),
	})
	require.NoError(t, err)
	latest, err := ListAsterNoteSegments(s, actor, note.ID, 0, 100, true)
	require.NoError(t, err)
	require.True(t, latest.FromEnd)
	require.False(t, latest.HasMore)
	require.EqualValues(t, count, latest.Total)
	require.Len(t, latest.Items, 100)
	for index, segment := range latest.Items {
		require.Equal(t, note.ID, segment.NoteID)
		require.Equal(t, fmt.Sprintf("Own record %05d", count-100+index), segment.Text)
		if index > 0 {
			require.Greater(t, segment.ID, latest.Items[index-1].ID+1, "cursor IDs are sparse because another note's rows are interleaved")
		}
	}
	require.Equal(t, latest.Items[99].ID, latest.NextCursor)
	first, err := ListAsterNoteSegments(s, actor, note.ID, 0, 100, false)
	require.NoError(t, err)
	require.False(t, first.FromEnd)
	require.True(t, first.HasMore)
	require.Equal(t, "Own record 00000", first.Items[0].Text)
	require.Equal(t, "Own record 00099", first.Items[99].Text)
	small, err := ListAsterNoteSegments(s, actor, note.ID, 0, 2, true)
	require.NoError(t, err)
	require.Len(t, small.Items, 2)
	require.Equal(t, fmt.Sprintf("Own record %05d", count-2), small.Items[0].Text)
	require.Equal(t, latest.NextCursor, small.NextCursor)
	_, err = ListAsterNoteSegments(s, actor, note.ID, 1, 100, true)
	require.ErrorContains(t, err, "note_invalid_cursor")
	_, err = ListAsterNoteSegments(s, &user.User{ID: 2}, note.ID, 0, 100, true)
	require.ErrorContains(t, err, "note_not_found")
	empty := asterNoteTestCreate(t, s, actor.ID)
	emptyLatest, err := ListAsterNoteSegments(s, actor, empty.ID, 0, 100, true)
	require.NoError(t, err)
	require.True(t, emptyLatest.FromEnd)
	require.False(t, emptyLatest.HasMore)
	require.Zero(t, emptyLatest.Total)
	require.Zero(t, emptyLatest.NextCursor)
	require.Empty(t, emptyLatest.Items)
}
