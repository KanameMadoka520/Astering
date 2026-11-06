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
	"bytes"
	"fmt"
	"math"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func projectVersionFixture(t *testing.T) (*xorm.Session, *user.User, *Project, *Task) {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	t.Cleanup(func() { events.CleanupPending(s); require.NoError(t, s.Close()) })
	owner := &user.User{ID: 1}
	p := &Project{Title: "Saved project"}
	require.NoError(t, p.Create(s, owner))
	task := &Task{
		Title:       "Saved task",
		Description: "<p>Saved body</p>",
		ProjectID:   p.ID,
	}
	require.NoError(t, task.Create(s, owner))
	return s, owner, p, task
}
func versionTestRestore(t *testing.T, s *xorm.Session, a *user.User, pid, vid int64, request string) *ProjectVersionRestoreResult {
	t.Helper()
	plan, err := PreviewProjectVersion(s, a, pid, vid, 1, 100)
	require.NoError(t, err)
	require.Empty(t, plan.Conflicts)
	result, err := RestoreProjectVersion(s, a, pid, vid, ProjectVersionRestoreInput{
		ExpectedCurrentHash: plan.CurrentHash,
		PlanHash:            plan.PlanHash,
		RequestID:           request,
	})
	require.NoError(t, err)
	require.True(t, result.Verified)
	return result
}
func versionTestAttachment(t *testing.T, s *xorm.Session, a *user.User, taskID int64, name string) *TaskAttachment {
	t.Helper()
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte("original file bytes")), name, 0, a)
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	attachment := &TaskAttachment{
		TaskID:      taskID,
		FileID:      f.ID,
		File:        f,
		CreatedByID: a.ID,
	}
	_, err = s.Insert(attachment)
	require.NoError(t, err)
	return attachment
}
func TestProjectVersionsDeduplicatesContentAndKeepsSequenceMonotonic(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	first, err := CreateProjectVersion(s, a, p.ID, "First checkpoint", "core-dedup-save-first")
	require.NoError(t, err)
	require.Positive(t, first.NewObjectBytes)
	second, err := CreateProjectVersion(s, a, p.ID, "Same content", "core-dedup-save-second")
	require.NoError(t, err)
	require.Equal(t, first.ContentHash, second.ContentHash)
	require.Zero(t, second.NewObjectBytes)
	require.NoError(t, DeleteProjectVersion(s, a, p.ID, second.ID, second.Name))
	task.Title = "Only this content changes"
	require.NoError(t, task.Update(s, a))
	third, err := CreateProjectVersion(s, a, p.ID, "Changed task", "core-dedup-save-third")
	require.NoError(t, err)
	require.Greater(t, third.Sequence, second.Sequence)
	require.NotEqual(t, third.ContentHash, first.ContentHash)
	require.Positive(t, third.NewObjectBytes)
	require.Less(t, third.NewObjectBytes, first.NewObjectBytes)
	retried, err := CreateProjectVersion(s, a, p.ID, "Changed task", "core-dedup-save-third")
	require.NoError(t, err)
	require.Equal(t, third.ID, retried.ID)
}
func TestProjectVersionsRestoresBoardAndInlineMediaWithoutRemovingLaterCommentImages(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	view := &ProjectView{}
	exists, err := s.Where("project_id = ? AND view_kind = ?", p.ID, ProjectViewKindKanban).Get(view)
	require.NoError(t, err)
	require.True(t, exists)
	bucket := &Bucket{
		Title:         "Saved stage",
		ProjectID:     p.ID,
		ProjectViewID: view.ID,
		Position:      321,
	}
	require.NoError(t, bucket.Create(s, a))
	placement := &TaskBucket{
		ProjectID:     p.ID,
		TaskID:        task.ID,
		ProjectViewID: view.ID,
		BucketID:      bucket.ID,
	}
	require.NoError(t, placement.Update(s, a))
	original := versionTestAttachment(t, s, a, task.ID, "saved-original.png")
	task.Description = fmt.Sprintf("<p>Saved <img src=\"/api/v2/tasks/%d/attachments/%d\"></p>", task.ID, original.ID)
	task.CoverImageAttachmentID = original.ID
	require.NoError(t, task.Update(s, a))
	checkpoint, err := CreateProjectVersion(s, a, p.ID, "Board and image", "core-board-image-save")
	require.NoError(t, err)
	require.NoError(t, original.Delete(s, a))
	// Attachment deletion authoritatively clears the persisted cover and body
	// image. Continue editing that result instead of resubmitting stale fields.
	reloadedTask := &Task{}
	exists, err = s.ID(task.ID).Get(reloadedTask)
	require.NoError(t, err)
	require.True(t, exists)
	task = reloadedTask
	later := versionTestAttachment(t, s, a, task.ID, "later-comment.png")
	comment := &TaskComment{
		TaskID:  task.ID,
		Comment: fmt.Sprintf("<p>Later fact <img src=\"/api/v2/tasks/%d/attachments/%d\"></p>", task.ID, later.ID),
	}
	require.NoError(t, comment.Create(s, a))
	bucket.Title = "Changed stage"
	require.NoError(t, bucket.Update(s, a))
	task.Title = "Changed title"
	require.NoError(t, task.Update(s, a))
	_, err = s.ID(original.FileID).Cols("name").Update(&files.File{Name: "renamed-shared-original.png"})
	require.NoError(t, err)
	preview, err := PreviewProjectVersion(s, a, p.ID, checkpoint.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, preview.Preserved.CommentAttachments)
	result := versionTestRestore(t, s, a, p.ID, checkpoint.ID, "core-board-image-restore")
	require.Contains(t, result.ChangedTaskIDs, task.ID)
	restored := &Task{}
	exists, err = s.ID(task.ID).Get(restored)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, "Saved task", restored.Title)
	mapped := result.IDMap.Attachments[fmt.Sprint(original.ID)]
	require.Positive(t, mapped)
	require.Contains(t, restored.Description, fmt.Sprintf("/api/v2/tasks/%d/attachments/%d", task.ID, mapped))
	require.Equal(t, mapped, restored.CoverImageAttachmentID)
	kept, err := s.ID(later.ID).Exist(new(TaskAttachment))
	require.NoError(t, err)
	require.True(t, kept)
	readComment := &TaskComment{}
	exists, err = s.ID(comment.ID).Get(readComment)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, comment.Comment, readComment.Comment)
	f := &files.File{ID: original.FileID}
	require.NoError(t, f.LoadFileMetaByID(s))
	require.Equal(t, "renamed-shared-original.png", f.Name)
	restoredBucket := &Bucket{}
	exists, err = s.ID(bucket.ID).Get(restoredBucket)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, "Saved stage", restoredBucket.Title)
	savedEntity, err := ReadProjectVersionEntity(s, a, p.ID, checkpoint.ID, "task", fmt.Sprint(task.ID))
	require.NoError(t, err)
	require.Contains(t, savedEntity.Content["description"], fmt.Sprintf("/api/v2/projects/%d/versions/%d/files/%d", p.ID, checkpoint.ID, original.FileID))
	require.NotContains(t, savedEntity.Content["description"], fmt.Sprintf("/attachments/%d", original.ID))
}

