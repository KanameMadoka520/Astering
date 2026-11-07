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
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/golang-jwt/jwt/v5"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIAccountAdmissionRejectsRevokedOriginalSessionWithoutCachingEmptyResult(t *testing.T) {
	aiBucketFixtures(t)
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("account-admission-fixture")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	_, err := tcyai.Save(2, tcyai.Settings{Connections: []tcyai.Connection{{ID: "fixture", Name: "Fixture", Kind: "chat", Protocol: "openai-chat", BaseURL: "https://example.com/v1", Model: "fixture", APIKey: "fixture-only"}}, Assistant: "fixture"})
	require.NoError(t, err)
	admitted := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
		"type": float64(auth.AuthTypeUser), "id": float64(2), "username": "user2", "sid": "550e8400-e29b-41d4-a716-446655440003",
	})
	s := db.NewSession()
	require.NoError(t, models.DeleteAllUserSessions(s, 2))
	require.NoError(t, s.Commit())
	events.DispatchPending(context.Background(), s)
	require.NoError(t, s.Close())
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			c.Set("user", admitted)
			return next(c)
		}
	})
	RegisterTCYAIRoutes(NewAPI(e, e.Group(GroupPrefix)))
	requestID := uuid.NewString()
	request := httptest.NewRequest(http.MethodPost, GroupPrefix+"/ai/run", strings.NewReader(fmt.Sprintf(`{"message":"never call the provider","mode":"read","request_id":%q}`, requestID)))
	request.Header.Set("Content-Type", "application/json")
	request.Header.Set("Accept-Language", "zh-CN")
	response := httptest.NewRecorder()
	e.ServeHTTP(response, request)
	require.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
	localized := i18n.T("zh-CN", "tcymc.errors.accountRunRevoked")
	assert.NotEqual(t, i18n.T("en", "tcymc.errors.accountRunRevoked"), localized)
	assert.Contains(t, response.Body.String(), localized)
	aiRuns.Lock()
	_, cached := aiRuns.entries[fmt.Sprintf("2:%s", requestID)]
	busy := aiRuns.busy[2]
	aiRuns.Unlock()
	assert.False(t, cached, "an authorization failure must not become a reusable empty successful reply")
	assert.False(t, busy, "a fresh login must be able to retry the same request")
}
