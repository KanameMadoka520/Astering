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
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/cron"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
)

// AutomationOutcome contains only safe status metadata. Full provider and tool
// details stay in the linked account-owned conversation.
type AutomationOutcome struct {
	Status    string
	ErrorCode string
	Error     string
}

// AutomationRunner must link its conversation before starting any model/tools.
// The worker context has the explicit total deadline; caller cancellation does not
// cancel it. Implementations must revoke temporary credentials on every exit.
type AutomationRunner func(context.Context, int64, Automation, AutomationRun, func(string) error) AutomationOutcome

var automationScheduler = struct {
	sync.Mutex
	runner  AutomationRunner
	cleanup func()
	root    string
	unlock  func()
	active  map[string]struct{}
}{active: map[string]struct{}{}}

// ConfigureAutomationRunner only binds an implementation. It never starts work
// while building an API schema or running synchronous initialization.
func ConfigureAutomationRunner(runner AutomationRunner, cleanup func()) {
	automationScheduler.Lock()
	defer automationScheduler.Unlock()
	automationScheduler.runner = runner
	automationScheduler.cleanup = cleanup
}

// The lifetime OS lease makes restart reconciliation safe across processes. All
// instances may serve CRUD, but only the lease holder accepts run-now/schedules.
func automationLeaseLocked() error {
	root := accountKey(0).root
	if automationScheduler.unlock != nil {
		if automationScheduler.root == root {
			return nil
		}
		if len(automationScheduler.active) > 0 {
			return ErrAutomationBusy
		}
		automationScheduler.unlock()
		automationScheduler.unlock = nil
	}
	if err := os.MkdirAll(root, 0700); err != nil {
		return err
	}
	info, err := os.Lstat(root)
	if err != nil {
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errStoragePathUnsafe
	}
	unlock, err := lockAutomationFile(filepath.Join(root, ".automation-scheduler.lock"), true)
	if err != nil {
		return ErrAutomationBusy
	}
	automationScheduler.root = root
	automationScheduler.unlock = unlock
	return nil
}
func automationLiveKey(uid int64, id string) string { return strconv.FormatInt(uid, 10) + ":" + id }

// RunAutomationNow is idempotent by request ID. A lost HTTP response must be
// retried using the same ID; a trimmed old receipt is rejected, never replayed.
func RunAutomationNow(uid int64, id, requestID string) (AutomationRun, error) {
	return launchAutomation(uid, id, requestID, "manual", time.Now().UTC())
}
func launchAutomation(uid int64, id, requestID, trigger string, now time.Time) (AutomationRun, error) {
	automationScheduler.Lock()
	if err := automationLeaseLocked(); err != nil {
		automationScheduler.Unlock()
		return AutomationRun{}, err
	}
	if automationScheduler.runner == nil {
		automationScheduler.Unlock()
		return AutomationRun{}, ErrAutomationBusy
	}
	key := automationLiveKey(uid, id)
	if _, live := automationScheduler.active[key]; !live {
		if err := reconcileAutomation(uid, id); err != nil {
			automationScheduler.Unlock()
			return AutomationRun{}, err
		}
	}
	// A retry for an already admitted request must return its receipt even when
	// all execution slots are busy. It must never create a fresh second worker.
	if trigger == "manual" {
		var previous AutomationRun
		err := automationStore(uid, false, func(file *automationFile) error {
			i := automationIndex(file, id)
			if i < 0 {
				return ErrAutomationMissing
			}
			old := file.Items[i].ManualRequests[requestID]
			if old == "" {
				return nil
			}
			for _, run := range file.Items[i].Runs {
				if run.ID == old {
					previous = run
					return nil
				}
			}
			return ErrAutomationReceiptExpired
		})
		if err != nil || previous.ID != "" {
			automationScheduler.Unlock()
			return previous, err
		}
	}
	if len(automationScheduler.active) >= 4 {
		automationScheduler.Unlock()
		return AutomationRun{}, ErrAutomationBusy
	}
	if _, exists := automationScheduler.active[key]; exists {
		automationScheduler.Unlock()
		return AutomationRun{}, ErrAutomationBusy
	}
	record, run, fresh, err := claimAutomation(uid, id, requestID, trigger, now)
	if err != nil || !fresh {
		automationScheduler.Unlock()
		return run, err
	}
	automationScheduler.active[key] = struct{}{}
	runner := automationScheduler.runner
	automationScheduler.Unlock()
	go executeAutomation(uid, record, run, runner, key)
	return run, nil
}
func reconcileAutomation(uid int64, id string) error {
	return automationStore(uid, true, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		now := time.Now().UTC()
		for index := range file.Items[i].Runs {
			run := &file.Items[i].Runs[index]
			if run.Status != "running" {
				continue
			}
			run.Status = "interrupted"
			run.ErrorCode = "INTERRUPTED"
			run.Error = "The server restarted before this execution was confirmed. Inspect its conversation before retrying."
			run.Finished = &now
			if index == len(file.Items[i].Runs)-1 {
				file.Items[i].LastStatus = run.Status
			}
		}
		return nil
	})
}

