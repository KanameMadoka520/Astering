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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestLiveNotesProviderFailureReturnsSafeTraceAndKeepsCommittedSegments(t *testing.T) {
	url, token, note := liveNotesFixture(t)
	requestID, taskID := uuid.NewString(), uuid.NewString()
	previous := recognizeLiveNoteSpeech
	t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
	recognizeLiveNoteSpeech = func(ctx context.Context, _ tcyai.Connection, _ int, audio <-chan []byte, ready func() error, delta func(tcyai.LiveSpeechDelta) error) error {
		if err := ready(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-audio:
			if !ok {
				return nil
			}
		}
		id := uuid.NewString()
		if err := delta(tcyai.LiveSpeechDelta{
			ID:   id,
			Text: "Private interim must not be present in diagnostics.",
		}); err != nil {
			return err
		}
		if err := delta(tcyai.LiveSpeechDelta{
			ID:      id,
			Text:    "One confirmed sentence stays saved.",
			Final:   true,
			StartMS: 0,
			EndMS:   100,
		}); err != nil {
			return err
		}
		return &tcyai.SpeechProviderError{
			Code:      "CLIENT_ERROR",
			RequestID: requestID,
			TaskID:    taskID,
		}
	}
	socket, ctx := dialLiveNotes(t, url, liveNoteStart{
		Action: "start",
		Token:  token,
		NoteID: note.ID,
	})
	var ready struct {
		Type      string `json:"type"`
		RequestID string `json:"request_id"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &ready))
	require.Equal(t, "ready", ready.Type)
	require.NoError(t, uuid.Validate(ready.RequestID))
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
	for _, kind := range []string{"partial", "segment"} {
		var event struct {
			Type string `json:"type"`
		}
		require.NoError(t, wsjson.Read(ctx, socket, &event))
		require.Equal(t, kind, event.Type)
	}
	var failure struct {
		Type      string `json:"type"`
		Code      string `json:"code"`
		Message   string `json:"message"`
		RequestID string `json:"request_id"`
		tcyai.SpeechProviderDiagnostic
		Diagnostics liveNoteDiagnostics `json:"diagnostics"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &failure))
	require.Equal(t, "error", failure.Type)
	require.Equal(t, "provider", failure.Code)
	require.Equal(t, ready.RequestID, failure.RequestID)
	require.Equal(t, "CLIENT_ERROR", failure.SpeechProviderDiagnostic.Code)
	require.Equal(t, requestID, failure.SpeechProviderDiagnostic.RequestID)
	require.Equal(t, taskID, failure.TaskID)
	require.NotEmpty(t, failure.Message)
	require.NotContains(t, failure.Message, "Private interim")
	require.EqualValues(t, 3200, failure.Diagnostics.ReceivedBytes)
	require.EqualValues(t, 100, failure.Diagnostics.AudioDuration)
	require.EqualValues(t, 1, failure.Diagnostics.PartialUpdates)
	require.EqualValues(t, 1, failure.Diagnostics.SavedSegments)
	require.Positive(t, failure.Diagnostics.FirstTextMS)
	s := db.NewReadSession()
	defer s.Close()
	stored := &models.AsterNote{ID: note.ID}
	found, err := s.ID(note.ID).Get(stored)
	require.NoError(t, err)
	require.True(t, found)
	require.EqualValues(t, 1, stored.SegmentCount, "a later provider failure must not undo the committed final")
}

