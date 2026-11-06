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
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm/contexts"
	"xorm.io/xorm/schemas"
)

type projectVersionGuardProbeKey struct{}
type projectVersionGuardProbe struct {
	once    sync.Once
	reached chan struct{}
}
type projectVersionGuardObserver struct{}

var projectVersionGuardObserverOnce sync.Once

func (projectVersionGuardObserver) BeforeProcess(c *contexts.ContextHook) (context.Context, error) {
	probe, _ := c.Ctx.Value(projectVersionGuardProbeKey{}).(*projectVersionGuardProbe)
	query := strings.ToUpper(c.SQL)
	if probe != nil && strings.Contains(query, "PROJECTS") && strings.Contains(query, "FOR UPDATE") {
		probe.once.Do(func() { close(probe.reached) })
	}
	return c.Ctx, nil
}

func (projectVersionGuardObserver) AfterProcess(*contexts.ContextHook) error { return nil }

func projectVersionGuardContext(t *testing.T) (context.Context, *projectVersionGuardProbe) {
	t.Helper()
	if kind := db.Type(); kind != schemas.POSTGRES && kind != schemas.MYSQL {
		t.Skip("requires real PostgreSQL or MySQL row locks")
	}
	engine, err := db.CreateDBEngine()
	require.NoError(t, err)
	projectVersionGuardObserverOnce.Do(func() { engine.AddHook(projectVersionGuardObserver{}) })
	probe := &projectVersionGuardProbe{reached: make(chan struct{})}
	ctx, cancel := context.WithTimeout(context.WithValue(context.Background(), projectVersionGuardProbeKey{}, probe), 10*time.Second)
	t.Cleanup(cancel)
	return ctx, probe
}

func TestProjectVersionsSecurityConcurrentSnapshotWaitsForCommittedWriter(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, task := projectVersionAuditFixture(t)
	require.NoError(t, s.Commit())
	writer := db.NewSession()
	defer writer.Close()
	defer events.CleanupPending(writer)
	task.Title = "Committed after the checkpoint request began"
	require.NoError(t, task.Update(writer, owner))

	type response struct {
		id  int64
		err error
	}
	done := make(chan response, 1)
	go func() {
		checkpoint := db.NewSession()
		defer checkpoint.Close()
		defer events.CleanupPending(checkpoint)
		db.SetSessionContext(ctx, checkpoint)
		version, err := CreateProjectVersion(checkpoint, owner, project.ID, "Concurrent checkpoint", "audit-concurrent-save")
		var id int64
		if err == nil {
			id = version.ID
			err = checkpoint.Commit()
		}
		done <- response{id: id, err: err}
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("checkpoint never reached its project gate")
	}
	select {
	case result := <-done:
		t.Fatalf("checkpoint escaped an uncommitted ordinary task writer: %v", result.err)
	default:
	}
	require.NoError(t, writer.Commit())
	var result response
	select {
	case result = <-done:
	case <-ctx.Done():
		t.Fatal("checkpoint did not finish after the task writer committed")
	}
	require.NoError(t, result.err)
	read := db.NewSession()
	defer read.Close()
	entity, err := ReadProjectVersionEntity(read, owner, project.ID, result.id, "task", fmt.Sprint(task.ID))
	require.NoError(t, err)
	require.Equal(t, task.Title, entity.Content["title"], "the project gate must be followed by current reads, including MySQL repeatable-read transactions")
}

