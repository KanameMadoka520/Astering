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
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
)

const liveNoteRotateSeconds = 7 * 60

var recognizeLiveNoteSpeech = tcyai.RecognizeLiveSpeech

type liveNoteCaptureState struct {
	sync.Mutex
	segment  models.AsterNoteSegment
	progress *liveNoteProgress
}

func (c *liveNoteCaptureState) snapshot() models.AsterNoteSegment {
	c.Lock()
	defer c.Unlock()
	return c.segment
}

type liveNoteConnection struct {
	ID         string `json:"id" required:"true"`
	Name       string `json:"name" required:"true"`
	Model      string `json:"model" required:"true"`
	Protocol   string `json:"protocol" required:"true"`
	Endpoint   string `json:"endpoint" required:"true"`
	SampleRate int    `json:"sample_rate" required:"true"`
	Default    bool   `json:"default" required:"true"`
}

func init() { AddRouteRegistrar(registerLiveNoteConnections) }

func registerLiveNoteConnections(api huma.API) {
	Register(api, asterNotesOperation(huma.Operation{
		OperationID: "notes-live-connections",
		Method:      http.MethodGet,
		Path:        "/notes/live-connections",
		Summary:     "List this user's saved connections which support live microphone transcription",
		Tags:        []string{"notes"},
	}), func(ctx context.Context, _ *struct{}) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         []liveNoteConnection
	}, error) {
		actor, err := asterNotesAuth(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewReadSession()
		current, err := models.RequireAsterNotesHuman(s, actor, false)
		_ = s.Close()
		if err != nil {
			return nil, translateDomainError(err)
		}
		settings, err := tcyai.Load(current.ID)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		out := make([]liveNoteConnection, 0)
		for _, c := range settings.Connections {
			if c.Kind != "transcription" || c.Speech != nil && c.Speech.Disabled {
				continue
			}
			rate, rateErr := tcyai.LiveSpeechSampleRate(c)
			if rateErr != nil {
				continue
			}
			out = append(out, liveNoteConnection{
				ID:         c.ID,
				Name:       c.Name,
				Model:      c.Model,
				Protocol:   c.EffectiveProtocol(),
				Endpoint:   tcyai.Endpoint(c),
				SampleRate: rate,
				Default:    c.ID == settings.Transcription,
			})
		}
		return &struct {
			CacheControl string `header:"Cache-Control"`
			Body         []liveNoteConnection
		}{
			CacheControl: "no-store",
			Body:         out,
		}, nil
	})
}

type liveNoteStart struct {
	Action             string     `json:"action"`
	Token              string     `json:"token"`
	NoteID             int64      `json:"note_id"`
	ConnectionID       string     `json:"connection_id"`
	OffsetMS           int64      `json:"offset_ms"`
	Language           string     `json:"language"`
	RecordingID        string     `json:"recording_id"`
	RecordingStartedAt *time.Time `json:"recording_started_at"`
	RecordingOffsetMS  int64      `json:"recording_offset_ms"`
	Timezone           string     `json:"timezone"`
	AppendToArticle    bool       `json:"append_to_article"`
}

var liveNoteSlots = struct {
	sync.Mutex
	active map[int64]map[int64]bool
}{active: map[int64]map[int64]bool{}}

func acquireLiveNote(uid, noteID int64) (func(), bool) {
	liveNoteSlots.Lock()
	defer liveNoteSlots.Unlock()
	if liveNoteSlots.active[uid][noteID] || len(liveNoteSlots.active[uid]) >= 2 {
		return nil, false
	}
	if liveNoteSlots.active[uid] == nil {
		liveNoteSlots.active[uid] = map[int64]bool{}
	}
	liveNoteSlots.active[uid][noteID] = true
	return sync.OnceFunc(func() {
		liveNoteSlots.Lock()
		defer liveNoteSlots.Unlock()
		delete(liveNoteSlots.active[uid], noteID)
		if len(liveNoteSlots.active[uid]) == 0 {
			delete(liveNoteSlots.active, uid)
		}
	}), true
}

