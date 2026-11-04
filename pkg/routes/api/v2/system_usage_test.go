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

package apiv2

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func usageTestServer(t *testing.T) *echo.Echo {
	t.Helper()
	aiBucketFixtures(t)
	config.FilesBasePath.Set(t.TempDir())
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			id, err := strconv.ParseInt(c.Request().Header.Get("X-Test-User"), 10, 64)
			if err == nil {
				// Intentionally stale principal: the production handler must re-read
				// bot/status metadata rather than trust these zero-valued flags.
				c.Set("api_user", &user.User{ID: id})
			}
			if c.Request().Header.Get("X-Test-Token") == "true" {
				c.Set("api_token", &models.APIToken{OwnerID: id})
			}
			return next(c)
		}
	})
	RegisterSystemUsageRoutes(NewAPI(e, e.Group(GroupPrefix)))
	return e
}

func usageRequest(e *echo.Echo, uid int64, token bool, path string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, GroupPrefix+path, nil)
	if uid > 0 {
		req.Header.Set("X-Test-User", strconv.FormatInt(uid, 10))
	}
	if token {
		req.Header.Set("X-Test-Token", "true")
	}
	response := httptest.NewRecorder()
	e.ServeHTTP(response, req)
	return response
}

func TestSystemUsagePermissions(t *testing.T) {
	e := usageTestServer(t)
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "1")
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "2")
	response := usageRequest(e, 1, false, "/system/usage/access")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Contains(t, response.Body.String(), `"can_view_usage":true`)
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	response = usageRequest(e, 2, false, "/system/usage/access")
	require.Equal(t, http.StatusOK, response.Code)
	assert.Contains(t, response.Body.String(), `"can_view_usage":false`)
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 2, false, "/system/usage/users").Code)
	assert.Equal(t, http.StatusUnauthorized, usageRequest(e, 0, false, "/system/usage/access").Code)
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, true, "/system/usage/users").Code)

	s := db.NewReadSession()
	_, err := s.Table("users").Where("id = ?", 2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 2, false, "/system/usage/users").Code, "stored admin flag is not a usage grant")

	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "")
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/users").Code)
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "1, 4, 999999")
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 4, false, "/system/usage/users").Code, "awaiting email confirmation is inactive")
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 999999, false, "/system/usage/users").Code, "removed user cannot use an old principal")
	for _, status := range []user.Status{user.StatusDisabled, user.StatusAccountLocked} {
		s = db.NewReadSession()
		_, err = s.Table("users").Where("id = ?", 1).Cols("status").Update(&user.User{Status: status})
		require.NoError(t, err)
		require.NoError(t, s.Close())
		assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/access").Code)
		assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/users").Code)
	}
	s = db.NewReadSession()
	_, err = s.Table("users").Where("id = ?", 1).Cols("status", "bot_owner_id").Update(&user.User{
		Status:     user.StatusActive,
		BotOwnerID: 2,
	})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/access").Code)
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/users").Code)
}

func TestSystemUsageReadOnlySnapshot(t *testing.T) {
	e := usageTestServer(t)
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "1")
	response := usageRequest(e, 1, false, "/system/usage/users?q=user1&per_page=1&sort_by=file_bytes&order_by=desc")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	assert.Equal(t, "no-store", response.Header().Get("Cache-Control"))
	result := instanceusage.AccountUsageSnapshot{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	require.Len(t, result.Items, 1)
	assert.EqualValues(t, 1, result.Items[0].ID)
	assert.EqualValues(t, 1, result.Items[0].FilesUploaded)
	assert.EqualValues(t, 100, result.Items[0].FileBytes)
	assert.Positive(t, result.Items[0].ProjectsOwned)
	assert.True(t, result.Items[0].AIScanComplete)
	assert.True(t, result.Overview.SnapshotComplete)
	assert.Greater(t, result.Total, int64(1))
	assert.Equal(t, result.Total, result.TotalPages)
	for _, forbidden := range []string{`"email"`, `"password"`, `"issuer"`, `"subject"`, `"title"`, `"filename"`, `"api_key"`, "user1@example.com"} {
		assert.NotContains(t, response.Body.String(), forbidden)
	}
	// Usage access must not promote the reader or make someone else's project readable.
	s := db.NewReadSession()
	u := &user.User{}
	_, err := s.Table("users").Where("id = ?", 1).Get(u)
	require.NoError(t, err)
	assert.False(t, u.IsAdmin)
	can, _, err := (&models.Project{ID: 2}).CanRead(s, u)
	require.NoError(t, err)
	assert.False(t, can)
	require.NoError(t, s.Close())
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "")
	assert.Equal(t, http.StatusForbidden, usageRequest(e, 1, false, "/system/usage/users").Code, "cached snapshot must remain behind the current grant")
}

