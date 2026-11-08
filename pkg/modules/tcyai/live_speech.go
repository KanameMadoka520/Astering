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
	"strconv"
	"strings"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
)

// MaxLiveSpeechSeconds limits one provider connection, not the duration of a note.
// Callers finish and reopen a stream before this limit, preserving the note's audio offset.
const MaxLiveSpeechSeconds = 8 * 60

const (
	MaxLiveSpeechFrameBytes = 32 * 1024
	liveSpeechReadyTimeout  = 15 * time.Second
	liveSpeechFinishTimeout = 30 * time.Second
	liveSpeechResponseLimit = 32 * 1024 * 1024
)

// LiveSpeechDelta replaces the previous interim for ID. A final ID is immutable.
// Times are relative to this stream's PCM, so callers add their durable recording offset.
type LiveSpeechDelta struct {
	ID              string `json:"id"`
	Text            string `json:"text"`
	Final           bool   `json:"final"`
	StartMS         int64  `json:"start_ms"`
	EndMS           int64  `json:"end_ms"`
	TimingEstimated bool   `json:"timing_estimated,omitempty"`
}

func LiveSpeechSampleRate(c Connection) (int, error) {
	const rate = 16000
	return rate, ValidateLiveSpeech(c, rate)
}

func ValidateLiveSpeech(c Connection, sampleRate int) error {
	if c.Kind != "transcription" || strings.TrimSpace(c.Model) == "" {
		return tcylocale.Error("speechOptions")
	}
	if c.Speech != nil && c.Speech.Disabled {
		return tcylocale.Error("speechDisabled")
	}
	if err := validateSpeech(c); err != nil {
		return err
	}
	switch c.EffectiveProtocol() {
	case "dashscope-asr":
		if sampleRate != 8000 && sampleRate != 16000 && sampleRate != 24000 && sampleRate != 48000 {
			return tcylocale.Error("speechSampleRate", 16000)
		}
		_, err := dashSpeechPayload(c, sampleRate)
		return err
	case "qwen-asr-realtime":
		if sampleRate != 8000 && sampleRate != 16000 {
			return tcylocale.Error("speechProtocol08")
		}
		return nil
	default:
		return tcylocale.Error("speechLiveUnsupported")
	}
}

// RecognizeLiveSpeech consumes signed 16-bit, mono, little-endian PCM as it arrives.
// onReady runs exactly once, after the provider's acknowledgement. Closing audio flushes
// the final utterance; canceling ctx aborts immediately. Callbacks run on the reader only.
// Sending a slice transfers ownership to the recognizer; producers must not reuse its backing array.
func RecognizeLiveSpeech(
	ctx context.Context,
	c Connection,
	sampleRate int,
	audio <-chan []byte,
	onReady func() error,
	onDelta func(LiveSpeechDelta) error,
) error {
	if err := ValidateLiveSpeech(c, sampleRate); err != nil {
		return err
	}
	if audio == nil {
		return tcylocale.Error("speechLiveFrame")
	}
	ctx, cancel := context.WithTimeout(ctx, (MaxLiveSpeechSeconds+120)*time.Second)
	defer cancel()
	readyCtx, readyCancel := context.WithTimeout(ctx, liveSpeechReadyTimeout)
	defer readyCancel()
	socket, release, err := dialSpeechSocket(readyCtx, Endpoint(c), speechHeaders(c))
	if err != nil {
		return err
	}
	defer release()
	taskID := uuid.NewString()
	protocol := c.EffectiveProtocol()
	if err = startLiveSpeechProvider(readyCtx, socket, c, sampleRate, taskID); err != nil {
		return err
	}
	transcript := newLiveSpeechTranscript(onDelta)
	var upload *liveSpeechUpload
	defer func() {
		if upload != nil {
			upload.close()
		}
	}()
	responseBytes := 0
	for {
		readCtx := ctx
		if upload == nil {
			readCtx = readyCtx
		}
		var event liveSpeechEvent
		if err = readLiveSpeechEvent(readCtx, socket, &event, &responseBytes); err != nil {
			if upload != nil {
				if writeErr := upload.completedError(); writeErr != nil {
					return writeErr
				}
			}
			return err
		}
		started := event.Type == "session.updated"
		finished := event.Type == "session.finished"
		if protocol == "dashscope-asr" {
			if event.Header.TaskID != taskID {
				return tcylocale.Error("speechProtocol01")
			}
			started = event.Header.Event == "task-started"
			finished = event.Header.Event == "task-finished"
		}
		if event.Header.Event == "task-failed" || event.Type == "error" || event.Type == "conversation.item.input_audio_transcription.failed" {
			return tcylocale.Error("speechProviderRejected")
		}
		if started {
			if upload != nil {
				continue
			}
			if onReady != nil {
				if err = onReady(); err != nil {
					return err
				}
			}
			upload = startLiveSpeechUpload(ctx, socket, c, sampleRate, taskID, audio)
			readyCancel()
			continue
		}
		if finished {
			if upload == nil || !upload.finishing.Load() {
				return tcylocale.Error("speechProtocol04")
			}
			if err = upload.wait(); err != nil {
				return err
			}
			return transcript.finish()
		}
		if err = consumeLiveSpeechTranscript(protocol, &event, transcript, upload); err != nil {
			return err
		}
	}
}

