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
	"fmt"
	"net/http"
	"net/http/httptest"
	"strconv"
	"testing"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/user"
	"github.com/danielgtaylor/huma/v2"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func compassExecutorFixture(t *testing.T) func(int64) *aiExecution {
	t.Helper()
	aiBucketFixtures(t)
	e := echo.New()
	// This fixture substitutes authentication only; all Compass HTTP handlers,
	// ACLs, revision locks, sanitization and database writes remain real.
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
	api := NewAPI(e, e.Group(GroupPrefix))
	RegisterCompassRoutes(api)
	Register(api, huma.Operation{
		OperationID: "fixture-user",
		Method:      http.MethodGet,
		Path:        "/user",
	}, func(ctx context.Context, _ *struct{}) (*singleBody[user.User], error) {
		a, err := authFromCtx(ctx)
		if err != nil {
			return nil, err
		}
		return &singleBody[user.User]{Body: &user.User{ID: a.GetID()}}, nil
	})
	return func(id int64) *aiExecution {
		request := httptest.NewRequest(http.MethodPost, "/ai/run", nil)
		request.Header.Set("Authorization", strconv.FormatInt(id, 10))
		return &aiExecution{
			api:    api,
			caller: request,
			auth:   &user.User{ID: id},
			input: tcyai.RunInput{
				Mode:        "write",
				ToolModules: tcyai.ToolModules{Compass: "write"},
			},
		}
	}
}

func compassToolCall(t *testing.T, executor *aiExecution, name string, args map[string]any) map[string]any {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	preview, err := executor.prepare(context.Background(), name, raw)
	require.NoError(t, err)
	out, err := executor.execute(tcyai.WithOperation(context.Background(), &preview), name, raw)
	require.NoError(t, err)
	var result map[string]any
	require.NoError(t, json.Unmarshal([]byte(out), &result))
	return result
}

func TestTCYAICompassRoundTripAndRevision(t *testing.T) {
	executor := compassExecutorFixture(t)(1)
	// Project scope must not accidentally become a cross-module deny or grant.
	executor.input.WriteProjectIDs = []int64{999999}
	space := compassToolCall(t, executor, "create_compass_space", map[string]any{"title": "Writing fixture"})
	spaceID := space["id"]
	entry := compassToolCall(t, executor, "create_compass_entry", map[string]any{
		"space_id": spaceID,
		"title":    "First writing",
		"content":  "<p>Keep this <strong>body</strong>.</p><script>alert(1)</script>",
		"category": "Direction",
		"tags":     []string{"fixture"},
		"pinned":   true,
	})
	id := entry["id"]
	assert.NotContains(t, entry["content"], "<script")
	assert.Equal(t, "note", entry["kind"])
	assert.Equal(t, "active", entry["state"])
	assert.Equal(t, "inherit", entry["theme"])
	for _, title := range []string{"Second writing", "Third writing"} {
		compassToolCall(t, executor, "create_compass_entry", map[string]any{
			"space_id": spaceID,
			"title":    title,
		})
	}
	page := compassToolCall(t, executor, "list_compass_entries", map[string]any{
		"space_id": spaceID,
		"page":     2,
		"per_page": 1,
	})
	assert.EqualValues(t, 3, page["total"])
	assert.EqualValues(t, 3, page["total_pages"])
	rows := page["items"].([]any)
	require.Len(t, rows, 1)
	assert.NotContains(t, rows[0].(map[string]any), "content")
	saved := compassToolCall(t, executor, "update_compass_entry", map[string]any{
		"id":       id,
		"revision": entry["revision"],
		"title":    "Revised writing",
		"state":    "archived",
	})
	assert.Equal(t, entry["content"], saved["content"])
	assert.Equal(t, entry["tags"], saved["tags"])
	assert.Equal(t, entry["category"], saved["category"])
	stale, err := json.Marshal(map[string]any{
		"id":       id,
		"revision": entry["revision"],
		"content":  "must not replace",
	})
	require.NoError(t, err)
	_, err = executor.execute(context.Background(), "update_compass_entry", stale)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	trashed := compassToolCall(t, executor, "update_compass_entry", map[string]any{
		"id":       id,
		"revision": saved["revision"],
		"state":    "trashed",
	})
	assert.Equal(t, false, trashed["pinned"])
	restored := compassToolCall(t, executor, "restore_compass_revision", map[string]any{
		"id":                id,
		"revision":          entry["revision"],
		"expected_revision": trashed["revision"],
	})
	assert.Equal(t, "First writing", restored["title"])
	assert.Equal(t, "trashed", restored["state"], "history restore does not secretly untrash")
	assert.Equal(t, false, restored["pinned"])
	restored = compassToolCall(t, executor, "update_compass_entry", map[string]any{
		"id":       id,
		"revision": restored["revision"],
		"state":    "active",
	})
	assert.Equal(t, entry["content"], restored["content"])
	history := compassToolCall(t, executor, "list_compass_revisions", map[string]any{
		"id":       id,
		"per_page": 1,
	})
	assert.GreaterOrEqual(t, history["total"].(float64), float64(4))
	original := compassToolCall(t, executor, "get_compass_revision", map[string]any{
		"id":       id,
		"revision": entry["revision"],
	})
	assert.Equal(t, entry["content"], original["content"])
}

