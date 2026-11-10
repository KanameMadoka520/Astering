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
	"crypto/tls"
	"crypto/x509"
	"encoding/json"
	"net/http"
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
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

type shortSpeechResponse struct {
	Type            string `json:"type"`
	Code            string `json:"code"`
	Message         string `json:"message"`
	ID              string `json:"id"`
	Text            string `json:"text"`
	Final           bool   `json:"final"`
	SampleRate      int    `json:"sample_rate"`
	MaxSeconds      int    `json:"max_seconds"`
	ElapsedMS       int64  `json:"elapsed_ms"`
	FirstTextMS     int64  `json:"first_text_ms"`
	AudioDurationMS int64  `json:"audio_duration_ms"`
	FinishMS        int64  `json:"finish_ms"`
	RequestID       string `json:"request_id"`
}

func shortSpeechFixture(t *testing.T, provider func(context.Context, *websocket.Conn, *http.Request)) (string, string) {
	t.Helper()
	aiBucketFixtures(t)
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	oldLocal := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	oldTransport := http.DefaultTransport
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("short-speech-fixture-secret")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldLocal)
		http.DefaultTransport = oldTransport
	})
	upstream := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if !assert.NoError(t, err) {
			return
		}
		defer func() { _ = socket.CloseNow() }()
		ctx, cancel := context.WithTimeout(r.Context(), 8*time.Second)
		defer cancel()
		provider(ctx, socket, r)
	}))
	t.Cleanup(upstream.Close)
	pool := x509.NewCertPool()
	pool.AddCert(upstream.Certificate())
	transport := oldTransport.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(transport.CloseIdleConnections)
	_, err := tcyai.Save(1, tcyai.Settings{
		Connections: []tcyai.Connection{{
			ID:       "live",
			Name:     "Local fake speech provider",
			Kind:     "transcription",
			Protocol: "dashscope-asr",
			BaseURL:  upstream.URL,
			Model:    "fun-asr-realtime",
			APIKey:   "fixture-only-short-key",
		}},
		Transcription: "live",
	})
	require.NoError(t, err)
	token, err := auth.NewUserJWTAuthtoken(&user.User{ID: 1}, "550e8400-e29b-41d4-a716-446655440001")
	require.NoError(t, err)
	e := echo.New()
	e.GET("/ai/speech/live", LiveAssistantSpeech)
	server := httptest.NewServer(e)
	t.Cleanup(server.Close)
	return "ws" + strings.TrimPrefix(server.URL, "http") + "/ai/speech/live", token
}

func dialShortSpeech(t *testing.T, url, token string) (*websocket.Conn, context.Context) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 7*time.Second)
	t.Cleanup(cancel)
	socket, response, err := websocket.Dial(ctx, url, nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	socket.SetReadLimit(shortSpeechEventBytes)
	t.Cleanup(func() { _ = socket.CloseNow() })
	require.NoError(t, wsjson.Write(ctx, socket, shortSpeechStart{
		Action:       "start",
		Token:        token,
		ConnectionID: "live",
	}))
	return socket, ctx
}

func readShortSpeech(ctx context.Context, t *testing.T, socket *websocket.Conn) shortSpeechResponse {
	t.Helper()
	var response shortSpeechResponse
	require.NoError(t, wsjson.Read(ctx, socket, &response))
	return response
}

