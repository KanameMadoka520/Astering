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
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const (
	shortSpeechMaxSeconds = 180
	shortSpeechMaxBytes   = 16 * 1024 * 1024
	shortSpeechQueueSize  = 16
	shortSpeechTextBytes  = 64 * 1024
	shortSpeechMaxIDs     = 2048
	shortSpeechEventBytes = 256 * 1024
)

var (
	errShortSpeechAudio   = errors.New("invalid_audio")
	errShortSpeechCommand = errors.New("invalid_command")
	errShortSpeechLimit   = errors.New("limit")
	errShortSpeechClosed  = errors.New("disconnected")
	errShortSpeechFinal   = errors.New("invalid_final")
	errShortSpeechFlush   = errors.New("finalize_timeout")
	shortSpeechSlots      = struct {
		sync.Mutex
		accounts map[int64]int
	}{accounts: map[int64]int{}}
)

type shortSpeechStart struct {
	Action       string `json:"action"`
	Token        string `json:"token"`
	ConnectionID string `json:"connection_id"`
}

type shortSpeechState struct {
	bytes     atomic.Int64
	stoppedAt atomic.Int64
	stopped   chan struct{}
}

type shortSpeechTranscript struct {
	segments map[string]tcyai.LiveSpeechDelta
	ids      []string
	bytes    int
	nonempty int
}

func (t *shortSpeechTranscript) update(delta tcyai.LiveSpeechDelta) (bool, error) {
	previous, exists := t.segments[delta.ID]
	if exists && previous.Final {
		if delta.Final && delta.Text != previous.Text {
			return false, errShortSpeechFinal
		}
		return false, nil
	}
	if !exists && len(t.segments) >= shortSpeechMaxIDs {
		return false, errShortSpeechLimit
	}
	nonempty := t.nonempty
	if previous.Text != "" {
		nonempty--
	}
	if delta.Text != "" {
		nonempty++
	}
	size := t.bytes - len(previous.Text) + len(delta.Text)
	if size+max(0, nonempty-1) > shortSpeechTextBytes {
		return false, errShortSpeechLimit
	}
	if !exists {
		t.ids = append(t.ids, delta.ID)
	}
	t.bytes, t.nonempty = size, nonempty
	t.segments[delta.ID] = delta
	return true, nil
}

func (t *shortSpeechTranscript) text() string {
	parts := make([]string, 0, len(t.ids))
	for _, id := range t.ids {
		if segment := t.segments[id]; segment.Final && segment.Text != "" {
			parts = append(parts, segment.Text)
		}
	}
	return strings.Join(parts, "\n")
}

