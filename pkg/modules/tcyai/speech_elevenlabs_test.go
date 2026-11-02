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
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"code.vikunja.io/api/pkg/i18n"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIElevenLabsSpeechMultipart(t *testing.T) {
	audio := []byte("fixture encoded audio")
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/v1/speech-to-text", r.URL.Path)
		assert.Equal(t, "fixture-key", r.Header.Get("xi-api-key"))
		assert.Empty(t, r.Header.Get("Authorization"))
		r.Body = http.MaxBytesReader(w, r.Body, 2*1024*1024)
		multipartReader, parseErr := r.MultipartReader()
		if !assert.NoError(t, parseErr) {
			http.Error(w, "invalid fixture multipart", http.StatusBadRequest)
			return
		}
		form, parseErr := multipartReader.ReadForm(1024 * 1024)
		if !assert.NoError(t, parseErr) {
			http.Error(w, "invalid fixture multipart", http.StatusBadRequest)
			return
		}
		defer func() { assert.NoError(t, form.RemoveAll()) }()
		assert.Equal(t, []string{"scribe_v2"}, form.Value["model_id"])
		assert.Equal(t, []string{"en"}, form.Value["language_code"])
		assert.Equal(t, []string{"Vikunja", "Arona"}, form.Value["keyterms"])
		assert.Empty(t, form.Value["transcript_edit"], "recognition context must not enable a billed editing feature")
		assert.Empty(t, form.Value["webhook"])
		if !assert.Len(t, form.File["file"], 1) {
			http.Error(w, "missing fixture file", http.StatusBadRequest)
			return
		}
		header := form.File["file"][0]
		file, err := header.Open()
		if !assert.NoError(t, err) {
			http.Error(w, "missing fixture file", http.StatusBadRequest)
			return
		}
		defer func() { assert.NoError(t, file.Close()) }()
		assert.Equal(t, "voice.webm", header.Filename)
		body, err := io.ReadAll(file)
		assert.NoError(t, err)
		assert.Equal(t, audio, body)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"text":"Recognized text"}`)
	}))
	defer server.Close()
	ctx := context.WithValue(context.Background(), providerClientContextKey{}, server.Client())
	var deltas []SpeechDelta
	text, err := transcribeElevenLabs(ctx, Connection{
		Protocol: "elevenlabs-transcription",
		BaseURL:  server.URL + "/v1",
		Model:    "scribe_v2",
		APIKey:   "fixture-key",
		Speech: &SpeechOptions{
			Language: "en",
			Prompt:   "Recognition context",
			Hotwords: []string{"Vikunja", "Arona"},
		},
	}, "../voice.webm", audio, func(delta SpeechDelta) { deltas = append(deltas, delta) })
	require.NoError(t, err)
	require.Equal(t, "Recognized text", text)
	require.Equal(t, []SpeechDelta{{
		Text:  text,
		Final: true,
	}}, deltas)
}

func TestTCYAIElevenLabsSpeechHTTPRejectsInvalidResponses(t *testing.T) {
	for _, tc := range []struct {
		name   string
		status int
		body   string
	}{
		{
			name:   "provider rejection is redacted",
			status: http.StatusUnauthorized,
			body:   `{"detail":{"message":"fixture-key PRIVATE_TRANSCRIPT"}}`,
		},
		{
			name:   "invalid JSON",
			status: http.StatusOK,
			body:   `{"text":`,
		},
		{
			name:   "asynchronous response is not a transcript",
			status: http.StatusOK,
			body:   `{"request_id":"fixture-request"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
				w.WriteHeader(tc.status)
				_, _ = io.WriteString(w, tc.body)
			}))
			defer server.Close()
			ctx := context.WithValue(context.Background(), providerClientContextKey{}, server.Client())
			text, err := transcribeElevenLabs(ctx, Connection{
				Protocol: "elevenlabs-transcription",
				BaseURL:  server.URL,
				APIKey:   "fixture-key",
			}, "voice.wav", []byte("fixture"), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-key")
			require.NotContains(t, err.Error(), "PRIVATE_TRANSCRIPT")
		})
	}
}

