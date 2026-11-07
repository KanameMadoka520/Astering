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
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth/oauth2server"
	"github.com/golang-jwt/jwt/v5"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// Model the boundary after JWT admission but before the handler can acquire the
// account lock. Revoking before middleware would not exercise proof forwarding.
func TestOAuthAuthorizationPreservesAdmittedSessionProof(t *testing.T) {
	for _, version := range []string{"v1", "v2"} {
		t.Run(version, func(t *testing.T) {
			aiBucketFixtures(t)
			const sid = "550e8400-e29b-41d4-a716-446655440003"
			admitted := jwt.NewWithClaims(jwt.SigningMethodHS256, jwt.MapClaims{
				"type": float64(auth.AuthTypeUser), "id": float64(2), "username": "user2", "sid": sid,
			})
			s := db.NewSession()
			require.NoError(t, models.DeleteAllUserSessions(s, 2))
			require.NoError(t, s.Commit())
			events.DispatchPending(context.Background(), s)
			require.NoError(t, s.Close())
			const body = `{"response_type":"code","client_id":"astering","redirect_uri":"astering-desktop://callback","code_challenge":"challenge","code_challenge_method":"S256"}`
			e := echo.New()
			if version == "v1" {
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, "/api/v1/oauth/authorize", strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				c := e.NewContext(request, response)
				c.Set("user", admitted)
				err := oauth2server.HandleAuthorize(c)
				assert.True(t, models.IsErrGenericForbidden(err), "a revoked admitted session cannot mint an OAuth code: %v", err)
				assert.NotContains(t, response.Body.String(), `"code":"`)
			} else {
				e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
					return func(c *echo.Context) error {
						c.Set("user", admitted)
						return next(c)
					}
				})
				RegisterOAuthRoutes(NewAPI(e, e.Group(GroupPrefix)))
				response := httptest.NewRecorder()
				request := httptest.NewRequest(http.MethodPost, GroupPrefix+"/oauth/authorize", strings.NewReader(body))
				request.Header.Set("Content-Type", "application/json")
				e.ServeHTTP(response, request)
				assert.Equal(t, http.StatusForbidden, response.Code, response.Body.String())
			}
			s = db.NewReadSession()
			defer s.Close()
			count, err := s.Where("user_id = ?", 2).Count(new(models.OAuthCode))
			require.NoError(t, err)
			assert.Zero(t, count, "neither transport may downgrade the original authenticated proof to a bare user ID")
		})
	}
}
