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

package tcyai

import (
	"context"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func automationFixture(t *testing.T) {
	t.Helper()
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("automation-fixture-secret")
	automationScheduler.Lock()
	oldRunner, oldCleanup := automationScheduler.runner, automationScheduler.cleanup
	automationScheduler.runner = nil
	automationScheduler.cleanup = nil
	automationScheduler.Unlock()
	t.Cleanup(func() {
		require.Eventually(t, func() bool {
			automationScheduler.Lock()
			defer automationScheduler.Unlock()
			return len(automationScheduler.active) == 0
		}, 3*time.Second, 10*time.Millisecond)
		automationScheduler.Lock()
		if automationScheduler.unlock != nil {
			automationScheduler.unlock()
			automationScheduler.unlock = nil
		}
		automationScheduler.root = ""
		automationScheduler.runner = oldRunner
		automationScheduler.cleanup = oldCleanup
		automationScheduler.Unlock()
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
}
func testAutomationSpec() AutomationSpec {
	return AutomationSpec{

		Title: "Private planning",

		Prompt: "Read my current tasks",

		Kind: "agent",

		Enabled: true,

		Timezone: "Asia/Shanghai",

		Schedule: AutomationSchedule{

			Kind: "interval",

			IntervalMinutes: 1,
		},

		Options: &AssistantOptions{

			Mode: "read",

			Approval: "smart",

			SearchMode: "off",

			MaxRounds: 16,

			MaxOperations: 40,

			TimeoutSeconds: 180,
		},

		NotifyOnSuccess: false,

		NotifyOnFailure: false,

		MaxRuntimeSeconds: 3600,
	}
}
func TestAutomationEncryptedCASAndOwnerIsolation(t *testing.T) {
	automationFixture(t)
	spec := testAutomationSpec()
	value, err := SaveAutomation(1, "", 0, spec)
	require.NoError(t, err)
	raw, err := os.ReadFile(automationPath(1))
	require.NoError(t, err)
	assert.NotContains(t, string(raw), spec.Title)
	assert.NotContains(t, string(raw), spec.Prompt)
	info, err := os.Stat(automationPath(1))
	require.NoError(t, err)
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
	_, err = GetAutomation(2, value.ID)
	require.ErrorIs(t, err, ErrAutomationMissing)
	unrelated, err := ListAutomations(2, "")
	require.NoError(t, err)
	assert.Empty(t, unrelated)
	spec.Prompt = "New prompt"
	saved, err := SaveAutomation(1, value.ID, value.Revision, spec)
	require.NoError(t, err)
	_, err = SaveAutomation(1, value.ID, value.Revision, spec)
	require.ErrorIs(t, err, ErrAutomationConflict)
	require.ErrorIs(t, DeleteAutomation(2, value.ID, saved.Revision), ErrAutomationMissing)
	require.ErrorIs(t, DeleteAutomation(1, value.ID, value.Revision), ErrAutomationConflict)
	actual, err := GetAutomation(1, value.ID)
	require.NoError(t, err)
	assert.Equal(t, "New prompt", actual.Prompt)
	summary, err := GetPersonalStorage(context.Background(), 1)
	require.NoError(t, err)
	assert.Positive(t, summary.AutomationBytes)
	assert.Zero(t, summary.ConversationBytes)
	require.NoError(t, DeleteAutomation(1, value.ID, saved.Revision))
	_, err = GetAutomation(1, value.ID)
	require.ErrorIs(t, err, ErrAutomationMissing)
}

func TestAutomationMetadataDoesNotEnterConversationScans(t *testing.T) {
	t.Run("create search and storage", func(t *testing.T) {
		automationFixture(t)
		plan, err := SaveAutomation(1, "", 0, testAutomationSpec())
		require.NoError(t, err)
		chat, err := CreateConversation(1, "Automation execution history")
		require.NoError(t, err)
		listed, err := ListConversations(1)
		require.NoError(t, err)
		require.Len(t, listed, 1)
		assert.Equal(t, chat.ID, listed[0].ID)
		matched, err := SearchConversations(1, "execution", "all")
		require.NoError(t, err)
		require.Len(t, matched, 1)
		assert.Equal(t, chat.ID, matched[0].ID)
		_, err = GetConversation(1, chat.ID)
		require.NoError(t, err)
		storage, err := GetPersonalStorage(context.Background(), 1)
		require.NoError(t, err)
		assert.EqualValues(t, 1, storage.ConversationCount)
		assert.Positive(t, storage.AutomationBytes)
		retained, err := GetAutomation(1, plan.ID)
		require.NoError(t, err)
		assert.Equal(t, plan.ID, retained.ID)
	})
	t.Run("shared attachment cleanup", func(t *testing.T) {
		automationFixture(t)
		first, err := CreateConversation(1, "First use")
		require.NoError(t, err)
		second, err := CreateConversation(1, "Second use")
		require.NoError(t, err)
		attachment := legacyChatAttachment(t, 1, first.ID, "shared.txt", []byte("Shared original"))
		legacyChatAttachment(t, 1, second.ID, "shared.txt", []byte("Shared original"))
		_, err = SaveAutomation(1, "", 0, testAutomationSpec())
		require.NoError(t, err)
		path, err := attachmentPath(1, attachment.ID)
		require.NoError(t, err)
		require.NoError(t, DeleteConversation(1, first.ID))
		_, err = os.Stat(path)
		require.NoError(t, err, "the remaining conversation must protect the shared original")
		require.NoError(t, DeleteConversation(1, second.ID))
		_, err = os.Stat(path)
		require.ErrorIs(t, err, os.ErrNotExist, "automation metadata must not block verified orphan cleanup")
	})
	t.Run("drive reference safety", func(t *testing.T) {
		automationFixture(t)
		_, err := SaveAutomation(1, "", 0, testAutomationSpec())
		require.NoError(t, err)
		used, err := (chatDriveBridge{}).Referenced(1, 42)
		require.NoError(t, err)
		assert.False(t, used)
		path := filepath.Join(conversationDir(1), uuid.NewString()+".enc")
		require.NoError(t, os.WriteFile(path, []byte("unreadable canonical conversation"), 0600))
		_, err = (chatDriveBridge{}).Referenced(1, 42)
		require.Error(t, err, "an unreadable real conversation must still prevent deletion")
	})
}
func TestAutomationFrozenOptionsAndReviewPolicies(t *testing.T) {
	automationFixture(t)
	for _, approval := range []string{

		"smart",

		"review",

		"auto",

		"unattended",
	} {
		spec := testAutomationSpec()
		spec.Options.Mode = "write"
		spec.Options.Approval = approval
		spec.Options.StopAtSegmentLimit = false
		spec.Options.MCPServerIDs = []string{"owned-mcp"}
		value, err := SaveAutomation(1, "", 0, spec)
		require.NoError(t, err)
		spec.Options.MCPServerIDs[0] = "other"
		spec.Options.Mode = "read"
		read, err := GetAutomation(1, value.ID)
		require.NoError(t, err)
		assert.Equal(t, "write", read.Options.Mode)
		assert.Equal(t, []string{"owned-mcp"}, read.Options.MCPServerIDs)
		assert.False(t, read.Options.StopAtSegmentLimit)
	}
}
func TestAutomationDurableClaimNeverReplaysUnknownOrTrimmedRequest(t *testing.T) {
	automationFixture(t)
	value, err := SaveAutomation(1, "", 0, testAutomationSpec())
	require.NoError(t, err)
	_, first, fresh, err := claimAutomation(1, value.ID, "request-first", "manual", time.Now())
	require.NoError(t, err)
	assert.True(t, fresh)
	_, duplicate, fresh, err := claimAutomation(1, value.ID, "request-first", "manual", time.Now())
	require.NoError(t, err)
	assert.False(t, fresh)
	assert.Equal(t, first.ID, duplicate.ID)
	_, _, _, err = claimAutomation(1, value.ID, "request-second", "manual", time.Now())
	require.ErrorIs(t, err, ErrAutomationBusy)
	require.NoError(t, reconcileAutomation(1, value.ID))
	recovered, err := GetAutomationRun(1, value.ID, first.ID)
	require.NoError(t, err)
	assert.Equal(t, "interrupted", recovered.Status)
	assert.NotNil(t, recovered.Finished)
	for i := 0; i < automationRunLimit; i++ {
		_, run, _, claimErr := claimAutomation(1, value.ID, time.Now().Format(time.RFC3339Nano), "manual", time.Now())
		require.NoError(t, claimErr)
		require.NoError(t, updateAutomationRun(1, value.ID, run.ID, func(saved *AutomationRun) { saved.Status = "succeeded" }))
	}
	runs, err := ListAutomationRuns(1, value.ID)
	require.NoError(t, err)
	assert.Len(t, runs, automationRunLimit)
	_, _, _, err = claimAutomation(1, value.ID, "request-first", "manual", time.Now())
	require.ErrorIs(t, err, ErrAutomationReceiptExpired)
}
func TestAutomationWorkerContinuesAfterCallerAndUsesFrozenSettings(t *testing.T) {
	automationFixture(t)
	started, release := make(chan Automation, 1), make(chan struct{})
	var calls atomic.Int32
	ConfigureAutomationRunner(func(_ context.Context, _ int64, record Automation, _ AutomationRun, _ func(string) error) AutomationOutcome {
		calls.Add(1)
		started <- record
		<-release
		return AutomationOutcome{Status: "succeeded"}
	}, nil)
	value, err := SaveAutomation(1, "", 0, testAutomationSpec())
	require.NoError(t, err)
	run, err := RunAutomationNow(1, value.ID, "persistent-request")
	require.NoError(t, err)
	frozen := <-started
	updated := testAutomationSpec()
	updated.Enabled = false
	updated.Prompt = "Changed future prompt"
	_, err = SaveAutomation(1, value.ID, value.Revision, updated)
	require.NoError(t, err)
	duplicate, err := RunAutomationNow(1, value.ID, "persistent-request")
	require.NoError(t, err)
	assert.Equal(t, run.ID, duplicate.ID)
	_, err = RunAutomationNow(1, value.ID, "new-run-while-busy")
	require.ErrorIs(t, err, ErrAutomationBusy)
	automationTick()
	current, err := GetAutomationRun(1, value.ID, run.ID)
	require.NoError(t, err)
	assert.Equal(t, "running", current.Status, "reconciliation must not interrupt a live worker")
	assert.Equal(t, testAutomationSpec().Prompt, frozen.Prompt)
	assert.True(t, frozen.Enabled)
	close(release)
	require.Eventually(t, func() bool {
		receipt, readErr := GetAutomationRun(1, value.ID, run.ID)
		return readErr == nil && receipt.Status == "succeeded"
	}, 3*time.Second, 10*time.Millisecond)
	assert.EqualValues(t, 1, calls.Load())
}
func TestAutomationManualRetryAfterRestartReturnsInterruptedReceipt(t *testing.T) {
	automationFixture(t)
	var calls atomic.Int32
	ConfigureAutomationRunner(func(context.Context, int64, Automation, AutomationRun, func(string) error) AutomationOutcome {
		calls.Add(1)
		return AutomationOutcome{Status: "succeeded"}
	}, nil)
	value, err := SaveAutomation(1, "", 0, testAutomationSpec())
	require.NoError(t, err)
	_, old, _, err := claimAutomation(1, value.ID, "restart-request", "manual", time.Now())
	require.NoError(t, err)
	receipt, err := RunAutomationNow(1, value.ID, "restart-request")
	require.NoError(t, err)
	assert.Equal(t, old.ID, receipt.ID)
	assert.Equal(t, "interrupted", receipt.Status)
	assert.Zero(t, calls.Load())
}
func TestAutomationOnceCoalescesAndDoesNotCatchUpDuplicate(t *testing.T) {
	automationFixture(t)
	spec := testAutomationSpec()
	spec.Schedule = AutomationSchedule{

		Kind: "once",

		At: time.Now().Add(time.Minute).UTC().Format(time.RFC3339),
	}
	value, err := SaveAutomation(1, "", 0, spec)
	require.NoError(t, err)
	_, run, fresh, err := claimAutomation(1, value.ID, "", "schedule", time.Now().Add(2*time.Minute))
	require.NoError(t, err)
	assert.True(t, fresh)
	require.NoError(t, updateAutomationRun(1, value.ID, run.ID, func(saved *AutomationRun) { saved.Status = "succeeded" }))
	_, _, _, err = claimAutomation(1, value.ID, "", "schedule", time.Now().Add(3*time.Minute))
	require.ErrorIs(t, err, ErrAutomationConflict)
	read, err := GetAutomation(1, value.ID)
	require.NoError(t, err)
	assert.Nil(t, read.NextRun)
}
func TestAutomationRejectsUnsafeOrInvalidInputs(t *testing.T) {
	automationFixture(t)
	for _, mutate := range []func(*AutomationSpec){

		func(s *AutomationSpec) { s.Timezone = "Local" },

		func(s *AutomationSpec) { s.Schedule.IntervalMinutes = 0 },

		func(s *AutomationSpec) { s.Options.AllowDelete = true },

		func(s *AutomationSpec) { s.MaxRuntimeSeconds = 86401 },

		func(s *AutomationSpec) { s.Kind = "arbitrary" },

		func(s *AutomationSpec) { s.Options = nil },

		func(s *AutomationSpec) { s.Title = "bad\nname" },
	} {
		spec := testAutomationSpec()
		mutate(&spec)
		_, err := SaveAutomation(1, "", 0, spec)
		require.ErrorIs(t, err, ErrAutomationInvalid)
	}
}

func TestAutomationStorageRejectsSymlinkParentsAndCleanupTargets(t *testing.T) {
	automationFixture(t)
	outside := t.TempDir()
	require.NoError(t, os.Symlink(outside, filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai")))
	_, err := SaveAutomation(1, "", 0, testAutomationSpec())
	require.ErrorIs(t, err, errStoragePathUnsafe)
	entries, err := os.ReadDir(outside)
	require.NoError(t, err)
	assert.Empty(t, entries)
	require.NoError(t, os.Remove(filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai")))
	record, err := SaveAutomation(1, "", 0, testAutomationSpec())
	require.NoError(t, err)
	page, err := ListStorageConversations(context.Background(), 1, StorageConversationQuery{

		Page: 1,

		PerPage: 20,

		Scope: "all",

		SortBy: "updated",

		OrderBy: "desc",

		Running: "all",
	})
	require.NoError(t, err)
	assert.Empty(t, page.Items)
	_, err = DeleteStorageConversation(1, ".automations", "any", true)
	require.Error(t, err)
	retained, err := GetAutomation(1, record.ID)
	require.NoError(t, err)
	assert.Equal(t, record.ID, retained.ID)
}

func TestAutomationCancellationBindsExactLiveInstance(t *testing.T) {
	automationFixture(t)
	const id = "same-private-conversation"
	var originalCanceled, replacementCanceled atomic.Int32
	ctx, stop := WithAutomationConversationOwner(context.Background())
	record := &conversationFile{Conversation: Conversation{
		ID: id,
		Turns: []ChatTurn{{
			RequestID: "same-request",
			Status:    "running",
		}},
	}}
	original := &liveConversation{
		uid:       1,
		id:        id,
		record:    record,
		storeRoot: accountKey(1).root,
		cancel:    func() { originalCanceled.Add(1) },
	}
	conversations.Lock()
	conversations.live[liveKey(1, id)] = original
	bindAutomationConversation(ctx, original)
	conversations.Unlock()
	t.Cleanup(func() { conversations.Lock(); delete(conversations.live, liveKey(1, id)); conversations.Unlock() })
	stop()
	assert.EqualValues(t, 1, originalCanceled.Load())
	conversations.Lock()
	record.Turns[0].Status = "awaiting_approval"
	conversations.Unlock()
	stop()
	assert.EqualValues(t, 1, originalCanceled.Load(), "terminal checkpoint must not be changed")
	conversations.Lock()
	record.Turns[0].Status = "running"
	replacement := &liveConversation{
		uid:       1,
		id:        id,
		record:    record,
		storeRoot: accountKey(1).root,
		cancel:    func() { replacementCanceled.Add(1) },
	}
	conversations.live[liveKey(1, id)] = replacement
	// A normal browser review has no automation owner capability in its context.
	bindAutomationConversation(context.Background(), replacement)
	conversations.Unlock()
	stop()
	assert.Zero(t, replacementCanceled.Load(), "same request ID in a newer human live instance must keep running")
}
