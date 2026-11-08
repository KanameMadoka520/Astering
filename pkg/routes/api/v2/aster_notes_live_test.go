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
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func liveNotesFixture(t *testing.T) (string, string, *models.AsterNote) {
	t.Helper()
	aiBucketFixtures(t)
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("live-notes-fixture-secret")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
	_, err := tcyai.Save(1, tcyai.Settings{
		Connections: []tcyai.Connection{{
			ID:       "live",
			Name:     "Fixture live recognizer",
			Kind:     "transcription",
			Protocol: "dashscope-asr",
			BaseURL:  "https://speech.invalid/api-ws/v1/inference",
			Model:    "fun-asr-realtime",
			APIKey:   "fixture-only-key",
		}},
		Transcription: "live",
	})
	require.NoError(t, err)
	note := &models.AsterNote{
		Title:   "Live recording",
		Content: "Do not overwrite the edited article.",
	}
	s := db.NewSession()
	require.NoError(t, note.Create(s, &user.User{ID: 1}))
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	token, err := auth.NewUserJWTAuthtoken(&user.User{ID: 1}, "550e8400-e29b-41d4-a716-446655440001")
	require.NoError(t, err)
	e := echo.New()
	e.GET("/notes/live", LiveNoteSpeech)
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/notes/live", token, note
}

func dialLiveNotes(t *testing.T, url string, start liveNoteStart) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 8*time.Second)
	t.Cleanup(cancel)
	socket, response, err := websocket.Dial(ctx, url, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	t.Cleanup(func() { _ = socket.CloseNow() })
	require.NoError(t, wsjson.Write(ctx, socket, start))
	return socket, ctx
}

func TestLiveNotesWebSocketRejectsInvalidOrForeignCredentials(t *testing.T) {
	url, token, note := liveNotesFixture(t)
	for _, start := range []liveNoteStart{
		{
			Action: "start",
			Token:  "not-a-token",
			NoteID: note.ID,
		},
		{
			Action: "start",
			Token:  token,
			NoteID: note.ID + 1000,
		},
	} {
		socket, ctx := dialLiveNotes(t, url, start)
		var response map[string]string
		require.NoError(t, wsjson.Read(ctx, socket, &response))
		assert.Equal(t, "error", response["type"])
		assert.NotEmpty(t, response["code"])
		assert.NotContains(t, response, "token")
	}
	other, err := auth.NewUserJWTAuthtoken(&user.User{ID: 2}, "550e8400-e29b-41d4-a716-446655440003")
	require.NoError(t, err)
	socket, ctx := dialLiveNotes(t, url, liveNoteStart{
		Action: "start",
		Token:  other,
		NoteID: note.ID,
	})
	var response map[string]string
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	assert.Equal(t, "note_unavailable", response["code"])
}