func startLiveSpeechProvider(ctx context.Context, socket *websocket.Conn, c Connection, sampleRate int, taskID string) error {
	var err error
	if c.EffectiveProtocol() == "dashscope-asr" {
		payload, payloadErr := dashSpeechPayload(c, sampleRate)
		if payloadErr != nil {
			return payloadErr
		}
		parameters := payload["parameters"].(map[string]any)
		parameters["heartbeat"] = true
		parameters["multi_threshold_mode_enabled"] = true
		err = wsjson.Write(ctx, socket, dashSpeechCommand(taskID, "run-task", payload))
	} else {
		session := qwenSpeechSession(c, sampleRate)
		// Manual commit is forbidden in VAD mode; session.finish flushes the last in-progress utterance.
		session["turn_detection"] = map[string]any{
			"type":                "server_vad",
			"threshold":           0.0,
			"silence_duration_ms": 400,
		}
		err = wsjson.Write(ctx, socket, map[string]any{
			"type":     "session.update",
			"event_id": uuid.NewString(),
			"session":  session,
		})
	}
	if err != nil {
		return speechStreamError(ctx)
	}
	return nil
}

func consumeLiveSpeechTranscript(protocol string, event *liveSpeechEvent, transcript *liveSpeechTranscript, upload *liveSpeechUpload) error {
	if protocol == "dashscope-asr" {
		if event.Header.Event != "result-generated" {
			return nil
		}
		if upload == nil {
			return tcylocale.Error("speechProtocol02")
		}
		sentence := event.Payload.Output.Sentence
		if sentence == nil || sentence.Heartbeat {
			return nil
		}
		if sentence.ID < 1 {
			return tcylocale.Error("speechProtocol03")
		}
		return transcript.update(strconv.Itoa(sentence.ID), sentence.Text, sentence.Final, sentence.Begin, sentence.End, upload.durationMS())
	}
	switch event.Type {
	case "input_audio_buffer.speech_started", "input_audio_buffer.speech_stopped":
		if upload == nil {
			return tcylocale.Error("speechProtocol09")
		}
		return transcript.setTiming(event.ItemID, event.AudioStart, event.AudioEnd)
	case "conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed":
		if upload == nil {
			return tcylocale.Error("speechProtocol09")
		}
		final := event.Type == "conversation.item.input_audio_transcription.completed"
		text := event.Text + event.Stash
		if final {
			text = event.Transcript
		}
		return transcript.update(event.ItemID, text, final, nil, nil, upload.durationMS())
	}
	return nil
}