func TestProjectVersionsRestoresDeletedViewsAndOnlyTheirLegacyOrphanBuckets(t *testing.T) {
	for _, tc := range []struct {
		name       string
		orphanView string
		conflict   bool
	}{
		{name: "deleted view removes its buckets"},
		{
			name:       "legacy buckets still reference the saved deleted view",
			orphanView: "saved",
		},
		{
			name:       "unrelated orphan identity is not reclaimed",
			orphanView: "missing",
			conflict:   true,
		},
		{
			name:       "another project's view is not reclaimed",
			orphanView: "foreign",
			conflict:   true,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			s, a, p, task := projectVersionFixture(t)
			view := &ProjectView{}
			exists, err := s.Where("project_id = ? AND view_kind = ?", p.ID, ProjectViewKindKanban).Get(view)
			require.NoError(t, err)
			require.True(t, exists)
			buckets := []*Bucket{}
			require.NoError(t, s.Where("project_view_id = ?", view.ID).OrderBy("position, id").Find(&buckets))
			require.NotEmpty(t, buckets)
			placement := &TaskBucket{
				ProjectID:     p.ID,
				TaskID:        task.ID,
				ProjectViewID: view.ID,
				BucketID:      buckets[0].ID,
			}
			require.NoError(t, placement.Update(s, a))
			checkpoint, err := CreateProjectVersion(s, a, p.ID, "Before deleting a board", "deleted-view-checkpoint")
			require.NoError(t, err)
			temporary := &ProjectView{
				ProjectID: p.ID,
				Title:     "Temporary list",
				ViewKind:  ProjectViewKindList,
			}
			require.NoError(t, temporary.Create(s, a))
			require.NoError(t, view.Delete(s, a))
			count, err := s.Where("project_view_id = ?", view.ID).Count(new(Bucket))
			require.NoError(t, err)
			require.Zero(t, count, "deleting a view must remove its bucket rows in the same transaction")
			if tc.orphanView != "" {
				orphanViewID := view.ID
				switch tc.orphanView {
				case "missing":
					orphanViewID += 100000
				case "foreign":
					other := &Project{Title: "Independent project"}
					require.NoError(t, other.Create(s, a))
					foreign := &ProjectView{}
					exists, err = s.Where("project_id = ? AND view_kind = ?", other.ID, ProjectViewKindKanban).Get(foreign)
					require.NoError(t, err)
					require.True(t, exists)
					orphanViewID = foreign.ID
				}
				// Existing installations can contain these rows because the old
				// view delete removed placements but left the buckets behind.
				for _, bucket := range buckets {
					bucket.ProjectViewID = orphanViewID
					_, err = s.Insert(bucket)
					require.NoError(t, err)
				}
			}
			plan, err := PreviewProjectVersion(s, a, p.ID, checkpoint.ID, 1, 100)
			require.NoError(t, err)
			if tc.conflict {
				require.False(t, plan.CanRestore)
				require.Contains(t, plan.Conflicts, ProjectVersionConflict{
					Code:     "project_version_bucket_moved",
					Kind:     "bucket",
					EntityID: fmt.Sprint(buckets[0].ID),
					Message:  "A saved bucket identity now belongs to another project.",
				})
				_, err = RestoreProjectVersion(s, a, p.ID, checkpoint.ID, ProjectVersionRestoreInput{
					ExpectedCurrentHash: plan.CurrentHash,
					PlanHash:            plan.PlanHash,
					RequestID:           "deleted-view-rejected-restore",
				})
				require.Error(t, err)
				return
			}
			require.True(t, plan.CanRestore)
			require.Empty(t, plan.Conflicts)
			result, err := RestoreProjectVersion(s, a, p.ID, checkpoint.ID, ProjectVersionRestoreInput{
				ExpectedCurrentHash: plan.CurrentHash,
				PlanHash:            plan.PlanHash,
				RequestID:           "deleted-view-reviewed-restore",
			})
			require.NoError(t, err)
			require.True(t, result.Verified)
			mappedViewID := result.IDMap.Views[fmt.Sprint(view.ID)]
			require.Positive(t, mappedViewID)
			require.NotEqual(t, view.ID, mappedViewID)
			for _, bucket := range buckets {
				mappedBucketID := result.IDMap.Buckets[fmt.Sprint(bucket.ID)]
				restored := &Bucket{}
				exists, err = s.ID(mappedBucketID).Get(restored)
				require.NoError(t, err)
				require.True(t, exists)
				require.Equal(t, mappedViewID, restored.ProjectViewID)
				require.Equal(t, bucket.Title, restored.Title)
				if tc.orphanView == "saved" {
					require.Equal(t, bucket.ID, mappedBucketID, "the known legacy bucket keeps its identity")
				}
			}
			restoredPlacement := &TaskBucket{}
			exists, err = s.Where("task_id = ? AND project_view_id = ?", task.ID, mappedViewID).Get(restoredPlacement)
			require.NoError(t, err)
			require.True(t, exists)
			require.Equal(t, result.IDMap.Buckets[fmt.Sprint(placement.BucketID)], restoredPlacement.BucketID)
		})
	}
}
func TestProjectVersionsEntityReadsCurrentOnlyAndRestrictsMovedEntities(t *testing.T) {
	s, a, p, _ := projectVersionFixture(t)
	checkpoint, err := CreateProjectVersion(s, a, p.ID, "Before later work", "core-entity-save-initial")
	require.NoError(t, err)
	later := &Task{
		Title:       "Later task",
		ProjectID:   p.ID,
		Description: "Only this project",
	}
	require.NoError(t, later.Create(s, a))
	entity, err := ReadProjectVersionEntity(s, a, p.ID, checkpoint.ID, "task", fmt.Sprint(later.ID))
	require.NoError(t, err)
	require.Nil(t, entity.Content)
	require.Equal(t, later.Title, entity.CurrentContent["title"])
	foreign := &Project{Title: "Other project"}
	require.NoError(t, foreign.Create(s, a))
	later.ProjectID = foreign.ID
	require.NoError(t, later.Update(s, a))
	_, err = ReadProjectVersionEntity(s, a, p.ID, checkpoint.ID, "task", fmt.Sprint(later.ID))
	require.Error(t, err)
	_, _, err = ListProjectVersionEntities(s, a, p.ID, checkpoint.ID, "task", 1, 100)
	require.NoError(t, err)
}