// Like /ws, the browser authenticates in the first message, never in a URL.
// Unlike an agent job, this stream ends when its microphone client disconnects.
func LiveNoteSpeech(c *echo.Context) error {
	socket, err := websocket.Accept(c.Response(), c.Request(), &websocket.AcceptOptions{
		OriginPatterns: config.CorsOrigins.GetStringSlice(),
	})
	if err != nil {
		return nil
	}
	defer func() { _ = socket.CloseNow() }()
	socket.SetReadLimit(8192)
	transportCtx, transportDone := context.WithTimeout(c.Request().Context(), 10*time.Minute)
	defer transportDone()
	ctx, cancel := context.WithCancel(transportCtx)
	defer cancel()
	var writeMu sync.Mutex
	write := func(writeContext context.Context, value any) error {
		writeMu.Lock()
		defer writeMu.Unlock()
		if err := writeContext.Err(); err != nil {
			return err
		}
		writeCtx, done := context.WithTimeout(writeContext, 5*time.Second)
		defer done()
		return wsjson.Write(writeCtx, socket, value)
	}
	send := func(value any) error { return write(ctx, value) }
	fail := func(code string) {
		_ = send(map[string]string{
			"type": "error",
			"code": code,
		})
	}
	authCtx, authDone := context.WithTimeout(ctx, 5*time.Second)
	var start liveNoteStart
	err = wsjson.Read(authCtx, socket, &start)
	authDone()
	if err != nil || start.Action != "start" || start.NoteID <= 0 || len(start.ConnectionID) > 80 ||
		start.OffsetMS < 0 || start.OffsetMS > int64(365*24*time.Hour/time.Millisecond) {
		fail("invalid_start")
		return nil
	}
	claims, err := auth.ParseUserToken(start.Token)
	start.Token = ""
	if err != nil {
		fail("authentication")
		return nil
	}
	capture := &models.AsterNoteSegment{RecordingID: start.RecordingID, RecordingStartedAt: start.RecordingStartedAt, RecordingOffsetMS: start.RecordingOffsetMS, Timezone: start.Timezone, AppendToArticle: start.AppendToArticle}
	if err := models.NormalizeAsterNoteCapture(capture); err != nil {
		fail("invalid_start")
		return nil
	}
	captureState := &liveNoteCaptureState{segment: *capture}
	ctx = tcyai.WithAccountRunAdmission(ctx, claims.UserID)
	if err = checkLiveNoteSession(ctx, claims); err != nil {
		fail("authentication")
		return nil
	}
	if strings.HasPrefix(start.Language, "zh") {
		ctx = tcylocale.WithLanguage(ctx, "zh-CN")
	}
	actor := user.WithSessionCredential(&user.User{ID: claims.UserID}, claims.SessionID)
	release, ok := acquireLiveNote(claims.UserID, start.NoteID)
	if !ok {
		fail("already_recording")
		return nil
	}
	defer release()
	offset, err := liveNoteOffset(ctx, actor, start.NoteID)
	if err != nil {
		fail("note_unavailable")
		return nil
	}
	if start.OffsetMS > offset {
		offset = start.OffsetMS
	}
	ctx, finish, err := tcyai.RegisterAccountRun(ctx, claims.UserID)
	if err != nil {
		fail("authentication")
		return nil
	}
	defer finish()
	settings, err := tcyai.Load(claims.UserID)
	if err != nil {
		fail("connection")
		return nil
	}
	if start.ConnectionID == "" {
		start.ConnectionID = settings.Transcription
	}
	connection, err := settings.Find(start.ConnectionID, "transcription")
	if err != nil {
		fail("connection")
		return nil
	}
	rate, err := tcyai.LiveSpeechSampleRate(connection)
	if err != nil {
		fail("unsupported")
		return nil
	}
	requestID := uuid.NewString()
	progress := &liveNoteProgress{
		started: time.Now(),
		rate:    rate,
	}
	captureState.progress = progress
	status := "interrupted"
	var provider tcyai.SpeechProviderDiagnostic
	defer func() {
		progress.log(requestID, claims.UserID, start.NoteID, connection.EffectiveProtocol(), status, provider)
	}()
	socket.SetReadLimit(32 * 1024)
	audio := make(chan []byte, 64)
	readDone := make(chan error, 1)
	ready := make(chan struct{})
	go func() {
		defer close(audio)
		readErr := readLiveNoteAudio(ctx, socket, audio, ready, rate, captureState)
		readDone <- readErr
		if readErr != nil {
			cancel()
		}
	}()
	go watchLiveNote(ctx, cancel, actor, start.NoteID, claims)
	err = recognizeLiveNoteSpeech(ctx, connection, rate, audio, func() error {
		rotate := liveNoteRotation(claims.ExpiresAt, time.Now())
		if rotate < 30 {
			fail("authentication")
			return auth.ErrUserTokenRejected
		}
		if sendErr := send(map[string]any{
			"type":           "ready",
			"request_id":     requestID,
			"sample_rate":    rate,
			"offset_ms":      offset,
			"rotate_seconds": rotate,
			"model":          connection.Model,
			"endpoint":       tcyai.Endpoint(connection),
		}); sendErr != nil {
			return sendErr
		}
		progress.providerReady.Store(true)
		close(ready)
		return nil
	}, liveNoteDeltaSink(ctx, actor, start.NoteID, offset, claims, send, captureState))
	if err != nil {
		var failure map[string]any
		status, provider, failure = progress.failureEvent(ctx, err, readDone, requestID)
		if failure != nil {
			if status == "invalid_audio" {
				// Only this fixed error and content-free counters may outlive the
				// reader's cancellation. Transcript events remain fenced by ctx.
				_ = write(transportCtx, failure)
			} else {
				_ = send(failure)
			}
		}
		return nil
	}
	select {
	case readErr := <-readDone:
		if readErr != nil {
			return nil
		}
	default:
		fail("interrupted")
		return nil
	}
	// A done event permits the next wire; free this slot before acknowledging rotation.
	release()
	status = "done"
	_ = send(map[string]any{
		"type":        "done",
		"request_id":  requestID,
		"diagnostics": progress.snapshot(),
	})
	_ = socket.Close(websocket.StatusNormalClosure, "")
	return nil
}