func TestTCYAICompassPermissionsAndReview(t *testing.T) {
	makeExecutor := compassExecutorFixture(t)
	owner, member, outsider := makeExecutor(1), makeExecutor(2), makeExecutor(3)
	private := compassToolCall(t, owner, "create_compass_space", map[string]any{"title": "Private fixture"})
	_, err := outsider.execute(context.Background(), "get_compass_space", json.RawMessage(fmt.Sprintf(`{"id":%.0f}`, private["id"])))
	require.Error(t, err)
	team := compassToolCall(t, owner, "create_compass_space", map[string]any{
		"title":   "Team fixture",
		"team_id": 1,
	})
	entry := compassToolCall(t, member, "create_compass_entry", map[string]any{
		"space_id": team["id"],
		"title":    "Member writing",
		"content":  "<p>Original</p>",
	})
	raw, err := json.Marshal(map[string]any{
		"id":       entry["id"],
		"revision": entry["revision"],
		"content":  "<p>Reviewed change</p>",
	})
	require.NoError(t, err)
	preview, err := member.prepare(context.Background(), "update_compass_entry", raw)
	require.NoError(t, err)
	s := db.NewSession()
	_, err = s.Where("team_id = ? AND user_id = ?", 1, 2).Delete(&models.TeamMember{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	_, err = member.execute(tcyai.WithOperation(context.Background(), &preview), "update_compass_entry", raw)
	require.Error(t, err)
	unchanged := compassToolCall(t, owner, "get_compass_entry", map[string]any{"id": entry["id"]})
	assert.Equal(t, entry["content"], unchanged["content"])

	owner.input.ToolModules.Compass = "read"
	_, err = owner.prepare(context.Background(), "update_compass_entry", raw)
	require.Error(t, err)
	_, err = owner.execute(context.Background(), "update_compass_entry", raw)
	require.Error(t, err)
	owner.input.ToolModules.Compass = "off"
	_, err = owner.execute(context.Background(), "get_compass_entry", json.RawMessage(fmt.Sprintf(`{"id":%.0f}`, entry["id"])))
	require.Error(t, err)
}

func TestTCYAICompassUpdatePreservesSpaceAndRejectsStaleReview(t *testing.T) {
	executor := compassExecutorFixture(t)(1)
	space := compassToolCall(t, executor, "create_compass_space", map[string]any{
		"title":        "Before",
		"motto":        "Keep motto",
		"introduction": "<p>Keep introduction</p>",
		"theme":        "ink",
	})
	args := map[string]any{
		"id":       space["id"],
		"revision": space["revision"],
		"title":    "After",
	}
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	preview, err := executor.prepare(context.Background(), "update_compass_space", raw)
	require.NoError(t, err)
	updated := compassToolCall(t, executor, "update_compass_space", args)
	assert.Equal(t, "Keep motto", updated["motto"])
	assert.Equal(t, space["introduction"], updated["introduction"])
	assert.Equal(t, space["theme"], updated["theme"])
	assert.Equal(t, space["background_focus_x"], updated["background_focus_x"])
	_, err = executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_compass_space", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	executor.caller.Header.Del("Authorization")
	_, err = executor.execute(context.Background(), "get_compass_space", json.RawMessage(fmt.Sprintf(`{"id":%.0f}`, space["id"])))
	require.Error(t, err, "each adapter execution must validate the current session")
}
