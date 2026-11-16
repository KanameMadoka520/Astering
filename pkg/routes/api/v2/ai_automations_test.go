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
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/personalstorage"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func automationHTTPFixture(t *testing.T) (*echo.Echo, map[int64]string) {
	t.Helper()
	aiBucketFixtures(t)
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("automation-route-secret")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	tokens := map[int64]string{}
	for _, uid := range []int64{
		1,
		2,
	} {
		s := db.NewSession()
		session := &models.Session{
			ID:         uuid.NewString(),
			UserID:     uid,
			TokenHash:  uuid.NewString(),
			LastActive: time.Now(),
		}
		_, err := s.Insert(session)
		require.NoError(t, err)
		require.NoError(t, s.Commit())
		require.NoError(t, s.Close())
		token, err := auth.NewUserJWTAuthtoken(&user.User{ID: uid}, session.ID)
		require.NoError(t, err)
		tokens[uid] = token
	}
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			claims, err := auth.ParseUserToken(strings.TrimPrefix(c.Request().Header.Get("Authorization"), "Bearer "))
			if err != nil || auth.CheckUserTokenSessionContext(c.Request().Context(), claims) != nil {
				return c.NoContent(http.StatusUnauthorized)
			}
			principal := user.WithSessionCredential(&user.User{ID: claims.UserID}, claims.SessionID)
			if c.Request().Header.Get("X-Test-Scoped") == "true" {
				principal = user.RestrictToResourcePermissions(principal).(*user.User)
			}
			if c.Request().Header.Get("X-Test-Token") == "true" {
				c.Set("api_token", &models.APIToken{
					ID:      123,
					OwnerID: claims.UserID,
				})
			}
			c.Set("api_user", principal)
			return next(c)
		}
	})
	api := NewAPI(e, e.Group(GroupPrefix))
	RegisterAutomationRoutes(api)
	return e, tokens
}
func automationHTTPRequest(t *testing.T, e *echo.Echo, token, method, path string, body any, headers map[string]string) *httptest.ResponseRecorder {
	t.Helper()
	var data []byte
	var err error
	if body != nil {
		data, err = json.Marshal(body)
		require.NoError(t, err)
	}
	req := httptest.NewRequest(method, GroupPrefix+path, strings.NewReader(string(data)))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Authorization", "Bearer "+token)
	for key, value := range headers {
		req.Header.Set(key, value)
	}
	result := httptest.NewRecorder()
	e.ServeHTTP(result, req)
	return result
}
func decodeAutomationHTTP[T any](t *testing.T, result *httptest.ResponseRecorder, status int) T {
	t.Helper()
	require.Equal(t, status, result.Code, result.Body.String())
	require.Equal(t, "no-store", result.Header().Get("Cache-Control"))
	var value T
	require.NoError(t, json.Unmarshal(result.Body.Bytes(), &value))
	return value
}
func TestAutomationHTTPCRUDRunPaginationAndOwnership(t *testing.T) {
	e, tokens := automationHTTPFixture(t)
	spec := tcyai.AutomationSpec{
		Title:    "Private teacher reminder",
		Prompt:   "Remember the meeting",
		Kind:     "reminder",
		Enabled:  true,
		Timezone: "Asia/Shanghai",
		Schedule: tcyai.AutomationSchedule{
			Kind: "daily",
			Time: "09:00",
		},
		MaxRuntimeSeconds: 3600,
		NotifyOnSuccess:   true,
		NotifyOnFailure:   true,
	}
	created := decodeAutomationHTTP[tcyai.Automation](t, automationHTTPRequest(t, e, tokens[1], http.MethodPost, "/ai/automations", spec, nil), http.StatusCreated)
	read := decodeAutomationHTTP[tcyai.Automation](t, automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations/"+created.ID, nil, nil), http.StatusOK)
	assert.Equal(t, created.ID, read.ID)
	list := decodeAutomationHTTP[Paginated[tcyai.Automation]](t, automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations?page=1&per_page=1", nil, nil), http.StatusOK)
	require.Len(t, list.Items, 1)
	assert.EqualValues(t, 1, list.Total)
	other := decodeAutomationHTTP[Paginated[tcyai.Automation]](t, automationHTTPRequest(t, e, tokens[2], http.MethodGet, "/ai/automations", nil, nil), http.StatusOK)
	assert.Empty(t, other.Items)
	require.Equal(t, http.StatusNotFound, automationHTTPRequest(t, e, tokens[2], http.MethodGet, "/ai/automations/"+created.ID, nil, nil).Code)
	encoded, err := json.Marshal(spec)
	require.NoError(t, err)
	var update map[string]any
	require.NoError(t, json.Unmarshal(encoded, &update))
	update["expected_revision"] = created.Revision
	update["title"] = "Updated reminder"
	changed := decodeAutomationHTTP[tcyai.Automation](t, automationHTTPRequest(t, e, tokens[1], http.MethodPut, "/ai/automations/"+created.ID, update, nil), http.StatusOK)
	assert.Equal(t, "Updated reminder", changed.Title)
	require.Equal(t, http.StatusConflict, automationHTTPRequest(t, e, tokens[1], http.MethodPut, "/ai/automations/"+created.ID, update, nil).Code)
	runBody := map[string]string{"request_id": "persistent-reminder-request"}
	receipt := decodeAutomationHTTP[tcyai.AutomationRun](t, automationHTTPRequest(t, e, tokens[1], http.MethodPost, "/ai/automations/"+created.ID+"/run", runBody, nil), http.StatusCreated)
	duplicate := decodeAutomationHTTP[tcyai.AutomationRun](t, automationHTTPRequest(t, e, tokens[1], http.MethodPost, "/ai/automations/"+created.ID+"/run", runBody, nil), http.StatusCreated)
	assert.Equal(t, receipt.ID, duplicate.ID)
	require.Eventually(t, func() bool {
		run, readErr := tcyai.GetAutomationRun(1, created.ID, receipt.ID)
		return readErr == nil && run.NotificationStatus == "sent"
	}, 3*time.Second, 10*time.Millisecond)
	runs := decodeAutomationHTTP[Paginated[tcyai.AutomationRun]](t, automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations/"+created.ID+"/runs", nil, nil), http.StatusOK)
	require.Len(t, runs.Items, 1)
	assert.Equal(t, "succeeded", runs.Items[0].Status)
	single := decodeAutomationHTTP[tcyai.AutomationRun](t, automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations/"+created.ID+"/runs/"+receipt.ID, nil, nil), http.StatusOK)
	assert.Equal(t, receipt.ID, single.ID)
	require.Equal(t, http.StatusNotFound, automationHTTPRequest(t, e, tokens[2], http.MethodGet, "/ai/automations/"+created.ID+"/runs/"+receipt.ID, nil, nil).Code)
	require.Equal(t, http.StatusConflict, automationHTTPRequest(t, e, tokens[1], http.MethodDelete, "/ai/automations/"+created.ID, map[string]any{"expected_revision": created.Revision}, nil).Code)
	deleted := automationHTTPRequest(t, e, tokens[1], http.MethodDelete, "/ai/automations/"+created.ID, map[string]any{"expected_revision": changed.Revision}, nil)
	require.Equal(t, http.StatusNoContent, deleted.Code, deleted.Body.String())
	require.Equal(t, http.StatusNotFound, automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations/"+created.ID, nil, nil).Code)
}
func TestAutomationHTTPRejectsToolAndAPITokenAuthorization(t *testing.T) {
	e, tokens := automationHTTPFixture(t)
	for _, headers := range []map[string]string{
		{"X-Test-Scoped": "true"},
		{"X-Test-Token": "true"},
	} {
		result := automationHTTPRequest(t, e, tokens[1], http.MethodGet, "/ai/automations", nil, headers)
		require.Equal(t, http.StatusForbidden, result.Code, result.Body.String())
	}
}
func TestAutomationMissingModelFailsWithoutCreatingServiceSession(t *testing.T) {
	automationHTTPFixture(t)
	s := db.NewReadSession()
	before, err := s.Where("device_info LIKE ?", automationSessionPrefix+"%").Count(&models.Session{})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	record := tcyai.Automation{AutomationSpec: tcyai.AutomationSpec{Options: &tcyai.AssistantOptions{ConnectionID: "missing-model"}}}
	outcome := runAutomationAgent(context.Background(), nil, 1, record, tcyai.AutomationRun{}, func(string) error { t.Fatal("missing model must not create a conversation"); return nil })
	assert.Equal(t, "MODEL_NOT_CONFIGURED", outcome.ErrorCode)
	s = db.NewReadSession()
	defer s.Close()
	after, err := s.Where("device_info LIKE ?", automationSessionPrefix+"%").Count(&models.Session{})
	require.NoError(t, err)
	assert.Equal(t, before, after)
}

func automationSavedAgentFixture(t *testing.T) tcyai.Automation {
	t.Helper()
	automationHTTPFixture(t)
	_, err := tcyai.Save(1, tcyai.Settings{
		Assistant: "preflight-fixture",
		Connections: []tcyai.Connection{{
			ID:       "preflight-fixture",
			Name:     "Preflight fixture",
			Kind:     "chat",
			Protocol: "openai-chat",
			BaseURL:  "https://example.com/v1",
			Model:    "fixture-model",
			APIKey:   "public-fixture-key",
		}},
	})
	require.NoError(t, err)
	plan, err := tcyai.SaveAutomation(1, "", 0, tcyai.AutomationSpec{
		Title:    "Linked execution",
		Prompt:   "Read current tasks",
		Kind:     "agent",
		Timezone: "UTC",
		Schedule: tcyai.AutomationSchedule{
			Kind:            "interval",
			IntervalMinutes: 1,
		},
		Options: &tcyai.AssistantOptions{
			ConnectionID:   "preflight-fixture",
			Mode:           "read",
			Approval:       "smart",
			SearchMode:     "off",
			MaxRounds:      16,
			MaxOperations:  40,
			TimeoutSeconds: 180,
		},
	})
	require.NoError(t, err)
	return plan
}

func TestAutomationRunnerCreatesConversationAlongsideSavedDefinition(t *testing.T) {
	plan := automationSavedAgentFixture(t)
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	conversationID := ""
	outcome := runAutomationAgent(ctx, nil, 1, plan, tcyai.AutomationRun{ID: uuid.NewString()}, func(id string) error {
		conversationID = id
		// Stop before provider/tool execution while exercising the real account,
		// temporary credential and durable conversation admission path.
		return errors.New("fixture rejects admission link")
	})
	require.NotEmpty(t, conversationID, outcome)
	assert.Equal(t, "AUTOMATION_REMOVED", outcome.ErrorCode)
	conversation, err := tcyai.GetConversation(1, conversationID)
	require.NoError(t, err)
	assert.Equal(t, "[Automation] Linked execution", conversation.Title)
	s := db.NewReadSession()
	defer s.Close()
	remaining, err := s.Where("device_info LIKE ?", automationSessionPrefix+"%").Count(&models.Session{})
	require.NoError(t, err)
	assert.Zero(t, remaining, "the admission failure must revoke its service credential")
}

func TestAutomationRunnerConversationLimitIsActionableAndDoesNotStartModel(t *testing.T) {
	plan := automationSavedAgentFixture(t)
	for range 100 {
		chat, err := tcyai.CreateConversation(1, "Retained execution history")
		require.NoError(t, err)
		archived := true
		_, err = tcyai.UpdateConversationMetadata(1, chat.ID, tcyai.ConversationMetadata{Archived: &archived})
		require.NoError(t, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	outcome := runAutomationAgent(ctx, nil, 1, plan, tcyai.AutomationRun{ID: uuid.NewString()}, func(string) error {
		t.Fatal("the conversation limit must stop before linking or starting a model")
		return nil
	})
	assert.Equal(t, "CONVERSATION_LIMIT", outcome.ErrorCode)
	assert.Contains(t, outcome.Error, "Storage")
	chats, err := tcyai.ListConversations(1)
	require.NoError(t, err)
	assert.Len(t, chats, 100, "quota handling must not silently remove existing history")
	s := db.NewReadSession()
	defer s.Close()
	remaining, err := s.Where("device_info LIKE ?", automationSessionPrefix+"%").Count(&models.Session{})
	require.NoError(t, err)
	assert.Zero(t, remaining, "quota rejection must revoke its temporary service credential")
}
func TestAutomationTemporarySessionCleanupDoesNotDeleteNormalDevices(t *testing.T) {
	automationHTTPFixture(t)
	s := db.NewSession()
	expired := &models.Session{
		ID:         uuid.NewString(),
		UserID:     1,
		TokenHash:  uuid.NewString(),
		DeviceInfo: automationSessionPrefix + "1/expired",
		LastActive: time.Now(),
	}
	live := &models.Session{
		ID:         uuid.NewString(),
		UserID:     1,
		TokenHash:  uuid.NewString(),
		DeviceInfo: automationSessionPrefix + "9999999999/live",
		LastActive: time.Now(),
	}
	normal := &models.Session{
		ID:         uuid.NewString(),
		UserID:     1,
		TokenHash:  uuid.NewString(),
		DeviceInfo: "A teacher's phone",
		LastActive: time.Now(),
	}
	_, err := s.Insert(expired, live, normal)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.NoError(t, cleanupAutomationSessionRecords())
	db.AssertMissing(t, "sessions", map[string]interface{}{"id": expired.ID})
	db.AssertExists(t, "sessions", map[string]interface{}{"id": live.ID}, false)
	db.AssertExists(t, "sessions", map[string]interface{}{"id": normal.ID}, false)
	require.NoError(t, revokeAutomationSession(live.ID))
	db.AssertMissing(t, "sessions", map[string]interface{}{"id": live.ID})
	// Notifications are registered as private account-scoped feed records.
	notification, ok := notifications.Lookup("ai.automation")
	require.True(t, ok)
	assert.EqualValues(t, 0, notifications.ProjectIDOf(notification))
}

func TestAutomationStorageSummaryProtectsDefinitionsAndCountsOnce(t *testing.T) {
	automationHTTPFixture(t)
	before, err := personalstorage.ReadSummary(context.Background(), 1)
	require.NoError(t, err)
	spec := tcyai.AutomationSpec{
		Title:    "Protected reminder",
		Prompt:   "Private prompt",
		Kind:     "reminder",
		Timezone: "UTC",
		Schedule: tcyai.AutomationSchedule{
			Kind:            "interval",
			IntervalMinutes: 1,
		},
	}
	value, err := tcyai.SaveAutomation(1, "", 0, spec)
	require.NoError(t, err)
	after, err := personalstorage.ReadSummary(context.Background(), 1)
	require.NoError(t, err)
	assert.Positive(t, after.AutomationBytes)
	assert.Equal(t, after.AutomationBytes, after.TotalBytes-before.TotalBytes)
	assert.Equal(t, before.ConversationBytes, after.ConversationBytes)
	found := false
	for _, category := range after.Categories {
		if category.ID == "automations" {
			found = true
			assert.False(t, category.Cleanable)
			assert.Equal(t, after.AutomationBytes, category.Bytes)
		}
	}
	assert.True(t, found)
	preview, err := personalstorage.PreviewCleanup(context.Background(), 1, "test-human-session", []personalstorage.StorageSelection{{
		Kind:   "automations",
		ID:     value.ID,
		Action: "delete",
	}})
	if err == nil {
		require.Len(t, preview.Items, 1)
		assert.False(t, preview.Items[0].Allowed)
	}
	retained, err := tcyai.GetAutomation(1, value.ID)
	require.NoError(t, err)
	assert.Equal(t, value.ID, retained.ID)
}