type automationConversationOwnerKey struct{}
type automationConversationOwner struct{ live *liveConversation }

// WithAutomationConversationOwner captures the exact live instance created by
// StartConversation. Human continuation receives a new context and live pointer,
// even if it resumes the same request ID. The stop closure cannot cancel it.
func WithAutomationConversationOwner(ctx context.Context) (context.Context, func()) {
	owner := &automationConversationOwner{}
	stop := func() {
		conversations.Lock()
		defer conversations.Unlock()
		live := owner.live
		if live == nil || live.storeRoot != accountKey(live.uid).root || conversations.live[liveKey(live.uid, live.id)] != live || live.record == nil || len(live.record.Turns) == 0 {
			return
		}
		if live.record.Turns[len(live.record.Turns)-1].Status != "running" {
			return
		}
		live.acceptingSteering = false
		if live.cancel != nil {
			live.cancel()
		}
	}
	return context.WithValue(ctx, automationConversationOwnerKey{}, owner), stop
}

// Called only by launchConversation while holding conversations.Mutex. The
// context key is server-owned and is never decoded from JSON, JWT or a header.
func bindAutomationConversation(ctx context.Context, live *liveConversation) {
	if owner, ok := ctx.Value(automationConversationOwnerKey{}).(*automationConversationOwner); ok {
		owner.live = live
	}
}

func executeAutomation(uid int64, record Automation, run AutomationRun, runner AutomationRunner, key string) {
	outcome := AutomationOutcome{
		Status:    "failed",
		ErrorCode: "INTERNAL_ERROR",
		Error:     "The automation could not finish. Inspect its conversation before retrying.",
	}
	defer func() {
		if recover() != nil {
			outcome = AutomationOutcome{
				Status:    "interrupted",
				ErrorCode: "INTERNAL_ERROR",
				Error:     "Execution was interrupted. Some actions may already have completed; inspect the conversation before retrying.",
			}
		}
		now := time.Now().UTC()
		err := updateAutomationRun(uid, record.ID, run.ID, func(saved *AutomationRun) {
			saved.Status = outcome.Status
			saved.ErrorCode = outcome.ErrorCode
			saved.Error = outcome.Error
			saved.Finished = &now
		})
		if err == nil && (record.Kind == "reminder" || outcome.Status == "succeeded" && record.NotifyOnSuccess || outcome.Status != "succeeded" && record.NotifyOnFailure) {
			notifyAutomation(uid, record, run, outcome)
		}
		automationScheduler.Lock()
		delete(automationScheduler.active, key)
		automationScheduler.Unlock()
	}()
	seconds := record.MaxRuntimeSeconds
	if seconds == 0 {
		seconds = 3600
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Duration(seconds)*time.Second)
	defer cancel()
	if err := requireActiveAccount(uid); err != nil {
		outcome = AutomationOutcome{
			Status:    "canceled",
			ErrorCode: "ACCOUNT_REVOKED",
			Error:     "The account is inactive or its authorization has been revoked.",
		}
		return
	}
	if record.Kind == "reminder" {
		outcome = AutomationOutcome{Status: "succeeded"}
		return
	}
	outcome = runner(ctx, uid, record, run, func(conversationID string) error {
		return updateAutomationRun(uid, record.ID, run.ID, func(saved *AutomationRun) { saved.ConversationID = conversationID })
	})
	if ctx.Err() != nil {
		outcome = AutomationOutcome{
			Status:    "canceled",
			ErrorCode: "TIMEOUT",
			Error:     "The configured total execution time was reached. The conversation was stopped; completed actions are retained.",
		}
	}
	switch outcome.Status {
	case "succeeded", "failed", "interrupted", "canceled", "needs_attention":
	default:
		outcome = AutomationOutcome{
			Status:    "interrupted",
			ErrorCode: "UNKNOWN_RESULT",
			Error:     "The execution result could not be confirmed. Inspect its conversation before retrying.",
		}
	}
}

