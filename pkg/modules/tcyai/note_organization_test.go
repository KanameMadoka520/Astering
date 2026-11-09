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

package tcyai

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func organizationFixture(t *testing.T, uid int64, text string) (*user.User, *models.AsterNoteOrganization) {
	t.Helper()
	engine := accountCleanupFixture(t, uid)
	require.NoError(t, engine.Sync2(&models.AsterNote{}, &models.AsterNoteSegment{}, &models.AsterNoteOrganization{}))
	i18n.Init()
	actor := &user.User{ID: uid}
	s := db.NewSession()
	defer s.Close()
	note := &models.AsterNote{
		Title:   "Private original",
		Content: text,
	}
	require.NoError(t, note.Create(s, actor))
	job, err := models.CreateAsterNoteOrganization(s, actor, note.ID, "article", "fixture", "original-model")
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	return actor, job
}
func awaitOrganization(t *testing.T, actor *user.User, id int64) *models.AsterNoteOrganization {
	t.Helper()
	require.Eventually(t, func() bool {
		noteOrganizations.Lock()
		defer noteOrganizations.Unlock()
		return noteOrganizations.runs[noteOrganizationKey(actor.ID, id)] == nil
	}, 10*time.Second, 10*time.Millisecond)
	s := db.NewReadSession()
	defer s.Close()
	row := &models.AsterNoteOrganization{}
	found, err := s.ID(id).Get(row)
	require.NoError(t, err)
	require.True(t, found)
	return row
}

func TestNoteOrganizationBoundsLongSourceAndMergesWithoutTools(t *testing.T) {
	actor, job := organizationFixture(t, 94311, strings.Repeat("A precise idea and a different intention.\n", 550))
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request map[string]any
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&request)) {
			return
		}
		assert.NotContains(t, request, "tools")
		assert.InDelta(t, 2048.0, request["max_completion_tokens"], 0.001)
		messages := request["messages"].([]any)
		system := messages[0].(map[string]any)["content"].(string)
		source := messages[1].(map[string]any)["content"].(string)
		assert.Contains(t, system, "untrusted")
		assert.LessOrEqual(t, len(source), 3880)
		assert.NotContains(t, system, "Private original")
		calls.Add(1)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"model":"served-model","choices":[{"message":{"role":"assistant","content":"# Organized ideas\n\nClear intentions and precise dates."},"finish_reason":"stop"}],"usage":{"prompt_tokens":100,"completion_tokens":15}}`)
	}))
	defer server.Close()
	c := Connection{
		ID:              "fixture",
		Protocol:        "openai-chat",
		BaseURL:         server.URL,
		Model:           "configured-model",
		ContextWindow:   10000,
		MaxOutputTokens: 2048,
		NonStreaming:    true,
	}
	require.NoError(t, StartNoteOrganization(context.Background(), actor, job, c))
	finished := awaitOrganization(t, actor, job.ID)
	require.Equal(t, "completed", finished.Status, finished.Error)
	require.Greater(t, calls.Load(), int32(2))
	require.EqualValues(t, calls.Load(), finished.CompletedSteps)
	require.Equal(t, int64(calls.Load())*100, finished.InputTokens)
	require.NotEmpty(t, finished.Result)
	require.Empty(t, finished.SourceArticle)
	s := db.NewReadSession()
	defer s.Close()
	note := &models.AsterNote{ID: job.NoteID}
	require.NoError(t, note.ReadOne(s, actor))
	require.Equal(t, strings.Repeat("A precise idea and a different intention.\n", 550), note.Content)
}

func TestNoteOrganizationRejectsTruncatedResultAndKeepsCheckpointRetryable(t *testing.T) {
	actor, job := organizationFixture(t, 94312, "The entire original remains available.")
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Truncated unfinished"},"finish_reason":"length"}],"usage":{"prompt_tokens":90,"completion_tokens":5}}`)
	}))
	defer server.Close()
	c := Connection{
		ID:              "fixture",
		Protocol:        "openai-chat",
		BaseURL:         server.URL,
		Model:           "model",
		ContextWindow:   10000,
		MaxOutputTokens: 2048,
		NonStreaming:    true,
	}
	require.NoError(t, StartNoteOrganization(context.Background(), actor, job, c))
	finished := awaitOrganization(t, actor, job.ID)
	require.Equal(t, "failed", finished.Status)
	require.Empty(t, finished.Result)
	require.Zero(t, finished.CompletedSteps)
	var work noteOrganizationWork
	require.NoError(t, json.Unmarshal([]byte(finished.Work), &work))
	require.Empty(t, work.Summaries)
	require.Zero(t, work.SourceOffset)
}

