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
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"
)

func noteExecutorFixture(t *testing.T) func(int64) *aiExecution {
	t.Helper()
	aiBucketFixtures(t)
	oldSecret := config.ServiceSecret.GetString()
	config.ServiceSecret.Set("note-tools-fixture-secret")
	t.Cleanup(func() { config.ServiceSecret.Set(oldSecret) })
	e := echo.New()
	e.Use(func(next echo.HandlerFunc) echo.HandlerFunc {
		return func(c *echo.Context) error {
			claims, err := auth.ParseUserToken(strings.TrimPrefix(c.Request().Header.Get("Authorization"), "Bearer "))
			if err != nil || auth.CheckUserTokenSessionContext(c.Request().Context(), claims) != nil {
				return c.NoContent(http.StatusUnauthorized)
			}
			c.Set("api_user", user.WithSessionCredential(&user.User{ID: claims.UserID}, claims.SessionID))
			return next(c)
		}
	})
	api := NewAPI(e, e.Group(GroupPrefix))
	RegisterAsterNotesRoutes(api)
	Register(api, huma.Operation{
		OperationID: "note-tools-current-user",
		Method:      http.MethodGet,
		Path:        "/user",
	}, func(ctx context.Context, _ *struct{}) (*singleBody[user.User], error) {
		actor, err := authFromCtx(ctx)
		if err != nil {
			return nil, err
		}
		return &singleBody[user.User]{Body: &user.User{ID: actor.GetID()}}, nil
	})
	return func(uid int64) *aiExecution {
		session := &models.Session{
			ID:         uuid.NewString(),
			UserID:     uid,
			TokenHash:  uuid.NewString(),
			LastActive: time.Now(),
		}
		s := db.NewSession()
		_, err := s.Insert(session)
		require.NoError(t, err)
		require.NoError(t, s.Commit())
		require.NoError(t, s.Close())
		identity := user.WithSessionCredential(&user.User{ID: uid}, session.ID)
		token, err := auth.NewUserJWTAuthtoken(identity, session.ID)
		require.NoError(t, err)
		caller := httptest.NewRequest(http.MethodPost, "/ai/run", nil)
		caller.Header.Set("Authorization", "Bearer "+token)
		return &aiExecution{
			api:    api,
			caller: caller,
			auth:   user.RestrictToResourcePermissions(identity),
			input: tcyai.RunInput{
				Mode:        "write",
				AllowDelete: true,
				ToolModules: tcyai.ToolModules{
					ProjectTasks: "off",
					Notes:        "write",
				},
			},
		}
	}
}

func noteToolPrepare(t *testing.T, executor *aiExecution, name string, args map[string]any) (json.RawMessage, tcyai.Operation) {
	t.Helper()
	raw, err := json.Marshal(args)
	require.NoError(t, err)
	preview, err := executor.prepare(context.Background(), name, raw)
	require.NoError(t, err)
	preview.Approved = true
	return raw, preview
}

func noteToolCall(t *testing.T, executor *aiExecution, name string, args map[string]any) map[string]json.RawMessage {
	t.Helper()
	raw, preview := noteToolPrepare(t, executor, name, args)
	out, err := executor.execute(tcyai.WithOperation(context.Background(), &preview), name, raw)
	require.NoError(t, err)
	if tcyai.IsWriteTool(name) {
		require.True(t, preview.Verified)
	}
	var result map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(out), &result))
	return result
}

func noteToolCreate(t *testing.T, executor *aiExecution, title, content string) models.AsterNote {
	t.Helper()
	result := noteToolCall(t, executor, "create_note", map[string]any{
		"title":   title,
		"content": content,
	})
	var metadata models.AsterNote
	require.NoError(t, json.Unmarshal(result["note"], &metadata))
	require.Positive(t, metadata.ID)
	require.Empty(t, metadata.Content)
	require.JSONEq(t, fmt.Sprint(metadata.ID), string(result["note_id"]))
	require.JSONEq(t, "true", string(result["success"]))
	return metadata
}