func TestProjectVersionsRevivesSoftDeletedTaskKeepingOnlySavedAndCommentAttachments(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	original := versionTestAttachment(t, s, a, task.ID, "saved-before-deletion.png")
	saved, err := CreateProjectVersion(s, a, p.ID, "Before later attachments", "core-soft-task-media-save")
	require.NoError(t, err)
	commentImage := versionTestAttachment(t, s, a, task.ID, "later-comment-fact.png")
	unused := versionTestAttachment(t, s, a, task.ID, "later-unused-attachment.png")
	comment := &TaskComment{
		TaskID:  task.ID,
		Comment: fmt.Sprintf(`<p>Retained fact <img src="/api/v2/tasks/%d/attachments/%d"></p>`, task.ID, commentImage.ID),
	}
	require.NoError(t, comment.Create(s, a))
	require.NoError(t, task.Delete(s, a))
	active, err := s.ID(task.ID).Exist(new(Task))
	require.NoError(t, err)
	require.False(t, active)
	preview, err := PreviewProjectVersion(s, a, p.ID, saved.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, 1, preview.Preserved.CommentAttachments)
	result := versionTestRestore(t, s, a, p.ID, saved.ID, "core-soft-task-media-restore")
	require.Equal(t, task.ID, result.IDMap.Tasks[fmt.Sprint(task.ID)])
	active, err = s.ID(task.ID).Exist(new(Task))
	require.NoError(t, err)
	require.True(t, active)
	var attachmentIDs []int64
	require.NoError(t, s.Table(new(TaskAttachment)).Cols("id").Where("task_id = ?", task.ID).Find(&attachmentIDs))
	require.ElementsMatch(t, []int64{
		original.ID,
		commentImage.ID,
	}, attachmentIDs)
	readComment := &TaskComment{}
	exists, err := s.ID(comment.ID).Get(readComment)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, comment.Comment, readComment.Comment)
	// Removing a relationship does not delete its reusable Drive original.
	exists, err = s.ID(unused.FileID).Exist(new(files.File))
	require.NoError(t, err)
	require.True(t, exists)
}
func TestProjectVersionsAutomaticNamesStayWithinStorageLimit(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	name := strings.Repeat("\u661f", 160)
	checkpoint, err := CreateProjectVersion(s, a, p.ID, name, "core-long-name-save")
	require.NoError(t, err)
	task.Title = "Change"
	require.NoError(t, task.Update(s, a))
	result := versionTestRestore(t, s, a, p.ID, checkpoint.ID, "core-long-name-restore")
	require.LessOrEqual(t, len([]rune(result.Version.Name)), 160)
}

