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
	"errors"
	"net/http"
	"strconv"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func liveSpeechTestConnection(endpoint, protocol string) Connection {
	model := "qwen-audio-3.1-asr-flash-streaming"
	if protocol == "qwen-asr-realtime" {
		model = "qwen3-asr-flash-realtime"
	}
	return Connection{
		Kind:     "transcription",
		Protocol: protocol,
		BaseURL:  endpoint,
		Model:    model,
		APIKey:   "fixture-live-key",
	}
}

func liveSpeechTestReceive[T any](ctx context.Context, t *testing.T, channel <-chan T) T {
	t.Helper()
	select {
	case value := <-channel:
		return value
	case <-ctx.Done():
		t.Fatal("live fixture did not complete before the test deadline")
		var zero T
		return zero
	}
}

func liveSpeechTestErrorKey(t *testing.T, err error, key string) {
	t.Helper()
	var localized *tcylocale.LocalizedError
	require.ErrorAs(t, err, &localized)
	require.Equal(t, "tcymc.errors."+key, localized.Key)
}

func TestTCYAILiveSpeechDashStreamsBeforeRecordingStops(t *testing.T) {
	pcm := bytes.Repeat([]byte{0x00, 0x01}, 1600)
	disconnected := make(chan struct{})
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, request *http.Request) {
		require.Equal(t, "Bearer fixture-live-key", request.Header.Get("Authorization"))
		id := speechTestDashStart(ctx, t, socket)
		speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
		speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
		kind, frame, err := socket.Read(ctx)
		require.NoError(t, err)
		require.Equal(t, websocket.MessageBinary, kind)
		require.Equal(t, pcm, frame)
		speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
			"sentence_id":  1,
			"begin_time":   0,
			"end_time":     nil,
			"text":         "Hel",
			"sentence_end": false,
		})
		require.Empty(t, speechTestDrainDash(ctx, t, socket, id))
		final := map[string]any{
			"sentence_id":  1,
			"begin_time":   0,
			"end_time":     90,
			"text":         "Hello",
			"sentence_end": true,
		}
		speechTestDashEvent(ctx, t, socket, id, "result-generated", final)
		speechTestDashEvent(ctx, t, socket, id, "result-generated", final)
		speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
			"sentence_id":  1,
			"text":         "stale interim",
			"sentence_end": false,
		})
		speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
		_, _, _ = socket.Read(ctx)
		close(disconnected)
	})
	audio := make(chan []byte)
	ready := make(chan struct{}, 1)
	events := make(chan LiveSpeechDelta, 4)
	done := make(chan error, 1)
	var readyCount atomic.Int32
	go func() {
		done <- RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, "dashscope-asr"), 16000, audio, func() error {
			readyCount.Add(1)
			ready <- struct{}{}
			return nil
		}, func(delta LiveSpeechDelta) error {
			events <- delta
			return nil
		})
	}()
	liveSpeechTestReceive(ctx, t, ready)
	audio <- pcm
	partial := liveSpeechTestReceive(ctx, t, events)
	require.Equal(t, "Hel", partial.Text)
	require.False(t, partial.Final)
	require.True(t, partial.TimingEstimated)
	select {
	case err := <-done:
		t.Fatalf("recognizer ended while the recording was still open: %v", err)
	default:
	}
	close(audio)
	final := liveSpeechTestReceive(ctx, t, events)
	require.NoError(t, liveSpeechTestReceive(ctx, t, done))
	require.Equal(t, int32(1), readyCount.Load())
	require.Equal(t, partial.ID, final.ID)
	_, err := uuid.Parse(final.ID)
	require.NoError(t, err)
	require.True(t, final.Final)
	require.Equal(t, "Hello", final.Text)
	require.EqualValues(t, 0, final.StartMS)
	require.EqualValues(t, 90, final.EndMS)
	require.False(t, final.TimingEstimated)
	require.Empty(t, events, "duplicate final and stale interim must not be emitted again")
	liveSpeechTestReceive(ctx, t, disconnected)
}

