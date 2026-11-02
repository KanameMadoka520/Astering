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
	"strings"
	"sync/atomic"

	"code.vikunja.io/api/pkg/modules/tcylocale"

	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
)

// https://docs.soniox.com/api-reference/stt/websocket-api
func transcribeSoniox(ctx context.Context, c Connection, filename string, audio []byte, onDelta func(SpeechDelta)) (string, error) {
	pcm, rate, err := preparePCMSpeechAudio(filename, audio)
	if err != nil {
		return "", err
	}
	headers := make(http.Header)
	headers.Set("Authorization", "Bearer "+c.APIKey)
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), headers)
	if err != nil {
		return "", err
	}
	defer cleanup()
	config := map[string]any{
		"model":        c.Model,
		"audio_format": "pcm_s16le",
		"sample_rate":  rate,
		"num_channels": 1,
	}
	if c.Speech != nil {
		if c.Speech.Language != "" && c.Speech.Language != "auto" {
			config["language_hints"] = []string{c.Speech.Language}
		}
		if c.Speech.Prompt != "" || len(c.Speech.Hotwords) != 0 {
			contextData := map[string]any{}
			if c.Speech.Prompt != "" {
				contextData["text"] = c.Speech.Prompt
			}
			if len(c.Speech.Hotwords) != 0 {
				contextData["terms"] = c.Speech.Hotwords
			}
			config["context"] = contextData
		}
	}
	if err = wsjson.Write(ctx, socket, config); err != nil {
		return "", speechStreamError(ctx)
	}
	upload := startSpeechAudioUpload(ctx, socket, func(writeCtx context.Context, finishing *atomic.Bool) error {
		if err := writeSpeechPCM(writeCtx, socket, pcm, false); err != nil {
			return err
		}
		finishing.Store(true)
		// Empty binary frames are audio, not the protocol's end-of-stream signal.
		return socket.Write(writeCtx, websocket.MessageText, nil)
	})
	defer upload.close()
	var committed strings.Builder
	var provisional, previous string
	for {
		var event sonioxSpeechEvent
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return "", err
		}
		if event.ErrorCode != 0 || event.ErrorType != "" {
			return "", tcylocale.Error("speechProtocol05")
		}
		if event.Tokens != nil {
			var tail strings.Builder
			for _, token := range event.Tokens {
				if token.Text == "<end>" || token.Text == "<fin>" {
					continue
				}
				if token.Final {
					if committed.Len()+len(token.Text) > 2*1024*1024 {
						return "", tcylocale.Error("speechProtocol21")
					}
					committed.WriteString(token.Text)
				} else {
					tail.WriteString(token.Text)
				}
			}
			provisional = tail.String()
		}
		text := committed.String() + provisional
		if event.Finished {
			if !upload.finishing.Load() || provisional != "" {
				return "", tcylocale.Error("speechProtocol22")
			}
			if strings.TrimSpace(text) == "" {
				return "", tcylocale.Error("speechProtocol13")
			}
			if onDelta != nil {
				onDelta(SpeechDelta{
					Text:  text,
					Final: true,
				})
			}
			return text, nil
		}
		if onDelta != nil && previous != text {
			onDelta(SpeechDelta{Text: text})
		}
		previous = text
	}
}

type sonioxSpeechEvent struct {
	Tokens []struct {
		Text  string `json:"text"`
		Final bool   `json:"is_final"`
	} `json:"tokens"`
	Finished  bool   `json:"finished"`
	ErrorCode int    `json:"error_code"`
	ErrorType string `json:"error_type"`
}
