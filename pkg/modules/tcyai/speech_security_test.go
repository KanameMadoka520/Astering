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
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func speechTestOpenAICommit(ctx context.Context, t *testing.T, socket *websocket.Conn) {
	t.Helper()
	var event map[string]any
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
	for event["type"] != "input_audio_buffer.commit" {
		require.NoError(t, wsjson.Read(ctx, socket, &event))
	}
}

func TestTCYAISpeechSecurityPrecommitTextKeepsOriginalTiming(t *testing.T) {
	for _, recognize := range []bool{false, true} {
		t.Run(fmt.Sprint("recognize=", recognize), func(t *testing.T) {
			committedAt := make(chan time.Time, 1)
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				speechTestOpenAICommit(ctx, t, socket)
				for _, event := range []map[string]string{
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "foreign",
						"delta":   "private unrelated words",
					},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "ours",
						"delta":   "Hello",
					},
					{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": "ours",
						"delta":   " world",
					},
				} {
					require.NoError(t, wsjson.Write(ctx, socket, event))
				}
				// The pong proves the reader consumed the earlier events. Delay only the
				// commit acknowledgment to exercise recognition latency independently.
				readerDone := make(chan struct{})
				go func() {
					_, _, _ = socket.Read(ctx)
					close(readerDone)
				}()
				require.NoError(t, socket.Ping(ctx))
				timer := time.NewTimer(30 * time.Millisecond)
				defer timer.Stop()
				select {
				case <-timer.C:
				case <-ctx.Done():
					return
				}
				committedAt <- time.Now()
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
					"type":    "input_audio_buffer.committed",
					"item_id": "ours",
				}))
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
					"type":       "conversation.item.input_audio_transcription.completed",
					"item_id":    "ours",
					"transcript": "Hello world!",
				}))
				<-readerDone
			})
			c := Connection{
				Protocol: "openai-realtime",
				BaseURL:  endpoint,
				Model:    "gpt-live-transcribe",
			}
			audio := speechTestWAV([]byte{0, 0}, 24000)
			if recognize {
				result, err := RecognizeSpeech(ctx, c, "voice.wav", audio)
				require.NoError(t, err)
				require.Equal(t, "Hello world!", result.Text)
				require.Positive(t, result.FirstTextMS)
				require.GreaterOrEqual(t, result.ElapsedMS-result.FirstTextMS, int64(20), "first text must use the precommit receipt time, not the later callback time")
			} else {
				var deltas []SpeechDelta
				text, err := transcribeOpenAIRealtime(ctx, c, "voice.wav", audio, func(delta SpeechDelta) { deltas = append(deltas, delta) })
				require.NoError(t, err)
				require.Equal(t, "Hello world!", text)
				require.Len(t, deltas, 2)
				require.Equal(t, "Hello world", deltas[0].Text)
				require.False(t, deltas[0].Final)
				require.False(t, deltas[0].ReceivedAt.IsZero())
				require.True(t, deltas[0].ReceivedAt.Before(<-committedAt))
				require.True(t, deltas[1].Final)
			}
		})
	}
}

func TestTCYAISpeechSecurityErrorsNeverEchoProviderBody(t *testing.T) {
	const private = "private-recognition-sentinel"
	for _, kind := range []string{"handshake", "http-status", "invalid-json", "sse-error", "legacy-status", "legacy-stream"} {
		t.Run(kind, func(t *testing.T) {
			ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				switch kind {
				case "handshake", "http-status", "legacy-status":
					w.Header().Set("Content-Type", "application/json")
					w.WriteHeader(http.StatusForbidden)
					_, _ = fmt.Fprintf(w, `{"error":{"message":%q}}`, private)
				case "invalid-json":
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, private)
				case "sse-error", "legacy-stream":
					w.Header().Set("Content-Type", "text/event-stream")
					_, _ = fmt.Fprintf(w, "data: {\"error\":{\"message\":%q}}\n\n", private)
				}
			})
			c := Connection{
				BaseURL:  endpoint,
				Protocol: "mimo-asr",
				Model:    "fixture",
				APIKey:   "fixture-key",
			}
			var err error
			switch kind {
			case "handshake":
				c.Protocol = "openai-realtime"
				_, err = transcribeOpenAIRealtime(ctx, c, "voice.wav", speechTestWAV([]byte{0, 0}, 24000), nil)
			case "legacy-status", "legacy-stream":
				c.Protocol = "openai-transcription"
				_, err = RecognizeSpeech(ctx, c, "voice.wav", speechTestWAV([]byte{0, 0}, 16000))
			default:
				_, err = transcribeSpeechHTTP(ctx, c, "voice.wav", speechTestWAV([]byte{0, 0}, 16000))
			}
			require.Error(t, err)
			require.NotContains(t, err.Error(), private)
			require.NotContains(t, err.Error(), "fixture-key")
		})
	}
}

