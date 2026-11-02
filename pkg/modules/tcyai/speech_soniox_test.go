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
	"net/http"
	"testing"
	"time"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func TestTCYAISonioxSpeechStreaming(t *testing.T) {
	pcm := bytes.Repeat([]byte{1, 2}, 1700)
	closed := make(chan struct{})
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
		require.Equal(t, "Bearer fixture-key", r.Header.Get("Authorization"))
		require.Empty(t, r.URL.RawQuery)
		var config map[string]any
		require.NoError(t, wsjson.Read(ctx, socket, &config))
		require.Equal(t, "stt-rt-v5", config["model"])
		require.Equal(t, "pcm_s16le", config["audio_format"])
		require.InDelta(t, 16000, config["sample_rate"], 0)
		require.InDelta(t, 1, config["num_channels"], 0)
		require.NotContains(t, config, "api_key", "authentication belongs to the handshake")
		require.Equal(t, []any{"en"}, config["language_hints"])
		require.Equal(t, map[string]any{
			"text":  "Planning context",
			"terms": []any{"Vikunja"},
		}, config["context"])
		var received []byte
		for {
			kind, body, err := socket.Read(ctx)
			require.NoError(t, err)
			if kind == websocket.MessageText {
				require.Empty(t, body)
				break
			}
			require.Equal(t, websocket.MessageBinary, kind)
			received = append(received, body...)
		}
		require.Equal(t, pcm, received)
		for _, frame := range []string{
			`{"tokens":[{"text":"Hel","is_final":false}]}`,
			`{"tokens":[]}`,
			`{"tokens":[{"text":"Hello ","is_final":true},{"text":"wurld","is_final":false}]}`,
			`{"tokens":[{"text":"world","is_final":true},{"text":"<end>","is_final":true}]}`,
			`{"tokens":[],"finished":true}`,
		} {
			require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(frame)))
		}
		_, _, _ = socket.Read(ctx)
		close(closed)
	})
	var deltas []SpeechDelta
	text, err := transcribeSoniox(ctx, Connection{
		Protocol: "soniox-realtime",
		BaseURL:  endpoint,
		Model:    "stt-rt-v5",
		APIKey:   "fixture-key",
		Speech: &SpeechOptions{
			Language: "en",
			Prompt:   "Planning context",
			Hotwords: []string{"Vikunja"},
		},
	}, "voice.wav", speechTestWAV(pcm, 16000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
	require.NoError(t, err)
	require.Equal(t, "Hello world", text)
	require.Equal(t, []SpeechDelta{
		{Text: "Hel"},
		{Text: ""},
		{Text: "Hello wurld"},
		{Text: "Hello world"},
		{
			Text:  "Hello world",
			Final: true,
		},
	}, deltas)
	select {
	case <-closed:
	case <-ctx.Done():
		t.Fatal("completed recognition did not close the provider socket")
	}
}

func TestTCYAISonioxSpeechRejectsIncompleteAndProviderErrors(t *testing.T) {
	for _, tc := range []struct {
		name   string
		frames []string
	}{
		{
			name: "unfinalized tail",
			frames: []string{
				`{"tokens":[{"text":"unfinished","is_final":false}]}`,
				`{"finished":true}`,
			},
		},
		{
			name:   "provider error is redacted",
			frames: []string{`{"error_code":401,"error_message":"fixture-key PRIVATE_TRANSCRIPT"}`},
		},
		{
			name:   "malformed event",
			frames: []string{`{"tokens":`},
		},
		{
			name:   "EOF is not success",
			frames: []string{`{"tokens":[{"text":"looks final","is_final":true}]}`},
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				var config map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &config))
				for {
					kind, _, err := socket.Read(ctx)
					require.NoError(t, err)
					if kind == websocket.MessageText {
						break
					}
				}
				for _, frame := range tc.frames {
					require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(frame)))
				}
			})
			text, err := transcribeSoniox(ctx, Connection{
				Protocol: "soniox-realtime",
				BaseURL:  endpoint,
				Model:    "stt-rt-v5",
				APIKey:   "fixture-key",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-key")
			require.NotContains(t, err.Error(), "PRIVATE_TRANSCRIPT")
		})
	}
}

func TestTCYAISpeechAdapterCancellationReleasesSocket(t *testing.T) {
	for _, protocol := range []string{"soniox-realtime", "elevenlabs-realtime", "volcengine-asr"} {
		t.Run(protocol, func(t *testing.T) {
			closed := make(chan struct{})
			started := make(chan struct{})
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				close(started)
				for {
					if _, _, err := socket.Read(ctx); err != nil {
						close(closed)
						return
					}
				}
			})
			ctx, cancel := context.WithCancel(ctx)
			defer cancel()
			go func() {
				<-started
				cancel()
			}()
			c := Connection{
				Protocol: protocol,
				BaseURL:  endpoint,
				Model:    "fixture-model",
				Speech:   &SpeechOptions{ResourceID: "fixture-resource"},
			}
			var err error
			audio := speechTestWAV([]byte{0, 0}, 16000)
			switch protocol {
			case "soniox-realtime":
				_, err = transcribeSoniox(ctx, c, "voice.wav", audio, nil)
			case "elevenlabs-realtime":
				_, err = transcribeElevenLabsRealtime(ctx, c, "voice.wav", audio, nil)
			case "volcengine-asr":
				_, err = transcribeVolcengine(ctx, c, "voice.wav", audio, nil)
			}
			require.ErrorIs(t, err, context.Canceled)
			select {
			case <-closed:
			case <-time.After(time.Second):
				t.Fatal("cancellation left the provider socket open")
			}
		})
	}
}