// LiveAssistantSpeech streams ephemeral microphone input. Unlike notes/live it
// never creates a note, attachment, transcript segment or chat message.
func LiveAssistantSpeech(c *echo.Context) error {
	if c.Get("api_token") != nil || user.ResourcePermissionsOnly(c.Request().Context()) {
		return echo.NewHTTPError(403, "human_session_required")
	}
	socket, err := websocket.Accept(c.Response(), c.Request(), &websocket.AcceptOptions{
		OriginPatterns: config.CorsOrigins.GetStringSlice(),
	})
	if err != nil {
		return nil
	}
	defer func() { _ = socket.CloseNow() }()
	transportCtx, transportCancel := context.WithTimeout(c.Request().Context(), (shortSpeechMaxSeconds+60)*time.Second)
	defer transportCancel()
	if strings.HasPrefix(strings.ToLower(c.Request().Header.Get("Accept-Language")), "zh") {
		transportCtx = tcylocale.WithLanguage(transportCtx, "zh-CN")
	}
	runCtx, cancel := context.WithCancelCause(transportCtx)
	defer cancel(context.Canceled)
	send := func(value any) error {
		body, err := json.Marshal(value)
		if err != nil {
			return err
		}
		if len(body) > shortSpeechEventBytes {
			return errShortSpeechLimit
		}
		writeCtx, done := context.WithTimeout(transportCtx, 5*time.Second)
		defer done()
		return socket.Write(writeCtx, websocket.MessageText, body)
	}
	fail := func(code, key string) {
		_ = send(map[string]string{
			"type":    "error",
			"code":    code,
			"message": tcylocale.Render(transportCtx, tcylocale.Error(key)),
		})
	}
	socket.SetReadLimit(8192)
	authCtx, authCancel := context.WithTimeout(runCtx, 5*time.Second)
	var start shortSpeechStart
	err = wsjson.Read(authCtx, socket, &start)
	authCancel()
	if err != nil || start.Action != "start" || len(start.ConnectionID) > 80 {
		fail("invalid_start", "speechOptions")
		return nil
	}
	claims, err := auth.ParseUserToken(start.Token)
	start.Token = ""
	if err != nil {
		fail("authentication", "accountRunRevoked")
		return nil
	}
	runCtx = tcyai.WithAccountRunAdmission(runCtx, claims.UserID)
	if err = checkShortSpeechSession(runCtx, claims); err != nil {
		fail("authentication", "accountRunRevoked")
		return nil
	}
	release, ok := acquireShortSpeech(claims.UserID)
	if !ok {
		fail("already_recording", "speechLiveLimit")
		return nil
	}
	defer release()
	runCtx, finish, err := tcyai.RegisterAccountRun(runCtx, claims.UserID)
	if err != nil {
		fail("authentication", "accountRunRevoked")
		return nil
	}
	defer finish()
	settings, err := tcyai.Load(claims.UserID)
	if err != nil {
		fail("connection", "speechOptions")
		return nil
	}
	if start.ConnectionID == "" {
		start.ConnectionID = settings.Transcription
	}
	connection, err := settings.Find(start.ConnectionID, "transcription")
	if err != nil {
		fail("connection", "speechOptions")
		return nil
	}
	rate, err := tcyai.LiveSpeechSampleRate(connection)
	if err != nil {
		fail("unsupported", "speechLiveUnsupported")
		return nil
	}
	socket.SetReadLimit(tcyai.MaxLiveSpeechFrameBytes)
	audio := make(chan []byte, shortSpeechQueueSize)
	ready := make(chan struct{})
	state := &shortSpeechState{stopped: make(chan struct{})}
	go readShortSpeechAudio(runCtx, transportCtx, cancel, socket, audio, ready, state, rate)
	go watchShortSpeechSession(runCtx, cancel, claims)
	go limitShortSpeechRecording(runCtx, cancel, ready, state.stopped)
	started := time.Now()
	requestID := uuid.NewString()
	var firstTextMS int64
	transcript := &shortSpeechTranscript{segments: map[string]tcyai.LiveSpeechDelta{}}
	err = tcyai.RecognizeLiveSpeech(runCtx, connection, rate, audio, func() error {
		if err := checkShortSpeechSession(runCtx, claims); err != nil {
			cancel(auth.ErrUserTokenRejected)
			return err
		}
		close(ready)
		if err := send(map[string]any{
			"type":        "ready",
			"sample_rate": rate,
			"model":       connection.Model,
			"endpoint":    tcyai.Endpoint(connection),
			"max_seconds": shortSpeechMaxSeconds,
			"request_id":  requestID,
		}); err != nil {
			return err
		}
		return nil
	}, func(delta tcyai.LiveSpeechDelta) error {
		changed, err := transcript.update(delta)
		if err != nil {
			cancel(err)
			return err
		}
		if !changed {
			return nil
		}
		if firstTextMS == 0 && strings.TrimSpace(delta.Text) != "" {
			firstTextMS = max(1, time.Since(started).Milliseconds())
		}
		err = send(map[string]any{
			"type":  "transcript",
			"id":    delta.ID,
			"text":  delta.Text,
			"final": delta.Final,
		})
		if err != nil {
			cancel(err)
		}
		return err
	})
	if err != nil {
		if runCtx.Err() == nil {
			provider := tcyai.SpeechProviderErrorDiagnostic(err)
			_ = send(map[string]string{
				"type":                "error",
				"code":                "provider",
				"message":             tcyai.ExplainError(transportCtx, err),
				"request_id":          requestID,
				"provider_code":       provider.Code,
				"provider_request_id": provider.RequestID,
				"provider_task_id":    provider.TaskID,
			})
		} else {
			fail(shortSpeechFailure(runCtx))
		}
		return nil
	}
	if state.stoppedAt.Load() == 0 || checkShortSpeechSession(runCtx, claims) != nil {
		fail("authentication", "accountRunRevoked")
		return nil
	}
	finishMS := time.Since(time.Unix(0, state.stoppedAt.Load())).Milliseconds()
	finish()
	release()
	err = send(map[string]any{
		"type":              "done",
		"text":              transcript.text(),
		"elapsed_ms":        time.Since(started).Milliseconds(),
		"first_text_ms":     firstTextMS,
		"audio_duration_ms": state.bytes.Load() * 1000 / int64(rate*2),
		"finish_ms":         finishMS,
		"request_id":        requestID,
	})
	if errors.Is(err, errShortSpeechLimit) {
		fail("limit", "speechLiveLimit")
	}
	return nil
}

