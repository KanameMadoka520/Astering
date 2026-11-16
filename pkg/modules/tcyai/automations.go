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
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"time"

	"strconv"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
)

var (
	ErrAutomationInvalid        = errors.New("automation_invalid")
	ErrAutomationMissing        = errors.New("automation_not_found")
	ErrAutomationConflict       = errors.New("automation_changed")
	ErrAutomationBusy           = errors.New("automation_running")
	ErrAutomationLimit          = errors.New("automation_limit")
	ErrAutomationReceiptExpired = errors.New("automation_run_receipt_expired")
)

const automationLimit = 100
const automationRunLimit = 50
const automationRecordLimit = 16 * 1024 * 1024
const automationRecordName = ".automations.enc"

type AutomationSpec struct {
	Title             string             `json:"title" minLength:"1" maxLength:"120" doc:"Private display name."`
	Prompt            string             `json:"prompt" minLength:"1" maxLength:"12000" doc:"Instruction for agent runs, or the body of a pure reminder."`
	Kind              string             `json:"kind" enum:"agent,reminder" doc:"Agent uses the selected model and tools; reminder only delivers a notification."`
	Enabled           bool               `json:"enabled" doc:"Pause future scheduled runs without stopping an existing run."`
	Timezone          string             `json:"timezone" minLength:"1" maxLength:"80" doc:"IANA timezone, independent of the server/browser timezone."`
	Schedule          AutomationSchedule `json:"schedule" doc:"Exactly one validated recurrence; no arbitrary cron or code."`
	Options           *AssistantOptions  `json:"options,omitempty" doc:"Required for agent runs. Current account/resource/MCP permissions are always rechecked; a policy requiring human review can pause execution."`
	MaxRuntimeSeconds int                `json:"max_runtime_seconds" minimum:"60" maximum:"86400" default:"3600" doc:"Total job deadline across execution segments, in seconds; timeout stops this conversation without replaying writes."`
	NotifyOnSuccess   bool               `json:"notify_on_success" doc:"Notify after successful agent execution; reminders always notify."`
	NotifyOnFailure   bool               `json:"notify_on_failure" doc:"Notify after failed, interrupted or needs-attention execution."`
}

type Automation struct {
	AutomationSpec
	ID         string     `json:"id" readOnly:"true" doc:"Server-generated account-scoped UUID."`
	Revision   int64      `json:"revision" readOnly:"true" doc:"Configuration revision; execution receipts do not invalidate an open edit."`
	Created    time.Time  `json:"created" readOnly:"true" doc:"Creation time in UTC."`
	Updated    time.Time  `json:"updated" readOnly:"true" doc:"Last explicit configuration edit."`
	NextRun    *time.Time `json:"next_run" readOnly:"true" doc:"Next planned instant, or null when paused/finished."`
	LastRunAt  *time.Time `json:"last_run_at" readOnly:"true" doc:"Most recent execution start, or null."`
	LastStatus string     `json:"last_status" readOnly:"true" doc:"Most recent run status; empty before the first run."`
}

type AutomationRun struct {
	ID                 string            `json:"id" doc:"Durable receipt UUID, never replayed automatically."`
	Status             string            `json:"status" enum:"running,succeeded,failed,interrupted,canceled,needs_attention" doc:"interrupted means outcome may be unknown; inspect conversation before manual retry."`
	Trigger            string            `json:"trigger" enum:"schedule,manual" doc:"How this execution was admitted."`
	ScheduledFor       time.Time         `json:"scheduled_for" doc:"Original due slot in UTC; missed slots coalesce rather than queue."`
	Started            time.Time         `json:"started" doc:"Time the durable claim was committed."`
	Finished           *time.Time        `json:"finished" doc:"Terminal receipt time; null while running."`
	ConversationID     string            `json:"conversation_id" doc:"Private conversation containing complete model/tool results, or empty for a pure reminder/start failure."`
	ErrorCode          string            `json:"error_code" doc:"Stable safe failure category, never raw upstream credentials/content."`
	Error              string            `json:"error" doc:"Safe user-facing explanation; detailed model/tool diagnostics remain in the private conversation."`
	AutomationRevision int64             `json:"automation_revision" doc:"Configuration revision frozen at claim time."`
	Options            *AssistantOptions `json:"options,omitempty" doc:"Execution parameter snapshot; not a permission grant."`
	PromptSHA256       string            `json:"prompt_sha256" doc:"Prompt fingerprint; the original agent prompt is preserved in the linked conversation."`
	NotificationStatus string            `json:"notification_status" doc:"none, sent, failed or unknown; delivery errors do not replay the agent."`
	RequestID          string            `json:"-"`
}

