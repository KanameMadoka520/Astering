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
	"encoding/json"
	"fmt"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/license"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

// These tests deliberately use the public model boundary. They independently
// verify access, retained facts, and media lifetime rather than reproducing the
// snapshot encoder's own implementation.
func projectVersionAuditFixture(t *testing.T) (*xorm.Session, *user.User, *Project, *Task) {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	files.InitTestFileFixtures(t)
	s := db.NewSession()
	t.Cleanup(func() {
		events.CleanupPending(s)
		require.NoError(t, s.Close())
	})
	owner := &user.User{ID: 1}
	project := &Project{Title: "Version security boundary", Description: "Original project content"}
	require.NoError(t, project.Create(s, owner))
	task := &Task{Title: "Original task", Description: "Original task body", ProjectID: project.ID}
	require.NoError(t, task.Create(s, owner))
	return s, owner, project, task
}

func projectVersionAuditTask(t *testing.T, s *xorm.Session, id int64) *Task {
	t.Helper()
	row := &Task{}
	exists, err := s.Unscoped().ID(id).Get(row)
	require.NoError(t, err)
	require.True(t, exists)
	return row
}

func projectVersionAuditFile(t *testing.T, s *xorm.Session, ownerID int64, drive bool) *files.File {
	t.Helper()
	f, err := files.CreateWithSession(s, bytes.NewReader([]byte("project history media bytes")), "history-media.txt", 0, &user.User{ID: ownerID})
	require.NoError(t, err)
	if drive {
		require.NoError(t, files.AddToDrive(s, f))
	}
	return f
}

func projectVersionAuditJSON(t *testing.T, value any) string {
	t.Helper()
	data, err := json.Marshal(value)
	require.NoError(t, err)
	return string(data)
}

func projectVersionAuditRestore(t *testing.T, s *xorm.Session, owner *user.User, projectID, versionID int64, requestID string) *ProjectVersionRestoreResult {
	t.Helper()
	plan, err := PreviewProjectVersion(s, owner, projectID, versionID, 1, 25)
	require.NoError(t, err)
	require.Empty(t, plan.Conflicts)
	require.True(t, plan.CanRestore)
	result, err := RestoreProjectVersion(s, owner, projectID, versionID, ProjectVersionRestoreInput{
		ExpectedCurrentHash: plan.CurrentHash,
		PlanHash:            plan.PlanHash,
		RequestID:           requestID,
	})
	require.NoError(t, err)
	require.True(t, result.Verified)
	return result
}

