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
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

// https://developers.openai.com/api/docs/guides/realtime-transcription
func TestTCYAIOpenAISpeechRealtimeContract(t *testing.T) {
	for _, model := range []string{"gpt-live-transcribe", "gpt-transcribe"} {
		t.Run(model, func(t *testing.T) {
			pcm := bytes.Repeat([]byte{1, 2}, 4900)
			disconnected := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
				require.Equal(t, "/realtime", r.URL.Path)
				require.Equal(t, "transcription", r.URL.Query().Get("intent"))
				require.Equal(t, "Bearer fixture-key", r.Header.Get("Authorization"))
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.created"}))
				var command map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &command))
				require.Equal(t, "session.update", command["type"])
				session := command["session"].(map[string]any)
				require.Equal(t, "transcription", session["type"])
				require.NotContains(t, session, "input_audio_format", "old beta session shape must not leak into the native API")
				input := session["audio"].(map[string]any)["input"].(map[string]any)
				require.Equal(t, map[string]any{
					"type": "audio/pcm",
					"rate": float64(24000),
				}, input["format"])
				require.Contains(t, input, "turn_detection")
				require.Nil(t, input["turn_detection"])
				transcription := input["transcription"].(map[string]any)
				require.Equal(t, model, transcription["model"])
				require.Equal(t, "Project discussion", transcription["prompt"])
				if model == "gpt-live-transcribe" {
					require.Equal(t, []any{"en"}, transcription["languages"])
					require.Equal(t, []any{"vikunja-x"}, transcription["keywords"])
					require.NotContains(t, transcription, "language")
				} else {
					require.Equal(t, "en", transcription["language"])
					require.NotContains(t, transcription, "languages")
					require.NotContains(t, transcription, "keywords")
				}
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
				var received []byte
				for {
					var event map[string]string
					require.NoError(t, wsjson.Read(ctx, socket, &event))
					if event["type"] == "input_audio_buffer.commit" {
						break
					}
					require.Equal(t, "input_audio_buffer.append", event["type"])
					frame, err := base64.StdEncoding.DecodeString(event["audio"])
					require.NoError(t, err)
					require.LessOrEqual(t, len(frame), 4800)
					received = append(received, frame...)
				}
				require.Equal(t, pcm, received, "PCM24k upload must not contain RIFF header or duplicate audio")
				for _, event := range []map[string]string{
					{"type": "session.updated"},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "unrelated-before-commit",
						"delta":   "must not appear",
					},
					{
						"type":    "input_audio_buffer.committed",
						"item_id": "our-item",
					},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "another-item",
						"delta":   "also unrelated",
					},
					{
						"type":       "conversation.item.input_audio_transcription.completed",
						"item_id":    "another-item",
						"transcript": "wrong final",
					},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "our-item",
						"delta":   "Hello",
					},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "our-item",
						"delta":   " world",
					},
					{
						"type":       "conversation.item.input_audio_transcription.completed",
						"item_id":    "our-item",
						"transcript": "Hello world!",
					},
				} {
					require.NoError(t, wsjson.Write(ctx, socket, event))
				}
				_, _, err := socket.Read(ctx)
				require.Error(t, err, "repeated session.updated must not upload a second recording")
				close(disconnected)
			})
			var deltas []SpeechDelta
			text, err := transcribeOpenAIRealtime(ctx, Connection{
				Protocol: "openai-realtime",
				BaseURL:  endpoint,
				Model:    model,
				APIKey:   "fixture-key",
				Speech: &SpeechOptions{
					Language: "en",
					Prompt:   "Project discussion",
					Hotwords: []string{"vikunja-x"},
				},
			}, "voice.wav", speechTestWAV(pcm, 24000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
			require.NoError(t, err)
			require.Equal(t, "Hello world!", text)
			require.Equal(t, []SpeechDelta{
				{Text: "Hello"},
				{Text: "Hello world"},
				{
					Text:  "Hello world!",
					Final: true,
				},
			}, deltas)
			require.NoError(t, ctx.Err(), "the matched completed event must finish without waiting for socket EOF")
			select {
			case <-disconnected:
			case <-ctx.Done():
				t.Fatal("finished OpenAI speech socket was not closed")
			}
		})
	}
}

func TestTCYAIOpenAISpeechRejectsWrongSampleRate(t *testing.T) {
	_, err := transcribeOpenAIRealtime(context.Background(), Connection{BaseURL: "https://must-not-dial.invalid"}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
	require.Error(t, err)
	require.NotContains(t, err.Error(), "must-not-dial")
}

func TestTCYAIOpenAISpeechErrorsAndCancellation(t *testing.T) {
	for _, scenario := range []string{"provider-error", "item-failed", "disconnect", "cancel"} {
		t.Run(scenario, func(t *testing.T) {
			ready := make(chan struct{})
			disconnected := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				defer close(disconnected)
				var event map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &event))
				close(ready)
				if scenario == "cancel" {
					_, _, _ = socket.Read(ctx)
					return
				}
				if scenario == "disconnect" {
					return
				}
				kind := "error"
				if scenario == "item-failed" {
					kind = "conversation.item.input_audio_transcription.failed"
				}
				require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
					"type":  kind,
					"error": map[string]string{"message": "fixture-secret private transcript"},
				}))
			})
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			if scenario == "cancel" {
				go func() {
					select {
					case <-ready:
						cancel()
					case <-ctx.Done():
					}
				}()
			}
			text, err := transcribeOpenAIRealtime(ctx, Connection{
				Protocol: "openai-realtime",
				BaseURL:  endpoint,
				Model:    "gpt-live-transcribe",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 24000), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-secret")
			if scenario == "cancel" {
				require.ErrorIs(t, err, context.Canceled)
			}
			select {
			case <-disconnected:
			case <-time.After(2 * time.Second):
				t.Fatal("failed or canceled socket leaked")
			}
		})
	}
}