func TestTCYAILiveSpeechQwenVADKeepsUtterancesAndFlushesTail(t *testing.T) {
	pcm := bytes.Repeat([]byte{0x01, 0x00}, 1600)
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		var command struct {
			Type    string         `json:"type"`
			Session map[string]any `json:"session"`
		}
		require.NoError(t, wsjson.Read(ctx, socket, &command))
		require.Equal(t, "session.update", command.Type)
		require.Equal(t, "pcm", command.Session["input_audio_format"])
		require.EqualValues(t, 16000, command.Session["sample_rate"])
		require.Equal(t, map[string]any{
			"type":                "server_vad",
			"threshold":           float64(0),
			"silence_duration_ms": float64(400),
		}, command.Session["turn_detection"])
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
		for index, id := range []string{"first", "second"} {
			var frame struct {
				Type  string `json:"type"`
				Audio string `json:"audio"`
			}
			require.NoError(t, wsjson.Read(ctx, socket, &frame))
			require.Equal(t, "input_audio_buffer.append", frame.Type)
			decoded, err := base64.StdEncoding.DecodeString(frame.Audio)
			require.NoError(t, err)
			require.Equal(t, pcm, decoded)
			require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
				"type":           "input_audio_buffer.speech_started",
				"item_id":        id,
				"audio_start_ms": index * 100,
			}))
			if index == 0 {
				require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
					"type":         "input_audio_buffer.speech_stopped",
					"item_id":      id,
					"audio_end_ms": 100,
				}))
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
					"type":       "conversation.item.input_audio_transcription.completed",
					"item_id":    id,
					"transcript": "First sentence.",
				}))
			} else {
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
					"type":    "conversation.item.input_audio_transcription.text",
					"item_id": id,
					"text":    "Last ",
					"stash":   "sent",
				}))
			}
		}
		var finish map[string]any
		require.NoError(t, wsjson.Read(ctx, socket, &finish))
		require.Equal(t, "session.finish", finish["type"], "VAD must never send a manual commit")
		require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
			"type":         "input_audio_buffer.speech_stopped",
			"item_id":      "second",
			"audio_end_ms": 200,
		}))
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
			"type":       "conversation.item.input_audio_transcription.completed",
			"item_id":    "second",
			"transcript": "Last sentence.",
		}))
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.finished"}))
		_, _, _ = socket.Read(ctx)
	})
	audio := make(chan []byte)
	ready := make(chan struct{}, 1)
	events := make(chan LiveSpeechDelta, 3)
	done := make(chan error, 1)
	go func() {
		done <- RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, "qwen-asr-realtime"), 16000, audio, func() error {
			ready <- struct{}{}
			return nil
		}, func(delta LiveSpeechDelta) error {
			events <- delta
			return nil
		})
	}()
	liveSpeechTestReceive(ctx, t, ready)
	audio <- pcm
	first := liveSpeechTestReceive(ctx, t, events)
	require.True(t, first.Final, "the first utterance must finalize while capture continues")
	require.Equal(t, "First sentence.", first.Text)
	audio <- pcm
	partial := liveSpeechTestReceive(ctx, t, events)
	require.Equal(t, "Last sent", partial.Text)
	require.False(t, partial.Final)
	close(audio)
	last := liveSpeechTestReceive(ctx, t, events)
	require.NoError(t, liveSpeechTestReceive(ctx, t, done))
	require.NotEqual(t, first.ID, last.ID)
	require.Equal(t, partial.ID, last.ID)
	require.True(t, last.Final)
	require.Equal(t, "Last sentence.", last.Text)
	require.EqualValues(t, 100, last.StartMS)
	require.EqualValues(t, 200, last.EndMS)
	require.False(t, last.TimingEstimated)
}