func usageRows(t *testing.T, e *echo.Echo) map[int64]instanceusage.InstanceUserUsage {
	t.Helper()
	response := usageRequest(e, 1, false, "/system/usage/users?per_page=100")
	require.Equal(t, http.StatusOK, response.Code, response.Body.String())
	result := instanceusage.AccountUsageSnapshot{}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	rows := map[int64]instanceusage.InstanceUserUsage{}
	for _, row := range result.Items {
		rows[row.ID] = row
	}
	require.Contains(t, rows, int64(1))
	require.Contains(t, rows, int64(2))
	return rows
}

func TestSystemUsageAttributionAndDeduplication(t *testing.T) {
	e := usageTestServer(t)
	t.Setenv("ASTERING_USAGE_ADMIN_IDS", "1")
	before := usageRows(t, e)
	s := db.NewReadSession()
	p1 := &models.Project{
		Title:      "private project, never in usage output",
		OwnerID:    2,
		IsArchived: true,
	}
	p2 := &models.Project{
		Title:   "another private project",
		OwnerID: 1,
	}
	_, err := s.Insert(p1, p2)
	require.NoError(t, err)
	t1 := &models.Task{
		Title:       "private task",
		ProjectID:   p1.ID,
		CreatedByID: 1,
		Index:       1,
	}
	t2 := &models.Task{
		Title:       "other private task",
		ProjectID:   p2.ID,
		CreatedByID: 2,
		Index:       1,
	}
	deleted := &models.Task{
		Title:       "deleted private task",
		ProjectID:   p1.ID,
		CreatedByID: 1,
		Index:       2,
	}
	_, err = s.Insert(t1, t2, deleted)
	require.NoError(t, err)
	_, err = s.ID(deleted.ID).Delete(&models.Task{})
	require.NoError(t, err)
	file := &files.File{
		Name:        "private filename",
		Size:        700,
		CreatedByID: 1,
	}
	_, err = s.Insert(file)
	require.NoError(t, err)
	_, err = s.Insert(&files.DriveFile{
		FileID:    file.ID,
		OwnerID:   1,
		Revision:  1,
		TrashedAt: time.Now(),
	})
	require.NoError(t, err)
	_, err = s.Insert(&models.TaskAttachment{
		TaskID:      t1.ID,
		FileID:      file.ID,
		CreatedByID: 1,
	}, &models.TaskAttachment{
		TaskID:      t2.ID,
		FileID:      file.ID,
		CreatedByID: 1,
	})
	require.NoError(t, err)
	space := &models.CompassSpace{
		Title:    "private space",
		OwnerID:  2,
		Theme:    "ink",
		Revision: 1,
	}
	_, err = s.Insert(space)
	require.NoError(t, err)
	_, err = s.Insert(&models.CompassEntry{
		SpaceID:     space.ID,
		Title:       "private writing",
		Content:     "private body",
		CreatedByID: 1,
		State:       "trashed",
		Kind:        "note",
		Theme:       "inherit",
		Revision:    1,
	})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	// Separate configured storage identity intentionally invalidates the short
	// cache; tests do not depend on a real-time 30-second sleep.
	config.FilesBasePath.Set(t.TempDir())
	after := usageRows(t, e)
	assert.Equal(t, before[2].ProjectsOwned+1, after[2].ProjectsOwned)
	assert.Equal(t, before[2].ProjectsArchived+1, after[2].ProjectsArchived)
	assert.Equal(t, before[2].ProjectsCreated24h+1, after[2].ProjectsCreated24h)
	assert.Equal(t, before[1].TasksCreated+1, after[1].TasksCreated)
	assert.Equal(t, before[2].TasksOwned+1, after[2].TasksOwned)
	assert.Equal(t, before[2].TasksCreated+1, after[2].TasksCreated)
	assert.Equal(t, before[1].TasksOwned+1, after[1].TasksOwned)
	assert.Equal(t, before[1].FilesUploaded+1, after[1].FilesUploaded)
	assert.Equal(t, before[1].FileBytes+700, after[1].FileBytes)
	assert.Equal(t, before[1].DriveFileBytes+700, after[1].DriveFileBytes)
	assert.Equal(t, before[1].DriveTrashedBytes+700, after[1].DriveTrashedBytes)
	assert.Equal(t, before[1].TotalStorageBytes+700, after[1].TotalStorageBytes)
	assert.Equal(t, before[2].CompassSpacesOwned+1, after[2].CompassSpacesOwned)
	assert.Equal(t, before[2].CompassEntriesOwned+1, after[2].CompassEntriesOwned)
	assert.Equal(t, before[1].CompassEntriesOwned, after[1].CompassEntriesOwned)
}
