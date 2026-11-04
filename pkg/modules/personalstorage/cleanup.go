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

package personalstorage

import (
	"context"
	"crypto/sha256"
	"errors"
	"fmt"
	"strconv"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
)

func reason(err error) string {
	switch {
	case err == nil:
		return ""
	case errors.Is(err, ErrForbidden), errors.Is(err, models.ErrDriveMissing), errors.Is(err, tcyai.ErrConversationMissing):
		return "missing_or_forbidden"
	case errors.Is(err, models.ErrDriveChanged), errors.Is(err, tcyai.ErrStorageConversationChanged):
		return "changed"
	case errors.Is(err, models.ErrDriveInUse):
		return "in_use"
	case errors.Is(err, models.ErrDriveConfirm):
		return "in_use"
	case errors.Is(err, models.ErrDriveChatUnreadable):
		return "references_unavailable"
	case errors.Is(err, tcyai.ErrConversationBusy):
		return "conversation_busy"
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		return "interrupted"
	default:
		return "unavailable"
	}
}

func fileID(value string) (int64, error) {
	id, err := strconv.ParseInt(value, 10, 64)
	if err != nil || id <= 0 || strconv.FormatInt(id, 10) != value {
		return 0, ErrInvalid
	}
	return id, nil
}

func previewFile(ctx context.Context, uid int64, in StorageSelection) (StoragePreviewItem, string) {
	item := StoragePreviewItem{
		StorageSelection: in,
		Usages:           []models.DriveUsage{},
	}
	id, err := fileID(in.ID)
	if err != nil {
		item.Reason = "invalid_selection"
		return item, ""
	}
	row, err := currentOwnedFile(ctx, uid, id)
	if err != nil {
		item.Reason = reason(err)
		return item, ""
	}
	item.Name = row.Name
	item.Bytes = row.Size
	if strconv.FormatInt(row.Revision, 10) != in.Revision {
		item.Reason = "changed"
		return item, ""
	}
	if in.Action != "clear_previews" && (row.DriveID == 0 || row.DriveOwnerID != uid) {
		item.Reason = "protected_original"
		return item, ""
	}
	if in.Action != "trash" && in.Action != "purge" && in.Action != "clear_previews" {
		item.Reason = "invalid_selection"
		return item, ""
	}
	if in.Action == "trash" && (row.TrashedAt.After(trashEpoch) || row.Purging) {
		item.Reason = "already_trashed"
		return item, ""
	}
	if in.Action == "purge" && !row.TrashedAt.After(trashEpoch) {
		item.Reason = "must_trash_first"
		return item, ""
	}
	if in.Action == "clear_previews" && row.Purging {
		item.Reason = "purge_in_progress"
		return item, ""
	}
	if in.Action != "clear_previews" && !row.Purging {
		s := db.NewReadSession()
		db.SetSessionContext(ctx, s)
		item.Usages, err = models.DriveUsages(s, authFor(uid), id)
		_ = s.Close()
		if err != nil {
			item.Reason = "references_unavailable"
			return item, ""
		}
		if len(item.Usages) > 0 {
			item.Reason = "in_use"
			return item, ""
		}
		current, readErr := currentOwnedFile(ctx, uid, id)
		if readErr != nil {
			item.Reason = reason(readErr)
			return item, ""
		}
		if current.Revision != row.Revision || current.Name != row.Name {
			item.Reason = "changed"
			return item, ""
		}
	}
	m := files.MeasureStoredUsage(ctx, id)
	if in.Action == "clear_previews" {
		item.ExpectedFreedBytes = m.PreviewBytes
	}
	if in.Action == "purge" {
		item.ExpectedFreedBytes = m.OriginalBytes + m.PreviewBytes
	}
	item.Allowed = true
	return item, referenceFingerprint(item.Usages)
}

