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
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func speechTestHTTP(t *testing.T, handler http.HandlerFunc) (context.Context, string) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	server := httptest.NewTLSServer(handler)
	t.Cleanup(func() {
		cancel()
		server.Close()
	})
	client := server.Client()
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return context.WithValue(ctx, providerClientContextKey{}, client), server.URL
}

// https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition
func TestTCYAIMiMoSpeechHTTPContract(t *testing.T) {
	for _, stream := range []bool{false, true} {
		t.Run(fmt.Sprint("stream=", stream), func(t *testing.T) {
			audio := speechTestWAV([]byte{0, 0, 1, 0}, 16000)
			ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, r *http.Request) {
				assert.Equal(t, "/chat/completions", r.URL.Path)
				assert.Equal(t, http.MethodPost, r.Method)
				assert.Equal(t, "Bearer fixture-key", r.Header.Get("Authorization"))
				var body map[string]any
				if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
					http.Error(w, "invalid fixture JSON", http.StatusBadRequest)
					return
				}
				assert.Equal(t, "mimo-v2.5-asr", body["model"])
				assert.Equal(t, stream, body["stream"])
				assert.Equal(t, map[string]any{"language": "zh"}, body["asr_options"])
				assert.Equal(t, []any{map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type": "input_audio",
						"input_audio": map[string]any{
							"data":   "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio),
							"format": "wav",
						},
					}},
				}}, body["messages"])
				if !stream {
					w.Header().Set("Content-Type", "application/json")
					_, _ = io.WriteString(w, `{"choices":[{"message":{"content":"Hello world"}}]}`)
					return
				}
				w.Header().Set("Content-Type", "text/event-stream")
				_, _ = io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"Hello \"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"world\"},\"finish_reason\":\"stop\"}]}\n\ndata: {\"choices\":[],\"usage\":{\"prompt_tokens\":12,\"completion_tokens\":2}}\n\ndata: [DONE]\n\n")
				w.(http.Flusher).Flush()
				<-r.Context().Done()
			})
			text, err := transcribeSpeechHTTP(ctx, Connection{
				Protocol:     "mimo-asr",
				BaseURL:      endpoint,
				Model:        "mimo-v2.5-asr",
				APIKey:       "fixture-key",
				NonStreaming: !stream,
				Speech:       &SpeechOptions{Language: "zh"},
			}, "voice.wav", audio)
			require.NoError(t, err)
			require.Equal(t, "Hello world", text)
			require.NoError(t, ctx.Err(), "SSE DONE must finish without waiting for EOF")
		})
	}
}

