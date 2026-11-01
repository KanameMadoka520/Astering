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
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAttachmentImageLifecycle(t *testing.T) {
	oldURL := config.ServicePublicURL.GetString()
	config.ServicePublicURL.Set("https://task.test/")
	t.Cleanup(func() { config.ServicePublicURL.Set(oldURL) })
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			files.InitTestFileFixtures(t)
			s := db.NewSession()
			defer s.Close()
			original := `<p>meeting notes</p><img data-src="https://task.test/api/v2/tasks/1/attachments/1" src="#"><img src="https://outside.test/image.png">`
			remaining := `<p>meeting notes</p><img src="https://outside.test/image.png">`
			_, err := s.ID(1).Cols("description", "cover_image_attachment_id").Update(&Task{Description: original, CoverImageAttachmentID: 1})
			require.NoError(t, err)
			comment := &TaskComment{TaskID: 1, AuthorID: 1, Comment: original}
			_, err = s.Insert(comment)
			require.NoError(t, err)
			require.NoError(t, s.Commit())
			s = db.NewSession()
			defer s.Close()
			a := &TaskAttachment{ID: 1, TaskID: 1}
			require.NoError(t, a.Delete(s, &user.User{ID: 1}))
			exists, err := s.ID(1).Exist(&TaskAttachment{})
			require.NoError(t, err)
			require.False(t, exists, "attachment row removed")
			var task Task
			_, err = s.ID(1).Get(&task)
			require.NoError(t, err)
			assert.Equal(t, remaining, task.Description)
			assert.Zero(t, task.CoverImageAttachmentID)
			var stored TaskComment
			_, err = s.ID(comment.ID).Get(&stored)
			require.NoError(t, err)
			assert.Equal(t, remaining, stored.Comment)
			// A stale comment edit must not restore the deleted image either.
			stored.Comment = original
			require.NoError(t, stored.Update(s, &user.User{ID: 1}))
			assert.Equal(t, remaining, stored.Comment)
			// A stale editor save must not restore a deleted attachment image.
			task.Description = original
			require.NoError(t, task.updateSingleTask(s, &user.User{ID: 1}, []string{"description"}))
			assert.Equal(t, remaining, task.Description)
			if rollback {
				require.NoError(t, s.Rollback())
				events.CleanupPending(s)
			} else {
				require.NoError(t, s.Commit())
				events.DispatchPending(t.Context(), s)
			}
			s2 := db.NewSession()
			defer s2.Close()
			var after Task
			_, err = s2.ID(1).Get(&after)
			require.NoError(t, err)
			if rollback {
				assert.Equal(t, original, after.Description)
				assert.Equal(t, int64(1), after.CoverImageAttachmentID)
			} else {
				assert.Equal(t, remaining, after.Description)
				assert.Zero(t, after.CoverImageAttachmentID)
			}
			_, err = files.FileStat(a.File)
			require.NoError(t, err, "shared file must survive")
		})
	}
}

func TestAttachmentImageLifecycleSplitOrigins(t *testing.T) {
	for _, rollback := range []bool{false, true} {
		t.Run(map[bool]string{false: "commit", true: "rollback"}[rollback], func(t *testing.T) {
			db.LoadAndAssertFixtures(t)
			files.InitTestFileFixtures(t)
			oldPublic, oldAPI := config.ServicePublicURL.GetString(), config.ServiceAPIURL.GetString()
			config.ServicePublicURL.Set("https://frontend.test/app/")
			config.ServiceAPIURL.Set("https://api.test:8443/backend/api/v2/")
			t.Cleanup(func() {
				config.ServicePublicURL.Set(oldPublic)
				config.ServiceAPIURL.Set(oldAPI)
			})
			remaining := `<p>meeting notes</p><img src="https://outside.test/backend/api/v2/tasks/1/attachments/1"><img src="https://api.test:8443/backend/api/v2/tasks/2/attachments/1">`
			original := remaining + `<img data-src="https://api.test:8443/backend/api/v2/tasks/1/attachments/1" src="#">`
			s := db.NewSession()
			defer s.Close()
			_, err := s.ID(1).Cols("description", "cover_image_attachment_id").Update(&Task{Description: original, CoverImageAttachmentID: 1})
			require.NoError(t, err)
			comment := &TaskComment{TaskID: 1, AuthorID: 1, Comment: original}
			_, err = s.Insert(comment)
			require.NoError(t, err)
			require.NoError(t, s.Commit())

			mutation := db.NewSession()
			defer mutation.Close()
			attachment := &TaskAttachment{ID: 1, TaskID: 1}
			require.NoError(t, attachment.Delete(mutation, &user.User{ID: 1}))
			var task Task
			_, err = mutation.ID(1).Get(&task)
			require.NoError(t, err)
			assert.Equal(t, remaining, task.Description)
			assert.Zero(t, task.CoverImageAttachmentID)
			var savedComment TaskComment
			_, err = mutation.ID(comment.ID).Get(&savedComment)
			require.NoError(t, err)
			assert.Equal(t, remaining, savedComment.Comment)
			// Old tabs cannot restore the deleted image through either writer.
			task.Description = original
			require.NoError(t, task.updateSingleTask(mutation, &user.User{ID: 1}, []string{"description"}))
			assert.Equal(t, remaining, task.Description)
			savedComment.Comment = original
			require.NoError(t, savedComment.Update(mutation, &user.User{ID: 1}))
			assert.Equal(t, remaining, savedComment.Comment)
			if rollback {
				require.NoError(t, mutation.Rollback())
				events.CleanupPending(mutation)
			} else {
				require.NoError(t, mutation.Commit())
				events.DispatchPending(t.Context(), mutation)
			}
			read := db.NewReadSession()
			defer read.Close()
			var persisted Task
			_, err = read.ID(1).Get(&persisted)
			require.NoError(t, err)
			if rollback {
				assert.Equal(t, original, persisted.Description)
				assert.Equal(t, int64(1), persisted.CoverImageAttachmentID)
			} else {
				assert.Equal(t, remaining, persisted.Description)
				assert.Zero(t, persisted.CoverImageAttachmentID)
			}
			_, err = files.FileStat(attachment.File)
			require.NoError(t, err, "shared Drive source must survive")
		})
	}
}