func TestTCYAISpeechSecurityHTTPResponseBounds(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint(stream), func(t *testing.T) {
			ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				if stream {
					w.Header().Set("Content-Type", "text/event-stream")
					// Each SSE event is small; only their aggregate exceeds the bound.
					frame := "data: {\"choices\":[{\"delta\":{\"content\":\"" + strings.Repeat("a", 16384) + "\"}}]}\n\n"
					for range 140 {
						if _, err := io.WriteString(w, frame); err != nil {
							return
						}
					}
					_, _ = io.WriteString(w, "data: [DONE]\n\n")
					return
				}
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"`+strings.Repeat("a", speechResponseLimit+1)+`"}}]}`)
			})
			_, err := transcribeSpeechHTTP(ctx, Connection{
				BaseURL:      endpoint,
				Protocol:     "mimo-asr",
				Model:        "mimo-v2.5-asr",
				NonStreaming: !stream,
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000))
			require.Error(t, err)
			require.NoError(t, ctx.Err(), "oversized recognition must not wait for the request deadline")
		})
	}
}

func TestTCYAISpeechSecurityOpenAIPendingBounds(t *testing.T) {
	for _, scenario := range []string{"items", "bytes"} {
		t.Run(scenario, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				speechTestOpenAICommit(ctx, t, socket)
				count := 5
				text := "small"
				if scenario == "bytes" {
					count = 3
					text = strings.Repeat("a", speechResponseLimit/2)
				}
				for i := range count {
					id := "one-item"
					if scenario == "items" {
						id = fmt.Sprint(i)
					}
					err := wsjson.Write(ctx, socket, map[string]string{
						"type":    "conversation.item.input_audio_transcription.delta",
						"item_id": id,
						"delta":   text,
					})
					if err != nil {
						return
					}
				}
				_, _, _ = socket.Read(ctx)
			})
			_, err := transcribeOpenAIRealtime(ctx, Connection{
				BaseURL:  endpoint,
				Protocol: "openai-realtime",
				Model:    "gpt-live-transcribe",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 24000), nil)
			require.Error(t, err)
			require.NoError(t, ctx.Err())
		})
	}
}

func TestTCYAISpeechSecurityTranscriptBoundsPreserveState(t *testing.T) {
	transcript := newSpeechTranscript(false, nil)
	require.NoError(t, transcript.update("first", strings.Repeat("a", speechResponseLimit), false))
	require.Error(t, transcript.update("second", "b", true))
	require.Len(t, transcript.sentences, 1, "rejected input must not partially mutate the transcript")
	require.NoError(t, transcript.update("first", "short", true), "replacing a long partial must release its byte allowance")
	require.NoError(t, transcript.update("second", " accepted", true))
	text, err := transcript.finish()
	require.NoError(t, err)
	require.Equal(t, "short accepted", text)
	transcript = newSpeechTranscript(false, nil)
	for i := range 4096 {
		require.NoError(t, transcript.update(fmt.Sprint(i), "a", true))
	}
	require.Error(t, transcript.update("overflow", "a", true))
	require.Len(t, transcript.sentences, 4096)
	require.NoError(t, transcript.update("0", "a", true), "duplicate final does not consume another segment")
	require.Error(t, newSpeechTranscript(false, nil).update(strings.Repeat("a", 257), "text", true))
}

func TestTCYAISpeechSecurityQwenSegmentLimitClosesSocket(t *testing.T) {
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		var command map[string]any
		require.NoError(t, wsjson.Read(ctx, socket, &command))
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
		for command["type"] != "session.finish" {
			require.NoError(t, wsjson.Read(ctx, socket, &command))
		}
		for i := range 4097 {
			if err := wsjson.Write(ctx, socket, map[string]string{
				"type":       "conversation.item.input_audio_transcription.completed",
				"item_id":    fmt.Sprint(i),
				"transcript": "a",
			}); err != nil {
				return
			}
		}
		_, _, _ = socket.Read(ctx)
	})
	text, err := transcribeQwenRealtime(ctx, Connection{
		BaseURL:  endpoint,
		Protocol: "qwen-asr-realtime",
		Model:    "qwen3-asr-flash-realtime",
	}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
	require.Error(t, err)
	require.Empty(t, text)
	require.NoError(t, ctx.Err(), "segment overflow should end recognition immediately")
}
