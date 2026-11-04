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
	"encoding/base64"
	"encoding/json"
	"net/http"
	"sort"
	"strconv"
	"strings"
	"sync/atomic"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
)

// These are distinct wire protocols, not interchangeable model-name aliases:
// https://www.alibabacloud.com/help/en/model-studio/qwen-audio-asr-streaming-client-events
// https://help.aliyun.com/en/model-studio/qwen-asr-realtime-client-events
func transcribeDashScope(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	payload, err := dashSpeechPayload(c, rate)
	if err != nil {
		return "", err
	}
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), speechHeaders(c))
	if err != nil {
		return "", err
	}
	defer cleanup()
	taskID := uuid.NewString()
	command := dashSpeechCommand(taskID, "run-task", payload)
	if err = wsjson.Write(ctx, socket, command); err != nil {
		return "", speechStreamError(ctx)
	}
	transcript := newSpeechTranscript(true, onDelta)
	var upload *speechAudioUpload
	defer func() {
		if upload != nil {
			upload.close()
		}
	}()
	for {
		var event dashSpeechEvent
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return "", err
		}
		if event.Header.TaskID != taskID {
			return "", tcylocale.Error("speechProtocol01")
		}
		switch event.Header.Event {
		case "task-started":
			if upload == nil {
				upload = startSpeechAudioUpload(ctx, socket, func(writeCtx context.Context, finishing *atomic.Bool) error {
					if err := writeSpeechPCM(writeCtx, socket, pcm, false); err != nil {
						return err
					}
					finishing.Store(true)
					return wsjson.Write(writeCtx, socket, dashSpeechCommand(taskID, "finish-task", map[string]any{"input": map[string]any{}}))
				})
			}
		case "result-generated":
			if upload == nil {
				return "", tcylocale.Error("speechProtocol02")
			}
			sentence := event.Payload.Output.Sentence
			if sentence == nil || sentence.Heartbeat {
				continue
			}
			if sentence.ID < 1 {
				return "", tcylocale.Error("speechProtocol03")
			}
			if err = transcript.update(strconv.Itoa(sentence.ID), sentence.Text, sentence.Final); err != nil {
				return "", err
			}
		case "task-finished":
			if upload == nil || !upload.finishing.Load() {
				return "", tcylocale.Error("speechProtocol04")
			}
			return transcript.finish()
		case "task-failed":
			// Provider messages can echo the audio transcript or credentials; never expose them.
			return "", tcylocale.Error("speechProtocol05")
		}
	}
}

func dashSpeechPayload(c Connection, rate int) (map[string]any, error) {
	if c.Speech != nil && len([]rune(c.Speech.Prompt)) > 400 {
		return nil, tcylocale.Error("speechProtocol06")
	}
	if c.Speech != nil && len(c.Speech.Hotwords) > 0 && strings.HasPrefix(c.Model, "fun-") {
		return nil, tcylocale.Error("speechProtocol07")
	}
	parameters := map[string]any{
		"format":      "pcm",
		"sample_rate": rate,
	}
	if c.Speech != nil {
		if c.Speech.Language != "" && c.Speech.Language != "auto" {
			parameters["language_hints"] = []string{c.Speech.Language}
		}
		if c.Speech.VocabularyID != "" {
			parameters["vocabulary_id"] = c.Speech.VocabularyID
		}
		if len(c.Speech.Hotwords) > 0 {
			words := make(map[string]int, len(c.Speech.Hotwords))
			for _, word := range c.Speech.Hotwords {
				words[word] = 3
			}
			parameters["vocabulary"] = words
		}
	}
	input := map[string]any{}
	if c.Speech != nil && c.Speech.Prompt != "" {
		input["context"] = []map[string]any{{
			"role": "user",
			"content": []map[string]string{{
				"type": "input_text",
				"text": c.Speech.Prompt,
			}},
		}}
	}
	return map[string]any{
		"task_group": "audio",
		"task":       "asr",
		"function":   "recognition",
		"model":      c.Model,
		"parameters": parameters,
		"input":      input,
	}, nil
}