func TestTCYAIElevenLabsRealtimeSpeechSegmentAcknowledgement(t *testing.T) {
	// More than 20 seconds requires two explicit commits. The first committed
	// transcript must not finish the request or duplicate its timestamp variant.
	pcm := bytes.Repeat([]byte{1, 2}, 16000*20+1600)
	ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
		require.Equal(t, "fixture-key", r.Header.Get("xi-api-key"))
		require.Empty(t, r.Header.Get("Authorization"))
		require.Equal(t, "scribe_v2_realtime", r.URL.Query().Get("model_id"))
		require.Equal(t, "manual", r.URL.Query().Get("commit_strategy"))
		require.Equal(t, "pcm_16000", r.URL.Query().Get("audio_format"))
		require.Equal(t, "en", r.URL.Query().Get("language_code"))
		require.Equal(t, []string{"Vikunja"}, r.URL.Query()["keyterms"])
		require.Empty(t, r.URL.Query().Get("token"))
		require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"message_type": "session_started"}))
		var received []byte
		commits := 0
		for {
			var chunk struct {
				Type         string `json:"message_type"`
				Audio        string `json:"audio_base_64"`
				Rate         int    `json:"sample_rate"`
				Commit       bool   `json:"commit"`
				PreviousText string `json:"previous_text"`
			}
			require.NoError(t, wsjson.Read(ctx, socket, &chunk))
			require.Equal(t, "input_audio_chunk", chunk.Type)
			require.Equal(t, 16000, chunk.Rate)
			if len(received) == 0 {
				require.Equal(t, "Planning context", chunk.PreviousText)
			} else {
				require.Empty(t, chunk.PreviousText)
			}
			decoded, err := base64.StdEncoding.DecodeString(chunk.Audio)
			require.NoError(t, err)
			received = append(received, decoded...)
			if !chunk.Commit {
				continue
			}
			commits++
			text := "First segment "
			if commits == 2 {
				text = "last segment"
			}
			require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
				"message_type": "partial_transcript",
				"text":         "provisional",
			}))
			require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
				"message_type": "committed_transcript",
				"text":         text,
			}))
			if commits == 2 {
				break
			}
			require.NoError(t, wsjson.Write(ctx, socket, map[string]string{
				"message_type": "committed_transcript_with_timestamps",
				"text":         text,
			}))
		}
		require.Equal(t, pcm, received)
		_, _, _ = socket.Read(ctx)
	})
	var deltas []SpeechDelta
	text, err := transcribeElevenLabsRealtime(ctx, Connection{
		Protocol: "elevenlabs-realtime",
		BaseURL:  endpoint,
		Model:    "scribe_v2_realtime",
		APIKey:   "fixture-key",
		Speech: &SpeechOptions{
			Language: "en",
			Prompt:   "Planning context",
			Hotwords: []string{"Vikunja"},
		},
	}, "voice.wav", speechTestWAV(pcm, 16000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
	require.NoError(t, err)
	require.Equal(t, "First segment last segment", text)
	require.Equal(t, []SpeechDelta{
		{Text: "provisional"},
		{Text: "First segment "},
		{Text: "First segment provisional"},
		{
			Text:  "First segment last segment",
			Final: true,
		},
	}, deltas)
	require.NoError(t, ctx.Err(), "final acknowledgement must finish without waiting for EOF")
}

func TestTCYAIElevenLabsRealtimeSpeechRejectsInvalidEvents(t *testing.T) {
	i18n.Init()
	for _, tc := range []struct {
		name  string
		frame string
	}{
		{
			name:  "provider error",
			frame: `{"message_type":"auth_error","error":"fixture-key PRIVATE_TRANSCRIPT"}`,
		},
		{
			name:  "empty final text",
			frame: `{"message_type":"committed_transcript","text":""}`,
		},
		{
			name:  "partial then EOF",
			frame: `{"message_type":"partial_transcript","text":"unfinished"}`,
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"message_type": "session_started"}))
				var chunk map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &chunk))
				require.NoError(t, socket.Write(ctx, websocket.MessageText, []byte(tc.frame)))
			})
			text, err := transcribeElevenLabsRealtime(ctx, Connection{
				Protocol: "elevenlabs-realtime",
				BaseURL:  endpoint,
				Model:    "scribe_v2_realtime",
				APIKey:   "fixture-key",
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
			require.Error(t, err)
			require.Empty(t, text)
			require.NotContains(t, err.Error(), "fixture-key")
			require.NotContains(t, err.Error(), "PRIVATE_TRANSCRIPT")
		})
	}
	_, err := transcribeElevenLabsRealtime(context.Background(), Connection{}, "voice.wav", speechTestWAV([]byte{0, 0}, 8000), nil)
	require.ErrorContains(t, err, "16000")
}