func noteToolReadStored(t *testing.T, executor *aiExecution, id int64) *models.AsterNote {
	t.Helper()
	principal := executor.auth.(*user.User)
	actor := user.WithSessionCredential(&user.User{ID: principal.ID}, principal.CredentialScope().SessionID)
	s := db.NewReadSession()
	defer s.Close()
	note := &models.AsterNote{ID: id}
	require.NoError(t, note.ReadOne(s, actor))
	return note
}

func noteToolAppendASR(t *testing.T, executor *aiExecution, id int64, text string) *models.AsterNoteSegment {
	t.Helper()
	principal := executor.auth.(*user.User)
	actor := user.WithSessionCredential(&user.User{ID: principal.ID}, principal.CredentialScope().SessionID)
	s := db.NewSession()
	defer s.Close()
	segment := &models.AsterNoteSegment{
		ClientID: uuid.NewString(),
		Text:     text,
		StartMS:  0,
		EndMS:    100,
	}
	require.NoError(t, models.AppendAsterNoteSegment(s, actor, id, segment))
	require.NoError(t, s.Commit())
	return segment
}

func TestTCYAINoteToolsPartialMergeAppendAndCAS(t *testing.T) {
	executor := noteExecutorFixture(t)(1)
	executor.input.WriteProjectIDs = []int64{999999}
	note := noteToolCreate(t, executor, "Original", "Existing draft")
	for _, change := range []map[string]any{
		{"title": "Renamed"},
		{"pinned": true},
		{"append_content": "\nAppended once"},
		{"append_content": ""},
	} {
		current := noteToolReadStored(t, executor, note.ID)
		change["id"] = note.ID
		change["expected_revision"] = current.Revision
		result := noteToolCall(t, executor, "update_note", change)
		require.NotContains(t, string(result["note"]), `"content":`)
	}
	stored := noteToolReadStored(t, executor, note.ID)
	require.Equal(t, "Existing draft\nAppended once", stored.Content)
	require.Equal(t, "Renamed", stored.Title)
	require.True(t, stored.Pinned)
	require.EqualValues(t, 4, stored.Revision, "empty append is a no-op")
	raw, preview := noteToolPrepare(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": stored.Revision,
		"append_content":    "\nStale append",
	})
	noteToolCall(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": stored.Revision,
		"content":           "Intentional newer draft",
	})
	_, err := executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	require.Equal(t, "Intentional newer draft", noteToolReadStored(t, executor, note.ID).Content)
	noteToolCall(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": stored.Revision + 1,
		"content":           "",
	})
	require.Empty(t, noteToolReadStored(t, executor, note.ID).Content)
}

func TestTCYAINoteToolsEditorialReviewRemainsValidAcrossIndependentASR(t *testing.T) {
	executor := noteExecutorFixture(t)(1)
	note := noteToolCreate(t, executor, "During recording", "Keep article")
	raw, preview := noteToolPrepare(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
		"append_content":    "\nEditorial addition",
	})
	noteToolAppendASR(t, executor, note.ID, "New original transcription")
	after, err := executor.prepare(context.Background(), "update_note", raw)
	require.NoError(t, err)
	require.Equal(t, preview.Before, after.Before, "runtime's Before comparison must not force re-review for independent ASR")
	require.Equal(t, preview.Version, after.Version)
	_, err = executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
	require.NoError(t, err)
	stored := noteToolReadStored(t, executor, note.ID)
	require.Equal(t, "Keep article\nEditorial addition", stored.Content)
	require.EqualValues(t, 1, stored.SegmentCount)
	require.EqualValues(t, len("New original transcription"), stored.TranscriptBytes)
}