func transcribeQwenRealtime(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	if rate != 8000 && rate != 16000 {
		return "", tcylocale.Error("speechProtocol08")
	}
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), speechHeaders(c))
	if err != nil {
		return "", err
	}
	defer cleanup()
	if err = wsjson.Write(ctx, socket, map[string]any{
		"event_id": uuid.NewString(),
		"type":     "session.update",
		"session":  qwenSpeechSession(c, rate),
	}); err != nil {
		return "", speechStreamError(ctx)
	}
	transcript := newSpeechTranscript(false, onDelta)
	var upload *speechAudioUpload
	defer func() {
		if upload != nil {
			upload.close()
		}
	}()
	for {
		var event qwenSpeechEvent
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return "", err
		}
		switch event.Type {
		case "session.updated":
			if upload == nil {
				upload = startSpeechAudioUpload(ctx, socket, func(writeCtx context.Context, finishing *atomic.Bool) error {
					if err := writeSpeechPCM(writeCtx, socket, pcm, true); err != nil {
						return err
					}
					if err := writeQwenSpeechAction(writeCtx, socket, "input_audio_buffer.commit"); err != nil {
						return err
					}
					finishing.Store(true)
					return writeQwenSpeechAction(writeCtx, socket, "session.finish")
				})
			}
		case "conversation.item.input_audio_transcription.text", "conversation.item.input_audio_transcription.completed":
			if upload == nil || event.ItemID == "" {
				return "", tcylocale.Error("speechProtocol09")
			}
			final := event.Type == "conversation.item.input_audio_transcription.completed"
			text := event.Text + event.Stash
			if final {
				text = event.Transcript
			}
			if err = transcript.update(event.ItemID, text, final); err != nil {
				return "", err
			}
		case "session.finished":
			if upload == nil || !upload.finishing.Load() {
				return "", tcylocale.Error("speechProtocol04")
			}
			return transcript.finish()
		case "error", "conversation.item.input_audio_transcription.failed":
			return "", tcylocale.Error("speechProtocol05")
		}
	}
}

func qwenSpeechSession(c Connection, rate int) map[string]any {
	session := map[string]any{
		"input_audio_format": "pcm",
		"sample_rate":        rate,
		"turn_detection":     nil,
	}
	if c.Speech != nil && c.Speech.Language != "" && c.Speech.Language != "auto" {
		session["input_audio_transcription"] = map[string]string{"language": c.Speech.Language}
	}
	return session
}

func speechHeaders(c Connection) http.Header {
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+c.APIKey)
	if c.Speech != nil && c.Speech.WorkspaceID != "" {
		headers.Set("X-DashScope-WorkSpace", c.Speech.WorkspaceID)
	}
	return headers
}

func dashSpeechCommand(taskID, action string, payload map[string]any) map[string]any {
	return map[string]any{
		"header": map[string]string{
			"action":    action,
			"task_id":   taskID,
			"streaming": "duplex",
		},
		"payload": payload,
	}
}

type dashSpeechEvent struct {
	Header struct {
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
			} `json:"sentence"`
		} `json:"output"`
	} `json:"payload"`
}

type qwenSpeechEvent struct {
	Type       string `json:"type"`
	ItemID     string `json:"item_id"`
	Text       string `json:"text"`
	Stash      string `json:"stash"`
	Transcript string `json:"transcript"`
}

func readSpeechEvent(ctx context.Context, socket *websocket.Conn, event any) error {
	kind, body, err := socket.Read(ctx)
	if err != nil {
		return speechStreamError(ctx)
	}
	if kind != websocket.MessageText || json.Unmarshal(body, event) != nil {
		return tcylocale.Error("speechProtocol10")
	}
	return nil
}

func speechStreamError(ctx context.Context) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	return tcylocale.Error("speechProtocol11")
}