func shortSpeechProviderStart(ctx context.Context, t *testing.T, socket *websocket.Conn) string {
	t.Helper()
	var command struct {
		Header struct {
			Action string `json:"action"`
			ID     string `json:"task_id"`
		} `json:"header"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &command))
	require.Equal(t, "run-task", command.Header.Action)
	require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
		"header": map[string]string{
			"task_id": command.Header.ID,
			"event":   "task-started",
		},
	}))
	return command.Header.ID
}

func shortSpeechProviderEvent(ctx context.Context, t *testing.T, socket *websocket.Conn, id, event string, sentence map[string]any) {
	t.Helper()
	require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
		"header": map[string]string{
			"task_id": id,
			"event":   event,
		},
		"payload": map[string]any{
			"output": map[string]any{"sentence": sentence},
		},
	}))
}

func shortSpeechProviderDrain(ctx context.Context, t *testing.T, socket *websocket.Conn, id string) []byte {
	t.Helper()
	var audio []byte
	for {
		kind, frame, err := socket.Read(ctx)
		require.NoError(t, err)
		if kind == websocket.MessageBinary {
			audio = append(audio, frame...)
			continue
		}
		var command struct {
			Header struct {
				Action string `json:"action"`
				ID     string `json:"task_id"`
			} `json:"header"`
		}
		require.NoError(t, json.Unmarshal(frame, &command))
		require.Equal(t, "finish-task", command.Header.Action)
		require.Equal(t, id, command.Header.ID)
		return audio
	}
}

func TestShortSpeechStreamsBeforeStopDrainsAndNeverWritesNotes(t *testing.T) {
	pcm := bytes.Repeat([]byte{0x01, 0x00}, 1600)
	var uploaded atomic.Int64
	url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
		assert.Equal(t, "Bearer fixture-only-short-key", r.Header.Get("Authorization"))
		id := shortSpeechProviderStart(ctx, t, socket)
		kind, frame, err := socket.Read(ctx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageBinary, kind)
		shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", map[string]any{
			"sentence_id":  1,
			"text":         "First inter",
			"sentence_end": false,
		})
		uploaded.Store(int64(len(frame) + len(shortSpeechProviderDrain(ctx, t, socket, id))))
		for i, text := range []string{"First final.", "Second final."} {
			final := map[string]any{
				"sentence_id":  i + 1,
				"text":         text,
				"sentence_end": true,
			}
			shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", final)
			shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", final)
			shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", map[string]any{
				"sentence_id":  i + 1,
				"text":         "stale interim must stay hidden",
				"sentence_end": false,
			})
		}
		shortSpeechProviderEvent(ctx, t, socket, id, "task-finished", nil)
		_, _, _ = socket.Read(ctx)
	})
	s := db.NewReadSession()
	notesBefore, err := s.Count(&models.AsterNote{})
	require.NoError(t, err)
	segmentsBefore, err := s.Count(&models.AsterNoteSegment{})
	require.NoError(t, err)
	require.NoError(t, s.Close())
	settingsBefore, err := tcyai.Load(1)
	require.NoError(t, err)
	socket, ctx := dialShortSpeech(t, url, token)
	ready := readShortSpeech(ctx, t, socket)
	require.Equal(t, "ready", ready.Type)
	assert.Equal(t, 16000, ready.SampleRate)
	assert.Equal(t, 180, ready.MaxSeconds)
	assert.NotEmpty(t, ready.RequestID)
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, pcm))
	partial := readShortSpeech(ctx, t, socket)
	require.Equal(t, "transcript", partial.Type)
	assert.Equal(t, "First inter", partial.Text)
	assert.False(t, partial.Final, "partial must arrive before the user stops recording")
	for range 8 {
		require.NoError(t, socket.Write(ctx, websocket.MessageBinary, pcm))
	}
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "stop"}))
	first := readShortSpeech(ctx, t, socket)
	require.True(t, first.Final)
	assert.Equal(t, partial.ID, first.ID)
	second := readShortSpeech(ctx, t, socket)
	require.True(t, second.Final)
	done := readShortSpeech(ctx, t, socket)
	assert.Equal(t, "done", done.Type)
	assert.Equal(t, first.Text+"\n"+second.Text, done.Text)
	assert.Equal(t, ready.RequestID, done.RequestID)
	assert.EqualValues(t, len(pcm)*9, uploaded.Load(), "stop must drain all queued PCM before finish-task")
	assert.EqualValues(t, 900, done.AudioDurationMS)
	assert.Positive(t, done.FirstTextMS)
	assert.GreaterOrEqual(t, done.ElapsedMS, done.FirstTextMS)
	assert.GreaterOrEqual(t, done.FinishMS, int64(0))
	s = db.NewReadSession()
	defer s.Close()
	notesAfter, err := s.Count(&models.AsterNote{})
	require.NoError(t, err)
	segmentsAfter, err := s.Count(&models.AsterNoteSegment{})
	require.NoError(t, err)
	assert.Equal(t, notesBefore, notesAfter)
	assert.Equal(t, segmentsBefore, segmentsAfter)
	settingsAfter, err := tcyai.Load(1)
	require.NoError(t, err)
	assert.Equal(t, settingsBefore, settingsAfter, "recording must not rewrite cleanup or model settings")
}

func TestShortSpeechRejectsWrongIdentityAndAnotherAccountsConnection(t *testing.T) {
	for _, scenario := range []string{"invalid", "share", "foreign-session", "bot", "disabled", "other-connection"} {
		t.Run(scenario, func(t *testing.T) {
			var upstreamRequests atomic.Int32
			url, token := shortSpeechFixture(t, func(_ context.Context, _ *websocket.Conn, _ *http.Request) {
				upstreamRequests.Add(1)
			})
			code := "authentication"
			switch scenario {
			case "invalid":
				token = "tk_fixture_not_a_human_session"
			case "share":
				var err error
				token, err = auth.NewLinkShareJWTAuthtoken(&models.LinkSharing{ID: 1})
				require.NoError(t, err)
			case "foreign-session":
				var err error
				token, err = auth.NewUserJWTAuthtoken(&user.User{ID: 2}, "550e8400-e29b-41d4-a716-446655440001")
				require.NoError(t, err)
			case "bot", "disabled":
				s := db.NewSession()
				column := "bot_owner_id"
				u := &user.User{BotOwnerID: 2}
				if scenario == "disabled" {
					column = "status"
					u = &user.User{Status: user.StatusDisabled}
				}
				_, err := s.ID(1).Cols(column).Update(u)
				require.NoError(t, err)
				require.NoError(t, s.Commit())
				require.NoError(t, s.Close())
			case "other-connection":
				var err error
				token, err = auth.NewUserJWTAuthtoken(&user.User{ID: 2}, "550e8400-e29b-41d4-a716-446655440003")
				require.NoError(t, err)
				code = "connection"
			}
			socket, ctx := dialShortSpeech(t, url, token)
			response := readShortSpeech(ctx, t, socket)
			assert.Equal(t, "error", response.Type)
			assert.Equal(t, code, response.Code)
			assert.NotContains(t, response.Message, "fixture")
			assert.Zero(t, upstreamRequests.Load())
		})
	}
}

func TestShortSpeechRejectsScopedAgentAndAPITokenBeforeUpgrade(t *testing.T) {
	for _, scope := range []string{"agent", "api-token"} {
		t.Run(scope, func(t *testing.T) {
			e := echo.New()
			e.GET("/ai/speech/live", func(c *echo.Context) error {
				if scope == "agent" {
					c.SetRequest(c.Request().WithContext(user.WithResourceOnlyPermissions(c.Request().Context())))
				} else {
					c.Set("api_token", &models.APIToken{ID: 1, OwnerID: 1})
				}
				return LiveAssistantSpeech(c)
			})
			server := httptest.NewServer(e)
			defer server.Close()
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http")+"/ai/speech/live", nil)
			require.Error(t, err)
			require.NotNil(t, response)
			defer response.Body.Close()
			assert.Equal(t, http.StatusForbidden, response.StatusCode)
		})
	}
}

func TestShortSpeechSessionRevocationCancelsUpstream(t *testing.T) {
	disconnected := make(chan struct{})
	url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		shortSpeechProviderStart(ctx, t, socket)
		_, _, err := socket.Read(ctx)
		require.Error(t, err)
		close(disconnected)
	})
	socket, ctx := dialShortSpeech(t, url, token)
	require.Equal(t, "ready", readShortSpeech(ctx, t, socket).Type)
	s := db.NewSession()
	_, err := s.ID("550e8400-e29b-41d4-a716-446655440001").Delete(&models.Session{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	response := readShortSpeech(ctx, t, socket)
	assert.Equal(t, "authentication", response.Code)
	select {
	case <-disconnected:
	case <-ctx.Done():
		t.Fatal("revoking the session did not close the upstream")
	}
}

func TestShortSpeechDisconnectDuringFinalFlushCancelsUpstream(t *testing.T) {
	flushing, disconnected := make(chan struct{}), make(chan struct{})
	url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		id := shortSpeechProviderStart(ctx, t, socket)
		shortSpeechProviderDrain(ctx, t, socket, id)
		close(flushing)
		_, _, err := socket.Read(ctx)
		require.Error(t, err)
		close(disconnected)
	})
	socket, ctx := dialShortSpeech(t, url, token)
	require.Equal(t, "ready", readShortSpeech(ctx, t, socket).Type)
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "stop"}))
	select {
	case <-flushing:
	case <-ctx.Done():
		t.Fatal("provider did not receive finish-task")
	}
	require.NoError(t, socket.CloseNow())
	select {
	case <-disconnected:
	case <-time.After(time.Second):
		t.Fatal("provider continued consuming a paid connection after the client disconnected")
	}
}

func TestShortSpeechInvalidAudioAndProtocolErrorsAreSafe(t *testing.T) {
	for _, scenario := range []string{"odd", "empty", "burst", "oversized", "invalid-command", "provider-failure", "unfinished-partial"} {
		t.Run(scenario, func(t *testing.T) {
			url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := shortSpeechProviderStart(ctx, t, socket)
				switch scenario {
				case "provider-failure":
					require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
						"header": map[string]string{
							"task_id":       id,
							"event":         "task-failed",
							"error_message": "secret-upstream-key=fixture-only-short-key",
						},
					}))
				case "unfinished-partial":
					shortSpeechProviderDrain(ctx, t, socket, id)
					shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", map[string]any{
						"sentence_id":  1,
						"text":         "Not final yet",
						"sentence_end": false,
					})
					shortSpeechProviderEvent(ctx, t, socket, id, "task-finished", nil)
				}
				for {
					if _, _, err := socket.Read(ctx); err != nil {
						return
					}
				}
			})
			socket, ctx := dialShortSpeech(t, url, token)
			require.Equal(t, "ready", readShortSpeech(ctx, t, socket).Type)
			switch scenario {
			case "odd":
				require.NoError(t, socket.Write(ctx, websocket.MessageBinary, []byte{1}))
			case "empty":
				require.NoError(t, socket.Write(ctx, websocket.MessageBinary, nil))
			case "burst":
				for range 7 {
					err := socket.Write(ctx, websocket.MessageBinary, make([]byte, 32000))
					if err != nil {
						break
					}
				}
			case "oversized":
				_ = socket.Write(ctx, websocket.MessageBinary, make([]byte, tcyai.MaxLiveSpeechFrameBytes+2))
				_, _, err := socket.Read(ctx)
				require.Error(t, err)
				assert.Equal(t, websocket.StatusMessageTooBig, websocket.CloseStatus(err))
				return
			case "invalid-command":
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "keep-going"}))
			case "unfinished-partial":
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "stop"}))
			}
			response := readShortSpeech(ctx, t, socket)
			if response.Type == "transcript" {
				assert.False(t, response.Final)
				response = readShortSpeech(ctx, t, socket)
			}
			assert.Equal(t, "error", response.Type)
			assert.NotContains(t, response.Message, "fixture")
			assert.NotContains(t, response.Message, "secret-upstream")
		})
	}
}

func TestShortSpeechSlotsAreIndependentOfNotesAndChats(t *testing.T) {
	releaseA, ok := acquireShortSpeech(90001)
	require.True(t, ok)
	defer releaseA()
	releaseB, ok := acquireShortSpeech(90001)
	require.True(t, ok)
	defer releaseB()
	_, ok = acquireShortSpeech(90001)
	assert.False(t, ok)
	releaseOther, ok := acquireShortSpeech(90002)
	require.True(t, ok)
	releaseOther()
	releaseNote, ok := acquireLiveNote(90001, 1)
	require.True(t, ok)
	releaseNote()
	releaseA()
	releaseA()
	releaseC, ok := acquireShortSpeech(90001)
	require.True(t, ok)
	releaseC()
}

func TestShortSpeechBoundsTextAndSegmentCountFromRealProvider(t *testing.T) {
	for _, scenario := range []string{"one-large-text", "aggregate-with-separators", "segment-count"} {
		t.Run(scenario, func(t *testing.T) {
			count, text := 1, strings.Repeat("\u6587", shortSpeechTextBytes/3+1)
			expectedTranscripts := 0
			if scenario == "aggregate-with-separators" {
				count, text = 2, strings.Repeat("a", shortSpeechTextBytes/2)
				expectedTranscripts = 1
			}
			if scenario == "segment-count" {
				count, text = shortSpeechMaxIDs+1, "a"
				expectedTranscripts = shortSpeechMaxIDs
			}
			url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := shortSpeechProviderStart(ctx, t, socket)
				for i := range count {
					shortSpeechProviderEvent(ctx, t, socket, id, "result-generated", map[string]any{
						"sentence_id":  i + 1,
						"text":         text,
						"sentence_end": true,
					})
				}
				_, _, _ = socket.Read(ctx)
			})
			socket, ctx := dialShortSpeech(t, url, token)
			require.Equal(t, "ready", readShortSpeech(ctx, t, socket).Type)
			for range expectedTranscripts {
				require.Equal(t, "transcript", readShortSpeech(ctx, t, socket).Type)
			}
			failure := readShortSpeech(ctx, t, socket)
			assert.Equal(t, "error", failure.Type)
			assert.Equal(t, "limit", failure.Code)
		})
	}
}

func TestShortSpeechTranscriptRetainsOrderAndFinality(t *testing.T) {
	transcript := &shortSpeechTranscript{segments: map[string]tcyai.LiveSpeechDelta{}}
	for _, delta := range []tcyai.LiveSpeechDelta{
		{
			ID:   "a",
			Text: "first partial",
		},
		{
			ID:    "b",
			Text:  "Second",
			Final: true,
		},
		{
			ID:    "a",
			Text:  "First",
			Final: true,
		},
		{
			ID:   "a",
			Text: "late partial",
		},
		{
			ID:    "b",
			Text:  "Second",
			Final: true,
		},
	} {
		_, err := transcript.update(delta)
		require.NoError(t, err)
	}
	assert.Equal(t, "First\nSecond", transcript.text())
	_, err := transcript.update(tcyai.LiveSpeechDelta{
		ID:    "a",
		Text:  "Changed final",
		Final: true,
	})
	require.ErrorIs(t, err, errShortSpeechFinal)
	assert.Equal(t, "First\nSecond", transcript.text())
}

func TestShortSpeechDisconnectIsNotAnAuthenticationFailure(t *testing.T) {
	for _, cause := range []error{errShortSpeechClosed, context.Canceled} {
		ctx, cancel := context.WithCancelCause(context.Background())
		cancel(cause)
		code, key := shortSpeechFailure(ctx)
		assert.Equal(t, "interrupted", code)
		assert.Equal(t, "speechProtocol11", key)
	}
}

func TestShortSpeechCancelsBeforeProviderReady(t *testing.T) {
	for _, scenario := range []string{"disconnect", "premature-pcm"} {
		t.Run(scenario, func(t *testing.T) {
			started, disconnected := make(chan struct{}), make(chan struct{})
			url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				var start map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &start))
				close(started)
				_, _, err := socket.Read(ctx)
				require.Error(t, err)
				close(disconnected)
			})
			socket, ctx := dialShortSpeech(t, url, token)
			select {
			case <-started:
			case <-ctx.Done():
				t.Fatal("provider did not receive run-task")
			}
			if scenario == "disconnect" {
				require.NoError(t, socket.CloseNow())
			} else {
				require.NoError(t, socket.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
				response := readShortSpeech(ctx, t, socket)
				assert.Equal(t, "error", response.Type)
				assert.Equal(t, "invalid_audio", response.Code)
			}
			select {
			case <-disconnected:
			case <-time.After(time.Second):
				t.Fatal("upstream was not canceled before its acknowledgement")
			}
		})
	}
}
