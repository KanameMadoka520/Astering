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
	"archive/zip"
	"encoding/json"
	"fmt"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/xorm"
)

// Export notes as bounded JSONL streams so months of transcription do not turn
// the account export into an unbounded in-memory text collection.
func exportAsterNotes(s *xorm.Session, owner *user.User, archive *zip.Writer) error {
	cursor := int64(0)
	for {
		note := &AsterNote{}
		found, err := s.Where("owner_id = ? AND id > ?", owner.ID, cursor).OrderBy("id ASC").Limit(1).Get(note)
		if err != nil {
			return err
		}
		if !found {
			return nil
		}
		cursor = note.ID
		prefix := fmt.Sprintf("notes/%d/", note.ID)
		out, err := archive.Create(prefix + "note.json")
		if err != nil {
			return err
		}
		if err = json.NewEncoder(out).Encode(note); err != nil {
			return err
		}
		out, err = archive.Create(prefix + "transcript.jsonl")
		if err != nil {
			return err
		}
		encoder := json.NewEncoder(out)
		segmentCursor := int64(0)
		for {
			rows := []*AsterNoteSegment{}
			if err = s.Where("note_id = ? AND id > ?", note.ID, segmentCursor).OrderBy("id ASC").Limit(100).Find(&rows); err != nil {
				return err
			}
			for _, segment := range rows {
				if err = encoder.Encode(segment); err != nil {
					return err
				}
				segmentCursor = segment.ID
			}
			if len(rows) < 100 {
				break
			}
		}
		job := &AsterNoteOrganization{}
		found, err = s.Where("owner_id = ? AND note_id = ?", owner.ID, note.ID).OrderBy("id DESC").Limit(1).Get(job)
		if err != nil {
			return err
		}
		if found {
			out, err = archive.Create(prefix + "organization.json")
			if err != nil {
				return err
			}
			// Never export the original credential/session identifier or model API key.
			snapshot := struct {
				Job           *AsterNoteOrganization `json:"job"`
				SourceArticle string                 `json:"source_article,omitempty"`
				Checkpoint    string                 `json:"checkpoint,omitempty"`
			}{
				job,
				job.SourceArticle,
				job.Work,
			}
			if err = json.NewEncoder(out).Encode(snapshot); err != nil {
				return err
			}
		}
	}
}
