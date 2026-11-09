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
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestAsterNoteCapturedImportHasStableOriginAndIdempotentArticle(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := asterNoteTestCreate(t, s, 1)
	old := asterNoteTestSegment("Legacy sentence", 0, 9000)
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, old))
	require.Nil(t, old.CapturedAt)
	started := time.Date(2026, 11, 9, 7, 8, 9, 123000000, time.UTC)
	input := AsterNoteSegment{
		ClientID:           uuid.NewString(),
		Text:               "A real thought",
		StartMS:            1000,
		EndMS:              3000,
		RecordingID:        uuid.NewString(),
		RecordingStartedAt: &started,
		RecordingOffsetMS:  1000,
		Timezone:           "Asia/Shanghai",
		AppendToArticle:    true,
	}
	request := input
	require.NoError(t, ImportAsterNoteSegment(s, actor, note.ID, &input))
	require.EqualValues(t, 10000, input.StartMS)
	require.EqualValues(t, 12000, input.EndMS)
	require.True(t, input.ArticleAppended)
	require.True(t, input.CapturedAt.Equal(started.Add(time.Second)))
	require.NoError(t, note.ReadOne(s, actor))
	require.EqualValues(t, 2, note.Revision)
	require.Contains(t, note.Content, "2026-11-09 15:08:10 +08:00")
	require.Contains(t, note.Content, "Keep this editorial text.")
	require.NoError(t, ImportAsterNoteSegment(s, actor, note.ID, &request))
	require.Equal(t, input.ID, request.ID)
	require.Equal(t, input.StartMS, request.StartMS)
	require.NoError(t, note.ReadOne(s, actor))
	require.EqualValues(t, 2, note.Revision)
	require.Equal(t, 1, strings.Count(note.Content, "A real thought"))
	stale := *note
	stale.Content = "Overwritten draft"
	stale.ExpectedRevision = 1
	require.EqualError(t, stale.Update(s, actor), "note_revision_conflict")
	next := AsterNoteSegment{
		ClientID:           uuid.NewString(),
		Text:               "Second thought",
		StartMS:            4000,
		EndMS:              5000,
		RecordingID:        input.RecordingID,
		RecordingStartedAt: &started,
		RecordingOffsetMS:  4000,
		Timezone:           "Asia/Shanghai",
	}
	require.NoError(t, ImportAsterNoteSegment(s, actor, note.ID, &next))
	require.EqualValues(t, 13000, next.StartMS)
	bad := request
	bad.Text = "Changed retry"
	require.EqualError(t, ImportAsterNoteSegment(s, actor, note.ID, &bad), "note_segment_conflict")
}

func TestAsterNoteCaptureNeverUsesIngestionTimeAndValidatesClock(t *testing.T) {
	segment := AsterNoteSegment{}
	require.NoError(t, NormalizeAsterNoteCapture(&segment))
	require.Nil(t, segment.CapturedAt)
	started := time.Date(2026, 11, 9, 0, 0, 0, 123456789, time.UTC)
	original := started
	segment.RecordingStartedAt = &started
	segment.RecordingOffsetMS = 1234
	segment.Timezone = "Asia/Shanghai"
	require.NoError(t, NormalizeAsterNoteCapture(&segment))
	require.Equal(t, original, started, "normalization must not mutate shared capture-clock pointers")
	require.Equal(t, original.Truncate(time.Millisecond).Add(1234*time.Millisecond), *segment.CapturedAt)
	mismatched := segment
	mismatch := segment.CapturedAt.Add(time.Second)
	mismatched.CapturedAt = &mismatch
	require.EqualError(t, NormalizeAsterNoteCapture(&mismatched), "note_invalid_capture_time")
	segment.Timezone = "not/a/zone"
	require.EqualError(t, NormalizeAsterNoteCapture(&segment), "note_invalid_capture_time")
}

func TestAsterNoteAutoAppendRetainsRawTextWhenArticleIsFull(t *testing.T) {
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	defer s.Close()
	actor := &user.User{ID: 1}
	note := &AsterNote{
		Title:   "Full article",
		Content: strings.Repeat("x", AsterNoteContentLimit),
	}
	require.NoError(t, note.Create(s, actor))
	segment := asterNoteTestSegment("Never lose this sentence", 0, 1000)
	segment.AppendToArticle = true
	require.NoError(t, AppendAsterNoteSegment(s, actor, note.ID, segment))
	require.False(t, segment.ArticleAppended)
	require.NoError(t, note.ReadOne(s, actor))
	require.EqualValues(t, 1, note.Revision)
	require.EqualValues(t, 1, note.SegmentCount)
	require.Len(t, note.Content, AsterNoteContentLimit)
}
