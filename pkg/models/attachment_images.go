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

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/richtext"
	"xorm.io/xorm"
)

// Called while holding the task row lock. Old editor drafts cannot restore an
// image whose task attachment has been detached. Cross-task references remain intact.
func cleanTaskAttachmentImages(s *xorm.Session, taskID int64, source string) (string, error) {
	if !strings.Contains(source, "attachments/") {
		return source, nil
	}
	attachments := []TaskAttachment{}
	if err := s.Where("task_id = ?", taskID).Cols("id").Find(&attachments); err != nil {
		return "", err
	}
	available := map[int64]bool{}
	for _, a := range attachments {
		available[a.ID] = true
	}
	return richtext.FilterAttachmentImages(source, config.ServicePublicURL.GetString(), func(tid, aid int64) bool { return tid == taskID && !available[aid] }, config.ServiceAPIURL.GetString()), nil
}