// RegisterAutomationCron runs only during asynchronous server initialization.
// Fifteen seconds is polling latency, not a minimum user recurrence interval.
func RegisterAutomationCron() {
	if err := cron.Schedule("@every 15s", automationTick); err != nil {
		log.Errorf("Could not register automation scheduler: %v", err)
	}
}
func automationTick() {
	automationScheduler.Lock()
	if err := automationLeaseLocked(); err != nil {
		automationScheduler.Unlock()
		return
	}
	cleanup := automationScheduler.cleanup
	automationScheduler.Unlock()
	if cleanup != nil {
		cleanup()
	}
	directory := filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai", "conversations")
	root, err := os.OpenRoot(directory)
	if errors.Is(err, os.ErrNotExist) {
		return
	}
	if err != nil {
		return
	}
	defer root.Close()
	dir, err := root.Open(".")
	if err != nil {
		return
	}
	defer dir.Close()
	visited := 0
	for visited < personalStorageEntryLimit {
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			visited++
			uid, err := strconv.ParseInt(entry.Name(), 10, 64)
			if err != nil || uid <= 0 || strconv.FormatInt(uid, 10) != entry.Name() || !entry.IsDir() {
				continue
			}
			info, err := root.Lstat(filepath.Join(entry.Name(), automationRecordName))
			if err != nil || !info.Mode().IsRegular() {
				continue
			}
			records, err := ListAutomations(uid, "")
			if err != nil {
				continue
			}
			for _, record := range records {
				automationScheduler.Lock()
				_, live := automationScheduler.active[automationLiveKey(uid, record.ID)]
				if !live && record.LastStatus == "running" {
					_ = reconcileAutomation(uid, record.ID)
				}
				automationScheduler.Unlock()
				if record.Enabled && record.NextRun != nil && !record.NextRun.After(time.Now()) {
					_, err = launchAutomation(uid, record.ID, "", "schedule", time.Now().UTC())
					if errors.Is(err, ErrAutomationBusy) {
						return
					}
				}
			}
		}
		if readErr != nil {
			return
		}
	}
}

// AutomationNotification is deliberately account-scoped. It contains no raw
// model response/tool payload, and Bark reveals reminder text only with Preview.
type AutomationNotification struct {
	AutomationID   string `json:"automation_id"`
	RunID          string `json:"run_id"`
	Title          string `json:"title"`
	Kind           string `json:"kind"`
	Status         string `json:"status"`
	ConversationID string `json:"conversation_id"`
	Message        string `json:"message"`
}

func init() {
	notifications.Register(func() notifications.PersistedNotification { return &AutomationNotification{} })
}
func (*AutomationNotification) Name() string                      { return "ai.automation" }
func (n *AutomationNotification) ToDB() interface{}               { return n }
func (*AutomationNotification) ToMail(string) *notifications.Mail { return nil }
func (*AutomationNotification) ProjectID() int64                  { return 0 }
func (*AutomationNotification) ToTitle(lang string) string {
	return i18n.T(lang, "notifications.automation.subject")
}

func notifyAutomation(uid int64, record Automation, run AutomationRun, outcome AutomationOutcome) {
	// Claim before enqueue. A crash between the database commit and receipt update
	// leaves unknown delivery rather than sending the same private reminder twice.
	if err := updateAutomationRun(uid, record.ID, run.ID, func(saved *AutomationRun) {
		saved.NotificationStatus = "unknown"
		run.ConversationID = saved.ConversationID
	}); err != nil {
		return
	}
	message := "Automation finished. Open Astering to view its result."
	if outcome.Status != "succeeded" {
		message = "Automation needs attention. Open Astering to view its result."
	}
	if record.Kind == "reminder" {
		message = record.Prompt
	}
	s := db.NewSession()
	identity, err := user.GetUserByID(s, uid)
	_ = s.Close()
	if err == nil && identity.Status == user.StatusActive && !identity.IsBot() {
		err = notifications.Notify(identity, &AutomationNotification{
			AutomationID:   record.ID,
			RunID:          run.ID,
			Title:          record.Title,
			Kind:           record.Kind,
			Status:         outcome.Status,
			ConversationID: run.ConversationID,
			Message:        message,
		})
	} else if err == nil {
		err = ErrAccountInactive
	}
	status := "sent"
	if err != nil {
		status = "failed"
	}
	_ = updateAutomationRun(uid, record.ID, run.ID, func(saved *AutomationRun) {
		saved.NotificationStatus = status
		if record.Kind == "reminder" && err != nil {
			saved.Status = "failed"
			saved.ErrorCode = "NOTIFICATION_FAILED"
			saved.Error = "The reminder could not be saved to notifications. Check the account and retry manually."
		}
	})
}