type liveSpeechEvent struct {
	Type       string `json:"type"`
	ItemID     string `json:"item_id"`
	Text       string `json:"text"`
	Stash      string `json:"stash"`
	Transcript string `json:"transcript"`
	AudioStart *int64 `json:"audio_start_ms"`
	AudioEnd   *int64 `json:"audio_end_ms"`
	Header     struct {
		Event  string `json:"event"`
		TaskID string `json:"task_id"`
	} `json:"header"`
	Payload struct {
		Output struct {
			Sentence *struct {
				ID        int    `json:"sentence_id"`
				Text      string `json:"text"`
				Final     bool   `json:"sentence_end"`
				Heartbeat bool   `json:"heartbeat"`
				Begin     *int64 `json:"begin_time"`
				End       *int64 `json:"end_time"`
			} `json:"sentence"`
		} `json:"output"`
	} `json:"payload"`
}

func readLiveSpeechEvent(ctx context.Context, socket *websocket.Conn, event *liveSpeechEvent, total *int) error {
	kind, body, err := socket.Read(ctx)
	if err != nil {
		return speechStreamError(ctx)
	}
	*total += len(body)
	if *total > liveSpeechResponseLimit {
		return tcylocale.Error("speechTranscriptSize")
	}
	if kind != websocket.MessageText || json.Unmarshal(body, event) != nil {
		return tcylocale.Error("speechProtocol10")
	}
	return nil
}

type liveSpeechUpload struct {
	cancel    context.CancelFunc
	socket    *websocket.Conn
	done      chan struct{}
	err       error
	finish    *time.Timer
	finishing atomic.Bool
	bytes     atomic.Int64
	rate      int64
}

func startLiveSpeechUpload(ctx context.Context, socket *websocket.Conn, c Connection, rate int, taskID string, audio <-chan []byte) *liveSpeechUpload {
	writeCtx, cancel := context.WithCancel(ctx)
	upload := &liveSpeechUpload{
		cancel: cancel,
		socket: socket,
		done:   make(chan struct{}),
		rate:   int64(rate),
	}
	go func() {
		upload.err = upload.write(writeCtx, c, taskID, audio)
		close(upload.done)
		if upload.err != nil {
			_ = socket.CloseNow()
		}
	}()
	return upload
}

func (u *liveSpeechUpload) write(ctx context.Context, c Connection, taskID string, audio <-chan []byte) error {
	for {
		select {
		case <-ctx.Done():
			return ctx.Err()
		case frame, ok := <-audio:
			if !ok {
				u.finishing.Store(true)
				u.finish = time.AfterFunc(liveSpeechFinishTimeout, func() { _ = u.socket.CloseNow() })
				if c.EffectiveProtocol() == "dashscope-asr" {
					return liveSpeechWriteError(ctx, wsjson.Write(ctx, u.socket, dashSpeechCommand(taskID, "finish-task", map[string]any{"input": map[string]any{}})))
				}
				return liveSpeechWriteError(ctx, writeQwenSpeechAction(ctx, u.socket, "session.finish"))
			}
			if len(frame) == 0 || len(frame)%2 != 0 || len(frame) > MaxLiveSpeechFrameBytes {
				return tcylocale.Error("speechLiveFrame")
			}
			if u.bytes.Load()+int64(len(frame)) > u.rate*2*MaxLiveSpeechSeconds {
				return tcylocale.Error("speechLiveLimit")
			}
			// Publish the audio clock before a fast provider can return its matching timestamp.
			u.bytes.Add(int64(len(frame)))
			if err := writeSpeechPCM(ctx, u.socket, frame, c.EffectiveProtocol() != "dashscope-asr"); err != nil {
				return speechStreamError(ctx)
			}
		}
	}
}

