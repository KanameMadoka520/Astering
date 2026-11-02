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
	"net/http"
	"net/http/httptest"
	"sync/atomic"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/i18n"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func speechProbeFixture(protocol, base string) Connection {
	model := "qwen-audio-3.1-asr-flash-streaming"
	if protocol == "qwen-asr-realtime" {
		model = "qwen3-asr-flash-realtime"
	}
	return Connection{
		ID:       "speech",
		Name:     "Speech fixture",
		Kind:     "transcription",
		Protocol: protocol,
		BaseURL:  base,
		Model:    model,
		APIKey:   "fixture-probe-secret",
		Speech: &SpeechOptions{
			Provider: "aliyun",
			Language: "en",
		},
	}
}

// The shared fake only acknowledges a configured model and an explicit empty
// finish. An audio submission or an early return fails the same wire contract.
func speechProbeStarted(ctx context.Context, t *testing.T, socket *websocket.Conn, protocol string) string {
	t.Helper()
	if protocol == "dashscope-asr" {
		id := speechTestDashStart(ctx, t, socket)
		speechTestDashEvent(ctx, t, socket, id, "task-started", nil)
		require.Empty(t, speechTestDrainDash(ctx, t, socket, id))
		return id
	}
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.created"}))
	var update struct {
		Type    string         `json:"type"`
		Session map[string]any `json:"session"`
	}
	require.NoError(t, wsjson.Read(ctx, socket, &update))
	require.Equal(t, "session.update", update.Type)
	require.Equal(t, "pcm", update.Session["input_audio_format"])
	require.InDelta(t, 16000, update.Session["sample_rate"], 0)
	require.Contains(t, update.Session, "turn_detection")
	require.Nil(t, update.Session["turn_detection"])
	require.Equal(t, map[string]any{"language": "en"}, update.Session["input_audio_transcription"])
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.updated"}))
	var finish map[string]string
	require.NoError(t, wsjson.Read(ctx, socket, &finish))
	require.Equal(t, "session.finish", finish["type"], "an empty probe must neither upload nor commit audio")
	return ""
}

func speechProbeFinish(ctx context.Context, t *testing.T, socket *websocket.Conn, protocol, id string) {
	t.Helper()
	if protocol == "dashscope-asr" {
		speechTestDashEvent(ctx, t, socket, id, "task-finished", nil)
		return
	}
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"type": "session.finished"}))
}

func TestTCYAISpeechConnectionProbe(t *testing.T) {
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		t.Run(protocol, func(t *testing.T) {
			finishReceived := make(chan struct{})
			allowTerminal := make(chan struct{})
			disconnected := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
				require.Equal(t, "Bearer fixture-probe-secret", r.Header.Get("Authorization"))
				require.Empty(t, r.Header.Get("X-DashScope-WorkSpace"), "standard endpoint needs no workspace")
				if protocol == "qwen-asr-realtime" {
					require.Equal(t, "qwen3-asr-flash-realtime", r.URL.Query().Get("model"))
				}
				id := speechProbeStarted(ctx, t, socket, protocol)
				close(finishReceived)
				select {
				case <-allowTerminal:
				case <-ctx.Done():
					return
				}
				speechProbeFinish(ctx, t, socket, protocol, id)
				_, _, _ = socket.Read(ctx)
				close(disconnected)
			})
			done := make(chan struct{})
			var result SpeechResult
			var err error
			go func() {
				result, err = TestSpeechConnection(ctx, speechProbeFixture(protocol, endpoint))
				close(done)
			}()
			select {
			case <-finishReceived:
			case <-ctx.Done():
				t.Fatal("probe did not negotiate a model session")
			}
			select {
			case <-done:
				t.Fatal("connection test succeeded before provider termination acknowledgement")
			case <-time.After(20 * time.Millisecond):
			}
			close(allowTerminal)
			select {
			case <-done:
			case <-ctx.Done():
				t.Fatal("probe waited for upstream EOF after the terminal acknowledgement")
			}
			require.NoError(t, err)
			require.Empty(t, result.Text)
			require.Positive(t, result.ElapsedMS)
			require.Zero(t, result.AudioDurationMS)
			require.Zero(t, result.FirstTextMS)
			require.Equal(t, Endpoint(speechProbeFixture(protocol, endpoint)), result.Endpoint)
			select {
			case <-disconnected:
			case <-ctx.Done():
				t.Fatal("successful probe leaked its socket")
			}
		})
	}
}