func TestProjectVersionsReconstructsAbsentTaskIdentityWithoutRewindingIndexes(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	task.Description = fmt.Sprintf(`<p>Stable link <a href="/tasks/%d">self</a></p>`, task.ID)
	require.NoError(t, task.Update(s, a))
	saved, err := CreateProjectVersion(s, a, p.ID, "Before original row was lost", "core-absent-task-save")
	require.NoError(t, err)
	later := &Task{
		Title:     "Later identity",
		ProjectID: p.ID,
	}
	require.NoError(t, later.Create(s, a))
	// Simulate an absent legacy row. Ordinary soft deletion and the expiry cron
	// cannot remove a version-pinned row, and are covered independently.
	_, err = s.Unscoped().ID(task.ID).Delete(new(Task))
	require.NoError(t, err)
	result := versionTestRestore(t, s, a, p.ID, saved.ID, "core-absent-task-restore")
	require.Equal(t, task.ID, result.IDMap.Tasks[fmt.Sprint(task.ID)])
	row := &Task{}
	exists, err := s.ID(task.ID).Get(row)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, task.Title, row.Title)
	require.Equal(t, task.Description, row.Description)
	require.Greater(t, row.Index, later.Index)
	require.Equal(t, task.CreatedByID, row.CreatedByID)
}

