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

package webtests

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"strconv"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/personalstorage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func storageUploadFixture(t *testing.T, owner int64, name string, data []byte) *files.File {
	t.Helper()
	s := db.NewSession()
	defer s.Close()
	f, err := files.CreateWithSession(s, bytes.NewReader(data), name, uint64(len(data)), &user.User{ID: owner})
	require.NoError(t, err)
	require.NoError(t, files.AddToDrive(s, f))
	require.NoError(t, s.Commit())
	return f
}

func TestHumaPersonalStorageCleanupOwnershipReferencesCASAndPurge(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	originalPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(originalPath) })
	token := humaTokenFor(t, &testuser1)
	otherToken := humaTokenFor(t, &testuser2)
	free := storageUploadFixture(t, 1, "reviewed-original.txt", []byte("preserve until confirmed purge"))
	foreign := storageUploadFixture(t, 2, "another-account.txt", []byte("do not touch"))
	require.NoError(t, free.SavePreview(files.PreviewSmall, []byte("small preview")))
	read := humaRequest(t, e, http.MethodGet, "/api/v2/user/storage/files?category=previews", "", token, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	assert.Equal(t, "no-store", read.Header().Get("Cache-Control"))
	var list personalstorage.StorageFilePage
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &list))
	require.Len(t, list.Items, 1)
	assert.Equal(t, free.ID, list.Items[0].FileID)
	assert.EqualValues(t, len("small preview"), list.Items[0].PreviewBytes)
	assert.Equal(t, -1, list.Items[0].UsageCount, "unscanned references must not masquerade as unused")
	read = humaRequest(t, e, http.MethodGet, "/api/v2/user/storage", "", token, "")
	require.Equal(t, http.StatusOK, read.Code, read.Body.String())
	var summary personalstorage.StorageSummary
	require.NoError(t, json.Unmarshal(read.Body.Bytes(), &summary))
	var summed int64
	for _, category := range summary.Categories {
		summed += category.Bytes
	}
	assert.Equal(t, summary.TotalBytes, summed, "recycle-bin and Drive subsets must not double count originals")
	preview := func(id int64, revision, action string) personalstorage.StoragePreview {
		t.Helper()
		body := fmt.Sprintf(`{"items":[{"kind":"file","id":%q,"revision":%q,"action":%q}]}`, strconv.FormatInt(id, 10), revision, action)
		rec := humaRequest(t, e, http.MethodPost, "/api/v2/user/storage/cleanup/preview", body, token, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var value personalstorage.StoragePreview
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &value))
		require.Len(t, value.Items, 1)
		return value
	}
	execute := func(value personalstorage.StoragePreview, confirm bool) personalstorage.StorageExecute {
		t.Helper()
		payload, marshalErr := json.Marshal(map[string]any{
			"tokens":  []string{value.Items[0].Token},
			"confirm": confirm,
		})
		require.NoError(t, marshalErr)
		rec := humaRequest(t, e, http.MethodPost, "/api/v2/user/storage/cleanup/execute", string(payload), token, "")
		require.Equal(t, http.StatusOK, rec.Code, rec.Body.String())
		var result personalstorage.StorageExecute
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &result))
		return result
	}
	blocked := preview(foreign.ID, "1", "trash")
	assert.False(t, blocked.Items[0].Allowed)
	assert.Equal(t, "missing_or_forbidden", blocked.Items[0].Reason)
	assert.Empty(t, blocked.Items[0].Name, "another owner's filename must not leak through preview")
	value := preview(free.ID, "1", "trash")
	require.True(t, value.Items[0].Allowed, value.Items[0].Reason)
	assert.Zero(t, value.ExpectedFreedBytes)
	otherPayload, marshalErr := json.Marshal(map[string]any{
		"tokens":  []string{value.Items[0].Token},
		"confirm": true,
	})
	require.NoError(t, marshalErr)
	other := humaRequest(t, e, http.MethodPost, "/api/v2/user/storage/cleanup/execute", string(otherPayload), otherToken, "")
	require.Equal(t, http.StatusOK, other.Code, other.Body.String())
	var negative personalstorage.StorageExecute
	require.NoError(t, json.Unmarshal(other.Body.Bytes(), &negative))
	assert.Equal(t, 1, negative.Failed)
	assert.Zero(t, negative.FreedBytes)
	noConfirm := humaRequest(t, e, http.MethodPost, "/api/v2/user/storage/cleanup/execute", `{"tokens":["no-preview"],"confirm":false}`, token, "")
	assert.Equal(t, http.StatusBadRequest, noConfirm.Code)
	// A newly added reference invalidates the reviewed revision and blocks trash.
	s := db.NewSession()
	_, err = models.AttachDriveFile(s, &testuser1, free.ID, 1, 1)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	result := execute(value, true)
	assert.Equal(t, "blocked", result.Items[0].Status)
	assert.Equal(t, "changed", result.Items[0].Reason)
	blocked = preview(free.ID, "2", "trash")
	assert.Equal(t, "in_use", blocked.Items[0].Reason)
	require.NotEmpty(t, blocked.Items[0].Usages)
	assert.Empty(t, blocked.Items[0].Token)
	// A separate unused file follows the complete recycle-bin lifecycle.
	clean := storageUploadFixture(t, 1, "unused-original.txt", []byte("actual removed original"))
	require.NoError(t, clean.SavePreview(files.PreviewSmall, []byte("actual removed preview")))
	trashed := execute(preview(clean.ID, "1", "trash"), true)
	assert.Equal(t, "completed", trashed.Items[0].Status)
	assert.Zero(t, trashed.FreedBytes)
	value = preview(clean.ID, "2", "purge")
	require.True(t, value.Items[0].Allowed, value.Items[0].Reason)
	result = execute(value, true)
	require.Equal(t, "completed", result.Items[0].Status, result.Items[0].Reason)
	assert.EqualValues(t, len("actual removed original")+len("actual removed preview"), result.FreedBytes)
	retry := execute(value, true)
	assert.Equal(t, "already_done", retry.Items[0].Status)
	assert.Zero(t, retry.FreedBytes, "idempotent retries must not double report freed bytes")
	remaining := files.MeasureStoredUsage(context.Background(), clean.ID)
	assert.Zero(t, remaining.OriginalBytes)
	assert.Zero(t, remaining.PreviewBytes)
	owned := files.MeasureStoredUsage(context.Background(), foreign.ID)
	assert.EqualValues(t, len("do not touch"), owned.OriginalBytes)
}