func TestTCYAINoteToolsDeleteProtectsOriginalTranscriptAfterApproval(t *testing.T) {
	executor := noteExecutorFixture(t)(1)
	article := strings.Repeat("Keep until reviewed. ", 30) + "Body tail excluded from the bounded review excerpt."
	note := noteToolCreate(t, executor, "Deletion preview", article)
	noteToolAppendASR(t, executor, note.ID, "Already reviewed source")
	raw, preview := noteToolPrepare(t, executor, "delete_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
	})
	require.Contains(t, preview.Before, `"segment_count":1`)
	var snapshots []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal([]byte(preview.Before), &snapshots))
	require.Len(t, snapshots, 1)
	require.NotContains(t, snapshots[0], "content", "review must not copy the full editable article")
	var excerpt, digest string
	require.NoError(t, json.Unmarshal(snapshots[0]["excerpt"], &excerpt))
	require.NotEmpty(t, excerpt, "a bounded excerpt helps the user identify the deletion target")
	require.LessOrEqual(t, utf8.RuneCountInString(excerpt), 180)
	require.Contains(t, article, excerpt)
	require.NotContains(t, preview.Before, "Body tail excluded from the bounded review excerpt.")
	require.NoError(t, json.Unmarshal(snapshots[0]["content_sha256"], &digest))
	require.Equal(t, fmt.Sprintf("%x", sha256.Sum256([]byte(article))), digest, "review binds the entire article even though it displays only an excerpt")
	noteToolAppendASR(t, executor, note.ID, "Added after approval")
	_, err := executor.execute(tcyai.WithOperation(context.Background(), &preview), "delete_note", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	stored := noteToolReadStored(t, executor, note.ID)
	require.Equal(t, note.Revision, stored.Revision, "ASR never bumps editorial revision")
	require.EqualValues(t, 2, stored.SegmentCount)
	result := noteToolCall(t, executor, "delete_note", map[string]any{
		"id":                note.ID,
		"expected_revision": stored.Revision,
	})
	require.JSONEq(t, "true", string(result["deleted"]))
	require.JSONEq(t, fmt.Sprint(stored.Revision), string(result["revision"]))
	s := db.NewReadSession()
	defer s.Close()
	count, err := s.Where("note_id = ?", note.ID).Count(&models.AsterNoteSegment{})
	require.NoError(t, err)
	require.Zero(t, count)
	count, err = s.ID(note.ID).Count(&models.AsterNote{})
	require.NoError(t, err)
	require.Zero(t, count)
}

func TestTCYAINoteToolsUnicodePagesPinEditorialRevisionAndBoundRawSegments(t *testing.T) {
	executor := noteExecutorFixture(t)(1)
	article := strings.Repeat("\u661f🙂\u6587", 14000)
	// The normal editor permits 8 MiB; seed a long article through its actual
	// model rather than bypassing the shared 64 KB tool-argument safety limit.
	s := db.NewSession()
	note := &models.AsterNote{
		Title:   "Long Unicode article",
		Content: article,
	}
	identity := executor.auth.(*user.User)
	human := user.WithSessionCredential(&user.User{ID: identity.ID}, identity.CredentialScope().SessionID)
	require.NoError(t, note.Create(s, human))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	first := noteToolCall(t, executor, "get_note", map[string]any{"id": note.ID})
	var page aiNoteTextPage
	require.NoError(t, json.Unmarshal(first["content_page"], &page))
	require.Equal(t, 8000, utf8.RuneCountInString(page.Text))
	require.Equal(t, 42000, page.Total)
	require.True(t, page.HasMore)
	second := noteToolCall(t, executor, "get_note", map[string]any{
		"id":                note.ID,
		"offset":            page.NextOffset,
		"max_chars":         32000,
		"expected_revision": note.Revision,
	})
	require.NoError(t, json.Unmarshal(second["content_page"], &page))
	require.Equal(t, 32000, utf8.RuneCountInString(page.Text))
	require.True(t, utf8.ValidString(page.Text))
	require.Equal(t, 40000, page.NextOffset)
	noteToolCall(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
		"append_content":    "\nNew revision",
	})
	raw, err := json.Marshal(map[string]any{
		"id":                note.ID,
		"offset":            page.NextOffset,
		"expected_revision": note.Revision,
	})
	require.NoError(t, err)
	_, err = executor.execute(context.Background(), "get_note", raw)
	requireAIBucketCode(t, err, "STATE_CONFLICT")
	segment := noteToolAppendASR(t, executor, note.ID, strings.Repeat("\u8bed🙂", 4000))
	listed := noteToolCall(t, executor, "list_note_segments", map[string]any{"id": note.ID})
	var items []map[string]json.RawMessage
	require.NoError(t, json.Unmarshal(listed["items"], &items))
	require.Len(t, items, 1)
	var preview string
	require.NoError(t, json.Unmarshal(items[0]["text"], &preview))
	require.Equal(t, 1000, utf8.RuneCountInString(preview))
	require.JSONEq(t, "true", string(items[0]["text_truncated"]))
	full := noteToolCall(t, executor, "list_note_segments", map[string]any{
		"id":         note.ID,
		"segment_id": segment.ID,
		"max_chars":  32000,
	})
	require.NoError(t, json.Unmarshal(full["text_page"], &page))
	require.Equal(t, segment.Text, page.Text)
	require.False(t, page.HasMore)
}

