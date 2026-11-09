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
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestNoteOrganizationHTTPCapacityRejectsBeforeCreatingOrRetryingJobs(t *testing.T) {
	e, api := asterNotesFixture(t)
	registerNoteOrganizationRoutes(api)
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("notes-capacity-fixture")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
	_, err := tcyai.Save(1, tcyai.Settings{
		Connections: []tcyai.Connection{
			{
				ID:       "fixture",
				Name:     "Fixture",
				Kind:     "chat",
				Protocol: "openai-chat",
				BaseURL:  "https://example.com/v1",
				Model:    "fixture",
				APIKey:   "test-only-key",
			},
		},
		Assistant: "fixture",
	})
	require.NoError(t, err)
	created := asterNotesRequest(t, e, 1, http.MethodPost, "/notes", map[string]any{
		"title":   "Capacity source",
		"content": "Keep this source and its completed checkpoints.",
	}, false, false)
	require.Equal(t, http.StatusCreated, created.Code, created.Body.String())
	var note models.AsterNote
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &note))
	fresh := asterNotesDecode[models.AsterNote](t, asterNotesRequest(t, e, 1, http.MethodPost, "/notes", map[string]any{
		"title":   "No job yet",
		"content": "No queued orphan may be created when all slots are reserved.",
	}, false, false), http.StatusCreated)
	s := db.NewSession()
	job, err := models.CreateAsterNoteOrganization(s, &user.User{ID: 1}, note.ID, "article", "fixture", "fixture")
	require.NoError(t, err)
	job.Status = "failed"
	job.Error = "fixture_failure"
	job.Work = `{"source_offset":4,"summaries":["saved checkpoint"]}`
	require.NoError(t, models.SaveAsterNoteOrganizationCheckpoint(s, &user.User{ID: 1}, job))
	require.NoError(t, s.Commit())
	_ = s.Close()
	first, err := tcyai.ReserveNoteOrganizationStart(context.Background(), 1)
	require.NoError(t, err)
	t.Cleanup(first.Abort)
	second, err := tcyai.ReserveNoteOrganizationStart(context.Background(), 1)
	require.NoError(t, err)
	t.Cleanup(second.Abort)
	path := fmt.Sprintf("/notes/%d/organization", note.ID)
	full := asterNotesRequest(t, e, 1, http.MethodPost, path, map[string]any{"source": "article"}, false, false)
	require.Equal(t, http.StatusTooManyRequests, full.Code, full.Body.String())
	require.Equal(t, "5", full.Header().Get("Retry-After"))
	require.Contains(t, full.Body.String(), "note_organization_capacity_account")
	freshFull := asterNotesRequest(t, e, 1, http.MethodPost,
		fmt.Sprintf("/notes/%d/organization", fresh.ID), map[string]any{"source": "article"}, false, false)
	require.Equal(t, http.StatusTooManyRequests, freshFull.Code, freshFull.Body.String())
	retried := asterNotesRequest(t, e, 1, http.MethodPost,
		fmt.Sprintf("%s/%d/control", path, job.ID), map[string]any{"action": "retry"}, false, false)
	require.Equal(t, http.StatusTooManyRequests, retried.Code, retried.Body.String())
	s = db.NewReadSession()
	saved, err := models.ReadAsterNoteOrganization(s, &user.User{ID: 1}, note.ID, job.ID)
	require.NoError(t, err)
	require.Equal(t, job.Status, saved.Status)
	require.Equal(t, job.Attempt, saved.Attempt)
	require.Equal(t, job.Work, saved.Work)
	missing, err := models.ReadAsterNoteOrganization(s, &user.User{ID: 1}, fresh.ID, 0)
	require.NoError(t, err)
	require.Nil(t, missing, "capacity rejection must not leave a queued job behind")
	_ = s.Close()
	second.Abort()
	invalid := asterNotesRequest(t, e, 1, http.MethodPost, "/notes/999999/organization",
		map[string]any{"source": "article"}, false, false)
	require.Equal(t, http.StatusNotFound, invalid.Code, invalid.Body.String())
	replacement, err := tcyai.ReserveNoteOrganizationStart(context.Background(), 1)
	require.NoError(t, err, "failed DB admission must release its request-owned slot")
	t.Cleanup(replacement.Abort)
}