func PreviewCleanup(ctx context.Context, uid int64, session string, selections []StorageSelection) (*StoragePreview, error) {
	if err := Authorize(ctx, uid); err != nil {
		return nil, err
	}
	if len(selections) == 0 || len(selections) > 50 || session == "" {
		return nil, ErrInvalid
	}
	result := &StoragePreview{
		Items:     []StoragePreviewItem{},
		ExpiresAt: time.Now().UTC().Add(previewLifetime),
	}
	seen := map[string]bool{}
	for _, selection := range selections {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		key := selection.Kind + ":" + selection.ID
		if seen[key] {
			return nil, ErrInvalid
		}
		seen[key] = true
		item := StoragePreviewItem{
			StorageSelection: selection,
			Usages:           []models.DriveUsage{},
		}
		fingerprint := ""
		switch selection.Kind {
		case "file":
			item, fingerprint = previewFile(ctx, uid, selection)
		case "conversation":
			c, err := tcyai.GetStorageConversation(ctx, uid, selection.ID)
			if err != nil {
				item.Reason = reason(err)
				break
			}
			item.Name = c.Title
			item.Bytes = c.Bytes
			switch {
			case selection.Action != "delete":
				item.Reason = "invalid_selection"
			case c.Revision != selection.Revision:
				item.Reason = "changed"
			case c.Running || c.Compacting:
				item.Reason = "conversation_busy"
			default:
				item.Allowed = true
				item.ExpectedFreedBytes = c.Bytes
			}
		default:
			item.Reason = "invalid_selection"
		}
		if item.Allowed {
			token, err := signConfirmation(confirmation{
				StorageSelection: selection,
				UID:              uid,
				Session:          session,
				Name:             item.Name,
				Usages:           fingerprint,
				Expires:          result.ExpiresAt.Unix(),
			})
			if err != nil {
				return nil, err
			}
			item.Token = token
			result.ExpectedFreedBytes += item.ExpectedFreedBytes
		}
		result.Items = append(result.Items, item)
	}
	return result, nil
}

type targetGuard struct {
	ready chan struct{}
	refs  int
}

var executionGuards = struct {
	sync.Mutex
	targets  map[string]*targetGuard
	receipts map[[sha256.Size]byte]int64
}{
	targets:  map[string]*targetGuard{},
	receipts: map[[sha256.Size]byte]int64{},
}

func lockTarget(ctx context.Context, key string) (func(), error) {
	executionGuards.Lock()
	g := executionGuards.targets[key]
	if g == nil {
		g = &targetGuard{ready: make(chan struct{}, 1)}
		executionGuards.targets[key] = g
	}
	g.refs++
	executionGuards.Unlock()
	releaseRef := func() {
		executionGuards.Lock()
		g.refs--
		if g.refs == 0 {
			delete(executionGuards.targets, key)
		}
		executionGuards.Unlock()
	}
	select {
	case g.ready <- struct{}{}:
		return func() { <-g.ready; releaseRef() }, nil
	case <-ctx.Done():
		releaseRef()
		return nil, ctx.Err()
	}
}

func knownReceipt(token string) bool {
	sum := sha256.Sum256([]byte(token))
	executionGuards.Lock()
	defer executionGuards.Unlock()
	return executionGuards.receipts[sum] > time.Now().Unix()
}

func reserveReceipt(token string, expires int64) bool {
	executionGuards.Lock()
	defer executionGuards.Unlock()
	if len(executionGuards.receipts) >= 2048 {
		for key, expiry := range executionGuards.receipts {
			if expiry <= time.Now().Unix() {
				delete(executionGuards.receipts, key)
			}
		}
	}
	if len(executionGuards.receipts) < 2048 {
		executionGuards.receipts[sha256.Sum256([]byte(token))] = expires
		return true
	}
	return false
}

func forgetReceipt(token string) {
	executionGuards.Lock()
	delete(executionGuards.receipts, sha256.Sum256([]byte(token)))
	executionGuards.Unlock()
}

func measuredPurgeBytes(before, after files.StoredUsage) (int64, bool) {
	var freed int64
	if after.OriginalComplete {
		freed = max(int64(0), before.OriginalBytes-after.OriginalBytes)
	}
	if after.PreviewsComplete {
		freed += max(int64(0), before.PreviewBytes-after.PreviewBytes)
	}
	return freed, before.Complete && after.OriginalComplete && after.OriginalBytes == 0 && after.PreviewsComplete && after.PreviewBytes == 0
}