func TestTCYAILiveSpeechStopWithoutAudioFinishesCleanly(t *testing.T) {
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		t.Run(protocol, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				if protocol == "dashscope-asr" {
					id := speechTestDashStart(ctx, t, socket)
					speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
					require.Empty(t, speechTestDrainDash(ctx, t, socket, id))
					speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
				} else {
					var event map[string]any
					require.NoError(t, wsjson.Read(ctx, socket, &event))
					require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
					require.NoError(t, wsjson.Read(ctx, socket, &event))
					require.Equal(t, "session.finish", event["type"])
					require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.finished"}))
				}
				_, _, _ = socket.Read(ctx)
			})
			audio := make(chan []byte)
			close(audio)
			var ready int
			err := RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, protocol), 16000, audio, func() error {
				ready++
				return nil
			}, func(_ LiveSpeechDelta) error {
				t.Error("silent recording emitted a fabricated utterance")
				return nil
			})
			require.NoError(t, err)
			require.Equal(t, 1, ready)
		})
	}
}

func TestTCYAILiveSpeechCancellationAndCallbackFailureCloseTheSocket(t *testing.T) {
	for _, phase := range []string{"cancel", "ready", "delta"} {
		t.Run(phase, func(t *testing.T) {
			disconnected := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := speechTestDashStart(ctx, t, socket)
				speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
				if phase == "delta" {
					_, _, err := socket.Read(ctx)
					require.NoError(t, err)
					speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
						"sentence_id":  1,
						"text":         "interim",
						"sentence_end": false,
					})
				}
				_, _, err := socket.Read(ctx)
				require.Error(t, err)
				close(disconnected)
			})
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			callbackFailure := errors.New("durable transcript write failed")
			audio := make(chan []byte, 1)
			done := make(chan error, 1)
			go func() {
				done <- RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, "dashscope-asr"), 16000, audio, func() error {
					if phase == "ready" {
						return callbackFailure
					}
					if phase == "cancel" {
						cancel()
					} else {
						audio <- []byte{0, 0}
					}
					return nil
				}, func(_ LiveSpeechDelta) error { return callbackFailure })
			}()
			// The outer fixture context remains live when the recognizer's own context is canceled.
			waitCtx, waitCancel := context.WithTimeout(context.Background(), 5*time.Second)
			defer waitCancel()
			err := liveSpeechTestReceive(waitCtx, t, done)
			if phase == "cancel" {
				require.ErrorIs(t, err, context.Canceled)
			} else {
				require.ErrorIs(t, err, callbackFailure)
			}
			liveSpeechTestReceive(waitCtx, t, disconnected)
		})
	}
}

func TestTCYAILiveSpeechRejectsBadFrames(t *testing.T) {
	for _, size := range []int{0, 1, MaxLiveSpeechFrameBytes + 2} {
		t.Run(strconv.Itoa(size), func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := speechTestDashStart(ctx, t, socket)
				speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
				_, _, err := socket.Read(ctx)
				require.Error(t, err, "invalid PCM must never reach the provider")
			})
			audio := make(chan []byte, 1)
			audio <- make([]byte, size)
			err := RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, "dashscope-asr"), 16000, audio, nil, nil)
			liveSpeechTestErrorKey(t, err, "speechLiveFrame")
		})
	}
}

func TestTCYAILiveSpeechRefusesEarlyCompletionAndUnfinalizedText(t *testing.T) {
	for _, scenario := range []string{"before-start", "before-stop", "partial-only", "changed-final", "provider-error", "unrelated-task", "malformed-event"} {
		t.Run(scenario, func(t *testing.T) {
			const private = "fixture-secret-and-private-transcript"
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				id := speechTestDashStart(ctx, t, socket)
				switch scenario {
				case "before-start":
					speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
				case "provider-error":
					require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
						"header": map[string]any{
							"event":         "task-failed",
							"task_id":       id,
							"error_message": private,
						},
					}))
				case "unrelated-task":
					speechTestDashEvent(ctx, t, socket, uuid.NewString(), "task-started", nil)
				case "malformed-event":
					require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(private)))
				default:
					speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
					if scenario == "before-stop" {
						speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
					} else {
						require.Empty(t, speechTestDrainDash(ctx, t, socket, id))
						speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
							"sentence_id":  1,
							"text":         "initial text",
							"sentence_end": scenario == "changed-final",
						})
						if scenario == "changed-final" {
							speechTestDashEvent(ctx, t, socket, id, "result-generated", map[string]any{
								"sentence_id":  1,
								"text":         private,
								"sentence_end": true,
							})
						} else {
							speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
						}
					}
				}
				_, _, _ = socket.Read(ctx)
			})
			audio := make(chan []byte)
			if scenario == "partial-only" || scenario == "changed-final" {
				close(audio)
			}
			err := RecognizeLiveSpeech(ctx, liveSpeechTestConnection(endpoint, "dashscope-asr"), 16000, audio, nil, nil)
			require.Error(t, err)
			require.NotContains(t, err.Error(), private)
		})
	}
}