func TestProjectVersionsSecurityConcurrentIndependentProjectKeepsWorking(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, task := projectVersionAuditFixture(t)
	parent := &Project{Title: "Shared ACL ancestor with a higher ID than its first child"}
	require.NoError(t, parent.Create(s, owner))
	project.ParentProjectID = Ptr(parent.ID)
	require.NoError(t, project.Update(s, owner))
	other := &Project{Title: "Independent project that must remain responsive", ParentProjectID: Ptr(parent.ID)}
	require.NoError(t, other.Create(s, owner))
	otherTask := &Task{Title: "Independent task", ProjectID: other.ID}
	require.NoError(t, otherTask.Create(s, owner))
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	_, _, err := currentProjectReadPermission(blocker, owner, project.ID)
	require.NoError(t, err)
	done := make(chan error, 1)
	go func() {
		writer := db.NewSession()
		defer writer.Close()
		defer events.CleanupPending(writer)
		db.SetSessionContext(ctx, writer)
		err := (&Task{ID: task.ID, Title: "Waiting task edit"}).Update(writer, owner)
		if err == nil {
			err = writer.Commit()
		}
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("ordinary task update never reached its project gate")
	}
	independent := make(chan error, 1)
	go func() {
		writer := db.NewSession()
		defer writer.Close()
		defer events.CleanupPending(writer)
		db.SetSessionContext(ctx, writer)
		err := (&Task{ID: otherTask.ID, Title: "Independent edit completed"}).Update(writer, owner)
		if err == nil {
			err = writer.Commit()
		}
		independent <- err
	}()
	select {
	case err := <-independent:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("an unrelated project was blocked by another project's history gate")
	}
	select {
	case err := <-done:
		t.Fatalf("same-project task mutation escaped the held history gate: %v", err)
	default:
	}
	require.NoError(t, blocker.Rollback())
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("same-project task mutation did not resume after its project gate was released")
	}
}

func TestProjectVersionsSecurityConcurrentScopeChangeDoesNotChaseAnotherProject(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, task := projectVersionAuditFixture(t)
	other := &Project{Title: "Destination outside the original gate"}
	require.NoError(t, other.Create(s, owner))
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	done := make(chan error, 1)
	go func() {
		writer := db.NewSession()
		defer writer.Close()
		defer events.CleanupPending(writer)
		db.SetSessionContext(ctx, writer)
		err := (&Task{ID: task.ID, Title: "Must never overwrite the moved task"}).Update(writer, owner)
		if err == nil {
			err = writer.Commit()
		}
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("task update never reached its original project gate")
	}
	// Deliberately emulate a move that committed between initial scope discovery
	// and acquiring the gate. The mutation must not already hold a task row lock,
	// and must reject that changed scope instead of acquiring a new project late.
	mover := db.NewSession()
	db.SetSessionContext(ctx, mover)
	_, err := mover.ID(task.ID).Cols("project_id").Update(&Task{ProjectID: other.ID})
	require.NoError(t, err)
	require.NoError(t, mover.Commit())
	require.NoError(t, mover.Close())
	require.NoError(t, blocker.Rollback())
	select {
	case err = <-done:
		require.Error(t, err)
	case <-ctx.Done():
		t.Fatal("the stale task scope did not terminate with a conflict")
	}
	check := db.NewReadSession()
	defer check.Close()
	current := projectVersionAuditTask(t, check, task.ID)
	require.Equal(t, other.ID, current.ProjectID)
	require.Equal(t, task.Title, current.Title)
}

func TestProjectVersionsSecurityConcurrentRestoreRechecksRevokedAccess(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, task := projectVersionAuditFixture(t)
	actor, err := user.GetUserByID(s, 2)
	require.NoError(t, err)
	grant := &ProjectUser{ProjectID: project.ID, UserID: actor.ID, Username: actor.Username, Permission: PermissionAdmin}
	require.NoError(t, grant.Create(s, owner))
	version, err := CreateProjectVersion(s, owner, project.ID, "Before a later edit", "audit-concurrent-acl-checkpoint")
	require.NoError(t, err)
	task.Title = "Current content that must survive a revoked restore"
	require.NoError(t, task.Update(s, owner))
	plan, err := PreviewProjectVersion(s, actor, project.ID, version.ID, 1, 25)
	require.NoError(t, err)
	require.True(t, plan.CanRestore)
	require.NoError(t, s.Commit())

	revoker := db.NewSession()
	defer revoker.Close()
	defer events.CleanupPending(revoker)
	require.NoError(t, grant.Delete(revoker, owner))
	done := make(chan error, 1)
	go func() {
		restore := db.NewSession()
		defer restore.Close()
		defer events.CleanupPending(restore)
		db.SetSessionContext(ctx, restore)
		_, err := RestoreProjectVersion(restore, actor, project.ID, version.ID, ProjectVersionRestoreInput{
			ExpectedCurrentHash: plan.CurrentHash,
			PlanHash:            plan.PlanHash,
			RequestID:           "audit-concurrent-revoked-restore",
		})
		if err == nil {
			err = restore.Commit()
		}
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("restore never reached its project gate")
	}
	select {
	case err := <-done:
		t.Fatalf("restore escaped the transaction revoking its administrator grant: %v", err)
	default:
	}
	require.NoError(t, revoker.Commit())
	select {
	case err := <-done:
		require.Error(t, err, "the post-wait current ACL must reject the now-revoked actor")
	case <-ctx.Done():
		t.Fatal("restore did not reject revoked access after the grant deletion committed")
	}
	check := db.NewReadSession()
	defer check.Close()
	require.Equal(t, task.Title, projectVersionAuditTask(t, check, task.ID).Title)
	count, err := check.Where("project_id = ?", project.ID).Count(new(ProjectVersion))
	require.NoError(t, err)
	require.EqualValues(t, 1, count, "a rejected restore must not leave safety or result checkpoints")
}

