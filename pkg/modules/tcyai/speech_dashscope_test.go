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
	"bytes"
	"context"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/i18n"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func speechTestWAV(pcm []byte, rate uint32) []byte {
	// Match the supported upload bound before converting lengths into RIFF uint32 fields.
	size := len(pcm)
	if size > 16*1024*1024 {
		panic("speech test WAV exceeds supported fixture bounds")
	}
	if rate > 192000 {
		panic("speech test sample rate exceeds fixture bounds")
	}
	dataSize := uint32(size)
	audio := make([]byte, 44+size)
	copy(audio, "RIFF")
	binary.LittleEndian.PutUint32(audio[4:], dataSize+36)
	copy(audio[8:], "WAVEfmt ")
	binary.LittleEndian.PutUint32(audio[16:], 16)
	binary.LittleEndian.PutUint16(audio[20:], 1)
	binary.LittleEndian.PutUint16(audio[22:], 1)
	binary.LittleEndian.PutUint32(audio[24:], rate)
	binary.LittleEndian.PutUint32(audio[28:], rate*2)
	binary.LittleEndian.PutUint16(audio[32:], 2)
	binary.LittleEndian.PutUint16(audio[34:], 16)
	copy(audio[36:], "data")
	binary.LittleEndian.PutUint32(audio[40:], dataSize)
	copy(audio[44:], pcm)
	return audio
}

func speechTestSocket(t *testing.T, handler func(context.Context, *websocket.Conn, *http.Request)) (context.Context, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			t.Errorf("accept test socket: %v", err)
			return
		}
		defer func() { _ = socket.CloseNow() }()
		handler(ctx, socket, r)
	}))
	t.Cleanup(func() {
		cancel()
		server.Close()
	})
	client := server.Client()
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return context.WithValue(ctx, providerClientContextKey{}, client), server.URL
}

