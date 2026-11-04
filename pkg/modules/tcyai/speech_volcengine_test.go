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
	"compress/gzip"
	"context"
	"encoding/binary"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/i18n"

	"github.com/coder/websocket"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func speechTestVolcPayload(t *testing.T, frame []byte) []byte {
	t.Helper()
	require.GreaterOrEqual(t, len(frame), 8)
	require.Equal(t, byte(0x11), frame[0])
	require.Equal(t, int(binary.BigEndian.Uint32(frame[4:8])), len(frame)-8)
	reader, err := gzip.NewReader(bytes.NewReader(frame[8:]))
	require.NoError(t, err)
	defer reader.Close()
	payload, err := io.ReadAll(reader)
	require.NoError(t, err)
	return payload
}

func speechTestVolcResponse(t *testing.T, flags byte, text string) []byte {
	t.Helper()
	payload, err := json.Marshal(map[string]any{"result": map[string]string{"text": text}})
	require.NoError(t, err)
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	_, err = writer.Write(payload)
	require.NoError(t, err)
	require.NoError(t, writer.Close())
	frame := []byte{0x11, 0x90 | flags, 0x11, 0}
	if flags&1 != 0 {
		frame = append(frame, 0xff, 0xff, 0xff, 0xff)
	}
	size := compressed.Len()
	if size < 0 || size > speechResponseLimit {
		t.Fatal("compressed test frame exceeds supported response size")
		return nil
	}
	frame = binary.BigEndian.AppendUint32(frame, uint32(size))
	return append(frame, compressed.Bytes()...)
}

func TestTCYAIVolcSpeechStreaming(t *testing.T) {
	for _, appID := range []string{"fixture-app", ""} {
		t.Run("app="+appID, func(t *testing.T) {
			pcm := bytes.Repeat([]byte{1, 2}, 3200)
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, r *http.Request) {
				if appID == "" {
					require.Equal(t, "fixture-key", r.Header.Get("X-Api-Key"))
					require.Empty(t, r.Header.Get("X-Api-Access-Key"))
				} else {
					require.Equal(t, appID, r.Header.Get("X-Api-App-Key"))
					require.Equal(t, "fixture-key", r.Header.Get("X-Api-Access-Key"))
					require.Empty(t, r.Header.Get("X-Api-Key"))
				}
				require.Empty(t, r.Header.Get("Authorization"))
				require.Equal(t, "volc.seedasr.sauc.duration", r.Header.Get("X-Api-Resource-Id"))
				_, err := uuid.Parse(r.Header.Get("X-Api-Request-Id"))
				require.NoError(t, err)
				kind, frame, err := socket.Read(ctx)
				require.NoError(t, err)
				require.Equal(t, websocket.MessageBinary, kind)
				require.Equal(t, byte(0x10), frame[1])
				require.Equal(t, byte(0x11), frame[2])
				var config map[string]any
				require.NoError(t, json.Unmarshal(speechTestVolcPayload(t, frame), &config))
				require.Equal(t, "pcm", config["audio"].(map[string]any)["format"])
				request := config["request"].(map[string]any)
				require.Equal(t, "bigmodel", request["model_name"])
				require.Equal(t, "full", request["result_type"])
				corpus := request["corpus"].(map[string]any)
				require.Equal(t, "vocabulary-fixture", corpus["boosting_table_id"])
				var contextData map[string]any
				require.NoError(t, json.Unmarshal([]byte(corpus["context"].(string)), &contextData))
				require.Equal(t, "dialog_ctx", contextData["context_type"])
				require.Contains(t, contextData, "hotwords")
				_, frame, err = socket.Read(ctx)
				require.NoError(t, err)
				require.Equal(t, byte(0x22), frame[1], "last audio packet must carry the final flag")
				require.Equal(t, byte(1), frame[2], "audio is raw bytes inside gzip")
				require.Equal(t, pcm, speechTestVolcPayload(t, frame))
				require.NoError(t, socket.Write(ctx, websocket.MessageBinary, speechTestVolcResponse(t, 1, "Partial")))
				require.NoError(t, socket.Write(ctx, websocket.MessageBinary, speechTestVolcResponse(t, 3, "Final text")))
				_, _, _ = socket.Read(ctx)
			})
			var deltas []SpeechDelta
			text, err := transcribeVolcengine(ctx, Connection{
				Protocol: "volcengine-asr",
				BaseURL:  endpoint,
				Model:    "bigmodel",
				APIKey:   "fixture-key",
				Speech: &SpeechOptions{
					AppID:        appID,
					ResourceID:   "volc.seedasr.sauc.duration",
					VocabularyID: "vocabulary-fixture",
					Prompt:       "Planning context",
					Hotwords:     []string{"Vikunja"},
				},
			}, "voice.wav", speechTestWAV(pcm, 16000), func(delta SpeechDelta) { deltas = append(deltas, delta) })
			require.NoError(t, err)
			require.Equal(t, "Final text", text)
			require.Equal(t, []SpeechDelta{
				{Text: "Partial"},
				{
					Text:  "Final text",
					Final: true,
				},
			}, deltas)
			require.NoError(t, ctx.Err(), "final flag must finish without waiting for EOF")
		})
	}
}

func TestTCYAIVolcSpeechBinaryValidation(t *testing.T) {
	valid := speechTestVolcResponse(t, 3, "Final text")
	corruptSize := append([]byte(nil), valid...)
	binary.BigEndian.PutUint32(corruptSize[8:12], 1)
	invalidGzip := append([]byte(nil), valid...)
	invalidGzip[12] = 0
	oversize, err := encodeVolcSpeechFrame(0x92, 0x10, bytes.Repeat([]byte{'a'}, volcSpeechPayloadLimit+1))
	require.NoError(t, err)
	for _, tc := range []struct {
		name  string
		frame []byte
	}{
		{
			name:  "short header",
			frame: []byte{0x11},
		},
		{
			name:  "truncated sequence",
			frame: valid[:8],
		},
		{
			name:  "declared payload mismatch",
			frame: corruptSize,
		},
		{
			name:  "invalid compression",
			frame: invalidGzip,
		},
		{
			name:  "gzip expansion is bounded",
			frame: oversize,
		},
		{
			name:  "provider error does not echo contents",
			frame: append([]byte{0x11, 0xf0, 0x10, 0, 0, 0, 0, 1}, []byte("fixture-key PRIVATE_TRANSCRIPT")...),
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			_, _, err := decodeVolcSpeechFrame(tc.frame)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "fixture-key")
			require.NotContains(t, err.Error(), "PRIVATE_TRANSCRIPT")
		})
	}
	for _, flags := range []byte{0, 1, 2, 3} {
		payload, final, err := decodeVolcSpeechFrame(speechTestVolcResponse(t, flags, "Text"))
		require.NoError(t, err)
		require.JSONEq(t, `{"result":{"text":"Text"}}`, string(payload))
		require.Equal(t, flags&2 != 0, final)
	}
}

func TestTCYAIVolcSpeechRejectsUnsupportedAudioAndMissingResource(t *testing.T) {
	i18n.Init()
	c := Connection{Speech: &SpeechOptions{ResourceID: "fixture"}}
	_, err := transcribeVolcengine(context.Background(), c, "renamed.wav", []byte("not a WAV"), nil)
	require.Error(t, err)
	_, err = transcribeVolcengine(context.Background(), c, "voice.wav", speechTestWAV([]byte{0, 0}, 8000), nil)
	require.ErrorContains(t, err, "16000")
	_, err = transcribeVolcengine(context.Background(), Connection{}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000), nil)
	require.ErrorContains(t, err, "resource")
}