func TestLiveNotesInvalidPCMHasAnExplicitErrorAfterRunCancellation(t *testing.T) {
	url, token, note := liveNotesFixture(t)
	previous := recognizeLiveNoteSpeech
	t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
	recognizeLiveNoteSpeech = func(ctx context.Context, _ tcyai.Connection, _ int, audio <-chan []byte, ready func() error, _ func(tcyai.LiveSpeechDelta) error) error {
		if err := ready(); err != nil {
			return err
		}
		for range audio {
		}
		return ctx.Err()
	}
	socket, ctx := dialLiveNotes(t, url, liveNoteStart{
		Action: "start",
		Token:  token,
		NoteID: note.ID,
	})
	var event struct {
		Type        string              `json:"type"`
		Code        string              `json:"code"`
		Message     string              `json:"message"`
		Diagnostics liveNoteDiagnostics `json:"diagnostics"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, "ready", event.Type)
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, []byte{1}))
	require.NoError(t, wsjson.Read(ctx, socket, &event), "canceled provider context must not suppress the client error event")
	require.Equal(t, "error", event.Type)
	require.Equal(t, "invalid_audio", event.Code)
	require.NotEmpty(t, event.Message)
	require.Zero(t, event.Diagnostics.ReceivedBytes)
	require.Zero(t, event.Diagnostics.SavedSegments)
}

func TestLiveNotesCanceledRunCannotSendLatePartialOrSaveLateFinal(t *testing.T) {
	_, token, note := liveNotesFixture(t)
	claims, err := auth.ParseUserToken(token)
	require.NoError(t, err)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	var sends int
	actor := user.WithSessionCredential(&user.User{ID: claims.UserID}, claims.SessionID)
	sink := liveNoteDeltaSink(ctx, actor, note.ID, 0, claims, func(any) error {
		sends++
		return nil
	})
	for _, final := range []bool{false, true} {
		err := sink(tcyai.LiveSpeechDelta{
			ID:      uuid.NewString(),
			Text:    "Late private words after cancellation.",
			Final:   final,
			StartMS: 0,
			EndMS:   100,
		})
		if final {
			require.ErrorIs(t, err, auth.ErrUserTokenRejected)
		} else {
			require.ErrorIs(t, err, context.Canceled)
		}
	}
	require.Zero(t, sends, "a transport kept open for fixed failure diagnostics cannot carry late transcript text")
	s := db.NewReadSession()
	defer s.Close()
	stored := &models.AsterNote{}
	found, err := s.ID(note.ID).Get(stored)
	require.NoError(t, err)
	require.True(t, found)
	require.Zero(t, stored.SegmentCount)
}

func TestLiveNotesNoAudioExplanationRequiresProviderReadyAndZeroReceivedFrames(t *testing.T) {
	for _, providerReady := range []bool{false, true} {
		t.Run(map[bool]string{false: "rejected-before-ready", true: "ready-with-no-audio"}[providerReady], func(t *testing.T) {
			url, token, note := liveNotesFixture(t)
			previous := recognizeLiveNoteSpeech
			t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
			recognizeLiveNoteSpeech = func(_ context.Context, _ tcyai.Connection, _ int, _ <-chan []byte, ready func() error, _ func(tcyai.LiveSpeechDelta) error) error {
				if providerReady {
					if err := ready(); err != nil {
						return err
					}
				}
				return &tcyai.SpeechProviderError{Code: "CLIENT_ERROR"}
			}
			socket, ctx := dialLiveNotes(t, url, liveNoteStart{
				Action: "start",
				Token:  token,
				NoteID: note.ID,
			})
			var event struct {
				Type    string `json:"type"`
				Message string `json:"message"`
			}
			if providerReady {
				require.NoError(t, wsjson.Read(ctx, socket, &event))
				require.Equal(t, "ready", event.Type)
			}
			require.NoError(t, wsjson.Read(ctx, socket, &event))
			require.Equal(t, "error", event.Type)
			explanation := tcylocale.Render(ctx, tcylocale.Error("speechLiveNoAudio"))
			if providerReady {
				require.Contains(t, event.Message, explanation)
			} else {
				require.NotContains(t, event.Message, explanation, "an early provider rejection cannot be blamed on browser capture")
			}
		})
	}
}

func TestLiveNotesSaveFailureSendsOneRecoveryEventWithoutASecondProviderError(t *testing.T) {
	url, token, note := liveNotesFixture(t)
	previous := recognizeLiveNoteSpeech
	t.Cleanup(func() { recognizeLiveNoteSpeech = previous })
	recognizeLiveNoteSpeech = func(ctx context.Context, _ tcyai.Connection, _ int, audio <-chan []byte, ready func() error, delta func(tcyai.LiveSpeechDelta) error) error {
		if err := ready(); err != nil {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case _, ok := <-audio:
			if !ok {
				return nil
			}
		}
		return delta(tcyai.LiveSpeechDelta{
			ID:      uuid.NewString(),
			Text:    "Words for manual recovery.",
			Final:   true,
			StartMS: -1,
			EndMS:   100,
		})
	}
	socket, ctx := dialLiveNotes(t, url, liveNoteStart{
		Action: "start",
		Token:  token,
		NoteID: note.ID,
	})
	var event struct {
		Type string `json:"type"`
		Code string `json:"code"`
		Text string `json:"text"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, "ready", event.Type)
	require.NoError(t, socket.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, "error", event.Type)
	require.Equal(t, "save_failed", event.Code)
	require.Equal(t, "Words for manual recovery.", event.Text)
	require.Error(t, wsjson.Read(ctx, socket, &event), "save failure already has its recovery event and must not emit a misleading provider error")
}

