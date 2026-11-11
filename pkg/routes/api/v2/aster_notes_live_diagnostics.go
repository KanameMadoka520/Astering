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

package apiv2

import (
	"context"
	"errors"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
)

const liveNoteMaxBufferedSeconds = 30

var (
	errLiveNoteInvalidAudio   = errors.New("invalid live note audio")
	errLiveNoteInvalidCommand = errors.New("invalid live note command")
	errLiveNoteSaveFailed     = errors.New("live note transcript save failed")
)

// The client captures at 1x and drains a bounded 30-second queue at at most 2x.
// Keep both the catch-up speed and the total lead bounded; a 6-second lead would
// reject a legitimate longer queue halfway through reconnecting.
func liveNoteAllowedAudioBytes(elapsed time.Duration, rate int) int64 {
	elapsed = max(0, elapsed)
	bytesPerSecond := int64(rate) * 2
	realtime := int64(elapsed) * bytesPerSecond / int64(time.Second)
	return min(2*realtime+tcyai.MaxLiveSpeechFrameBytes, realtime+bytesPerSecond*liveNoteMaxBufferedSeconds)
}

type liveNoteDiagnostics struct {
	ElapsedMS      int64 `json:"elapsed_ms"`
	ReceivedBytes  int64 `json:"received_bytes"`
	AudioDuration  int64 `json:"audio_duration_ms"`
	LastAudioMS    int64 `json:"last_audio_ms"`
	PartialUpdates int64 `json:"partial_updates"`
	SavedSegments  int64 `json:"saved_segments"`
	FirstTextMS    int64 `json:"first_text_ms"`
	LastTextMS     int64 `json:"last_text_ms"`
}

// Metadata only: never retain audio, recognized text, model context, API keys,
// user-provided connection names, or URLs in the diagnostic/log record.
type liveNoteProgress struct {
	started        time.Time
	rate           int
	providerReady  atomic.Bool
	receivedBytes  atomic.Int64
	lastAudioMS    atomic.Int64
	partialUpdates atomic.Int64
	savedSegments  atomic.Int64
	firstTextMS    atomic.Int64
	lastTextMS     atomic.Int64
}

func liveNoteFailureMessage(ctx context.Context, err error, provider tcyai.SpeechProviderDiagnostic, progress *liveNoteProgress) string {
	message := tcyai.ExplainError(ctx, err)
	if progress != nil && progress.providerReady.Load() && progress.receivedBytes.Load() == 0 &&
		(provider.Code == "CLIENT_ERROR" || provider.Code == "TIMEOUT") {
		message += "\n" + tcylocale.Render(ctx, tcylocale.Error("speechLiveNoAudio"))
	}
	return message
}

func (p *liveNoteProgress) failureEvent(ctx context.Context, err error, readDone <-chan error, requestID string) (status string, provider tcyai.SpeechProviderDiagnostic, event map[string]any) {
	provider = tcyai.SpeechProviderErrorDiagnostic(err)
	status = "provider_error"
	code, message := "provider", liveNoteFailureMessage(ctx, err, provider, p)
	select {
	case readErr := <-readDone:
		if errors.Is(readErr, errLiveNoteInvalidAudio) || errors.Is(readErr, errLiveNoteInvalidCommand) {
			status = "invalid_audio"
			code, message = "invalid_audio", tcylocale.Render(ctx, tcylocale.Error("speechLiveUpload"))
		} else if ctx.Err() != nil {
			return "client_closed", provider, nil
		}
	default:
		if ctx.Err() != nil {
			return "canceled", provider, nil
		}
	}
	if errors.Is(err, errLiveNoteSaveFailed) {
		return "save_failed", provider, nil // The sink already sent the text for manual recovery.
	}
	return status, provider, map[string]any{
		"type":                "error",
		"code":                code,
		"message":             message,
		"request_id":          requestID,
		"provider_code":       provider.Code,
		"provider_request_id": provider.RequestID,
		"provider_task_id":    provider.TaskID,
		"diagnostics":         p.snapshot(),
	}
}

func (p *liveNoteProgress) received(size int) {
	if p == nil {
		return
	}
	p.receivedBytes.Add(int64(size))
	p.lastAudioMS.Store(max(1, time.Since(p.started).Milliseconds()))
}

func (p *liveNoteProgress) transcript(final bool, hasText bool) {
	if p == nil || !hasText {
		return
	}
	now := max(1, time.Since(p.started).Milliseconds())
	p.firstTextMS.CompareAndSwap(0, now)
	p.lastTextMS.Store(now)
	if !final {
		p.partialUpdates.Add(1)
	}
}

func (p *liveNoteProgress) snapshot() liveNoteDiagnostics {
	if p == nil {
		return liveNoteDiagnostics{}
	}
	bytes := p.receivedBytes.Load()
	return liveNoteDiagnostics{
		ElapsedMS:      time.Since(p.started).Milliseconds(),
		ReceivedBytes:  bytes,
		AudioDuration:  bytes * 1000 / int64(p.rate*2),
		LastAudioMS:    p.lastAudioMS.Load(),
		PartialUpdates: p.partialUpdates.Load(),
		SavedSegments:  p.savedSegments.Load(),
		FirstTextMS:    p.firstTextMS.Load(),
		LastTextMS:     p.lastTextMS.Load(),
	}
}

func (p *liveNoteProgress) log(requestID string, uid, noteID int64, protocol, status string, provider tcyai.SpeechProviderDiagnostic) {
	if !log.IsInitialized() {
		return
	}
	d := p.snapshot()
	log.Infof("notes.live request_id=%s user_id=%d note_id=%d protocol=%s status=%s elapsed_ms=%d received_bytes=%d audio_duration_ms=%d last_audio_ms=%d partial_updates=%d saved_segments=%d first_text_ms=%d last_text_ms=%d provider_code=%s provider_request_id=%s provider_task_id=%s",
		requestID, uid, noteID, protocol, status, d.ElapsedMS, d.ReceivedBytes, d.AudioDuration,
		d.LastAudioMS, d.PartialUpdates, d.SavedSegments, d.FirstTextMS, d.LastTextMS,
		provider.Code, provider.RequestID, provider.TaskID)
}
