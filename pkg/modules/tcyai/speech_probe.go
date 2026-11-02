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
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"

	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
)

// TestSpeechConnection validates a real model session without submitting audio.
// It does not claim that recognition quality or uploaded audio has been tested.
func TestSpeechConnection(ctx context.Context, c Connection) (result SpeechResult, err error) {
	started := time.Now()
	result.Endpoint = Endpoint(c)
	defer func() { result.ElapsedMS = time.Since(started).Milliseconds() }()
	if c.Speech != nil && c.Speech.Disabled {
		return result, tcylocale.Error("speechDisabled")
	}
	if c.Kind != "transcription" {
		return result, tcylocale.Error("speechOptions")
	}
	if c.EffectiveProtocol() != "dashscope-asr" && c.EffectiveProtocol() != "qwen-asr-realtime" {
		return result, tcylocale.Error("speechProbeUnsupported")
	}
	if err = validateConnection(&c, map[string]bool{}); err != nil {
		return result, err
	}
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if c.EffectiveProtocol() == "dashscope-asr" {
		return result, probeDashScopeSpeech(ctx, c)
	}
	return result, probeQwenSpeech(ctx, c)
}

// Both probes wait for the provider's terminal acknowledgement and then close
// their socket. The deadline and event bound also cover malformed/flooding peers.
func probeDashScopeSpeech(ctx context.Context, c Connection) error {
	payload, err := dashSpeechPayload(c, 16000)
	if err != nil {
		return err
	}
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), speechHeaders(c))
	if err != nil {
		return err
	}
	defer cleanup()
	taskID := uuid.NewString()
	if err = wsjson.Write(ctx, socket, dashSpeechCommand(taskID, "run-task", payload)); err != nil {
		return speechStreamError(ctx)
	}
	started := false
	for range 64 {
		var event dashSpeechEvent
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return err
		}
		if event.Header.TaskID != taskID {
			return tcylocale.Error("speechProtocol01")
		}
		switch event.Header.Event {
		case "task-started":
			if started {
				return tcylocale.Error("speechProtocol10")
			}
			started = true
			if err = wsjson.Write(ctx, socket, dashSpeechCommand(taskID, "finish-task", map[string]any{"input": map[string]any{}})); err != nil {
				return speechStreamError(ctx)
			}
		case "task-finished":
			if !started {
				return tcylocale.Error("speechProtocol10")
			}
			return nil
		case "task-failed":
			return tcylocale.Error("speechProtocol05")
		}
	}
	return tcylocale.Error("speechProtocol10")
}

// session.finish explicitly supports sessions with no detected speech:
// https://help.aliyun.com/zh/model-studio/qwen-asr-realtime-client-events
func probeQwenSpeech(ctx context.Context, c Connection) error {
	socket, cleanup, err := dialSpeechSocket(ctx, Endpoint(c), speechHeaders(c))
	if err != nil {
		return err
	}
	defer cleanup()
	if err = wsjson.Write(ctx, socket, map[string]any{
		"event_id": uuid.NewString(),
		"type":     "session.update",
		"session":  qwenSpeechSession(c, 16000),
	}); err != nil {
		return speechStreamError(ctx)
	}
	updated := false
	for range 64 {
		var event qwenSpeechEvent
		if err = readSpeechEvent(ctx, socket, &event); err != nil {
			return err
		}
		switch event.Type {
		case "session.updated":
			if updated {
				return tcylocale.Error("speechProtocol10")
			}
			updated = true
			// An empty audio buffer must not be committed; finish the empty session.
			if err = writeQwenSpeechAction(ctx, socket, "session.finish"); err != nil {
				return speechStreamError(ctx)
			}
		case "session.finished":
			if !updated {
				return tcylocale.Error("speechProtocol10")
			}
			return nil
		case "error", "conversation.item.input_audio_transcription.failed":
			return tcylocale.Error("speechProtocol05")
		}
	}
	return tcylocale.Error("speechProtocol10")
}
