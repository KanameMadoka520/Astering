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
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/coder/websocket/wsjson"
)

// https://developers.openai.com/api/docs/guides/realtime-transcription
func transcribeOpenAIRealtime(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	if rate != 24000 {
		return "", tcylocale.Error("speechSampleRate", 24000)
	}
	conn, release, err := dialSpeechSocket(ctx, Endpoint(c), http.Header{
		"Authorization": []string{"Bearer " + c.APIKey},
	})
	if err != nil {
		return "", err
	}
	defer release()
	if err = wsjson.Write(ctx, conn, map[string]any{
		"type": "session.update",
		"session": map[string]any{
			"type": "transcription",
			"audio": map[string]any{
				"input": map[string]any{
					"format": map[string]any{
						"type": "audio/pcm",
						"rate": rate,
					},
					"transcription":  openAISpeechTranscription(c),
					"turn_detection": nil,
				},
			},
		},
	}); err != nil {
		return "", tcylocale.Error("speechStream")
	}
	transcript := openAISpeechTranscript{
		pending: make(map[string]openAIPendingSpeech),
		onDelta: onDelta,
	}
	var upload *speechAudioUpload
	defer func() {
		if upload != nil {
			upload.close()
		}
	}()
	for {
		_, data, readErr := conn.Read(ctx)
		if readErr != nil {
			return "", speechStreamError(ctx)
		}
		var event openAISpeechEvent
		if json.Unmarshal(data, &event) != nil {
			return "", tcylocale.Error("speechStream")
		}
		switch event.Type {
		case "session.updated":
			if upload != nil {
				continue
			}
			upload = startSpeechAudioUpload(ctx, conn, func(writeCtx context.Context, finishing *atomic.Bool) error {
				if writeErr := writeSpeechPCM(writeCtx, conn, pcm, true); writeErr != nil {
					return writeErr
				}
				finishing.Store(true)
				return wsjson.Write(writeCtx, conn, map[string]any{"type": "input_audio_buffer.commit"})
			})
		case "input_audio_buffer.committed":
			if upload == nil || !upload.finishing.Load() {
				return "", tcylocale.Error("speechStream")
			}
			if err = transcript.commit(event.ItemID); err != nil {
				return "", err
			}
		case "conversation.item.input_audio_transcription.delta":
			if err = transcript.appendDelta(event, upload != nil); err != nil {
				return "", err
			}
		case "conversation.item.input_audio_transcription.completed":
			if transcript.committedID == "" || event.ItemID != transcript.committedID {
				continue
			}
			return transcript.complete(event.Transcript)
		case "error", "conversation.item.input_audio_transcription.failed":
			return "", tcylocale.Error("speechProviderRejected")
		}
	}
}

func openAISpeechTranscription(c Connection) map[string]any {
	transcription := map[string]any{"model": c.Model}
	if c.Speech != nil {
		s := c.Speech
		if s.Prompt != "" {
			transcription["prompt"] = s.Prompt
		}
		if c.Model == "gpt-live-transcribe" {
			if s.Language != "" && s.Language != "auto" {
				transcription["languages"] = []string{s.Language}
			}
			if len(s.Hotwords) > 0 {
				transcription["keywords"] = s.Hotwords
			}
		} else if s.Language != "" && s.Language != "auto" {
			transcription["language"] = s.Language
		}
	}
	return transcription
}

type openAISpeechEvent struct {
	Type       string `json:"type"`
	ItemID     string `json:"item_id"`
	Delta      string `json:"delta"`
	Transcript string `json:"transcript"`
}

type openAIPendingSpeech struct {
	text       string
	receivedAt time.Time
}

type openAISpeechTranscript struct {
	text         string
	committedID  string
	pending      map[string]openAIPendingSpeech
	pendingBytes int
	onDelta      func(SpeechDelta)
}

func (s *openAISpeechTranscript) commit(id string) error {
	if id == "" || (s.committedID != "" && s.committedID != id) {
		return tcylocale.Error("speechStream")
	}
	s.committedID = id
	if item, ok := s.pending[id]; ok {
		s.text = item.text
		if s.onDelta != nil {
			s.onDelta(SpeechDelta{
				Text:       s.text,
				ReceivedAt: item.receivedAt,
			})
		}
	}
	clear(s.pending)
	s.pendingBytes = 0
	return nil
}

func (s *openAISpeechTranscript) appendDelta(event openAISpeechEvent, started bool) error {
	if s.committedID == "" {
		if !started || event.ItemID == "" {
			return tcylocale.Error("speechStream")
		}
		item, exists := s.pending[event.ItemID]
		if (!exists && len(s.pending) >= 4) || s.pendingBytes+len(event.Delta) > speechResponseLimit {
			return tcylocale.Error("speechTranscriptSize")
		}
		if item.receivedAt.IsZero() && strings.TrimSpace(event.Delta) != "" {
			item.receivedAt = time.Now()
		}
		item.text += event.Delta
		s.pending[event.ItemID] = item
		s.pendingBytes += len(event.Delta)
		return nil
	}
	if event.ItemID != s.committedID {
		return nil
	}
	if len(s.text)+len(event.Delta) > speechResponseLimit {
		return tcylocale.Error("speechTranscriptSize")
	}
	s.text += event.Delta
	if s.onDelta != nil {
		s.onDelta(SpeechDelta{Text: s.text})
	}
	return nil
}

func (s *openAISpeechTranscript) complete(text string) (string, error) {
	if strings.TrimSpace(text) == "" {
		return "", tcylocale.Error("e34")
	}
	if len(text) > speechResponseLimit {
		return "", tcylocale.Error("speechTranscriptSize")
	}
	if s.onDelta != nil {
		s.onDelta(SpeechDelta{
			Text:  text,
			Final: true,
		})
	}
	return text, nil
}
