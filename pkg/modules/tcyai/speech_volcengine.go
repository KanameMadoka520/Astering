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
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"

	"github.com/coder/websocket"
	"github.com/google/uuid"
)

const volcSpeechPayloadLimit = 2 * 1024 * 1024

// https://docs.volcengine.com/docs/doubao-voice/large-model-streaming-automatic-speech-recognition-api-1
func transcribeVolcengine(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	if rate != 16000 {
		return "", tcylocale.Error("speechProtocol23")
	}
	if c.Speech == nil || c.Speech.ResourceID == "" {
		return "", tcylocale.Error("speechProtocol24")
	}
	headers := make(http.Header)
	if c.Speech.AppID != "" {
		headers.Set("X-Api-App-Key", c.Speech.AppID)
		headers.Set("X-Api-Access-Key", c.APIKey)
	} else {
		headers.Set("X-Api-Key", c.APIKey)
	}
	headers.Set("X-Api-Resource-Id", c.Speech.ResourceID)
	headers.Set("X-Api-Request-Id", uuid.NewString())
	headers.Set("X-Api-Connect-Id", uuid.NewString())
	headers.Set("X-Api-Sequence", "-1")
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), headers)
	if err != nil {
		return "", err
	}
	defer cleanup()
	configuration, err := volcSpeechConfiguration(c, rate)
	if err != nil {
		return "", err
	}
	frame, err := encodeVolcSpeechFrame(0x10, 0x10, configuration)
	if err != nil {
		return "", err
	}
	if err = socket.Write(ctx, websocket.MessageBinary, frame); err != nil {
		return "", speechStreamError(ctx)
	}
	upload := startSpeechAudioUpload(ctx, socket, func(writeCtx context.Context, finishing *atomic.Bool) error {
		return writeVolcSpeechAudio(writeCtx, socket, pcm, finishing)
	})
	defer upload.close()
	var text string
	for {
		kind, body, readErr := socket.Read(ctx)
		if readErr != nil {
			return "", speechStreamError(ctx)
		}
		if kind != websocket.MessageBinary {
			return "", tcylocale.Error("speechProtocol25")
		}
		payload, final, parseErr := decodeVolcSpeechFrame(body)
		if parseErr != nil {
			return "", parseErr
		}
		var event struct {
			Code   int `json:"code"`
			Result *struct {
				Text string `json:"text"`
			} `json:"result"`
		}
		if json.Unmarshal(payload, &event) != nil {
			return "", tcylocale.Error("speechProtocol15")
		}
		if event.Code != 0 && event.Code != 20000000 {
			return "", tcylocale.Error("speechProtocol05")
		}
		if event.Result != nil {
			text = event.Result.Text
			if onDelta != nil && !final {
				onDelta(SpeechDelta{Text: text})
			}
		}
		if final {
			if !upload.finishing.Load() || strings.TrimSpace(text) == "" {
				return "", tcylocale.Error("speechProtocol22")
			}
			if onDelta != nil {
				onDelta(SpeechDelta{
					Text:  text,
					Final: true,
				})
			}
			return text, nil
		}
	}
}

func encodeVolcSpeechFrame(kind, serialization byte, payload []byte) ([]byte, error) {
	var compressed bytes.Buffer
	writer := gzip.NewWriter(&compressed)
	if _, err := writer.Write(payload); err != nil {
		return nil, fmt.Errorf("compress speech frame: %w", err)
	}
	if err := writer.Close(); err != nil {
		return nil, fmt.Errorf("finish speech compression: %w", err)
	}
	size := compressed.Len()
	if size < 0 || size > volcSpeechPayloadLimit {
		return nil, tcylocale.Error("speechProtocol25")
	}
	frame := make([]byte, 8, 8+size)
	copy(frame, []byte{0x11, kind, serialization | 1, 0})
	binary.BigEndian.PutUint32(frame[4:8], uint32(size))
	return append(frame, compressed.Bytes()...), nil
}