func TestProjectVersionsSecurityConcurrentAccountCleanupDoesNotWaitBehindBackgroundProject(t *testing.T) {
	ctx, _ := projectVersionGuardContext(t)
	s, _, project, _ := projectVersionAuditFixture(t)
	file := projectVersionAuditFile(t, s, 4, true)
	_, err := s.ID(project.ID).Cols("background_file_id").Update(&Project{BackgroundFileID: file.ID})
	require.NoError(t, err)
	_, err = s.ID(4).Delete(new(user.User))
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	done := make(chan error, 1)
	go func() { done <- cleanupDeletedAccountFile(4, file.ID) }()
	select {
	case err := <-done:
		require.NoError(t, err, "maintenance must observe the committed background reference without waiting on its project gate")
	case <-ctx.Done():
		t.Fatal("account cleanup waited on a background project while holding Drive, which can deadlock snapshot capture")
	}
	require.NoError(t, blocker.Rollback())
	require.NoError(t, cleanupDeletedAccountFile(4, file.ID))
	check := db.NewReadSession()
	defer check.Close()
	exists, err := check.ID(file.ID).Exist(new(files.File))
	require.NoError(t, err)
	require.True(t, exists, "a background still in use must survive the deferred cleanup retry")
}

func TestProjectVersionsSecurityConcurrentBucketMoveUsesPostWaitBoardAndTaskState(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, task := projectVersionAuditFixture(t)
	view := &ProjectView{}
	exists, err := s.Where("project_id = ? AND view_kind = ?", project.ID, ProjectViewKindKanban).Get(view)
	require.NoError(t, err)
	require.True(t, exists)
	require.NotZero(t, view.DoneBucketID)
	originalDoneID := view.DoneBucketID
	alternate := &Bucket{ProjectID: project.ID, ProjectViewID: view.ID, Title: "Done after a restored board layout"}
	require.NoError(t, alternate.Create(s, owner))
	task.DueDate = time.Date(2026, 11, 10, 10, 0, 0, 0, time.UTC)
	require.NoError(t, task.Update(s, owner))
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	done := make(chan error, 1)
	go func() {
		move := db.NewSession()
		defer move.Close()
		defer events.CleanupPending(move)
		db.SetSessionContext(ctx, move)
		placement := &TaskBucket{TaskID: task.ID, ProjectID: project.ID, ProjectViewID: view.ID, BucketID: originalDoneID}
		err := placement.Update(move, owner)
		if err == nil {
			err = move.Commit()
		}
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("bucket move never reached its project gate")
	}
	newDue := task.DueDate.Add(48 * time.Hour)
	_, err = blocker.ID(view.ID).Cols("done_bucket_id").Update(&ProjectView{DoneBucketID: alternate.ID})
	require.NoError(t, err)
	_, err = blocker.ID(task.ID).Cols("done", "done_at", "due_date").Update(&Task{Done: true, DoneAt: time.Now(), DueDate: newDue})
	require.NoError(t, err)
	_, err = blocker.Where("task_id = ? AND project_view_id = ?", task.ID, view.ID).Cols("bucket_id").Update(&TaskBucket{BucketID: alternate.ID})
	require.NoError(t, err)
	require.NoError(t, blocker.Commit())
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("bucket move did not resume after the restored board state committed")
	}
	check := db.NewReadSession()
	defer check.Close()
	current := projectVersionAuditTask(t, check, task.ID)
	require.False(t, current.Done, "moving out of the new current Done bucket must reopen the task")
	require.True(t, newDue.Equal(current.DueDate), "a bucket move must not overwrite dates from the restored task with its old read view")
	placement := &TaskBucket{}
	exists, err = check.Where("task_id = ? AND project_view_id = ?", task.ID, view.ID).Get(placement)
	require.NoError(t, err)
	require.True(t, exists)
	require.Equal(t, originalDoneID, placement.BucketID)
}