func liveNoteOffset(ctx context.Context, actor *user.User, noteID int64) (int64, error) {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s := db.NewReadSession().Context(ctx)
	defer s.Close()
	return models.AsterNoteRecordingOffset(s, actor, noteID)
}

func checkLiveNoteSession(ctx context.Context, claims *auth.UserTokenClaims) error {
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	return auth.CheckUserTokenSessionContext(ctx, claims)
}

func saveLiveNoteSegment(ctx context.Context, actor *user.User, noteID int64, segment *models.AsterNoteSegment) (*models.AsterNoteTranscriptState, error) {
	writeCtx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	s := db.NewReadSession().Context(writeCtx)
	defer s.Close()
	if err := s.Begin(); err != nil {
		return nil, err
	}
	if err := models.AppendAsterNoteSegment(s, actor, noteID, segment); err != nil {
		return nil, err
	}
	stats, err := models.ReadAsterNoteTranscriptState(s, actor, noteID)
	if err != nil {
		return nil, err
	}
	if err = s.Commit(); err != nil {
		return nil, err
	}
	return stats, nil
}

func readLiveNoteAudio(ctx context.Context, socket *websocket.Conn, audio chan<- []byte, ready <-chan struct{}, rate int, captures ...*liveNoteCaptureState) error {
	select {
	case <-ready:
	case <-ctx.Done():
		return ctx.Err()
	}
	started := time.Now()
	var sent int64
	clockUpdated := false
	for {
		kind, data, readErr := socket.Read(ctx)
		if readErr != nil {
			return readErr
		}
		if kind == websocket.MessageText {
			var command struct {
				Action             string     `json:"action"`
				RecordingStartedAt *time.Time `json:"recording_started_at"`
			}
			if err := json.Unmarshal(data, &command); err != nil {
				return errLiveNoteInvalidCommand
			}
			if command.Action == "stop" {
				return nil
			}
			if command.Action == "capture_started" && sent == 0 && !clockUpdated && command.RecordingStartedAt != nil && len(captures) > 0 && captures[0] != nil {
				state := captures[0]
				state.Lock()
				capture := state.segment
				if capture.RecordingOffsetMS != 0 {
					state.Unlock()
					return errLiveNoteInvalidCommand
				}
				capture.RecordingStartedAt = command.RecordingStartedAt
				capture.CapturedAt = nil
				err := models.NormalizeAsterNoteCapture(&capture)
				if err == nil {
					state.segment = capture
				}
				state.Unlock()
				if err != nil {
					return errLiveNoteInvalidCommand
				}
				clockUpdated = true
				continue
			}
			return errLiveNoteInvalidCommand
		}
		sent += int64(len(data))
		allowed := liveNoteAllowedAudioBytes(time.Since(started), rate)
		if len(data) == 0 || len(data)%2 != 0 || sent > allowed || sent > int64(rate*2*tcyai.MaxLiveSpeechSeconds) {
			return errLiveNoteInvalidAudio
		}
		if len(captures) > 0 && captures[0] != nil {
			captures[0].progress.received(len(data))
		}
		select {
		case audio <- data:
		case <-ctx.Done():
			return ctx.Err()
		}
	}
}