func decodeVolcSpeechFrame(frame []byte) ([]byte, bool, error) {
	invalid := tcylocale.Error("speechProtocol25")
	if len(frame) < 8 || frame[0]>>4 != 1 || frame[0]&15 == 0 {
		return nil, false, invalid
	}
	offset := int(frame[0]&15) * 4
	if offset > len(frame)-4 {
		return nil, false, invalid
	}
	kind, flags := frame[1]>>4, frame[1]&15
	if kind == 15 {
		return nil, false, tcylocale.Error("speechProtocol05")
	}
	if kind != 9 || flags > 3 || frame[2]>>4 != 1 || frame[2]&15 > 1 {
		return nil, false, invalid
	}
	if flags&1 != 0 {
		offset += 4
	}
	if offset > len(frame)-4 {
		return nil, false, invalid
	}
	size := int64(binary.BigEndian.Uint32(frame[offset : offset+4]))
	payload := frame[offset+4:]
	if size != int64(len(payload)) || size > volcSpeechPayloadLimit {
		return nil, false, invalid
	}
	if frame[2]&15 == 1 {
		reader, err := gzip.NewReader(bytes.NewReader(payload))
		if err != nil {
			return nil, false, invalid
		}
		defer reader.Close()
		payload, err = io.ReadAll(io.LimitReader(reader, volcSpeechPayloadLimit+1))
		if err != nil || len(payload) > volcSpeechPayloadLimit {
			return nil, false, invalid
		}
	}
	return payload, flags&2 != 0, nil
}

func volcSpeechConfiguration(c Connection, rate int) ([]byte, error) {
	request := map[string]any{
		"model_name":  c.Model,
		"result_type": "full",
	}
	corpus := map[string]any{}
	if c.Speech.VocabularyID != "" {
		corpus["boosting_table_id"] = c.Speech.VocabularyID
	}
	contextData := map[string]any{}
	if len(c.Speech.Hotwords) != 0 {
		words := make([]map[string]string, 0, len(c.Speech.Hotwords))
		for _, word := range c.Speech.Hotwords {
			words = append(words, map[string]string{"word": word})
		}
		contextData["hotwords"] = words
	}
	if c.Speech.Prompt != "" {
		contextData["context_type"] = "dialog_ctx"
		contextData["context_data"] = []map[string]string{{"text": c.Speech.Prompt}}
	}
	if len(contextData) != 0 {
		encoded, marshalErr := json.Marshal(contextData)
		if marshalErr != nil {
			return nil, fmt.Errorf("encode speech context: %w", marshalErr)
		}
		corpus["context"] = string(encoded)
	}
	if len(corpus) != 0 {
		request["corpus"] = corpus
	}
	audioConfig := map[string]any{
		"format":  "pcm",
		"codec":   "raw",
		"rate":    rate,
		"bits":    16,
		"channel": 1,
	}
	if strings.Contains(Endpoint(c), "/bigmodel_nostream") && c.Speech.Language != "" && c.Speech.Language != "auto" {
		audioConfig["language"] = c.Speech.Language
	}
	return json.Marshal(map[string]any{
		"audio":   audioConfig,
		"request": request,
	})
}

func writeVolcSpeechAudio(ctx context.Context, socket *websocket.Conn, pcm []byte, finishing *atomic.Bool) error {
	const chunkSize = 6400 // 200 ms of mono PCM16 at 16 kHz, as recommended by the protocol.
	for offset := 0; offset < len(pcm); offset += chunkSize {
		if offset != 0 {
			timer := time.NewTimer(200 * time.Millisecond)
			select {
			case <-timer.C:
			case <-ctx.Done():
				timer.Stop()
				return ctx.Err()
			}
		}
		end := min(offset+chunkSize, len(pcm))
		kind := byte(0x20)
		if end == len(pcm) {
			kind |= 2
			finishing.Store(true)
		}
		frame, frameErr := encodeVolcSpeechFrame(kind, 0, pcm[offset:end])
		if frameErr != nil {
			return frameErr
		}
		if writeErr := socket.Write(ctx, websocket.MessageBinary, frame); writeErr != nil {
			return writeErr
		}
	}
	return nil
}