func executeFile(ctx context.Context, uid int64, value confirmation) StorageExecuteItem {
	result := StorageExecuteItem{
		Kind:          value.Kind,
		ID:            value.ID,
		Action:        value.Action,
		Status:        "blocked",
		BytesComplete: true,
	}
	id, err := fileID(value.ID)
	if err != nil {
		result.Reason = "invalid_selection"
		return result
	}
	row, err := currentOwnedFile(ctx, uid, id)
	if err != nil {
		if value.Action == "purge" && errors.Is(err, ErrForbidden) {
			result.Status = "already_done"
		} else {
			result.Reason = reason(err)
		}
		return result
	}
	if row.Name != value.Name {
		result.Reason = "changed"
		return result
	}
	if value.Action == "purge" && row.DriveID > 0 && row.Purging {
		before := files.MeasureStoredUsage(ctx, id)
		if err = files.FinishDrivePurge(id); err != nil {
			result.Status = "failed"
			result.Reason = "purge_retry"
			result.BytesComplete = false
			return result
		}
		after := files.MeasureStoredUsage(ctx, id)
		result.Status = "completed"
		result.FreedBytes, result.BytesComplete = measuredPurgeBytes(before, after)
		return result
	}
	if strconv.FormatInt(row.Revision, 10) != value.Revision {
		result.Reason = "changed"
		return result
	}
	preview, fingerprint := previewFile(ctx, uid, value.StorageSelection)
	if !preview.Allowed {
		result.Reason = preview.Reason
		return result
	}
	if fingerprint != value.Usages {
		result.Reason = "changed"
		return result
	}
	if err = Authorize(ctx, uid); err != nil {
		result.Reason = reason(err)
		return result
	}
	if value.Action == "clear_previews" {
		if row.DriveID > 0 {
			s := db.NewSession()
			_, err = models.LockDriveItem(s, authFor(uid), id, row.Revision)
			if err == nil {
				err = s.Commit()
			}
			_ = s.Close()
			if err != nil {
				result.Reason = reason(err)
				return result
			}
		}
		result.FreedBytes, result.BytesComplete, err = files.ClearStoredPreviews(ctx, id)
		result.Status = "completed"
		if err != nil {
			result.Status = "failed"
			result.Reason = "preview_cleanup_retry"
		}
		return result
	}
	// The cleaner never authorizes recycling a referenced original, including a reference added after the preview.
	change := models.DriveChange{
		Revision:    row.Revision,
		Action:      value.Action,
		Confirm:     value.Action != "trash",
		ConfirmName: row.Name,
	}
	models.PrepareDriveChange(authFor(uid), id, &change)
	if ctx.Err() != nil {
		result.Reason = "interrupted"
		return result
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	d, err := models.ChangeDriveItem(s, authFor(uid), id, change)
	if err != nil {
		result.Reason = reason(err)
		return result
	}
	if err = s.Commit(); err != nil {
		result.Status = "failed"
		result.Reason = "unavailable"
		return result
	}
	events.DispatchPending(ctx, s)
	_ = s.Close()
	result.Status = "completed"
	if !d.Purging {
		return result
	}
	before := files.MeasureStoredUsage(ctx, id)
	if err = files.FinishDrivePurge(id); err != nil {
		result.Status = "failed"
		result.Reason = "purge_retry"
		result.BytesComplete = false
		return result
	}
	after := files.MeasureStoredUsage(ctx, id)
	result.FreedBytes, result.BytesComplete = measuredPurgeBytes(before, after)
	return result
}

func executeOne(ctx context.Context, uid int64, session, token string) StorageExecuteItem {
	value, err := readConfirmation(token, uid, session, time.Now())
	if err != nil {
		return StorageExecuteItem{
			Status:        "blocked",
			Reason:        "preview_expired",
			BytesComplete: true,
		}
	}
	result := StorageExecuteItem{
		Kind:          value.Kind,
		ID:            value.ID,
		Action:        value.Action,
		Status:        "blocked",
		BytesComplete: true,
	}
	unlock, err := lockTarget(ctx, fmt.Sprintf("%d:%s:%s", uid, value.Kind, value.ID))
	if err != nil {
		result.Reason = "interrupted"
		return result
	}
	defer unlock()
	if knownReceipt(token) {
		result.Status = "already_done"
		return result
	}
	if err = Authorize(ctx, uid); err != nil {
		result.Reason = reason(err)
		return result
	}
	if !reserveReceipt(token, value.Expires) {
		result.Reason = "unavailable"
		return result
	}
	switch value.Kind {
	case "file":
		result = executeFile(ctx, uid, value)
	case "conversation":
		deleted, deleteErr := tcyai.DeleteStorageConversation(uid, value.ID, value.Revision, true)
		if deleteErr != nil {
			if errors.Is(deleteErr, tcyai.ErrConversationMissing) {
				result.Status = "already_done"
			} else {
				result.Reason = reason(deleteErr)
			}
		} else {
			result.Status = "completed"
			result.FreedBytes = deleted.FreedBytes
		}
	default:
		result.Reason = "invalid_selection"
	}
	if result.Status != "completed" && result.Status != "already_done" {
		forgetReceipt(token)
	}
	return result
}

func ExecuteCleanup(ctx context.Context, uid int64, session string, tokens []string, confirm bool) (*StorageExecute, error) {
	if err := Authorize(ctx, uid); err != nil {
		return nil, err
	}
	if !confirm || len(tokens) == 0 || len(tokens) > 50 || session == "" {
		return nil, ErrInvalid
	}
	result := &StorageExecute{Items: []StorageExecuteItem{}}
	for _, token := range tokens {
		item := executeOne(ctx, uid, session, token)
		result.Items = append(result.Items, item)
		result.FreedBytes += item.FreedBytes
		if item.Status == "completed" || item.Status == "already_done" {
			result.Completed++
		} else {
			result.Failed++
		}
	}
	return result, nil
}
