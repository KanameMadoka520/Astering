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
	"mime/multipart"
	"net/http"
	"net/url"
	"path/filepath"
	"strings"
	"sync/atomic"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// https://elevenlabs.io/docs/api-reference/speech-to-text/convert
func transcribeElevenLabs(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	fields := map[string]string{
		"model_id":               c.Model,
		"timestamps_granularity": "none",
		"tag_audio_events":       "false",
	}
	if c.Speech != nil && c.Speech.Language != "" && c.Speech.Language != "auto" {
		fields["language_code"] = c.Speech.Language
	}
	for key, value := range fields {
		if err := form.WriteField(key, value); err != nil {
			return "", fmt.Errorf("encode speech field: %w", err)
		}
	}
	if c.Speech != nil {
		for _, word := range c.Speech.Hotwords {
			if err := form.WriteField("keyterms", word); err != nil {
				return "", fmt.Errorf("encode speech vocabulary: %w", err)
			}
		}
	}
	file, err := form.CreateFormFile("file", filepath.Base(filename))
	if err != nil {
		return "", fmt.Errorf("encode speech file: %w", err)
	}
	if _, err = file.Write(audio); err != nil {
		return "", fmt.Errorf("write speech file: %w", err)
	}
	if err = form.Close(); err != nil {
		return "", fmt.Errorf("finish speech upload: %w", err)
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, Endpoint(c), &body)
	if err != nil {
		return "", tcylocale.Error("speechProtocol14")
	}
	req.Header.Set("Content-Type", form.FormDataContentType())
	req.Header.Set("xi-api-key", c.APIKey)
	client, release := providerClient(ctx)
	defer release()
	response, err := client.Do(req)
	if err != nil {
		return "", speechStreamError(ctx)
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return "", tcylocale.Error("speechHTTPStatus", response.StatusCode)
	}
	raw, err := io.ReadAll(io.LimitReader(response.Body, 2*1024*1024+1))
	if ctx.Err() != nil {
		return "", ctx.Err()
	}
	if err != nil || len(raw) > 2*1024*1024 {
		return "", tcylocale.Error("speechProtocol15")
	}
	var result struct {
		Text string `json:"text"`
	}
	if json.Unmarshal(raw, &result) != nil || strings.TrimSpace(result.Text) == "" {
		return "", tcylocale.Error("speechProtocol13")
	}
	if onDelta != nil {
		onDelta(SpeechDelta{
			Text:  result.Text,
			Final: true,
		})
	}
	return result.Text, nil
}

// https://elevenlabs.io/docs/eleven-api/guides/how-to/speech-to-text/realtime/transcripts-and-commit-strategies
func transcribeElevenLabsRealtime(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	if rate != 16000 {
		return "", tcylocale.Error("speechProtocol16")
	}
	if c.Speech != nil && len(c.Speech.Hotwords) > 50 {
		return "", tcylocale.Error("speechProtocol17")
	}
	endpoint, err := url.Parse(Endpoint(c))
	if err != nil {
		return "", tcylocale.Error("speechProtocol14")
	}

	headers := make(http.Header)
	headers.Set("xi-api-key", c.APIKey)
	socket, cleanup, err := dialSpeechSocket(ctx, endpoint.String(), headers)
	if err != nil {
		return "", err
	}
	defer cleanup()
	var upload *speechAudioUpload
	defer func() {
		if upload != nil {
			upload.close()
		}
	}()
	committed := ""
	ack := make(chan struct{}, 1)
	var awaiting atomic.Bool
	for {
		var event struct {
			Type  string `json:"message_type"`
			Text  string `json:"text"`
			Error string `json:"error"`
		}
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return "", err
		}
		if event.Error != "" || elevenSpeechFailure(event.Type) {
			return "", tcylocale.Error("speechProtocol05")
		}
		switch event.Type {
		case "session_started":
			if upload != nil {
				return "", tcylocale.Error("speechProtocol18")
			}
			upload = startSpeechAudioUpload(ctx, socket, func(writeCtx context.Context, finishing *atomic.Bool) error {
				prompt := ""
				if c.Speech != nil {
					prompt = c.Speech.Prompt
				}
				return writeElevenSpeechAudio(writeCtx, socket, pcm, prompt, &awaiting, finishing, ack)
			})
		case "partial_transcript":
			if upload == nil {
				return "", tcylocale.Error("speechProtocol19")
			}
			if onDelta != nil {
				onDelta(SpeechDelta{Text: committed + event.Text})
			}
		case "committed_transcript":
			if upload == nil || !awaiting.Swap(false) {
				return "", tcylocale.Error("speechProtocol20")
			}
			if len(committed)+len(event.Text) > 2*1024*1024 {
				return "", tcylocale.Error("speechProtocol21")
			}
			committed += event.Text
			final := upload.finishing.Load()
			if final && strings.TrimSpace(committed) == "" {
				return "", tcylocale.Error("speechProtocol13")
			}
			if onDelta != nil {
				onDelta(SpeechDelta{
					Text:  committed,
					Final: final,
				})
			}
			if final {
				return committed, nil
			}
			ack <- struct{}{}
		}
	}
}

func elevenSpeechFailure(kind string) bool {
	switch kind {
	case "error", "auth_error", "quota_exceeded", "commit_throttled", "transcriber_error",
		"unaccepted_terms", "unaccepted_terms_error", "rate_limited", "input_error", "invalid_request",
		"queue_overflow", "resource_exhausted", "session_time_limit_exceeded", "chunk_size_exceeded",
		"insufficient_audio_activity":
		return true
	}
	return false
}

func writeElevenSpeechAudio(ctx context.Context, socket *websocket.Conn, pcm []byte, prompt string, awaiting, finishing *atomic.Bool, ack <-chan struct{}) error {
	// Explicit acknowledgements every 20 s prevent the provider's automatic
	// ~36 s commit from being mistaken for the final audio acknowledgement.
	const segmentSize = 16000 * 2 * 20
	const chunkSize = 3200
	for offset := 0; offset < len(pcm); offset += chunkSize {
		end := min(offset+chunkSize, len(pcm))
		commit := end == len(pcm) || end%segmentSize == 0
		chunk := map[string]any{
			"message_type":  "input_audio_chunk",
			"audio_base_64": base64.StdEncoding.EncodeToString(pcm[offset:end]),
			"sample_rate":   16000,
			"commit":        commit,
		}
		if offset == 0 && prompt != "" {
			chunk["previous_text"] = prompt
		}
		if commit {
			awaiting.Store(true)
			if end == len(pcm) {
				finishing.Store(true)
			}
		}
		if writeErr := wsjson.Write(ctx, socket, chunk); writeErr != nil {
			return writeErr
		}
		if commit && end != len(pcm) {
			select {
			case <-ack:
			case <-ctx.Done():
				return ctx.Err()
			}
		}
	}
	return nil
}