func TestShortSpeechProviderFailureExplainsSafeKnownReason(t *testing.T) {
	url, token := shortSpeechFixture(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		id := shortSpeechProviderStart(ctx, t, socket)
		require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
			"header": map[string]string{
				"event":         "task-failed",
				"task_id":       id,
				"error_code":    "InvalidApiKey",
				"request_id":    "fixture-only-short-key",
				"error_message": "fixture-only-short-key and private user transcript",
			},
		}))
		_, _, _ = socket.Read(ctx)
	})
	socket, ctx := dialShortSpeech(t, url, token)
	require.Equal(t, "ready", readShortSpeech(ctx, t, socket).Type)
	var event struct {
		Type    string `json:"type"`
		Message string `json:"message"`
		tcyai.SpeechProviderDiagnostic
	}
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, "error", event.Type)
	require.Equal(t, "AUTHENTICATION", event.Code)
	require.Empty(t, event.RequestID)
	require.NoError(t, uuid.Validate(event.TaskID))
	require.Equal(t, tcylocale.Render(ctx, tcylocale.Error("speechProviderAuthentication")), event.Message)
	require.NotContains(t, event.Message, "fixture-only-short-key")
	require.NotContains(t, event.Message, "private user transcript")
}

func TestLiveNotesAudioBudgetAllowsBoundedCatchupAndRejectsLargeBursts(t *testing.T) {
	const rate = 16000
	for second := 0; second <= 60; second++ {
		allowed := liveNoteAllowedAudioBytes(time.Duration(second)*time.Second, rate)
		require.LessOrEqual(t, allowed, int64((second+liveNoteMaxBufferedSeconds)*rate*2))
		require.LessOrEqual(t, allowed, int64(2*second*rate*2+tcyai.MaxLiveSpeechFrameBytes))
	}
	require.GreaterOrEqual(t, liveNoteAllowedAudioBytes(8*time.Second, rate), int64(16*rate*2), "2x catch-up cannot be rejected just because it leads real time by more than 6 seconds")
	require.EqualValues(t, tcyai.MaxLiveSpeechFrameBytes, liveNoteAllowedAudioBytes(0, rate))
	require.Equal(t, liveNoteAllowedAudioBytes(0, rate), liveNoteAllowedAudioBytes(-time.Second, rate))
}

func TestLiveNotesAudioAcceptsActualTwoTimesCatchupPastSixSecondLead(t *testing.T) {
	result := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept catch-up fixture: %v", err)
			return
		}
		defer func() { _ = socket.CloseNow() }()
		ready := make(chan struct{})
		close(ready)
		audio := make(chan []byte, 64)
		go func(ctx context.Context) {
			result <- readLiveNoteAudio(ctx, socket, audio, ready, 16000)
			close(audio)
		}(r.Context())
		for range audio {
		}
	}))
	defer server.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 12*time.Second)
	defer cancel()
	socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer func() { _ = socket.CloseNow() }()
	ticker := time.NewTicker(50 * time.Millisecond)
	defer ticker.Stop()
	for range 140 {
		select {
		case <-ticker.C:
		case <-ctx.Done():
			t.Fatal("catch-up fixture timed out")
		}
		require.NoError(t, socket.Write(ctx, websocket.MessageBinary, make([]byte, 3200)))
	}
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "stop"}))
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("valid bounded catch-up never completed")
	}
}