func TestTCYAISpeechConnectionProbeRejectsInvalidEvents(t *testing.T) {
	i18n.Init()
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		for _, mode := range []string{"provider-error", "premature-terminal", "invalid-json", "event-flood"} {
			t.Run(protocol+"/"+mode, func(t *testing.T) {
				ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
					var command map[string]any
					require.NoError(t, wsjson.Read(ctx, socket, &command))
					if mode == "invalid-json" {
						require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte("not-json")))
						return
					}
					count := 1
					event := "task-failed"
					if protocol == "qwen-asr-realtime" {
						event = "error"
					}
					if mode == "premature-terminal" {
						event = "task-finished"
						if protocol == "qwen-asr-realtime" {
							event = "session.finished"
						}
					}
					if mode == "event-flood" {
						count = 64
						event = "unrecognized-event"
					}
					for range count {
						if protocol == "dashscope-asr" {
							header := command["header"].(map[string]any)
							speechTestDashEvent(ctx, t, socket, header["task_id"].(string), event, map[string]any{"text": "fixture-probe-secret private upstream echo"})
						} else {
							require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
								"type":    event,
								"message": "fixture-probe-secret private upstream echo",
							}))
						}
					}
				})
				_, err := TestSpeechConnection(ctx, speechProbeFixture(protocol, endpoint))
				require.Error(t, err)
				require.NotContains(t, err.Error(), "fixture-probe-secret")
				require.NotContains(t, err.Error(), "private upstream echo")
			})
		}
	}
}

func TestTCYAISpeechConnectionProbeCancellation(t *testing.T) {
	for _, protocol := range []string{"dashscope-asr", "qwen-asr-realtime"} {
		t.Run(protocol, func(t *testing.T) {
			disconnected := make(chan struct{})
			finishReceived := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				_ = speechProbeStarted(ctx, t, socket, protocol)
				close(finishReceived)
				_, _, _ = socket.Read(ctx)
				close(disconnected)
			})
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			done := make(chan error, 1)
			go func() {
				_, err := TestSpeechConnection(ctx, speechProbeFixture(protocol, endpoint))
				done <- err
			}()
			select {
			case <-finishReceived:
			case <-ctx.Done():
				t.Fatal("probe did not send finish")
			}
			cancel()
			select {
			case err := <-done:
				require.ErrorIs(t, err, context.Canceled)
			case <-time.After(time.Second):
				t.Fatal("cancelled probe did not return")
			}
			select {
			case <-disconnected:
			case <-time.After(time.Second):
				t.Fatal("cancelled probe leaked its socket")
			}
		})
	}
}

func TestTCYAISpeechConnectionProbeValidationAndSSRF(t *testing.T) {
	i18n.Init()
	var requests atomic.Int32
	server := httptest.NewTLSServer(http.HandlerFunc(func(_ http.ResponseWriter, _ *http.Request) {
		requests.Add(1)
	}))
	defer server.Close()
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(false)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	for _, mode := range []string{"unsupported", "disabled", "invalid-url", "missing-workspace", "ssrf"} {
		t.Run(mode, func(t *testing.T) {
			c := speechProbeFixture("dashscope-asr", server.URL)
			switch mode {
			case "unsupported":
				c.Protocol = "dashscope-file-asr"
			case "disabled":
				c.Speech.Disabled = true
			case "invalid-url":
				c.BaseURL += "?key=private"
			case "missing-workspace":
				c.BaseURL = "wss://{workspace_id}.cn-beijing.maas.aliyuncs.com"
			}
			ctx, cancel := context.WithTimeout(context.Background(), time.Second)
			defer cancel()
			_, err := TestSpeechConnection(ctx, c)
			require.Error(t, err)
		})
	}
	require.Zero(t, requests.Load(), "invalid or local destinations must not receive a probe")
}