func liveSpeechWriteError(ctx context.Context, err error) error {
	if err != nil {
		return speechStreamError(ctx)
	}
	return nil
}

func (u *liveSpeechUpload) durationMS() int64 {
	return u.bytes.Load() * 1000 / (u.rate * 2)
}

func (u *liveSpeechUpload) completedError() error {
	select {
	case <-u.done:
		return u.err
	default:
		return nil
	}
}

func (u *liveSpeechUpload) wait() error {
	<-u.done
	return u.err
}

func (u *liveSpeechUpload) close() {
	u.cancel()
	_ = u.socket.CloseNow()
	<-u.done
	if u.finish != nil {
		u.finish.Stop()
	}
}

type liveSpeechSentence struct {
	id    string
	text  string
	final bool
	start *int64
	end   *int64
}

type liveSpeechTranscript struct {
	items   map[string]*liveSpeechSentence
	bytes   int
	lastEnd int64
	onDelta func(LiveSpeechDelta) error
}

func newLiveSpeechTranscript(onDelta func(LiveSpeechDelta) error) *liveSpeechTranscript {
	return &liveSpeechTranscript{
		items:   make(map[string]*liveSpeechSentence),
		onDelta: onDelta,
	}
}

func (t *liveSpeechTranscript) sentence(id string) (*liveSpeechSentence, error) {
	if id == "" || len(id) > 256 {
		return nil, tcylocale.Error("speechProtocol09")
	}
	if item, ok := t.items[id]; ok {
		return item, nil
	}
	if len(t.items) >= 4096 {
		return nil, tcylocale.Error("speechTranscriptSize")
	}
	item := &liveSpeechSentence{id: uuid.NewString()}
	t.items[id] = item
	return item, nil
}

func (t *liveSpeechTranscript) setTiming(id string, start, end *int64) error {
	item, err := t.sentence(id)
	if err != nil {
		return err
	}
	if start != nil {
		item.start = start
	}
	if end != nil {
		item.end = end
	}
	if (item.start != nil && (*item.start < 0 || *item.start > MaxLiveSpeechSeconds*1000)) ||
		(item.end != nil && (*item.end < 0 || *item.end > MaxLiveSpeechSeconds*1000)) ||
		(item.start != nil && item.end != nil && *item.end < *item.start) {
		return tcylocale.Error("speechProtocol10")
	}
	return nil
}

func (t *liveSpeechTranscript) update(id, text string, final bool, start, end *int64, duration int64) error {
	item, err := t.sentence(id)
	if err != nil {
		return err
	}
	if item.final {
		if final && item.text != text {
			return tcylocale.Error("speechProtocol10")
		}
		return nil
	}
	if err = t.setTiming(id, start, end); err != nil {
		return err
	}
	if t.bytes-len(item.text)+len(text) > speechResponseLimit {
		return tcylocale.Error("speechTranscriptSize")
	}
	if item.text == text && !final {
		return nil
	}
	t.bytes += len(text) - len(item.text)
	item.text = text
	item.final = final
	delta := LiveSpeechDelta{
		ID:              item.id,
		Text:            text,
		Final:           final,
		StartMS:         min(t.lastEnd, duration),
		EndMS:           duration,
		TimingEstimated: item.start == nil || item.end == nil,
	}
	if item.start != nil {
		delta.StartMS = *item.start
	}
	if item.end != nil {
		delta.EndMS = *item.end
	}
	if delta.EndMS < delta.StartMS {
		delta.EndMS = delta.StartMS
		delta.TimingEstimated = true
	}
	if final {
		t.lastEnd = max(t.lastEnd, delta.EndMS)
	}
	if t.onDelta != nil {
		return t.onDelta(delta)
	}
	return nil
}

func (t *liveSpeechTranscript) finish() error {
	for _, item := range t.items {
		if !item.final && strings.TrimSpace(item.text) != "" {
			return tcylocale.Error("speechProtocol12")
		}
	}
	return nil
}