func speechTestDashStart(ctx context.Context, t *testing.T, socket *websocket.Conn) string {
	t.Helper()
	var command struct {
		Header struct {
			Action    string `json:"action"`
			ID        string `json:"task_id"`
			Streaming string `json:"streaming"`
		} `json:"header"`
		Payload struct {
			Model      string         `json:"model"`
			Parameters map[string]any `json:"parameters"`
		} `json:"payload"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &command))
	require.Equal(t, "run-task", command.Header.Action)
	require.Equal(t, "duplex", command.Header.Streaming)
	require.Equal(t, "pcm", command.Payload.Parameters["format"])
	require.InDelta(t, 16000, command.Payload.Parameters["sample_rate"], 0)
	_, err := uuid.Parse(command.Header.ID)
	require.NoError(t, err)
	return command.Header.ID
}

func speechTestDashEvent(ctx context.Context, t *testing.T, socket *websocket.Conn, id, event string, sentence map[string]any) {
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

func speechTestDrainDash(ctx context.Context, t *testing.T, socket *websocket.Conn, id string) []byte {
	t.Helper()
	var received []byte
	for {
		kind, frame, err := socket.Read(ctx)
		require.NoError(t, err)
		if kind == websocket.MessageBinary {
			received = append(received, frame...)
			continue
		}
		var command map[string]any
		require.NoError(t, json.Unmarshal(frame, &command))
		header := command["header"].(map[string]any)
		require.Equal(t, "finish-task", header["action"])
		require.Equal(t, id, header["task_id"])
		return received
	}
}

func TestTCYAIDashScopeSpeechStreaming(t *testing.T) {
	pcm := bytes.Repeat([]byte{0x00, 0x01}, 3300)
	disconnected := make(chan struct{})
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
		require.Equal(t, "Bearer fixture-key", r.Header.Get("Authorization"))
		require.Equal(t, "fixture-space", r.Header.Get("X-DashScope-WorkSpace"))
		id := speechTestDashStart(ctx, t, socket)
		speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
		require.Equal(t, pcm, speechTestDrainDash(ctx, t, socket, id), "PCM must not contain the WAV header")
		for _, sentence := range []map[string]any{
			{"heartbeat": true},
			{
				"sentence_id":  1,
				"text":         "Hell",
				"sentence_end": false,
			},
			{
				"sentence_id":  1,
				"text":         "Hello ",
				"sentence_end": true,
			},
			{
				"sentence_id":  1,
				"text":         "Hello ",
				"sentence_end": true,
			},
			{
				"sentence_id":  1,
				"text":         "obsolete partial",
				"sentence_end": false,
			},
			{
				"sentence_id":  2,
				"text":         "world",
				"sentence_end": true,
			},
		} {
			speechTestDashEvent(ctx, t, socket, id, "result-generated", sentence)
		}
		speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
		_, _, _ = socket.Read(ctx)
		close(disconnected)
	})
	var deltas []SpeechDelta
	text, err := transcribeDashScope(ctx, Connection{
		Protocol: "dashscope-asr",
		BaseURL:  endpoint,
		Model:    "qwen-audio-3.1-asr-flash-streaming",
		APIKey:   "fixture-key",
		Speech:   &SpeechOptions{WorkspaceID: "fixture-space"},
	}, "voice.wav", speechTestWAV(pcm, 16000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
	require.NoError(t, err)
	require.Equal(t, "Hello world", text)
	require.Equal(t, []SpeechDelta{
		{Text: "Hell"},
		{Text: "Hello "},
		{Text: "Hello world"},
		{
			Text:  "Hello world",
			Final: true,
		},
	}, deltas)
	require.NoError(t, ctx.Err(), "completion must not wait for upstream EOF")
	select {
	case <-disconnected:
	case <-ctx.Done():
		t.Fatal("completed recognition did not close its socket")
	}
}

func TestTCYAIQwenRealtimeSpeechStreaming(t *testing.T) {
	pcm := bytes.Repeat([]byte{0x01, 0x02}, 1700)
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.created"}))
		var config map[string]any
		require.NoError(t, wsjson.Read(ctx, socket, &config))
		require.Equal(t, "session.update", config["type"])
		session := config["session"].(map[string]any)
		require.Contains(t, session, "turn_detection")
		require.Nil(t, session["turn_detection"])
		require.Equal(t, "pcm", session["input_audio_format"])
		require.InDelta(t, 16000, session["sample_rate"], 0)
		require.Equal(t, map[string]any{"language": "en"}, session["input_audio_transcription"])
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
		var received []byte
		committed := false
		for {
			var event map[string]string
			require.NoError(t, wsjson.Read(ctx, socket, &event))
			if event["type"] == "input_audio_buffer.append" {
				require.False(t, committed)
				frame, err := base64.StdEncoding.DecodeString(event["audio"])
				require.NoError(t, err)
				received = append(received, frame...)
				continue
			}
			if event["type"] == "input_audio_buffer.commit" {
				committed = true
				continue
			}
			require.Equal(t, "session.finish", event["type"])
			require.True(t, committed)
			break
		}
		require.Equal(t, pcm, received)
		for _, event := range []map[string]string{
			{
				"type":    "conversation.item.input_audio_transcription.text",
				"item_id": "item-1",
				"text":    "Hello ",
				"stash":   "world?",
			},
			{
				"type":       "conversation.item.input_audio_transcription.completed",
				"item_id":    "item-1",
				"transcript": "Hello world!",
			},
			{
				"type":       "conversation.item.input_audio_transcription.completed",
				"item_id":    "item-1",
				"transcript": "Hello world!",
			},
			{"type": "session.finished"},
		} {
			require.NoError(t, wsjson.Write(ctx, socket, event))
		}
		_, _, _ = socket.Read(ctx)
	})
	var deltas []SpeechDelta
	text, err := transcribeQwenRealtime(ctx, Connection{
		Protocol: "qwen-asr-realtime",
		BaseURL:  endpoint,
		Model:    "qwen3-asr-flash-realtime",
		APIKey:   "fixture-key",
		Speech:   &SpeechOptions{Language: "en"},
	}, "voice.wav", speechTestWAV(pcm, 16000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
	require.NoError(t, err)
	require.Equal(t, "Hello world!", text)
	require.Equal(t, []SpeechDelta{
		{Text: "Hello world?"},
		{Text: "Hello world!"},
		{
			Text:  "Hello world!",
			Final: true,
		},
	}, deltas)
	require.NoError(t, ctx.Err())
}

func TestTCYAIDashScopeSpeechRejectsIncompleteAndUnrelatedEvents(t *testing.T) {
	for _, scenario := range []string{"task-failed", "wrong-task", "early-finish", "disconnect", "partial-only", "invalid-json"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := speechTestDashStart(ctx, t, socket)
				switch scenario {
				case "task-failed":
					require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
						"header": map[string]string{
							"task_id":       id,
							"event":         "task-failed",
							"error_message": "fixture-secret private transcript",
						},
					}))
					return
				case "wrong-task":
					speechTestDashEvent(ctx, t, socket, "different-task", "task-started", nil)
					return
				case "early-finish":
					speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
					return
				case "invalid-json":
					require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte("private invalid payload")))
					return
				}
				speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
				_ = speechTestDrainDash(ctx, t, socket, id)
				speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
					"sentence_id": 1,
					"text":        "incomplete words",
				})
				if scenario == "partial-only" {
					speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
				}
			})
			text, err := transcribeDashScope(ctx, Connection{
				Protocol: "dashscope-asr",
				BaseURL:  endpoint,
				Model:    "qwen-audio-3.1-asr-flash-streaming",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-secret")
			require.NotContains(t, err.Error(), "private")
			require.NoError(t, ctx.Err(), "protocol errors must terminate without waiting for deadline")
		})
	}
}

func TestTCYAISpeechCancellationClosesBothProtocols(t *testing.T) {
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		t.Run(protocol, func(t *testing.T) {
			ready := make(chan struct{})
			disconnected := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				if protocol == "dashscope-asr" {
					id := speechTestDashStart(ctx, t, socket)
					speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
				} else {
					var event map[string]any
					require.NoError(t, wsjson.Read(ctx, socket, &event))
					require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
				}
				close(ready)
				for {
					if _, _, err := socket.Read(ctx); err != nil {
						close(disconnected)
						return
					}
				}
			})
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			go func() {
				select {
				case <-ready:
					cancel()
				case <-ctx.Done():
				}
			}()
			transcribe := transcribeDashScope
			if protocol == "qwen-asr-realtime" {
				transcribe = transcribeQwenRealtime
			}
			_, err := transcribe(ctx, Connection{
				Protocol: protocol,
				BaseURL:  endpoint,
				Model:    "fixture",
			}, "voice.wav", speechTestWAV(bytes.Repeat([]byte{0, 0}, 3200), 16000), nil)
			require.ErrorIs(t, err, context.Canceled)
			select {
			case <-disconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("canceled speech socket leaked")
			}
		})
	}
}

func TestTCYAISpeechRejectsInvalidAudioBeforeDial(t *testing.T) {
	i18n.Init()
	for _, transcribe := range []func(context.Context, Connection, string, []byte, func(SpeechDelta)) (string, error){transcribeDashScope, transcribeQwenRealtime} {
		_, err := transcribe(context.Background(), Connection{BaseURL: "https://must-not-dial.invalid"}, "renamed.wav", []byte("not WAV"), nil)
		require.Error(t, err)
		require.NotContains(t, err.Error(), "must-not-dial")
	}
	_, err := transcribeQwenRealtime(context.Background(), Connection{BaseURL: "https://must-not-dial.invalid"}, "voice.wav", speechTestWAV([]byte{0, 0}, 24000), nil)
	require.ErrorContains(t, err, "8000 or 16000")
}

func TestTCYAISpeechTranscriptOrdersAndDeduplicates(t *testing.T) {
	transcript := newSpeechTranscript(true, nil)
	require.NoError(t, transcript.update("10", "C", true))
	require.NoError(t, transcript.update("2", "B", true))
	require.NoError(t, transcript.update("1", "A", false))
	require.NoError(t, transcript.update("1", "A", true))
	require.NoError(t, transcript.update("2", "stale", false))
	text, err := transcript.finish()
	require.NoError(t, err)
	require.Equal(t, "ABC", text)
	require.NotContains(t, text, "stale")
}

func TestTCYAIQwenRealtimeSpeechRejectsErrorsAndIncomplete(t *testing.T) {
	for _, scenario := range []string{"error", "failed", "disconnect", "partial-only", "early-finish"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				var command map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &command))
				if scenario == "early-finish" {
					require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.finished"}))
					return
				}
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
				for command["type"] != "session.finish" {
					require.NoError(t, wsjson.Read(ctx, socket, &command))
				}
				if scenario == "error" || scenario == "failed" {
					kind := "error"
					if scenario == "failed" {
						kind = "conversation.item.input_audio_transcription.failed"
					}
					require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
						"type":  kind,
						"error": map[string]string{"message": "fixture-secret private transcript"},
					}))
					return
				}
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
					"type":    "conversation.item.input_audio_transcription.text",
					"item_id": "item-1",
					"stash":   "unfinished",
				}))
				if scenario == "partial-only" {
					require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.finished"}))
				}
			})
			text, err := transcribeQwenRealtime(ctx, Connection{
				Protocol: "qwen-asr-realtime",
				BaseURL:  endpoint,
				Model:    "qwen3-asr-flash-realtime",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-secret")
			require.NotContains(t, err.Error(), "private")
			require.NoError(t, ctx.Err())
		})
	}
}

func TestTCYAIDashScopeSpeechOptions(t *testing.T) {
	i18n.Init()
	connection := Connection{
		Model: "qwen-audio-3.1-asr-flash-streaming",
		Speech: &SpeechOptions{
			Language:     "zh",
			Prompt:       "Project names",
			Hotwords:     []string{"vikunja-x"},
			VocabularyID: "vocab-fixture",
		},
	}
	payload, err := dashSpeechPayload(connection, 16000)
	require.NoError(t, err)
	require.Equal(t, map[string]any{
		"format":         "pcm",
		"sample_rate":    16000,
		"language_hints": []string{"zh"},
		"vocabulary_id":  "vocab-fixture",
		"vocabulary":     map[string]int{"vikunja-x": 3},
	}, payload["parameters"])
	require.Equal(t, map[string]any{
		"context": []map[string]any{{
			"role": "user",
			"content": []map[string]string{{
				"type": "input_text",
				"text": "Project names",
			}},
		}},
	}, payload["input"])
	connection.Speech.Language = "auto"
	payload, err = dashSpeechPayload(connection, 16000)
	require.NoError(t, err)
	require.NotContains(t, payload["parameters"], "language_hints")
	connection.Model = "fun-asr-realtime"
	_, err = dashSpeechPayload(connection, 16000)
	require.ErrorContains(t, err, "vocabulary ID")
	connection.Speech.Hotwords = nil
	_, err = dashSpeechPayload(connection, 16000)
	require.NoError(t, err)
	connection.Speech.Prompt = strings.Repeat("a", 401)
	_, err = dashSpeechPayload(connection, 16000)
	require.ErrorContains(t, err, "400")
}