func TestProjectVersionsMissingOriginalBytesPreventsRestoreWithoutPartialWrites(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	attachment := versionTestAttachment(t, s, a, task.ID, "missing-later.txt")
	saved, err := CreateProjectVersion(s, a, p.ID, "Original still existed", "core-missing-original-save")
	require.NoError(t, err)
	require.NoError(t, files.DeleteBlob(attachment.FileID))
	preview, err := PreviewProjectVersion(s, a, p.ID, saved.ID, 1, 100)
	require.NoError(t, err)
	require.False(t, preview.CanRestore)
	require.NotEmpty(t, preview.Conflicts)
	require.Equal(t, "project_version_file_missing", preview.Conflicts[0].Code)
	_, before, err := ListProjectVersions(s, a, p.ID, 1, 100)
	require.NoError(t, err)
	_, err = RestoreProjectVersion(s, a, p.ID, saved.ID, ProjectVersionRestoreInput{
		ExpectedCurrentHash: preview.CurrentHash,
		PlanHash:            preview.PlanHash,
		RequestID:           "core-missing-original-restore",
	})
	require.Error(t, err)
	_, after, err := ListProjectVersions(s, a, p.ID, 1, 100)
	require.NoError(t, err)
	require.Equal(t, before, after)
}
func TestProjectVersionsRestoreRequestIDRejectsChangedInput(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	saved, err := CreateProjectVersion(s, a, p.ID, "Original", "core-request-signature-save")
	require.NoError(t, err)
	task.Title = "Changed"
	require.NoError(t, task.Update(s, a))
	plan, err := PreviewProjectVersion(s, a, p.ID, saved.ID, 1, 100)
	require.NoError(t, err)
	request := ProjectVersionRestoreInput{
		ExpectedCurrentHash: plan.CurrentHash,
		PlanHash:            plan.PlanHash,
		RequestID:           "core-restore-same-request",
	}
	first, err := RestoreProjectVersion(s, a, p.ID, saved.ID, request)
	require.NoError(t, err)
	retry, err := RestoreProjectVersion(s, a, p.ID, saved.ID, request)
	require.NoError(t, err)
	require.Equal(t, first.Version.ID, retry.Version.ID)
	request.PlanHash = strings.Repeat("0", 64)
	_, err = RestoreProjectVersion(s, a, p.ID, saved.ID, request)
	require.Error(t, err)
	_, count, err := ListProjectVersions(s, a, p.ID, 1, 100)
	require.NoError(t, err)
	require.EqualValues(t, 3, count)
}

func TestProjectVersionsLargePagesReturnEmptyWithoutLosingTotals(t *testing.T) {
	s, a, p, task := projectVersionFixture(t)
	saved, err := CreateProjectVersion(s, a, p.ID, "Pagination boundary", "core-large-page-save")
	require.NoError(t, err)
	task.Title = "A real difference"
	require.NoError(t, task.Update(s, a))
	first, err := PreviewProjectVersion(s, a, p.ID, saved.ID, 1, 100)
	require.NoError(t, err)
	require.NotEmpty(t, first.Changes.Items)
	page := int(^uint(0) >> 1)
	preview, err := PreviewProjectVersion(s, a, p.ID, saved.ID, page, 100)
	require.NoError(t, err)
	require.Empty(t, preview.Changes.Items)
	require.Equal(t, first.Changes.Total, preview.Changes.Total)
	require.Equal(t, first.PlanHash, preview.PlanHash)
	versions, total, err := ListProjectVersions(s, a, p.ID, page, 100)
	require.NoError(t, err)
	require.Empty(t, versions)
	require.EqualValues(t, 1, total)
	entities, total, err := ListProjectVersionEntities(s, a, p.ID, saved.ID, "", page, 100)
	require.NoError(t, err)
	require.Empty(t, entities)
	require.Positive(t, total)
}

func TestProjectVersionsReferencedFileSizeOverflow(t *testing.T) {
	version := &ProjectVersion{ReferencedFileBytes: math.MaxInt64 - 1}
	require.NoError(t, addProjectVersionFileSize(version, 1))
	require.Equal(t, int64(math.MaxInt64), version.ReferencedFileBytes)
	require.Error(t, addProjectVersionFileSize(version, 1))
	require.Equal(t, int64(math.MaxInt64), version.ReferencedFileBytes)

	version.ReferencedFileBytes = 0
	require.Error(t, addProjectVersionFileSize(version, uint64(math.MaxInt64)+1))
	require.Zero(t, version.ReferencedFileBytes)
}
