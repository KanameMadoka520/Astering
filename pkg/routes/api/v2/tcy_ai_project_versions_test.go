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
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/license"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/mattn/go-sqlite3"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
	xormlog "xorm.io/xorm/log"
	"xorm.io/xorm/schemas"
)

func TestAIProjectVersionRoutePreservesCompoundIdentity(t *testing.T) {
	route, err := aiProjectVersionRoute("get_project_version_entity", json.RawMessage(`{"project_id":6,"version_id":12,"kind":"position","entity_id":"33:4"}`))
	require.NoError(t, err)
	assert.Equal(t, "/projects/6/versions/12/entities/position/33:4", route.path)
	assert.Equal(t, http.MethodGet, route.method)
	assert.Nil(t, route.body)
	route, err = aiProjectVersionRoute("list_project_versions", json.RawMessage(`{"project_id":6,"page":3}`))
	require.NoError(t, err)
	assert.Equal(t, "12", route.query.Get("per_page"))
	assert.Equal(t, "3", route.query.Get("page"))
	for _, args := range []string{
		`{"project_id":6,"version_id":12,"kind":"task","entity_id":"../secret"}`,
		`{"project_id":6,"version_id":12,"kind":"task","entity_id":"%2f"}`,
	} {
		_, err = aiProjectVersionRoute("get_project_version_entity", json.RawMessage(args))
		require.Error(t, err)
	}
}

func projectVersionAIExecutors(t *testing.T) func(int64) *aiExecution {
	t.Helper()
	aiBucketFixtures(t)
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			id, err := strconv.ParseInt(c.Request().Header.Get("Authorization"), 10, 64)
			if err != nil || id < 1 {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.Set("api_user", &user.User{ID: id, IsAdmin: id == 2})
			return next(c)
		}
	})
	api := NewAPI(e, e.Group(GroupPrefix))
	RegisterProjectRoutes(api)
	RegisterProjectVersionRoutes(api)
	Register(api, huma.Operation{OperationID: "version-fixture-user", Method: http.MethodGet, Path: "/user"},
		func(ctx context.Context, _ *struct{}) (*singleBody[user.User], error) {
			a, err := authFromCtx(ctx)
			if err != nil {
				return nil, err
			}
			return &singleBody[user.User]{Body: &user.User{ID: a.GetID()}}, nil
		})
	return func(id int64) *aiExecution {
		request := httptest.NewRequest(http.MethodPost, "/ai/run", nil)
		request.Header.Set("Authorization", strconv.FormatInt(id, 10))
		return &aiExecution{api: api, caller: request, auth: user.RestrictToResourcePermissions(&user.User{ID: id, IsAdmin: id == 2}), input: tcyai.RunInput{Mode: "write"}}
	}
}

func projectVersionAICall(t *testing.T, executor *aiExecution, name string, args any) (map[string]any, tcyai.Operation) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	op, err := executor.prepare(context.Background(), name, raw)
	require.NoError(t, err)
	op.ID = uuid.NewString() // The real runner creates this before persisting a pending operation.
	data, err := executor.execute(tcyai.WithOperation(context.Background(), &op), name, raw)
	require.NoError(t, err)
	var result map[string]any
	require.NoError(t, json.Unmarshal([]byte(data), &result))
	return result, op
}

