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
	"fmt"
	"math"
	"net/http"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/google/uuid"
	"xorm.io/xorm"
)

// NormalizeAsterNoteCapture validates capture metadata before a live provider is started.
func NormalizeAsterNoteCapture(segment *AsterNoteSegment) error {
	bad := func() error { return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_capture_time") }
	if segment.RecordingID != "" {
		id, err := uuid.Parse(segment.RecordingID)
		if err != nil || id == uuid.Nil {
			return bad()
		}
		segment.RecordingID = id.String()
	}
	if segment.RecordingOffsetMS < 0 || segment.RecordingOffsetMS > math.MaxInt64/int64(time.Millisecond) {
		return bad()
	}
	if len(segment.Timezone) > 80 || segment.Timezone == "Local" {
		return bad()
	}
	if segment.Timezone != "" {
		if _, err := time.LoadLocation(segment.Timezone); err != nil {
			return bad()
		}
	}
	for index, value := range []*time.Time{
		segment.CapturedAt,
		segment.RecordingStartedAt,
	} {
		if value == nil {
			continue
		}
		if value.Year() < 1970 || value.Year() > 9998 {
			return bad()
		}
		normalized := value.UTC().Truncate(time.Millisecond)
		if index == 0 {
			segment.CapturedAt = &normalized
		} else {
			segment.RecordingStartedAt = &normalized
		}
	}
	if segment.RecordingStartedAt != nil {
		derived := segment.RecordingStartedAt.Add(time.Duration(segment.RecordingOffsetMS) * time.Millisecond)
		if derived.Year() > 9998 {
			return bad()
		}
		if segment.CapturedAt != nil && !segment.CapturedAt.Equal(derived) {
			return bad()
		}
		segment.CapturedAt = &derived
	} else if segment.RecordingOffsetMS != 0 {
		return bad()
	}
	return nil
}

// ImportAsterNoteSegment gives an offline capture run one stable position on the
// note's cumulative timeline. The capture clock remains independent. Retries map
// back to the existing run origin before checking their immutable payload.
func ImportAsterNoteSegment(s *xorm.Session, a web.Auth, noteID int64, segment *AsterNoteSegment) error {
	if segment == nil {
		return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_segment")
	}
	if _, err := loadOwnedAsterNote(s, a, noteID, true, false); err != nil {
		return err
	}
	if err := validateAsterNoteSegment(segment); err != nil {
		return err
	}
	if segment.RecordingID != "" {
		first := &AsterNoteSegment{}
		found, err := s.Where("note_id = ? AND recording_id = ?", noteID, segment.RecordingID).OrderBy("id ASC").Limit(1).Get(first)
		if err != nil {
			return err
		}
		origin := int64(0)
		if found {
			origin = first.StartMS - first.RecordingOffsetMS
		} else {
			origin, err = AsterNoteRecordingOffset(s, a, noteID)
			if err != nil {
				return err
			}
		}
		duration := segment.EndMS - segment.StartMS
		if origin < 0 || segment.RecordingOffsetMS > math.MaxInt64-origin || duration > math.MaxInt64-origin-segment.RecordingOffsetMS {
			return asterNoteError(http.StatusUnprocessableEntity, "note_invalid_segment_time")
		}
		segment.StartMS = origin + segment.RecordingOffsetMS
		segment.EndMS = segment.StartMS + duration
	}
	return AppendAsterNoteSegment(s, a, noteID, segment)
}

func sameAsterNoteTime(a, b *time.Time) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && a.Equal(*b))
}

func sameAsterNoteCapture(a, b *AsterNoteSegment) bool {
	return a.RecordingID == b.RecordingID && sameAsterNoteTime(a.RecordingStartedAt, b.RecordingStartedAt) &&
		a.RecordingOffsetMS == b.RecordingOffsetMS && sameAsterNoteTime(a.CapturedAt, b.CapturedAt) && a.Timezone == b.Timezone && a.AppendToArticle == b.AppendToArticle
}

func asterNoteCapturedText(segment *AsterNoteSegment) string {
	label := fmt.Sprintf("+%02d:%02d:%02d", segment.StartMS/3600000, (segment.StartMS/60000)%60, (segment.StartMS/1000)%60)
	if segment.CapturedAt != nil {
		zone := time.UTC
		if segment.Timezone != "" {
			if parsed, err := time.LoadLocation(segment.Timezone); err == nil {
				zone = parsed
			}
		}
		label = segment.CapturedAt.In(zone).Format("2006-01-02 15:04:05 -07:00")
	}
	// Markdown hard breaks preserve raw sentence lines without interpreting them as
	// executable HTML. The article renderer applies its normal sanitization.
	return "[" + label + "] " + strings.ReplaceAll(segment.Text, "\n", "  \n")
}