func shortSpeechFailure(ctx context.Context) (code, key string) {
	cause := context.Cause(ctx)
	switch {
	case errors.Is(cause, auth.ErrUserTokenRejected):
		return "authentication", "accountRunRevoked"
	case errors.Is(cause, errShortSpeechClosed), errors.Is(cause, context.Canceled):
		return "interrupted", "speechProtocol11"
	case errors.Is(cause, errShortSpeechFlush):
		return "finalize_timeout", "speechProtocol11"
	case errors.Is(cause, errShortSpeechLimit):
		return "limit", "speechLiveLimit"
	case errors.Is(cause, errShortSpeechAudio), errors.Is(cause, errShortSpeechCommand):
		return "invalid_audio", "speechLiveFrame"
	default:
		return "provider", "speechProviderRejected"
	}
}

func acquireShortSpeech(uid int64) (func(), bool) {
	shortSpeechSlots.Lock()
	defer shortSpeechSlots.Unlock()
	if shortSpeechSlots.accounts[uid] >= 2 {
		return nil, false
	}
	shortSpeechSlots.accounts[uid]++
	var once sync.Once
	return func() {
		once.Do(func() {
			shortSpeechSlots.Lock()
			defer shortSpeechSlots.Unlock()
			shortSpeechSlots.accounts[uid]--
			if shortSpeechSlots.accounts[uid] == 0 {
				delete(shortSpeechSlots.accounts, uid)
			}
		})
	}, true
}

func checkShortSpeechSession(ctx context.Context, claims *auth.UserTokenClaims) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if time.Now().After(claims.ExpiresAt) {
		return auth.ErrUserTokenRejected
	}
	if err := auth.CheckUserTokenSessionContext(ctx, claims); err != nil {
		return err
	}
	active, err := instanceusage.ActiveHuman(ctx, claims.UserID)
	if err != nil {
		return err
	}
	if !active {
		return auth.ErrUserTokenRejected
	}
	return nil
}

func watchShortSpeechSession(ctx context.Context, cancel context.CancelCauseFunc, claims *auth.UserTokenClaims) {
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if checkShortSpeechSession(ctx, claims) != nil {
				cancel(auth.ErrUserTokenRejected)
				return
			}
		}
	}
}

func limitShortSpeechRecording(ctx context.Context, cancel context.CancelCauseFunc, ready, stopped <-chan struct{}) {
	select {
	case <-ready:
	case <-ctx.Done():
		return
	}
	timer := time.NewTimer(shortSpeechMaxSeconds * time.Second)
	defer timer.Stop()
	select {
	case <-ctx.Done():
		return
	case <-stopped:
	case <-timer.C:
		cancel(errShortSpeechLimit)
		return
	}
	// The core bounds provider finalization to 30 seconds after finish is sent.
	// Also bound draining queued PCM if an upstream socket stops accepting writes.
	flushTimer := time.NewTimer(35 * time.Second)
	defer flushTimer.Stop()
	select {
	case <-ctx.Done():
	case <-flushTimer.C:
		cancel(errShortSpeechFlush)
	}
}

func readShortSpeechAudio(ctx, transportCtx context.Context, cancel context.CancelCauseFunc, socket *websocket.Conn, audio chan<- []byte, ready <-chan struct{}, state *shortSpeechState, rate int) {
	closed := false
	defer func() {
		if !closed {
			close(audio)
		}
	}()
	var started time.Time
	for {
		kind, frame, err := socket.Read(transportCtx)
		if err != nil {
			cancel(errShortSpeechClosed)
			return
		}
		select {
		case <-ready:
		case <-ctx.Done():
			return
		default:
			cancel(errShortSpeechCommand)
			return
		}
		if started.IsZero() {
			started = time.Now()
		}
		if kind == websocket.MessageText && !closed {
			var command struct {
				Action string `json:"action"`
			}
			if json.Unmarshal(frame, &command) == nil && command.Action == "stop" {
				state.stoppedAt.Store(time.Now().UnixNano())
				close(state.stopped)
				close(audio)
				closed = true
				// Keep reading after half-close: a disconnected client must cancel
				// the provider immediately while it is flushing its final result.
				continue
			}
			cancel(errShortSpeechCommand)
			return
		}
		if closed || kind != websocket.MessageBinary || len(frame) == 0 || len(frame)%2 != 0 || len(frame) > tcyai.MaxLiveSpeechFrameBytes {
			cancel(errShortSpeechAudio)
			return
		}
		total := state.bytes.Load() + int64(len(frame))
		if total > shortSpeechMaxBytes || total > int64(rate*2*shortSpeechMaxSeconds) {
			cancel(errShortSpeechLimit)
			return
		}
		if total > int64(time.Since(started).Seconds()*float64(rate*2))+int64(rate*2*6) {
			cancel(errShortSpeechAudio)
			return
		}
		select {
		case audio <- frame:
			state.bytes.Store(total)
		case <-ctx.Done():
			return
		default:
			// Do not block the only socket reader behind a stalled provider:
			// it must still notice browser disconnects and stop paid work.
			cancel(errShortSpeechLimit)
			return
		}
	}
}