func TestAIProjectVersionsRealHTTPRestoreAndScope(t *testing.T) {
	makeExecutor := projectVersionAIExecutors(t)
	executor := makeExecutor(1)
	s := db.NewSession()
	project := &models.Project{Title: "Agent checkpoint fixture"}
	require.NoError(t, project.Create(s, &user.User{ID: 1}))
	newTask := &models.Task{ProjectID: project.ID, Title: "Before task edit", Description: "<p>Saved content</p>"}
	require.NoError(t, newTask.Create(s, &user.User{ID: 1}))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	saved, saveOp := projectVersionAICall(t, executor, "save_project_version", map[string]any{"project_id": project.ID, "name": "Before editing"})
	assert.True(t, saveOp.Verified)
	version := int64(saved["id"].(float64))
	index, _ := projectVersionAICall(t, executor, "list_project_version_entities", map[string]any{"project_id": project.ID, "version_id": version, "kind": "task", "per_page": 1})
	require.Len(t, index["items"].([]any), 1)
	entity := index["items"].([]any)[0].(map[string]any)
	detail, _ := projectVersionAICall(t, executor, "get_project_version_entity", map[string]any{"project_id": project.ID, "version_id": version, "kind": "task", "entity_id": entity["entity_id"]})
	task := detail["content"].(map[string]any)
	taskID := int64(task["id"].(float64))
	original := task["title"].(string)
	s = db.NewSession()
	_, err := s.ID(taskID).Cols("title").Update(&models.Task{Title: "Changed after checkpoint"})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	preview, _ := projectVersionAICall(t, executor, "get_project_version_preview", map[string]any{"project_id": project.ID, "version_id": version, "per_page": 1})
	require.Equal(t, true, preview["can_restore"])
	args := map[string]any{"project_id": project.ID, "version_id": version, "expected_current_hash": preview["current_hash"], "plan_hash": preview["plan_hash"]}
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	executor.input.WriteProjectIDs = []int64{2}
	_, err = executor.prepare(context.Background(), "restore_project_version", raw)
	requireAIBucketCode(t, err, "SCOPE_DENIED")
	executor.input.WriteProjectIDs = []int64{project.ID}
	restored, restoreOp := projectVersionAICall(t, executor, "restore_project_version", args)
	assert.True(t, restoreOp.Verified)
	assert.Equal(t, true, restored["verified"])
	assert.EqualValues(t, version, restored["restored_from_version_id"])
	assert.Contains(t, restoreOp.Before, "Before editing")
	s = db.NewSession()
	current, err := models.GetTaskSimple(s, &models.Task{ID: taskID})
	require.NoError(t, err)
	assert.Equal(t, original, current.Title)
	require.NoError(t, s.Close())
	_, err = executor.prepare(context.Background(), "restore_project_version", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
}

func TestAIProjectVersionsCannotInheritInstanceAdminOrDisabledModule(t *testing.T) {
	makeExecutor := projectVersionAIExecutors(t)
	license.SetForTests([]license.Feature{license.FeatureAdminPanel})
	t.Cleanup(license.ResetForTests)
	s := db.NewSession()
	_, err := s.ID(2).Cols("is_admin").Update(&user.User{IsAdmin: true})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	s = db.NewSession()
	canRead, _, err := (&models.Project{ID: 1}).CanRead(s, &user.User{ID: 2, IsAdmin: true})
	require.NoError(t, err)
	require.True(t, canRead, "the licensed ordinary admin bypass must really be available in this fixture")
	require.NoError(t, s.Close())
	outsider := makeExecutor(2)
	_, err = outsider.execute(context.Background(), "list_project_versions", json.RawMessage(`{"project_id":1}`))
	require.Error(t, err)
	_, err = outsider.prepare(context.Background(), "save_project_version", json.RawMessage(`{"project_id":1,"name":"Do not save"}`))
	require.Error(t, err)
	owner := makeExecutor(1)
	owner.input.ToolModules.ProjectTasks = "off"
	_, err = owner.execute(context.Background(), "list_project_versions", json.RawMessage(`{"project_id":1}`))
	requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	owner.input.ToolModules.ProjectTasks = "read"
	_, err = owner.prepare(context.Background(), "save_project_version", json.RawMessage(`{"project_id":1,"name":"Do not save"}`))
	requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	owner.input.ToolModules.ProjectTasks = "write"
	_, err = owner.execute(context.Background(), "save_project_version", json.RawMessage(`{"project_id":1,"name":"No receipt"}`))
	requireAIBucketCode(t, err, "OPERATION_REQUIRED")
	_, err = owner.execute(tcyai.WithOperation(context.Background(), &tcyai.Operation{ID: strings.Repeat("x", 36)}), "save_project_version", json.RawMessage(`{"project_id":1,"name":"Invalid receipt"}`))
	requireAIBucketCode(t, err, "OPERATION_REQUIRED")
}

func projectVersionRetryWALFixture(t *testing.T) *xorm.Engine {
	t.Helper()
	aiBucketFixtures(t)
	if db.Type() != schemas.SQLITE {
		t.Skip("requires SQLite WAL snapshot promotion")
	}
	engine, err := xorm.NewEngine("sqlite3", filepath.Join(t.TempDir(), "history-retry.db")+"?_journal_mode=WAL&_busy_timeout=100")
	require.NoError(t, err)
	engine.SetMaxOpenConns(4)
	t.Cleanup(func() { require.NoError(t, engine.Close()) })
	_, err = engine.Exec("CREATE TABLE history_retry_probe (id INTEGER PRIMARY KEY, value TEXT NOT NULL)")
	require.NoError(t, err)
	_, err = engine.Exec("INSERT INTO history_retry_probe (id, value) VALUES (1, 'before'), (2, 'unchanged')")
	require.NoError(t, err)
	return engine
}

func projectVersionRetryStoredValue(t *testing.T, engine *xorm.Engine) string {
	t.Helper()
	row := struct{ Value string }{}
	has, err := engine.SQL("SELECT value FROM history_retry_probe WHERE id = 2").Get(&row)
	require.NoError(t, err)
	require.True(t, has)
	return row.Value
}

func TestProjectVersionsSQLiteRetryRestartsRealStaleSnapshot(t *testing.T) {
	engine := projectVersionRetryWALFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	var attempts, committedCallbacks int
	var firstError error
	var sessions []*xorm.Session
	result, err := runProjectVersionSessions(ctx, &user.User{ID: 1}, engine.NewSession, func(s *xorm.Session, _ web.Auth) (*string, error) {
		attempts++
		sessions = append(sessions, s)
		row := struct{ Value string }{}
		if _, err := s.SQL("SELECT value FROM history_retry_probe WHERE id = 1").Get(&row); err != nil {
			return nil, err
		}
		if attempts == 1 {
			// Another connection commits after this attempt's read snapshot.
			// WAL must reject the following UPDATE with SQLITE_BUSY_SNAPSHOT.
			writerDone := make(chan error, 1)
			go func() {
				writer := engine.NewSession()
				defer writer.Close()
				writer.Context(ctx)
				_, err := writer.Exec("UPDATE history_retry_probe SET value = 'after concurrent commit' WHERE id = 1")
				writerDone <- err
			}()
			select {
			case err := <-writerDone:
				if err != nil {
					return nil, err
				}
			case <-ctx.Done():
				return nil, ctx.Err()
			}
		}
		events.OnCommit(s, func() error { committedCallbacks++; return nil })
		_, err := s.Exec("UPDATE history_retry_probe SET value = ? WHERE id = 2", row.Value)
		if attempts == 1 {
			firstError = err
		}
		return &row.Value, err
	})
	require.NoError(t, err)
	require.NotNil(t, result)
	require.Equal(t, "after concurrent commit", *result, "the retry must read a new snapshot, not replay one statement")
	require.Equal(t, 2, attempts)
	var sqliteErr sqlite3.Error
	require.ErrorAs(t, firstError, &sqliteErr)
	require.Equal(t, sqlite3.ErrBusySnapshot, sqliteErr.ExtendedCode)
	require.NotSame(t, sessions[0], sessions[1])
	require.Equal(t, "after concurrent commit", projectVersionRetryStoredValue(t, engine))
	for _, session := range sessions {
		require.False(t, session.IsInTx())
		events.DispatchPending(ctx, session)
	}
	require.Equal(t, 1, committedCallbacks, "failed transaction callbacks must be discarded before retry")
}

func TestProjectVersionsSQLiteRetryIsBoundedAndDiscardsFailedWrites(t *testing.T) {
	for _, tc := range []struct {
		name     string
		err      error
		attempts int
	}{
		{name: "busy", err: sqlite3.Error{Code: sqlite3.ErrBusy}, attempts: 4},
		{name: "wrapped_snapshot", err: fmt.Errorf("snapshot: %w", sqlite3.Error{Code: sqlite3.ErrBusy, ExtendedCode: sqlite3.ErrBusySnapshot}), attempts: 4},
		{name: "locked_is_not_busy", err: sqlite3.Error{Code: sqlite3.ErrLocked}, attempts: 1},
		{name: "message_is_not_a_typed_busy", err: errors.New("database is locked"), attempts: 1},
		{name: "authorization_is_not_retried", err: models.ErrGenericForbidden{}, attempts: 1},
	} {
		t.Run(tc.name, func(t *testing.T) {
			engine := projectVersionRetryWALFixture(t)
			var attempts, committedCallbacks int
			var sessions []*xorm.Session
			result, err := runProjectVersionSessions(context.Background(), &user.User{ID: 1}, engine.NewSession, func(s *xorm.Session, _ web.Auth) (*string, error) {
				attempts++
				sessions = append(sessions, s)
				if _, err := s.Exec("UPDATE history_retry_probe SET value = 'must roll back' WHERE id = 2"); err != nil {
					return nil, err
				}
				events.OnCommit(s, func() error { committedCallbacks++; return nil })
				value := "discard this failed output"
				return &value, tc.err
			})
			require.ErrorIs(t, err, tc.err)
			require.Nil(t, result)
			require.Equal(t, tc.attempts, attempts)
			for _, session := range sessions {
				require.False(t, session.IsInTx())
				events.DispatchPending(context.Background(), session)
			}
			require.Zero(t, committedCallbacks)
			require.Equal(t, "unchanged", projectVersionRetryStoredValue(t, engine))
		})
	}
}

func TestProjectVersionsSQLiteRetryCancellationStopsBeforeNextAttempt(t *testing.T) {
	engine := projectVersionRetryWALFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	attempts := 0
	result, err := runProjectVersionSessions(ctx, &user.User{ID: 1}, engine.NewSession, func(s *xorm.Session, _ web.Auth) (*string, error) {
		attempts++
		_, err := s.Exec("UPDATE history_retry_probe SET value = 'must roll back' WHERE id = 2")
		if err != nil {
			return nil, err
		}
		cancel()
		return nil, sqlite3.Error{Code: sqlite3.ErrBusy, ExtendedCode: sqlite3.ErrBusySnapshot}
	})
	require.ErrorIs(t, err, context.Canceled)
	require.Nil(t, result)
	require.Equal(t, 1, attempts)
	require.Equal(t, "unchanged", projectVersionRetryStoredValue(t, engine))
}

type attachmentUploadPermissionLogger struct {
	xormlog.ContextLogger
	before func(xormlog.LogContext)
}

func (*attachmentUploadPermissionLogger) IsShowSQL() bool { return true }
func (l *attachmentUploadPermissionLogger) BeforeSQL(ctx xormlog.LogContext) {
	l.before(ctx)
}
func (*attachmentUploadPermissionLogger) AfterSQL(xormlog.LogContext) {}

func projectVersionAttachmentAPI(t *testing.T) (*echo.Echo, *xorm.Engine) {
	t.Helper()
	aiBucketFixtures(t)
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			id, err := strconv.ParseInt(c.Request().Header.Get("Authorization"), 10, 64)
			if err != nil || id < 1 {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.Set("api_user", &user.User{ID: id})
			return next(c)
		}
	})
	RegisterTaskAttachmentRoutes(NewAPI(e, e.Group(GroupPrefix)))
	s := db.NewAutocommitSession()
	engine := s.Engine()
	require.NoError(t, s.Close())
	return e, engine
}