func TestProjectVersionsSecurityConcurrentPreviewLocksProjectBeforeVersion(t *testing.T) {
	ctx, probe := projectVersionGuardContext(t)
	s, owner, project, _ := projectVersionAuditFixture(t)
	version, err := CreateProjectVersion(s, owner, project.ID, "Concurrent preview lock order", "audit-preview-lock-order")
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	blocker := db.NewSession()
	defer blocker.Close()
	db.SetSessionContext(ctx, blocker)
	require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
	done := make(chan error, 1)
	go func() {
		preview := db.NewSession()
		defer preview.Close()
		db.SetSessionContext(ctx, preview)
		_, err := PreviewProjectVersion(preview, owner, project.ID, version.ID, 1, 25)
		done <- err
	}()
	select {
	case <-probe.reached:
	case <-ctx.Done():
		t.Fatal("preview never reached its project gate")
	}
	// A restore/delete that already owns the project gate must be able to take
	// the saved-version row. A waiting preview must not hold it in reverse order.
	row := &ProjectVersion{}
	exists, err := routineCurrentRead(blocker).ID(version.ID).Get(row)
	require.NoError(t, err)
	require.True(t, exists)
	require.NoError(t, blocker.Rollback())
	select {
	case err := <-done:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("preview did not finish after its project gate was released")
	}
}

func TestProjectVersionsSecurityConcurrentDoneSyncUsesPostWaitOtherViews(t *testing.T) {
	for _, operation := range []string{"task", "bucket"} {
		t.Run(operation, func(t *testing.T) {
			ctx, probe := projectVersionGuardContext(t)
			s, owner, project, task := projectVersionAuditFixture(t)
			primary := &ProjectView{}
			exists, err := s.Where("project_id = ? AND view_kind = ?", project.ID, ProjectViewKindKanban).Get(primary)
			require.NoError(t, err)
			require.True(t, exists)
			other := &ProjectView{ProjectID: project.ID, Title: "Another board", ViewKind: ProjectViewKindKanban, BucketConfigurationMode: BucketConfigurationModeManual}
			_, err = s.Insert(other)
			require.NoError(t, err)
			oldDone := &Bucket{ProjectID: project.ID, ProjectViewID: other.ID, Title: "Old Done"}
			require.NoError(t, oldDone.Create(s, owner))
			newDone := &Bucket{ProjectID: project.ID, ProjectViewID: other.ID, Title: "Restored Done"}
			require.NoError(t, newDone.Create(s, owner))
			_, err = s.ID(other.ID).Cols("done_bucket_id").Update(&ProjectView{DoneBucketID: oldDone.ID})
			require.NoError(t, err)
			require.NoError(t, s.Commit())

			blocker := db.NewSession()
			defer blocker.Close()
			require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
			done := make(chan error, 1)
			go func() {
				writer := db.NewSession()
				defer writer.Close()
				defer events.CleanupPending(writer)
				db.SetSessionContext(ctx, writer)
				var err error
				if operation == "task" {
					updated := *task
					updated.Done = true
					err = updated.Update(writer, owner)
				} else {
					placement := &TaskBucket{TaskID: task.ID, ProjectID: project.ID, ProjectViewID: primary.ID, BucketID: primary.DoneBucketID}
					err = placement.Update(writer, owner)
				}
				if err == nil {
					err = writer.Commit()
				}
				done <- err
			}()
			select {
			case <-probe.reached:
			case <-ctx.Done():
				t.Fatal("Done update never reached its project gate")
			}
			_, err = blocker.ID(other.ID).Cols("done_bucket_id").Update(&ProjectView{DoneBucketID: newDone.ID})
			require.NoError(t, err)
			require.NoError(t, blocker.Commit())
			select {
			case err := <-done:
				require.NoError(t, err)
			case <-ctx.Done():
				t.Fatal("Done update did not resume after the current board layout committed")
			}
			check := db.NewReadSession()
			defer check.Close()
			placement := &TaskBucket{}
			exists, err = check.Where("task_id = ? AND project_view_id = ?", task.ID, other.ID).Get(placement)
			require.NoError(t, err)
			require.True(t, exists)
			require.Equal(t, newDone.ID, placement.BucketID, "Done synchronization must use the other board's committed configuration after waiting")
		})
	}
}