type speechAudioUpload struct {
	cancel    context.CancelFunc
	socket    *websocket.Conn
	done      chan struct{}
	finishing atomic.Bool
}

func startSpeechAudioUpload(ctx context.Context, socket *websocket.Conn, write func(context.Context, *atomic.Bool) error) *speechAudioUpload {
	writeCtx, cancel := context.WithCancel(ctx)
	upload := &speechAudioUpload{
		cancel: cancel,
		socket: socket,
		done:   make(chan struct{}),
	}
	go func() {
		defer close(upload.done)
		if err := write(writeCtx, &upload.finishing); err != nil {
			_ = socket.CloseNow()
		}
	}()
	return upload
}

func (u *speechAudioUpload) close() {
	u.cancel()
	_ = u.socket.CloseNow()
	<-u.done
}

func writeSpeechPCM(ctx context.Context, socket *websocket.Conn, pcm []byte, base64Frames bool) error {
	// Bounded frames and one writer provide backpressure without buffering another audio copy.
	const chunkSize = 3200
	for offset := 0; offset < len(pcm); offset += chunkSize {
		frame := pcm[offset:min(offset+chunkSize, len(pcm))]
		var err error
		if base64Frames {
			err = wsjson.Write(ctx, socket, map[string]string{
				"event_id": uuid.NewString(),
				"type":     "input_audio_buffer.append",
				"audio":    base64.StdEncoding.EncodeToString(frame),
			})
		} else {
			err = socket.Write(ctx, websocket.MessageBinary, frame)
		}
		if err != nil {
			return err
		}
	}
	return nil
}

func writeQwenSpeechAction(ctx context.Context, socket *websocket.Conn, action string) error {
	return wsjson.Write(ctx, socket, map[string]string{
		"event_id": uuid.NewString(),
		"type":     action,
	})
}

type speechSentence struct {
	text  string
	final bool
}

type speechTranscript struct {
	sentences    map[string]speechSentence
	order        []string
	numericOrder bool
	onDelta      func(SpeechDelta)
	totalBytes   int
}

func newSpeechTranscript(numericOrder bool, onDelta func(SpeechDelta)) *speechTranscript {
	return &speechTranscript{
		sentences:    make(map[string]speechSentence),
		numericOrder: numericOrder,
		onDelta:      onDelta,
	}
}

func (t *speechTranscript) update(id, text string, final bool) error {
	previous, exists := t.sentences[id]
	if previous.final || (exists && previous.text == text && previous.final == final) {
		return nil
	}
	nextBytes := t.totalBytes - len(previous.text) + len(text)
	if nextBytes > speechResponseLimit || (!exists && len(t.sentences) >= 4096) || len(id) > 256 {
		return tcylocale.Error("speechTranscriptSize")
	}
	t.totalBytes = nextBytes
	if !exists {
		t.order = append(t.order, id)
		if t.numericOrder {
			sort.Slice(t.order, func(i, j int) bool {
				a, _ := strconv.Atoi(t.order[i])
				b, _ := strconv.Atoi(t.order[j])
				return a < b
			})
		}
	}
	t.sentences[id] = speechSentence{
		text:  text,
		final: final,
	}
	if t.onDelta != nil {
		t.onDelta(SpeechDelta{Text: t.text()})
	}
	return nil
}

func (t *speechTranscript) text() string {
	var text strings.Builder
	for _, id := range t.order {
		text.WriteString(t.sentences[id].text)
	}
	return text.String()
}

func (t *speechTranscript) finish() (string, error) {
	for _, sentence := range t.sentences {
		if !sentence.final {
			return "", tcylocale.Error("speechProtocol12")
		}
	}
	text := t.text()
	if strings.TrimSpace(text) == "" {
		return "", tcylocale.Error("speechProtocol13")
	}
	if t.onDelta != nil {
		t.onDelta(SpeechDelta{
			Text:  text,
			Final: true,
		})
	}
	return text, nil
}