func TestProjectVersionsSecurityCurrentPermissions(t *testing.T) {
	s, owner, project, _ := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Original content", "audit-save-permissions")
	require.NoError(t, err)
	stranger := &user.User{ID: 2}
	_, _, err = ListProjectVersions(s, stranger, project.ID, 1, 25)
	require.Error(t, err)
	_, err = ReadProjectVersion(s, stranger, project.ID, version.ID)
	require.Error(t, err)
	_, err = PreviewProjectVersion(s, stranger, project.ID, version.ID, 1, 25)
	require.Error(t, err)
	_, err = CreateProjectVersion(s, stranger, project.ID, "Unauthorized checkpoint", "audit-denied-save-1")
	require.Error(t, err)

	_, err = s.Insert(&ProjectUser{ProjectID: project.ID, UserID: 2, Permission: PermissionRead})
	require.NoError(t, err)
	_, err = ReadProjectVersion(s, stranger, project.ID, version.ID)
	require.NoError(t, err)
	plan, err := PreviewProjectVersion(s, stranger, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.False(t, plan.CanRestore)
	_, err = CreateProjectVersion(s, stranger, project.ID, "Read-only checkpoint", "audit-denied-save-2")
	require.Error(t, err)
	_, err = RestoreProjectVersion(s, stranger, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-denied-restore"})
	require.Error(t, err)
	require.Error(t, DeleteProjectVersion(s, stranger, project.ID, version.ID, version.Name))

	_, err = s.Where("project_id = ? AND user_id = ?", project.ID, 2).Cols("permission").Update(&ProjectUser{Permission: PermissionWrite})
	require.NoError(t, err)
	_, err = CreateProjectVersion(s, stranger, project.ID, "Writer checkpoint", "audit-writer-save-1")
	require.NoError(t, err)
	plan, err = PreviewProjectVersion(s, stranger, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.False(t, plan.CanRestore)
	require.Error(t, DeleteProjectVersion(s, stranger, project.ID, version.ID, version.Name))

	// A version ID cannot be used under a different project URL.
	other := &Project{Title: "Another project"}
	require.NoError(t, other.Create(s, owner))
	_, err = ReadProjectVersion(s, owner, other.ID, version.ID)
	require.Error(t, err)
	_, err = PreviewProjectVersion(s, owner, other.ID, version.ID, 1, 25)
	require.Error(t, err)
}

func TestProjectVersionsSecurityAgentCannotBorrowAdministratorAccess(t *testing.T) {
	s, owner, project, _ := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Private checkpoint", "audit-private-save")
	require.NoError(t, err)
	license.SetForTests([]license.Feature{license.FeatureAdminPanel})
	t.Cleanup(license.ResetForTests)
	_, err = s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	admin := &user.User{ID: 2, IsAdmin: true}
	_, err = ReadProjectVersion(s, admin, project.ID, version.ID)
	require.NoError(t, err, "ordinary licensed administration follows the existing project access policy")
	scoped := user.RestrictToResourcePermissions(admin)
	_, _, err = ListProjectVersions(s, scoped, project.ID, 1, 25)
	require.Error(t, err)
	_, err = ReadProjectVersion(s, scoped, project.ID, version.ID)
	require.Error(t, err)
	_, err = CreateProjectVersion(s, scoped, project.ID, "Agent checkpoint", "audit-agent-denied")
	require.Error(t, err)
	_, err = PreviewProjectVersion(s, scoped, project.ID, version.ID, 1, 25)
	require.Error(t, err)
}

func TestProjectVersionsSecurityShareLinksDoNotExposeHistoricalContent(t *testing.T) {
	s, owner, project, _ := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Private checkpoint", "audit-link-private")
	require.NoError(t, err)
	share := &LinkSharing{ID: 1, ProjectID: project.ID, Permission: PermissionAdmin}
	_, _, err = ListProjectVersions(s, share, project.ID, 1, 25)
	require.Error(t, err)
	_, err = ReadProjectVersion(s, share, project.ID, version.ID)
	require.Error(t, err)
	_, err = PreviewProjectVersion(s, share, project.ID, version.ID, 1, 25)
	require.Error(t, err)
	_, err = CreateProjectVersion(s, share, project.ID, "Public checkpoint", "audit-link-denied")
	require.Error(t, err)
}

func TestProjectVersionsSecurityStaleRestoreAndReceipt(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Initial content", "audit-stale-save-1")
	require.NoError(t, err)
	task.Title = "After the checkpoint"
	require.NoError(t, task.Update(s, owner))
	plan, err := PreviewProjectVersion(s, owner, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	_, countBefore, err := ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)

	task.Title = "A newer edit after the reviewed plan"
	require.NoError(t, task.Update(s, owner))
	_, err = RestoreProjectVersion(s, owner, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-stale-restore"})
	require.Error(t, err)
	require.Equal(t, task.Title, projectVersionAuditTask(t, s, task.ID).Title)
	_, countAfter, err := ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)
	require.Equal(t, countBefore, countAfter, "a rejected restore must not save partial safety checkpoints")

	plan, err = PreviewProjectVersion(s, owner, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	_, err = RestoreProjectVersion(s, owner, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: strings.Repeat("0", 64), RequestID: "audit-plan-tampered"})
	require.Error(t, err)
	require.Equal(t, task.Title, projectVersionAuditTask(t, s, task.ID).Title)
	request := ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-restore-receipt"}
	first, err := RestoreProjectVersion(s, owner, project.ID, version.ID, request)
	require.NoError(t, err)
	require.True(t, first.Verified)
	_, countBefore, err = ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)
	second, err := RestoreProjectVersion(s, owner, project.ID, version.ID, request)
	require.NoError(t, err)
	require.Equal(t, first.BeforeVersionID, second.BeforeVersionID)
	require.Equal(t, first.Version.ID, second.Version.ID)
	_, countAfter, err = ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)
	require.Equal(t, countBefore, countAfter, "retrying a committed restore must not create duplicate history")
	// The automatic checkpoint before restore makes the operation reversible.
	projectVersionAuditRestore(t, s, owner, project.ID, first.BeforeVersionID, "audit-reverse-restore")
	require.Equal(t, task.Title, projectVersionAuditTask(t, s, task.ID).Title)
}

func TestProjectVersionsSecurityRestoreKeepsCurrentGrantsAndFacts(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Before later activity", "audit-facts-save-1")
	require.NoError(t, err)
	_, err = s.Insert(&ProjectUser{ProjectID: project.ID, UserID: 2, Permission: PermissionRead})
	require.NoError(t, err)
	comment := &TaskComment{TaskID: task.ID, Comment: "A later collaborative comment"}
	require.NoError(t, comment.Create(s, owner))
	later := &Task{Title: "Task created after checkpoint", ProjectID: project.ID}
	require.NoError(t, later.Create(s, owner))
	laterComment := &TaskComment{TaskID: later.ID, Comment: "A retained fact on a later task"}
	require.NoError(t, laterComment.Create(s, owner))
	routine := &TaskRoutine{TaskID: later.ID, Enabled: true, Timezone: "UTC"}
	require.NoError(t, routine.Update(s, owner))
	_, err = SetTaskRoutineCheckin(s, owner, later.ID, routine.Date, true)
	require.NoError(t, err)
	// Period progress is a separate factual table and must be retained as well.
	progress := &TaskRoutineProgress{TaskID: later.ID, ScheduleKey: "audit-preserved-fact", LocalDate: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), Period: "daily", Timezone: "UTC", PeriodStartAt: time.Date(2026, 1, 1, 0, 0, 0, 0, time.UTC), PeriodEndAt: time.Date(2026, 1, 2, 0, 0, 0, 0, time.UTC), Amount: 2, Target: 3, Unit: "sessions", UpdatedByID: owner.ID}
	_, err = s.Insert(progress)
	require.NoError(t, err)
	task.Title = "Later changed content"
	require.NoError(t, task.Update(s, owner))
	result := projectVersionAuditRestore(t, s, owner, project.ID, version.ID, "audit-facts-restore")
	require.Equal(t, "Original task", projectVersionAuditTask(t, s, task.ID).Title)
	require.Contains(t, result.RemovedTaskIDs, later.ID)
	require.False(t, projectVersionAuditTask(t, s, later.ID).DeletedAt.IsZero())
	for _, fact := range []struct {
		model any
		id    int64
	}{{&TaskComment{}, comment.ID}, {&TaskComment{}, laterComment.ID}, {&TaskRoutineProgress{}, progress.ID}} {
		exists, getErr := s.ID(fact.id).Exist(fact.model)
		require.NoError(t, getErr)
		require.True(t, exists)
	}
	count, err := s.Where("task_id = ?", later.ID).Count(&TaskRoutineCheckin{})
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
	grant := &ProjectUser{}
	exists, err := s.Where("project_id = ? AND user_id = ?", project.ID, 2).Get(grant)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, PermissionRead, grant.Permission)
	// A legitimate future cleanup is a different transaction, after restoration
	// and its safety checkpoint have durably committed.
	require.NoError(t, s.Commit())
	deleteExpiredTasks(time.Now().Add(TaskDeleteRetention + 48*time.Hour))
	check := db.NewReadSession()
	defer check.Close()
	require.False(t, projectVersionAuditTask(t, check, later.ID).DeletedAt.IsZero())
	for _, fact := range []struct {
		model any
		id    int64
	}{{&TaskComment{}, laterComment.ID}, {&TaskRoutineProgress{}, progress.ID}} {
		exists, err = check.ID(fact.id).Exist(fact.model)
		require.NoError(t, err)
		require.True(t, exists, "retained facts must survive the ordinary task garbage collector")
	}
	count, err = check.Where("task_id = ?", later.ID).Count(&TaskRoutineCheckin{})
	require.NoError(t, err)
	require.EqualValues(t, 1, count)
}