func TestProjectVersionsSecurityConcurrentBucketLimitCountsPostWaitPlacements(t *testing.T) {
	for _, filterKind := range []string{"none", "done", "label"} {
		t.Run("filter_"+filterKind, func(t *testing.T) {
			ctx, probe := projectVersionGuardContext(t)
			s, owner, project, task := projectVersionAuditFixture(t)
			view := &ProjectView{}
			exists, err := s.Where("project_id = ? AND view_kind = ?", project.ID, ProjectViewKindKanban).Get(view)
			require.NoError(t, err)
			require.True(t, exists)
			var label *Label
			switch filterKind {
			case "label":
				label = &Label{Title: "Matches the board after restoration"}
				require.NoError(t, label.Create(s, owner))
				require.NoError(t, (&LabelTask{TaskID: task.ID, LabelID: label.ID}).Create(s, owner))
				view.Filter = &TaskCollection{Filter: fmt.Sprintf("labels = %d", label.ID)}
			case "done":
				view.Filter = &TaskCollection{Filter: "done = false"}
			}
			if view.Filter != nil {
				_, err = s.ID(view.ID).Cols("filter").Update(view)
				require.NoError(t, err)
			}
			destination := &Bucket{ProjectID: project.ID, ProjectViewID: view.ID, Title: "One task only", Limit: 1}
			require.NoError(t, destination.Create(s, owner))
			other := &Task{Title: "Will fill the restored bucket", ProjectID: project.ID}
			require.NoError(t, other.Create(s, owner))
			require.NoError(t, s.Commit())
			blocker := db.NewSession()
			defer blocker.Close()
			require.NoError(t, LockProjectsForVersionMutation(blocker, project.ID))
			done := make(chan error, 1)
			go func() {
				move := db.NewSession()
				defer move.Close()
				defer events.CleanupPending(move)
				db.SetSessionContext(ctx, move)
				placement := &TaskBucket{TaskID: task.ID, ProjectID: project.ID, ProjectViewID: view.ID, BucketID: destination.ID}
				err := placement.Update(move, owner)
				if err == nil {
					err = move.Commit()
				}
				done <- err
			}()
			select {
			case <-probe.reached:
			case <-ctx.Done():
				t.Fatal("limited bucket move never reached its project gate")
			}
			if label != nil {
				_, err = blocker.Insert(&LabelTask{TaskID: other.ID, LabelID: label.ID})
				require.NoError(t, err)
			}
			require.NoError(t, (&TaskBucket{TaskID: other.ID, ProjectViewID: view.ID, BucketID: destination.ID}).upsert(blocker))
			require.NoError(t, blocker.Commit())
			select {
			case err := <-done:
				require.True(t, IsErrBucketLimitExceeded(err), "the committed restored placement must count toward the limit, got %v", err)
			case <-ctx.Done():
				t.Fatal("limited bucket move did not resume after its project gate was released")
			}
			check := db.NewReadSession()
			defer check.Close()
			placement := &TaskBucket{}
			exists, err = check.Where("task_id = ? AND project_view_id = ?", task.ID, view.ID).Get(placement)
			require.NoError(t, err)
			require.True(t, exists)
			require.NotEqual(t, destination.ID, placement.BucketID)
		})
	}
}