func TestNoteOrganizationCancellationAndProcessInterruptionAreDistinct(t *testing.T) {
	actor, job := organizationFixture(t, 94313, "Wait for cancellation without losing this source.")
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	c := Connection{
		ID:              "fixture",
		Protocol:        "openai-chat",
		BaseURL:         server.URL,
		Model:           "model",
		ContextWindow:   10000,
		MaxOutputTokens: 2048,
		NonStreaming:    true,
	}
	require.NoError(t, StartNoteOrganization(context.Background(), actor, job, c))
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		t.Fatal("provider was not called")
	}
	s := db.NewSession()
	cancelled, err := models.ChangeAsterNoteOrganization(s, actor, job.NoteID, job.ID, "cancel")
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	_ = s.Close()
	CancelNoteOrganization(actor.ID, job.ID, cancelled.Attempt)
	finished := awaitOrganization(t, actor, job.ID)
	require.Equal(t, "cancelled", finished.Status)
	require.Empty(t, finished.Result)
	// A durable running row without a worker is observed as interrupted, never
	// automatically re-billed after a process restart.
	s = db.NewSession()
	retried, err := models.ChangeAsterNoteOrganization(s, actor, job.NoteID, job.ID, "retry")
	require.NoError(t, err)
	retried.Status = "running"
	require.NoError(t, models.SaveAsterNoteOrganizationCheckpoint(s, actor, retried))
	require.NoError(t, s.Commit())
	_ = s.Close()
	activity, err := NoteOrganizationStatus(context.Background(), actor, retried)
	require.NoError(t, err)
	require.Equal(t, "interrupted", activity.Job.Status)
}

func TestNoteOrganizationTranscriptBatchResumesInsideUTF8SegmentsWithoutLoss(t *testing.T) {
	actor, original := organizationFixture(t, 94314, "A separate saved article")
	s := db.NewSession()
	var expected strings.Builder
	last := int64(0)
	for index := 0; index < 19; index++ {
		text := strings.Repeat("\u601d\u8003\u4e0e\u884c\u52a8", 420) + "END"
		expected.WriteString(text)
		segment := &models.AsterNoteSegment{
			ClientID: fmt.Sprintf("10101010-1010-4010-8010-%012d", index+1),
			Text:     text,
			StartMS:  int64(index * 1000),
			EndMS:    int64(index*1000 + 900),
		}
		require.NoError(t, models.AppendAsterNoteSegment(s, actor, original.NoteID, segment))
		last = segment.ID
	}
	require.NoError(t, s.Commit())
	_ = s.Close()
	job := &models.AsterNoteOrganization{
		NoteID:      original.NoteID,
		Source:      "transcript",
		SourceEndID: last,
	}
	work := noteOrganizationWork{}
	var reconstructed strings.Builder
	processed := int64(0)
	for index := 0; index < 1000; index++ {
		part, next, count, err := nextNoteOrganizationSource(context.Background(), job, work, 4096)
		require.NoError(t, err)
		require.True(t, utf8.ValidString(part))
		require.LessOrEqual(t, len(part), 4096)
		if part == "" {
			break
		}
		reconstructed.WriteString(part)
		processed += count
		work = next
	}
	require.Equal(t, expected.String(), strings.ReplaceAll(reconstructed.String(), "\n", ""))
	require.EqualValues(t, expected.Len(), processed)
}

func TestNoteOrganizationUnknownContextPolicyReservesAnthropicOutput(t *testing.T) {
	budget, err := noteOrganizationInputBudget(Connection{
		Protocol: "anthropic",
		Model:    "custom",
	})
	require.NoError(t, err)
	require.Positive(t, budget)
	_, err = noteOrganizationInputBudget(Connection{
		ContextWindow:   10000,
		MaxOutputTokens: 9000,
	})
	require.Error(t, err)
}

func TestNoteOrganizationRevokedSessionStopsProviderWithoutPublishing(t *testing.T) {
	actor, job := organizationFixture(t, 94315, "This source must stay private after logout.")
	previousTTL := config.ServiceJWTTTL.GetInt64()
	config.ServiceJWTTTL.Set(int64(3600))
	t.Cleanup(func() { config.ServiceJWTTTL.Set(previousTTL) })
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.Sync2(&models.Session{}))
	s := db.NewSession()
	session, err := models.CreateSession(s, actor.ID, "fixture", "127.0.0.1", false, nil)
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	_ = s.Close()
	actor = user.WithSessionCredential(actor, session.ID)
	// Recreate the fixture job through the real authenticated admission path so
	// both its persisted binding and live worker carry this exact session.
	s = db.NewSession()
	_, err = s.ID(job.ID).Delete(&models.AsterNoteOrganization{})
	require.NoError(t, err)
	job, err = models.CreateAsterNoteOrganization(s, actor, job.NoteID, "article", "fixture", "model")
	require.NoError(t, err)
	require.Equal(t, session.ID, job.SessionID)
	require.NoError(t, models.ValidateAsterNoteOrganizationScope(s, actor, job.NoteID))
	require.NoError(t, s.Commit())
	_ = s.Close()
	entered := make(chan struct{})
	release := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(entered)
		select {
		case <-r.Context().Done():
		case <-release:
		}
	}))
	defer server.Close()
	defer close(release)
	require.NoError(t, StartNoteOrganization(context.Background(), actor, job, Connection{
		ID:              "fixture",
		Protocol:        "openai-chat",
		BaseURL:         server.URL,
		Model:           "model",
		ContextWindow:   10000,
		MaxOutputTokens: 2048,
		NonStreaming:    true,
	}))
	select {
	case <-entered:
	case <-time.After(5 * time.Second):
		finished := awaitOrganization(t, actor, job.ID)
		t.Fatalf("provider was not called; job status=%q error=%q", finished.Status, finished.Error)
	}
	_, err = engine.ID(session.ID).Delete(&models.Session{})
	require.NoError(t, err)
	finished := awaitOrganization(t, actor, job.ID)
	require.Equal(t, "failed", finished.Status)
	require.Equal(t, "note_organization_access_revoked", finished.Error)
	require.Empty(t, finished.Result)
}