func TestProjectVersionsSecurityHistoryPinsOriginalFilesWithoutCopying(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	f := projectVersionAuditFile(t, s, owner.ID, true)
	attachment, err := AttachDriveFile(s, owner, f.ID, 1, task.ID)
	require.NoError(t, err)
	secondTask := &Task{Title: "Reuses the same original", ProjectID: project.ID}
	require.NoError(t, secondTask.Create(s, owner))
	item, err := GetDriveItem(s, owner, f.ID)
	require.NoError(t, err)
	secondAttachment, err := AttachDriveFile(s, owner, f.ID, item.Revision, secondTask.ID)
	require.NoError(t, err)
	fileCountBefore, err := s.Count(&files.File{})
	require.NoError(t, err)
	version, err := CreateProjectVersion(s, owner, project.ID, "With shared media", "audit-media-save-1")
	require.NoError(t, err)
	require.EqualValues(t, 2, version.AttachmentCount)
	require.EqualValues(t, 1, version.FileCount)
	duplicate, err := CreateProjectVersion(s, owner, project.ID, "Same content", "audit-media-save-2")
	require.NoError(t, err)
	require.Zero(t, duplicate.NewObjectBytes, "unchanged checkpoint entities should reuse compressed content objects")
	fileCountAfter, err := s.Count(&files.File{})
	require.NoError(t, err)
	require.Equal(t, fileCountBefore, fileCountAfter, "checkpoints must reference original files instead of copying them")
	require.NoError(t, attachment.Delete(s, owner))
	require.NoError(t, secondAttachment.Delete(s, owner))
	item, err = GetDriveItem(s, owner, f.ID)
	require.NoError(t, err)
	item, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: item.Revision, Action: "trash", Confirm: true})
	require.NoError(t, err)
	_, err = ChangeDriveItem(s, owner, f.ID, DriveChange{Revision: item.Revision, Action: "purge", Confirm: true, ConfirmName: f.Name})
	require.ErrorIs(t, err, ErrDriveInUse)
	require.NoError(t, f.LoadFileMetaByID(s))
	// A history reference also protects older uploads that never had a Drive row.
	legacy := projectVersionAuditFile(t, s, owner.ID, false)
	legacyAttachment := &TaskAttachment{TaskID: task.ID, FileID: legacy.ID, CreatedByID: owner.ID}
	_, err = s.Insert(legacyAttachment)
	require.NoError(t, err)
	_, err = CreateProjectVersion(s, owner, project.ID, "Legacy media", "audit-media-legacy")
	require.NoError(t, err)
	require.NoError(t, legacyAttachment.Delete(s, owner))
	require.NoError(t, legacy.Delete(s))
	require.NoError(t, legacy.DeleteOnCommit(s))
	require.NoError(t, legacy.LoadFileMetaByID(s))
	require.NoError(t, legacy.LoadFileByID())
	require.NoError(t, legacy.File.Close())
}