func TestTCYAILiveSpeechBudgetsAndImmutableUtterances(t *testing.T) {
	ctx := context.Background()
	audio := make(chan []byte, 1)
	audio <- []byte{0, 0, 0, 0}
	upload := &liveSpeechUpload{rate: 16000}
	upload.bytes.Store(16000*2*MaxLiveSpeechSeconds - 2)
	err := upload.write(ctx, liveSpeechTestConnection("", "dashscope-asr"), "", audio)
	liveSpeechTestErrorKey(t, err, "speechLiveLimit")
	var events []LiveSpeechDelta
	transcript := newLiveSpeechTranscript(func(delta LiveSpeechDelta) error {
		events = append(events, delta)
		return nil
	})
	require.NoError(t, transcript.update("one", "One", true, nil, nil, 100))
	require.NoError(t, transcript.update("one", "One", true, nil, nil, 100))
	require.NoError(t, transcript.update("one", "old interim", false, nil, nil, 100))
	require.Len(t, events, 1)
	require.Error(t, transcript.update("one", "Changed final", true, nil, nil, 100))
	require.NoError(t, transcript.update("two", "Two", true, nil, nil, 200))
	require.NotEqual(t, events[0].ID, events[1].ID)
	require.EqualValues(t, 100, events[1].StartMS)
	require.EqualValues(t, 200, events[1].EndMS)
	require.True(t, events[1].TimingEstimated)
	require.Error(t, transcript.update("large", strings.Repeat("x", speechResponseLimit+1), true, nil, nil, 200))
	require.Error(t, transcript.update(strings.Repeat("x", 257), "text", true, nil, nil, 200))
	invalid := int64(-1)
	require.Error(t, transcript.setTiming("negative", &invalid, nil))
	for index := len(transcript.items); index < 4096; index++ {
		_, err = transcript.sentence("bounded-" + strconv.Itoa(index))
		require.NoError(t, err)
	}
	_, err = transcript.sentence("over-limit")
	require.Error(t, err)
}

func TestTCYAILiveSpeechResponseCapacityIsBounded(t *testing.T) {
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.created"}))
		_, _, _ = socket.Read(ctx)
	})
	socket, release, err := dialSpeechSocket(ctx, strings.Replace(endpoint, "https://", "wss://", 1), nil)
	require.NoError(t, err)
	defer release()
	total := liveSpeechResponseLimit
	err = readLiveSpeechEvent(ctx, socket, &liveSpeechEvent{}, &total)
	liveSpeechTestErrorKey(t, err, "speechTranscriptSize")
}

func TestTCYAILiveSpeechConfigurationIsExplicit(t *testing.T) {
	for _, protocol := range []string{"openai-transcription", "openai-realtime", "soniox-realtime", "gemini", "anthropic"} {
		connection := liveSpeechTestConnection("https://must-not-be-called.example", protocol)
		require.Error(t, ValidateLiveSpeech(connection, 16000))
		_, err := LiveSpeechSampleRate(connection)
		require.Error(t, err)
	}
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		connection := liveSpeechTestConnection("https://must-not-be-called.example", protocol)
		rate, err := LiveSpeechSampleRate(connection)
		require.NoError(t, err)
		require.Equal(t, 16000, rate)
		require.Error(t, ValidateLiveSpeech(connection, 44100))
		connection.Speech = &SpeechOptions{Disabled: true}
		require.Error(t, ValidateLiveSpeech(connection, 16000))
		connection.Speech = nil
		connection.Kind = "chat"
		require.Error(t, ValidateLiveSpeech(connection, 16000))
	}
}