type automationRecord struct {
	Automation
	Runs           []AutomationRun   `json:"runs"`
	ManualRequests map[string]string `json:"manual_requests,omitempty"`
}
type automationFile struct {
	Schema int                `json:"schema"`
	Items  []automationRecord `json:"items"`
}

var automationMutex sync.Mutex

func validateAutomation(spec AutomationSpec) error {
	if strings.TrimSpace(spec.Title) == "" || len([]rune(spec.Title)) > 120 || strings.ContainsAny(spec.Title, "\r\n\x00") || strings.TrimSpace(spec.Prompt) == "" || len([]rune(spec.Prompt)) > 12000 || len(spec.Timezone) > 80 {
		return ErrAutomationInvalid
	}
	if spec.MaxRuntimeSeconds != 0 && (spec.MaxRuntimeSeconds < 60 || spec.MaxRuntimeSeconds > 86400) {
		return ErrAutomationInvalid
	}
	if spec.Kind != "agent" && spec.Kind != "reminder" {
		return ErrAutomationInvalid
	}
	if err := validateAutomationSchedule(spec.Schedule, spec.Timezone); err != nil {
		return err
	}
	if spec.Kind == "agent" {
		if spec.Options == nil || !validAssistantOptions(*spec.Options) {
			return ErrAutomationInvalid
		}
		seen := map[int64]bool{}
		for _, id := range spec.Options.WriteProjectIDs {
			if id <= 0 || seen[id] {
				return ErrAutomationInvalid
			}
			seen[id] = true
		}
	}
	return nil
}

func automationPath(uid int64) string {
	return filepath.Join(conversationDir(uid), automationRecordName)
}

// Every directory component is opened relative to its verified parent. A
// symlink in the private hierarchy is never a route to another account/root.
func openAutomationStorage(uid int64, create bool) (*os.Root, error) {
	root, err := os.OpenRoot(config.FilesBasePath.GetString())
	if err != nil {
		return nil, err
	}
	for _, name := range []string{
		".tcymc-ai",
		"conversations",
		strconv.FormatInt(uid, 10),
	} {
		if create {
			err = withAccountWrite(uid, func() error {
				err := root.Mkdir(name, 0700)
				if errors.Is(err, os.ErrExist) {
					return nil
				}
				return err
			})
			if err != nil {
				_ = root.Close()
				return nil, err
			}
		}
		child, err := storageChildRoot(root, name)
		_ = root.Close()
		if err != nil {
			return nil, err
		}
		root = child
	}
	return root, nil
}

func automationStore(uid int64, write bool, action func(*automationFile) error) error {
	if uid <= 0 {
		return ErrAutomationInvalid
	}
	automationMutex.Lock()
	defer automationMutex.Unlock()
	if err := requireActiveAccount(uid); err != nil {
		return err
	}
	root, err := openAutomationStorage(uid, write)
	if errors.Is(err, os.ErrNotExist) && !write {
		if err = action(&automationFile{
			Schema: 1,
			Items:  []automationRecord{},
		}); err != nil {
			return err
		}
		return requireActiveAccount(uid)
	}
	if err != nil {
		return err
	}
	defer root.Close()
	unlock, err := lockAutomationRoot(root, ".automations.lock", false)
	if err != nil {
		return err
	}
	defer unlock()
	data, err := readAutomationRecord(root, uid)
	if err != nil {
		return err
	}
	if err = action(&data); err != nil {
		return err
	}
	if !write {
		return requireActiveAccount(uid)
	}
	return withAccountWrite(uid, func() error {
		plain, err := json.Marshal(data)
		if err != nil {
			return err
		}
		if len(plain) > automationRecordLimit-64 {
			return ErrAutomationLimit
		}
		cipher, err := aead()
		if err != nil {
			return err
		}
		nonce := make([]byte, cipher.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			return err
		}
		raw := cipher.Seal(nonce, nonce, plain, []byte(fmt.Sprintf("automations:%d", uid)))
		temporary := ".automation-write-" + uuid.NewString()
		stream, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		if err != nil {
			return err
		}
		defer func() { _ = root.Remove(temporary) }()
		if _, err = stream.Write(raw); err != nil {
			_ = stream.Close()
			return err
		}
		if err = stream.Sync(); err != nil {
			_ = stream.Close()
			return err
		}
		if err = stream.Close(); err != nil {
			return err
		}
		if err = root.Rename(temporary, automationRecordName); err != nil {
			return err
		}
		directoryFile, err := root.Open(".")
		if err != nil {
			return err
		}
		defer directoryFile.Close()
		return directoryFile.Sync()
	})
}