func projectVersionAttachmentUpload(t *testing.T, e *echo.Echo, userID int64) *httptest.ResponseRecorder {
	t.Helper()
	var body bytes.Buffer
	w := multipart.NewWriter(&body)
	part, err := w.CreateFormFile("files", "history-upload.txt")
	require.NoError(t, err)
	_, err = part.Write([]byte("history upload fixture"))
	require.NoError(t, err)
	require.NoError(t, w.Close())
	request := httptest.NewRequest(http.MethodPost, GroupPrefix+"/tasks/1/attachments", &body)
	request.Header.Set("Content-Type", w.FormDataContentType())
	request.Header.Set("Authorization", strconv.FormatInt(userID, 10))
	recorder := httptest.NewRecorder()
	e.ServeHTTP(recorder, request)
	return recorder
}

func TestProjectVersionsNativeAttachmentUploadWALReservesBeforePermissionRead(t *testing.T) {
	e, engine := projectVersionAttachmentAPI(t)
	if db.Type() != schemas.SQLITE {
		t.Skip("requires SQLite WAL writer reservation")
	}
	rows, err := engine.QueryString("PRAGMA journal_mode")
	require.NoError(t, err)
	t.Logf("SQLite journal mode: %v", rows)
	if len(rows) != 1 || rows[0]["journal_mode"] != "wal" {
		t.Skip("run with VIKUNJA_TESTS_USE_CONFIG=1 and an isolated SQLite WAL database")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	writerDone := make(chan error, 1)
	var reachedPermission atomic.Bool
	var writerFinishedEarly bool
	var writerErr error
	originalLogger := engine.Logger()
	engine.SetLogger(&attachmentUploadPermissionLogger{ContextLogger: originalLogger, before: func(ctxLog xormlog.LogContext) {
		sql := strings.ReplaceAll(strings.ReplaceAll(ctxLog.SQL, "`", ""), "\"", "")
		if !strings.HasPrefix(sql, "SELECT ") || !strings.Contains(sql, "FROM projects ") || !reachedPermission.CompareAndSwap(false, true) {
			return
		}
		// The native handler has already read the task. A background event
		// committing here used to invalidate its deferred WAL read snapshot.
		go func() {
			writer := engine.NewSession()
			defer writer.Close()
			writer.Context(ctx)
			_, err := writer.Exec("UPDATE tasks SET title = ? WHERE id = 1", "Concurrent native-upload fixture")
			writerDone <- err
		}()
		select {
		case writerErr = <-writerDone:
			writerFinishedEarly = true
		case <-time.After(75 * time.Millisecond):
		}
	}})
	defer engine.SetLogger(originalLogger)
	response := projectVersionAttachmentUpload(t, e, 1)
	if !writerFinishedEarly && reachedPermission.Load() {
		select {
		case writerErr = <-writerDone:
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		}
	}
	require.NoError(t, writerErr)
	require.True(t, reachedPermission.Load(), "the concurrency barrier must run during the actual model permission lookup")
	assert.False(t, writerFinishedEarly, "the second writer must wait until the upload transaction finishes")
	require.Less(t, response.Code, 300, response.Body.String())
	var result struct {
		Errors  []json.RawMessage        `json:"errors"`
		Success []*models.TaskAttachment `json:"success"`
	}
	require.NoError(t, json.Unmarshal(response.Body.Bytes(), &result))
	require.Len(t, result.Success, 1, response.Body.String())
	require.Empty(t, result.Errors, response.Body.String())
	require.NoError(t, result.Success[0].File.LoadFileByID())
	defer result.Success[0].File.File.Close()
}

func TestProjectVersionsNativeAttachmentUploadDeniedDoesNotStoreFile(t *testing.T) {
	e, engine := projectVersionAttachmentAPI(t)
	basePath := t.TempDir()
	originalPath, originalType := config.FilesBasePath.GetString(), config.FilesType.GetString()
	config.FilesBasePath.Set(basePath)
	config.FilesType.Set("local")
	require.NoError(t, files.InitStorageBackend(context.Background()))
	t.Cleanup(func() {
		config.FilesBasePath.Set(originalPath)
		config.FilesType.Set(originalType)
		files.InitTestFileHandler()
	})
	countBefore, err := engine.Count(new(files.File))
	require.NoError(t, err)
	response := projectVersionAttachmentUpload(t, e, 2)
	require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
	countAfter, err := engine.Count(new(files.File))
	require.NoError(t, err)
	require.Equal(t, countBefore, countAfter)
	var created []*files.File
	require.NoError(t, engine.Where("name = ?", "history-upload.txt").Find(&created))
	require.Empty(t, created)
	entries, err := os.ReadDir(basePath)
	require.NoError(t, err)
	require.Empty(t, entries, "a denied upload must not create a blob or even an upload temporary directory")
}

func TestProjectVersionsAPIErrorClassifiesCanceledRequests(t *testing.T) {
	for name, err := range map[string]error{
		"plain":   context.Canceled,
		"wrapped": fmt.Errorf("reading checkpoint: %w", context.Canceled),
	} {
		t.Run(name, func(t *testing.T) {
			mapped := projectVersionAPIError(err)
			var status huma.StatusError
			require.ErrorAs(t, mapped, &status)
			require.Equal(t, 499, status.GetStatus())
			require.Equal(t, "Request canceled", mapped.Error())
		})
	}
	for name, err := range map[string]error{
		"matching_message_is_not_a_cancellation": errors.New("context canceled"),
		"ordinary_database_error":                errors.New("database connection failed"),
		"deadline_is_not_client_cancellation":    context.DeadlineExceeded,
	} {
		t.Run(name, func(t *testing.T) {
			require.Equal(t, err, projectVersionAPIError(err), "real failures must keep their existing error handling")
		})
	}
}