func TestLiveNotesWebSocketPersistsBeforeAcknowledgingAndFlushes(t *testing.T) {
	url, token, note := liveNotesFixture(t)
	previous := recognizeLiveNoteSpeech
	t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
	recognizeLiveNoteSpeech = func(ctx context.Context, _ tcyai.Connection, _ int, audio <-chan []byte, ready func() error, delta func(tcyai.LiveSpeechDelta) error) error {
		if err := ready(); err != nil {
			return err
		}
		id := uuid.NewString()
		for frame := range audio {
			if len(frame) > 0 {
				if err := delta(tcyai.LiveSpeechDelta{
					ID:   id,
					Text: "Interim words",
				}); err != nil {
					return err
				}
				if err := delta(tcyai.LiveSpeechDelta{
					ID:      id,
					Text:    "A durable idea.",
					Final:   true,
					StartMS: 0,
					EndMS:   100,
				}); err != nil {
					return err
				}
			}
		}
		return ctx.Err()
	}
	socket, ctx := dialLiveNotes(t, url, liveNoteStart{
		Action:       "start",
		Token:        token,
		NoteID:       note.ID,
		ConnectionID: "live",
	})
	var response struct {
		Type       string                           `json:"type"`
		SampleRate int                              `json:"sample_rate"`
		Segment    *models.AsterNoteSegment         `json:"segment"`
		Stats      *models.AsterNoteTranscriptState `json:"stats"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	require.Equal(t, "ready", response.Type)
	assert.Equal(t, 16000, response.SampleRate)
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	assert.Equal(t, "partial", response.Type)
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	require.Equal(t, "segment", response.Type)
	require.NotNil(t, response.Segment)
	assert.Positive(t, response.Segment.ID)
	s := db.NewReadSession()
	stored := &models.AsterNoteSegment{}
	found, err := s.ID(response.Segment.ID).Get(stored)
	require.NoError(t, err)
	require.True(t, found, "the acknowledgement must follow the commit")
	assert.Equal(t, "A durable idea.", stored.Text)
	current := &models.AsterNote{}
	_, err = s.ID(note.ID).Get(current)
	require.NoError(t, err)
	assert.Equal(t, note.Content, current.Content)
	assert.Equal(t, note.Revision, current.Revision)
	assert.EqualValues(t, 1, current.SegmentCount)
	require.NotNil(t, response.Stats)
	assert.Equal(t, current.SegmentCount, response.Stats.SegmentCount)
	assert.Equal(t, current.TranscriptBytes, response.Stats.TranscriptBytes)
	assert.Equal(t, current.Updated.UTC(), response.Stats.Updated.UTC())
	require.NoError(t, s.Close())
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "stop"}))
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	assert.Equal(t, "done", response.Type)
}

func TestLiveNotesSlotsArePerNoteAndDoNotLockAgentConversations(t *testing.T) {
	finishA, ok := acquireLiveNote(101, 1)
	require.True(t, ok)
	defer finishA()
	_, ok = acquireLiveNote(101, 1)
	assert.False(t, ok)
	finishB, ok := acquireLiveNote(101, 2)
	require.True(t, ok)
	_, ok = acquireLiveNote(101, 3)
	assert.False(t, ok)
	finishOther, ok := acquireLiveNote(102, 1)
	require.True(t, ok)
	finishOther()
	finishB()
	finishC, ok := acquireLiveNote(101, 3)
	require.True(t, ok)
	finishC()
}

func TestLiveNotesRotationReleasesBeforeCloseHandshakeAndKeepsTheNextSlot(t *testing.T) {
	_, token, note := liveNotesFixture(t)
	previous := recognizeLiveNoteSpeech
	t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
	recognizeLiveNoteSpeech = func(ctx context.Context, _ tcyai.Connection, _ int, audio <-chan []byte, ready func() error, delta func(tcyai.LiveSpeechDelta) error) error {
		if err := ready(); err != nil {
			return err
		}
		for range audio {
			if err := delta(tcyai.LiveSpeechDelta{
				ID: uuid.NewString(), Text: "Before the rotation.", Final: true, StartMS: 0, EndMS: 100,
			}); err != nil {
				return err
			}
		}
		return ctx.Err()
	}
	var requests atomic.Int32
	returned := make(chan int32, 3)
	e := echo.New()
	e.GET("/notes/live", func(c *echo.Context) error {
		request := requests.Add(1)
		defer func() { returned <- request }()
		return LiveNoteSpeech(c)
	})
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)
	url := "ws" + strings.TrimPrefix(server.URL, "http") + "/notes/live"
	start := liveNoteStart{
		Action:       "start",
		Token:        token,
		NoteID:       note.ID,
		ConnectionID: "live",
	}
	first, ctx := dialLiveNotes(t, url, start)
	var response struct {
		Type   string `json:"type"`
		Code   string `json:"code"`
		Offset int64  `json:"offset_ms"`
	}
	require.NoError(t, wsjson.Read(ctx, first, &response))
	require.Equal(t, "ready", response.Type)
	require.NoError(t, first.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
	require.NoError(t, wsjson.Read(ctx, first, &response))
	require.Equal(t, "segment", response.Type)
	require.NoError(t, wsjson.Write(ctx, first, map[string]string{"action": "stop"}))
	require.NoError(t, wsjson.Read(ctx, first, &response))
	require.Equal(t, "done", response.Type)
	// Do not read/respond to the old close control frame yet. The handler is
	// still in its close handshake when the browser starts the next wire.
	select {
	case id := <-returned:
		t.Fatalf("handler %d returned before the old close handshake completed", id)
	default:
	}
	second, secondCtx := dialLiveNotes(t, url, start)
	require.NoError(t, wsjson.Read(secondCtx, second, &response))
	require.Equal(t, "ready", response.Type, "done must release the old slot before a new wire is admitted")
	require.EqualValues(t, 100, response.Offset, "the next stream starts after the committed previous utterance")
	require.NoError(t, first.CloseNow())
	select {
	case id := <-returned:
		require.EqualValues(t, 1, id)
	case <-ctx.Done():
		t.Fatal("old handler did not finish after closing its socket")
	}
	// The first handler's deferred release must be idempotent: it cannot erase
	// the slot now held by the second stream.
	third, thirdCtx := dialLiveNotes(t, url, start)
	require.NoError(t, wsjson.Read(thirdCtx, third, &response))
	require.Equal(t, "error", response.Type)
	require.Equal(t, "already_recording", response.Code)
	require.NoError(t, third.CloseNow())
	require.NoError(t, wsjson.Write(secondCtx, second, map[string]string{"action": "stop"}))
	require.NoError(t, wsjson.Read(secondCtx, second, &response))
	require.Equal(t, "done", response.Type)
	require.NoError(t, second.CloseNow())
}

func TestLiveNotesRotationReservesFinalizationBeforeJWTExpiry(t *testing.T) {
	now := time.Now()
	assert.Equal(t, liveNoteRotateSeconds, liveNoteRotation(now.Add(time.Hour), now))
	assert.Equal(t, 75, liveNoteRotation(now.Add(2*time.Minute), now))
	assert.Less(t, liveNoteRotation(now.Add(time.Minute), now), 30)
}