func readAutomationRecord(root *os.Root, uid int64) (automationFile, error) {
	data := automationFile{
		Schema: 1,
		Items:  []automationRecord{},
	}
	info, err := root.Lstat(automationRecordName)
	if err == nil {
		if !info.Mode().IsRegular() || info.Size() > automationRecordLimit {
			return data, errStoragePathUnsafe
		}
		stream, openErr := root.Open(automationRecordName)
		if openErr != nil {
			return data, openErr
		}
		raw, readErr := io.ReadAll(io.LimitReader(stream, automationRecordLimit+1))
		closeErr := stream.Close()
		if readErr != nil {
			return data, readErr
		}
		if closeErr != nil {
			return data, closeErr
		}
		if len(raw) > automationRecordLimit {
			return data, ErrAutomationLimit
		}
		cipher, cryptErr := aead()
		if cryptErr != nil {
			return data, cryptErr
		}
		if len(raw) < cipher.NonceSize() {
			return data, ErrAutomationInvalid
		}
		plain, cryptErr := cipher.Open(nil, raw[:cipher.NonceSize()], raw[cipher.NonceSize():], []byte(fmt.Sprintf("automations:%d", uid)))
		if cryptErr != nil {
			return data, ErrAutomationInvalid
		}
		if err = json.Unmarshal(plain, &data); err != nil {
			return data, err
		}
		if data.Schema != 1 || len(data.Items) > automationLimit {
			return data, ErrAutomationInvalid
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return data, err
	}
	return data, nil
}

func automationIndex(file *automationFile, id string) int {
	if _, err := uuid.Parse(id); err != nil {
		return -1
	}
	for i := range file.Items {
		if file.Items[i].ID == id {
			return i
		}
	}
	return -1
}

func ListAutomations(uid int64, q string) (items []Automation, err error) {
	items = []Automation{}
	err = automationStore(uid, false, func(file *automationFile) error {
		for _, record := range file.Items {
			if q == "" || strings.Contains(strings.ToLower(record.Title), strings.ToLower(q)) {
				items = append(items, record.Automation)
			}
		}
		slices.SortFunc(items, func(a, b Automation) int {
			if a.Created.After(b.Created) {
				return -1
			}
			if a.Created.Before(b.Created) {
				return 1
			}
			return strings.Compare(a.ID, b.ID)
		})
		return nil
	})
	return
}

func GetAutomation(uid int64, id string) (value Automation, err error) {
	err = automationStore(uid, false, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		value = file.Items[i].Automation
		return nil
	})
	return
}

func SaveAutomation(uid int64, id string, revision int64, spec AutomationSpec) (value Automation, err error) {
	if err = validateAutomation(spec); err != nil {
		return
	}
	if spec.MaxRuntimeSeconds == 0 {
		spec.MaxRuntimeSeconds = 3600
	}
	if spec.Options != nil {
		options := *spec.Options
		options.ToolModules = normalizedToolModules(options.ToolModules)
		options.WriteProjectIDs = slices.Clone(options.WriteProjectIDs)
		options.MCPServerIDs = slices.Clone(options.MCPServerIDs)
		spec.Options = &options
	}
	err = automationStore(uid, true, func(file *automationFile) error {
		now := time.Now().UTC()
		next, err := NextAutomationRun(spec.Schedule, spec.Timezone, now)
		if err != nil {
			return err
		}
		if !spec.Enabled {
			next = nil
		}
		if id == "" {
			if spec.Enabled && next == nil {
				return ErrAutomationInvalid
			}
			if len(file.Items) >= automationLimit {
				return ErrAutomationLimit
			}
			value = Automation{
				AutomationSpec: spec,
				ID:             uuid.NewString(),
				Revision:       1,
				Created:        now,
				Updated:        now,
				NextRun:        next,
			}
			file.Items = append(file.Items, automationRecord{
				Automation:     value,
				Runs:           []AutomationRun{},
				ManualRequests: map[string]string{},
			})
			return nil
		}
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		old := file.Items[i].Automation
		if old.Revision != revision {
			return ErrAutomationConflict
		}
		// Renaming an already executed one-shot must not re-arm it or make an
		// otherwise valid editor impossible to save merely because its date passed.
		if spec.Enabled && next == nil && (old.LastRunAt == nil || old.Schedule.Kind != "once" || spec.Schedule.Kind != "once" || old.Schedule.At != spec.Schedule.At) {
			return ErrAutomationInvalid
		}
		value = old
		value.AutomationSpec = spec
		value.Revision++
		value.Updated = now
		value.NextRun = next
		file.Items[i].Automation = value
		return nil
	})
	return
}