func liveNoteDeltaSink(ctx context.Context, actor *user.User, noteID, offset int64, claims *auth.UserTokenClaims, send func(any) error, captures ...*liveNoteCaptureState) func(tcyai.LiveSpeechDelta) error {
	ids := map[string]string{}
	return func(delta tcyai.LiveSpeechDelta) error {
		if err := ctx.Err(); err != nil {
			if delta.Final {
				return auth.ErrUserTokenRejected
			}
			return err
		}
		var progress *liveNoteProgress
		if len(captures) > 0 && captures[0] != nil {
			progress = captures[0].progress
		}
		progress.transcript(delta.Final, strings.TrimSpace(delta.Text) != "")
		if !delta.Final {
			return send(map[string]any{
				"type": "partial",
				"id":   delta.ID,
				"text": delta.Text,
			})
		}
		if strings.TrimSpace(delta.Text) == "" {
			return nil
		}
		if time.Now().After(claims.ExpiresAt) || checkLiveNoteSession(ctx, claims) != nil {
			return auth.ErrUserTokenRejected
		}
		clientID := ids[delta.ID]
		if clientID == "" {
			clientID = uuid.NewString()
			ids[delta.ID] = clientID
		}
		segment := &models.AsterNoteSegment{
			ClientID:        clientID,
			Text:            delta.Text,
			StartMS:         offset + delta.StartMS,
			EndMS:           offset + delta.EndMS,
			TimingEstimated: delta.TimingEstimated,
		}
		if len(captures) > 0 && captures[0] != nil {
			capture := captures[0].snapshot()
			segment.RecordingID, segment.RecordingStartedAt, segment.Timezone, segment.AppendToArticle = capture.RecordingID, capture.RecordingStartedAt, capture.Timezone, capture.AppendToArticle
			if capture.RecordingStartedAt != nil {
				segment.RecordingOffsetMS = capture.RecordingOffsetMS + delta.StartMS
			}
		}
		stats, saveErr := saveLiveNoteSegment(ctx, actor, noteID, segment)
		if saveErr != nil {
			_ = send(map[string]string{
				"type": "error",
				"code": "save_failed",
				"text": delta.Text,
			})
			return errors.Join(errLiveNoteSaveFailed, saveErr)
		}
		if progress != nil {
			progress.savedSegments.Add(1)
		}
		return send(map[string]any{
			"type":    "segment",
			"id":      delta.ID,
			"segment": segment,
			"stats":   stats,
		})
	}
}

// Leave enough token lifetime for provider finalization before opening the next wire.
func liveNoteRotation(expires, now time.Time) int {
	return min(liveNoteRotateSeconds, int(expires.Sub(now).Seconds())-45)
}

func watchLiveNote(ctx context.Context, cancel context.CancelFunc, actor *user.User, noteID int64, claims *auth.UserTokenClaims) {
	ticker := time.NewTicker(3 * time.Second)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
			if time.Now().After(claims.ExpiresAt) || checkLiveNoteSession(ctx, claims) != nil {
				cancel()
				return
			}
			if _, checkErr := liveNoteOffset(ctx, actor, noteID); checkErr != nil {
				cancel()
				return
			}
		}
	}
}