func TestTCYAINoteToolsPaginationHonorsConfiguredMaximum(t *testing.T) {
	for _, maximum := range []int{1, 2} {
		t.Run(fmt.Sprint(maximum), func(t *testing.T) {
			executor := noteExecutorFixture(t)(1)
			oldMaximum := config.ServiceMaxItemsPerPage.GetInt()
			config.ServiceMaxItemsPerPage.Set(maximum)
			t.Cleanup(func() { config.ServiceMaxItemsPerPage.Set(oldMaximum) })
			for i := 0; i < 5; i++ {
				noteToolCreate(t, executor, fmt.Sprintf("Note %d", i), "")
			}
			seen := map[int64]bool{}
			for page := 1; page <= (5+maximum-1)/maximum; page++ {
				result := noteToolCall(t, executor, "list_notes", map[string]any{
					"page":     page,
					"per_page": 25,
				})
				require.JSONEq(t, fmt.Sprint(maximum), string(result["per_page"]))
				require.JSONEq(t, fmt.Sprint((5+maximum-1)/maximum), string(result["total_pages"]))
				var rows []models.AsterNote
				require.NoError(t, json.Unmarshal(result["items"], &rows))
				for _, row := range rows {
					require.False(t, seen[row.ID])
					seen[row.ID] = true
					require.Empty(t, row.Content)
				}
			}
			require.Len(t, seen, 5)
		})
	}
}

func TestTCYAINoteToolsRefuseMissingReviewPermissionAndRevokedSession(t *testing.T) {
	executors := noteExecutorFixture(t)
	executor := executors(1)
	other := executors(2)
	other.auth.(*user.User).IsAdmin = true
	note := noteToolCreate(t, executor, "Owner only", "Private draft")
	raw, preview := noteToolPrepare(t, executor, "update_note", map[string]any{
		"id":                note.ID,
		"expected_revision": note.Revision,
		"title":             "Reviewed edit",
	})
	_, err := executor.execute(context.Background(), "update_note", raw)
	requireAIBucketCode(t, err, "REVIEW_REQUIRED")
	preview.Approved = false
	_, err = executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
	requireAIBucketCode(t, err, "REVIEW_REQUIRED")
	preview.Approved = true
	_, err = other.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
	require.Error(t, err)
	_, err = other.execute(context.Background(), "get_note", json.RawMessage(fmt.Sprintf(`{"id":%d}`, note.ID)))
	require.Error(t, err)
	for _, mode := range []string{"off", "read"} {
		executor.input.ToolModules.Notes = mode
		_, err = executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
		requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	}
	executor.input.ToolModules.Notes = "off"
	_, err = executor.execute(context.Background(), "get_note", json.RawMessage(fmt.Sprintf(`{"id":%d}`, note.ID)))
	requireAIBucketCode(t, err, "TOOL_NOT_ALLOWED")
	executor.input.ToolModules.Notes = "write"
	s := db.NewSession()
	_, err = s.ID(executor.auth.(*user.User).CredentialScope().SessionID).Delete(&models.Session{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	_, err = executor.execute(tcyai.WithOperation(context.Background(), &preview), "update_note", raw)
	require.Error(t, err)
	_, err = executor.execute(context.Background(), "get_note", json.RawMessage(fmt.Sprintf(`{"id":%d}`, note.ID)))
	require.Error(t, err)
}