func DeleteAutomation(uid int64, id string, revision int64) error {
	return automationStore(uid, true, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		if file.Items[i].Revision != revision {
			return ErrAutomationConflict
		}
		file.Items = append(file.Items[:i], file.Items[i+1:]...)
		return nil
	})
}

func ListAutomationRuns(uid int64, id string) (runs []AutomationRun, err error) {
	runs = []AutomationRun{}
	err = automationStore(uid, false, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		runs = append(runs, file.Items[i].Runs...)
		slices.Reverse(runs)
		return nil
	})
	return
}
func GetAutomationRun(uid int64, id, runID string) (AutomationRun, error) {
	runs, err := ListAutomationRuns(uid, id)
	if err != nil {
		return AutomationRun{}, err
	}
	for _, run := range runs {
		if run.ID == runID {
			return run, nil
		}
	}
	return AutomationRun{}, ErrAutomationMissing
}

func claimAutomation(uid int64, id, requestID, trigger string, now time.Time) (record Automation, run AutomationRun, fresh bool, err error) {
	err = automationStore(uid, true, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		item := &file.Items[i]
		if trigger == "manual" {
			if len(requestID) < 8 || len(requestID) > 80 {
				return ErrAutomationInvalid
			}
			if previous := item.ManualRequests[requestID]; previous != "" {
				for _, saved := range item.Runs {
					if saved.ID == previous {
						record = item.Automation
						run = saved
						return nil
					}
				}
				return ErrAutomationReceiptExpired
			}
			if len(item.ManualRequests) >= 4096 {
				return ErrAutomationLimit
			}
		}
		for _, saved := range item.Runs {
			if saved.Status == "running" {
				return ErrAutomationBusy
			}
		}
		due := now.UTC()
		if trigger == "schedule" {
			if !item.Enabled || item.NextRun == nil || item.NextRun.After(now) {
				return ErrAutomationConflict
			}
			due = *item.NextRun
			next, err := NextAutomationRun(item.Schedule, item.Timezone, now)
			if err != nil {
				return err
			}
			item.NextRun = next
		}
		fingerprint := sha256.Sum256([]byte(item.Prompt))
		run = AutomationRun{
			ID:                 uuid.NewString(),
			Status:             "running",
			Trigger:            trigger,
			ScheduledFor:       due,
			Started:            now.UTC(),
			AutomationRevision: item.Revision,
			Options:            item.Options,
			PromptSHA256:       hex.EncodeToString(fingerprint[:]),
			NotificationStatus: "none",
			RequestID:          requestID,
		}
		item.LastRunAt = &run.Started
		item.LastStatus = run.Status
		item.Runs = append(item.Runs, run)
		if len(item.Runs) > automationRunLimit {
			item.Runs = append([]AutomationRun{}, item.Runs[len(item.Runs)-automationRunLimit:]...)
		}
		if trigger == "manual" {
			if item.ManualRequests == nil {
				item.ManualRequests = map[string]string{}
			}
			item.ManualRequests[requestID] = run.ID
		}
		record = item.Automation
		fresh = true
		return nil
	})
	return
}

func updateAutomationRun(uid int64, id, runID string, change func(*AutomationRun)) error {
	return automationStore(uid, true, func(file *automationFile) error {
		i := automationIndex(file, id)
		if i < 0 {
			return ErrAutomationMissing
		}
		for index := range file.Items[i].Runs {
			run := &file.Items[i].Runs[index]
			if run.ID == runID {
				change(run)
				if index == len(file.Items[i].Runs)-1 {
					file.Items[i].LastStatus = run.Status
				}
				return nil
			}
		}
		return ErrAutomationMissing
	})
}