// https://help.aliyun.com/en/model-studio/fun-asr-flash-recorded-speech-recognition-http-api
func TestTCYAIFunSpeechHTTPContract(t *testing.T) {
	audio := speechTestWAV([]byte{0, 0, 1, 0}, 16000)
	ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/v1/services/aigc/multimodal-generation/generation", r.URL.Path)
		assert.Equal(t, "Bearer fixture-key", r.Header.Get("Authorization"))
		var body map[string]any
		if !assert.NoError(t, json.NewDecoder(r.Body).Decode(&body)) {
			http.Error(w, "invalid fixture JSON", http.StatusBadRequest)
			return
		}
		assert.Equal(t, "fun-asr-flash-2026-06-15", body["model"])
		assert.NotContains(t, body, "messages", "DashScope messages belong under input")
		assert.Equal(t, map[string]any{
			"format":         "wav",
			"sample_rate":    float64(16000),
			"language_hints": []any{"zh"},
			"vocabulary_id":  "vocab-fixture",
		}, body["parameters"])
		assert.Equal(t, map[string]any{
			"messages": []any{
				map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type": "input_text",
						"text": "Project names vikunja-x",
					}},
				},
				map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type":        "input_audio",
						"input_audio": map[string]any{"data": "data:audio/wav;base64," + base64.StdEncoding.EncodeToString(audio)},
					}},
				},
			},
		}, body["input"])
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"output":{"text":"recognized words","sentence":{"text":"must not duplicate"}}}`)
	})
	text, err := transcribeSpeechHTTP(ctx, Connection{
		Protocol: "dashscope-file-asr",
		BaseURL:  endpoint,
		Model:    "fun-asr-flash-2026-06-15",
		APIKey:   "fixture-key",
		Speech: &SpeechOptions{
			Language:     "zh",
			Prompt:       "Project names",
			Hotwords:     []string{"vikunja-x"},
			VocabularyID: "vocab-fixture",
		},
	}, "voice.wav", audio)
	require.NoError(t, err)
	require.Equal(t, "recognized words", text)
}

func TestTCYAIFunSpeechHTTPContextLimit(t *testing.T) {
	for _, length := range []int{400, 401} {
		t.Run(fmt.Sprint(length), func(t *testing.T) {
			var called atomic.Bool
			ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				called.Store(true)
				w.Header().Set("Content-Type", "application/json")
				_, _ = io.WriteString(w, `{"output":{"text":"recognized"}}`)
			})
			_, err := transcribeSpeechHTTP(ctx, Connection{
				Protocol: "dashscope-file-asr",
				BaseURL:  endpoint,
				Model:    "fun-asr-flash-2026-06-15",
				Speech:   &SpeechOptions{Prompt: strings.Repeat("a", length)},
			}, "voice.wav", speechTestWAV([]byte{0, 0}, 16000))
			if length == 400 {
				require.NoError(t, err)
				require.True(t, called.Load())
			} else {
				require.Error(t, err)
				require.False(t, called.Load(), "invalid context must be rejected before any provider request")
			}
		})
	}
}

// https://github.com/FunAudioLLM/SenseVoice/blob/main/api.py
func TestTCYAISenseVoiceSpeechHTTPContract(t *testing.T) {
	audio := speechTestWAV([]byte{0, 0, 1, 0}, 16000)
	ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, r *http.Request) {
		assert.Equal(t, "/api/v1/asr", r.URL.Path)
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
		assert.Equal(t, []string{"yue"}, form.Value["lang"])
		assert.Equal(t, []string{"true"}, form.Value["use_itn"])
		assert.NotContains(t, form.File, "file")
		assert.NotContains(t, form.Value, "model")
		if !assert.Len(t, form.File["files"], 1) {
			http.Error(w, "missing fixture file", http.StatusBadRequest)
			return
		}
		file := form.File["files"][0]
		assert.Equal(t, "voice.wav", file.Filename)
		reader, err := file.Open()
		if !assert.NoError(t, err) {
			http.Error(w, "unreadable fixture file", http.StatusBadRequest)
			return
		}
		defer func() { assert.NoError(t, reader.Close()) }()
		received, err := io.ReadAll(reader)
		assert.NoError(t, err)
		assert.Equal(t, audio, received)
		w.Header().Set("Content-Type", "application/json")
		_, _ = io.WriteString(w, `{"result":[{"text":"First"},{"text":" "},{"text":"Second"}]}`)
	})
	text, err := transcribeSpeechHTTP(ctx, Connection{
		Protocol: "sensevoice",
		BaseURL:  endpoint,
		Model:    "SenseVoiceSmall",
		Speech:   &SpeechOptions{Language: "yue"},
	}, "ignored/path/voice.wav", audio)
	require.NoError(t, err)
	require.Equal(t, "First\nSecond", text)
}

func TestTCYAISpeechHTTPProviderErrorDoesNotLeakKey(t *testing.T) {
	for _, protocol := range []string{"mimo-asr", "dashscope-file-asr", "sensevoice"} {
		t.Run(protocol, func(t *testing.T) {
			ctx, endpoint := speechTestHTTP(t, func(w http.ResponseWriter, _ *http.Request) {
				w.Header().Set("Content-Type", "application/json")
				w.WriteHeader(http.StatusUnauthorized)
				_, _ = io.WriteString(w, `{"error":{"message":"invalid fixture-key"}}`)
			})
			_, err := transcribeSpeechHTTP(ctx, Connection{
				Protocol: protocol,
				BaseURL:  endpoint,
				APIKey:   "fixture-key",
			}, "voice.wav", speechTestWAV(bytes.Repeat([]byte{0, 0}, 10), 16000))
			require.Error(t, err)
			require.NotContains(t, err.Error(), "fixture-key")
		})
	}
}