func TestProjectVersionsSecurityAccountCleanupKeepsHistoryOnlyFile(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	f := projectVersionAuditFile(t, s, 4, true)
	// Collaborator uploads may be shared with a task while remaining owned by
	// the uploader. Removing that account must not destroy a surviving project's
	// historical original, even after its live attachment was removed.
	attachment := &TaskAttachment{TaskID: task.ID, FileID: f.ID, CreatedByID: 4}
	_, err := s.Insert(attachment)
	require.NoError(t, err)
	_, err = CreateProjectVersion(s, owner, project.ID, "Shared upload", "audit-deleted-uploader")
	require.NoError(t, err)
	require.NoError(t, attachment.Delete(s, owner))
	_, err = s.ID(4).Delete(&user.User{})
	require.NoError(t, err)
	used, err := deletedAccountFileReferenced(s, f.ID)
	require.NoError(t, err)
	require.True(t, used)
	require.NoError(t, s.Commit())
	require.NoError(t, cleanupDeletedAccountFile(4, f.ID))
	check := db.NewReadSession()
	defer check.Close()
	require.NoError(t, f.LoadFileMetaByID(check))
	require.NoError(t, f.LoadFileByID())
	require.NoError(t, f.File.Close())
}

func TestProjectVersionsSecurityMovedTaskCannotBeTakenFromAnotherProject(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Before task moved", "audit-before-move")
	require.NoError(t, err)
	otherOwner := &user.User{ID: 2}
	other := &Project{Title: "Private destination project"}
	require.NoError(t, other.Create(s, otherOwner))
	_, err = s.Insert(&ProjectUser{ProjectID: other.ID, UserID: owner.ID, Permission: PermissionWrite})
	require.NoError(t, err)
	task.ProjectID = other.ID
	require.NoError(t, task.Update(s, owner))
	task.Title = "Private content written after move"
	require.NoError(t, task.Update(s, otherOwner))
	_, err = s.Where("project_id = ? AND user_id = ?", other.ID, owner.ID).Delete(&ProjectUser{})
	require.NoError(t, err)
	plan, err := PreviewProjectVersion(s, owner, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.False(t, plan.CanRestore)
	require.NotEmpty(t, plan.Conflicts)
	require.NotContains(t, projectVersionAuditJSON(t, plan), task.Title)
	require.NotContains(t, projectVersionAuditJSON(t, plan), other.Title)
	_, countBefore, err := ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)
	_, err = RestoreProjectVersion(s, owner, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-do-not-steal-task"})
	require.Error(t, err)
	current := projectVersionAuditTask(t, s, task.ID)
	require.Equal(t, other.ID, current.ProjectID)
	require.Equal(t, task.Title, current.Title)
	_, countAfter, err := ListProjectVersions(s, owner, project.ID, 1, 25)
	require.NoError(t, err)
	require.Equal(t, countBefore, countAfter)
}

func TestProjectVersionsSecurityRestoreDoesNotReuseOldConfigurationRevisions(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	routine := &TaskRoutine{TaskID: task.ID, Enabled: true, Timezone: "UTC"}
	require.NoError(t, routine.Update(s, owner))
	notice := &ProjectAnnouncement{ProjectID: project.ID, Title: "Initial notice", Content: "<p>Initial content</p>"}
	require.NoError(t, notice.Update(s, owner))
	version, err := CreateProjectVersion(s, owner, project.ID, "Initial configuration", "audit-config-save-1")
	require.NoError(t, err)
	routine.Timezone = "Asia/Shanghai"
	require.NoError(t, routine.Update(s, owner))
	lastRoutineRevision := routine.Revision
	notice.Title = "Changed notice"
	require.NoError(t, notice.Update(s, owner))
	lastNoticeRevision := notice.Revision
	projectVersionAuditRestore(t, s, owner, project.ID, version.ID, "audit-config-restore")
	require.NoError(t, routine.ReadOne(s, owner))
	require.NoError(t, notice.ReadOne(s, owner))
	require.Equal(t, "UTC", routine.Timezone)
	require.Equal(t, "Initial notice", notice.Title)
	require.Greater(t, routine.Revision, lastRoutineRevision, "restoring content cannot make old client CAS revisions valid again")
	require.Greater(t, notice.Revision, lastNoticeRevision)
}

func TestProjectVersionsSecurityRestoreRechecksRevokedAdministratorGrant(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Initial content", "audit-grant-save-1")
	require.NoError(t, err)
	_, err = s.Insert(&ProjectUser{ProjectID: project.ID, UserID: 2, Permission: PermissionAdmin})
	require.NoError(t, err)
	task.Title = "Content that must not change"
	require.NoError(t, task.Update(s, owner))
	actor := &user.User{ID: 2}
	plan, err := PreviewProjectVersion(s, actor, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.True(t, plan.CanRestore)
	_, err = s.Where("project_id = ? AND user_id = ?", project.ID, actor.ID).Delete(&ProjectUser{})
	require.NoError(t, err)
	_, err = RestoreProjectVersion(s, actor, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-revoked-restore"})
	require.Error(t, err)
	require.Equal(t, task.Title, projectVersionAuditTask(t, s, task.ID).Title)
}

func TestProjectVersionsSecurityMissingLabelIsAnExplicitConflict(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	label := &Label{Title: "Label removed outside project history"}
	require.NoError(t, label.Create(s, owner))
	require.NoError(t, (&LabelTask{TaskID: task.ID, LabelID: label.ID}).Create(s, owner))
	version, err := CreateProjectVersion(s, owner, project.ID, "With label", "audit-label-save-1")
	require.NoError(t, err)
	require.NoError(t, label.Delete(s, owner))
	plan, err := PreviewProjectVersion(s, owner, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.False(t, plan.CanRestore)
	require.NotEmpty(t, plan.Conflicts)
	_, err = RestoreProjectVersion(s, owner, project.ID, version.ID, ProjectVersionRestoreInput{ExpectedCurrentHash: plan.CurrentHash, PlanHash: plan.PlanHash, RequestID: "audit-label-restore"})
	require.Error(t, err)
	exists, err := s.Where("task_id = ? AND label_id = ?", task.ID, label.ID).Exist(&LabelTask{})
	require.NoError(t, err)
	require.False(t, exists, "history cannot recreate a dangling link to a globally deleted label")
}

func TestProjectVersionsSecurityRestoreLeavesExternalTaskRelationsAlone(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Before an external relationship", "audit-relation-save-1")
	require.NoError(t, err)
	other := &Project{Title: "Independent project"}
	require.NoError(t, other.Create(s, owner))
	otherTask := &Task{Title: "Task outside the restored project", ProjectID: other.ID}
	require.NoError(t, otherTask.Create(s, owner))
	relation := &TaskRelation{TaskID: task.ID, OtherTaskID: otherTask.ID, RelationKind: RelationKindRelated}
	require.NoError(t, relation.Create(s, owner))
	task.Title = "Changed task content"
	require.NoError(t, task.Update(s, owner))
	projectVersionAuditRestore(t, s, owner, project.ID, version.ID, "audit-external-relation")
	for _, pair := range [][2]int64{{task.ID, otherTask.ID}, {otherTask.ID, task.ID}} {
		exists, getErr := s.Where("task_id = ? AND other_task_id = ? AND relation_kind = ?", pair[0], pair[1], RelationKindRelated).Exist(&TaskRelation{})
		require.NoError(t, getErr)
		require.True(t, exists, "a checkpoint excludes external relationships and cannot erase another project's graph")
	}
}

func TestProjectVersionsSecurityRestoresSoftDeletedTaskIdentityAndFacts(t *testing.T) {
	s, owner, project, task := projectVersionAuditFixture(t)
	comment := &TaskComment{TaskID: task.ID, Comment: "Existing discussion must survive deletion and restore"}
	require.NoError(t, comment.Create(s, owner))
	version, err := CreateProjectVersion(s, owner, project.ID, "Before task deletion", "audit-softdelete-save")
	require.NoError(t, err)
	require.NoError(t, task.Delete(s, owner))
	require.False(t, projectVersionAuditTask(t, s, task.ID).DeletedAt.IsZero())
	result := projectVersionAuditRestore(t, s, owner, project.ID, version.ID, "audit-softdelete-restore")
	require.Equal(t, task.ID, result.IDMap.Tasks[fmt.Sprint(task.ID)], "a retained task is revived without changing its identity")
	require.True(t, projectVersionAuditTask(t, s, task.ID).DeletedAt.IsZero())
	live := &Task{ID: task.ID}
	require.NoError(t, live.ReadOne(s, owner))
	require.Equal(t, task.Title, live.Title)
	exists, err := s.ID(comment.ID).Exist(&TaskComment{})
	require.NoError(t, err)
	require.True(t, exists)
}
