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
	"encoding/binary"
	"errors"
	"net/http"
	"net/url"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"
	"github.com/coder/websocket"
)

type SpeechOptions struct {
	Provider     string   `json:"provider,omitempty" maxLength:"40" doc:"Speech provider preset; empty preserves a custom or legacy connection."`
	Language     string   `json:"language,omitempty" maxLength:"35" doc:"Recognition language hint; empty or auto lets the provider detect it."`
	Prompt       string   `json:"prompt,omitempty" maxLength:"8000" doc:"Optional recognition context, only sent by adapters that support it."`
	Hotwords     []string `json:"hotwords,omitempty" maxItems:"100" doc:"Optional vocabulary hints, only sent by adapters that support them."`
	VocabularyID string   `json:"vocabulary_id,omitempty" maxLength:"200" doc:"Provider-created vocabulary identifier when supported."`
	WorkspaceID  string   `json:"workspace_id,omitempty" maxLength:"100" doc:"Alibaba workspace ID used to resolve the dedicated inference hostname."`
	AppID        string   `json:"app_id,omitempty" maxLength:"200" doc:"Volcengine application ID/app key; the access token is stored in api_key."`
	ResourceID   string   `json:"resource_id,omitempty" maxLength:"200" doc:"Volcengine speech service resource identifier."`
	Disabled     bool     `json:"disabled,omitempty" doc:"Disabled speech connections cannot be used as the default recognizer."`
}

type SpeechDelta struct {
	Text  string
	Final bool
	// A provider may send text before identifying its committed audio item.
	ReceivedAt time.Time
}

const speechResponseLimit = 2 * 1024 * 1024

type SpeechResult struct {
	Text            string `json:"text"`
	Endpoint        string `json:"endpoint"`
	ElapsedMS       int64  `json:"elapsed_ms"`
	AudioDurationMS int64  `json:"audio_duration_ms"`
	FirstTextMS     int64  `json:"first_text_ms"`
}

func isSpeechSocketProtocol(protocol string) bool {
	switch protocol {
	case "dashscope-asr", "qwen-asr-realtime", "volcengine-asr", "openai-realtime", "elevenlabs-realtime", "soniox-realtime":
		return true
	}
	return false
}

func isNativeSpeechProtocol(protocol string) bool {
	return isSpeechSocketProtocol(protocol) || protocol == "dashscope-file-asr" ||
		protocol == "elevenlabs-transcription" || protocol == "mimo-asr" || protocol == "sensevoice"
}

func speechBase(c Connection) string {
	base := c.BaseURL
	if c.Speech != nil {
		base = strings.ReplaceAll(base, "{workspace_id}", c.Speech.WorkspaceID)
	}
	return strings.TrimRight(base, "/")
}

func speechEndpoint(c Connection) string {
	base := speechBase(c)
	suffix := map[string]string{
		"dashscope-asr":            "/api-ws/v1/inference",
		"qwen-asr-realtime":        "/api-ws/v1/realtime",
		"dashscope-file-asr":       "/api/v1/services/aigc/multimodal-generation/generation",
		"volcengine-asr":           "/api/v3/sauc/bigmodel",
		"openai-realtime":          "/realtime",
		"elevenlabs-realtime":      "/speech-to-text/realtime",
		"elevenlabs-transcription": "/speech-to-text",
		"soniox-realtime":          "/transcribe-websocket",
		"mimo-asr":                 "/chat/completions",
		"sensevoice":               "/api/v1/asr",
	}[c.EffectiveProtocol()]
	completeVolcengine := c.EffectiveProtocol() == "volcengine-asr" &&
		(strings.HasSuffix(base, "/api/v3/sauc/bigmodel_async") || strings.HasSuffix(base, "/api/v3/sauc/bigmodel_nostream"))
	if !strings.HasSuffix(base, suffix) && !completeVolcengine {
		base += suffix
	}
	if isSpeechSocketProtocol(c.EffectiveProtocol()) {
		base = strings.Replace(base, "https://", "wss://", 1)
	}
	u, err := url.Parse(base)
	if err != nil {
		return base
	}
	q := u.Query()
	switch c.EffectiveProtocol() {
	case "openai-realtime":
		q.Set("intent", "transcription")
	case "qwen-asr-realtime":
		q.Set("model", c.Model)
	case "elevenlabs-realtime":
		q.Set("model_id", c.Model)
		q.Set("audio_format", "pcm_16000")
		q.Set("commit_strategy", "manual")
		if c.Speech != nil && c.Speech.Language != "" && c.Speech.Language != "auto" {
			q.Set("language_code", c.Speech.Language)
		}
		if c.Speech != nil {
			for _, word := range c.Speech.Hotwords {
				q.Add("keyterms", word)
			}
		}
	}
	u.RawQuery = q.Encode()
	return u.String()
}

func validateSpeech(c Connection) error {
	if c.Speech == nil {
		return nil
	}
	if c.Kind != "transcription" {
		return tcylocale.Error("speechOptions")
	}
	s := c.Speech
	if strings.ContainsAny(s.WorkspaceID, "/\\?#@:.{} \t\r\n") {
		return tcylocale.Error("speechOptions")
	}
	if strings.Contains(c.BaseURL, "{workspace_id}") && s.WorkspaceID == "" {
		return tcylocale.Error("speechWorkspace")
	}
	if len(s.Hotwords) > 100 {
		return tcylocale.Error("speechOptions")
	}
	for _, word := range s.Hotwords {
		if strings.TrimSpace(word) == "" || len([]rune(word)) > 200 || strings.ContainsAny(word, "<>\r\n") {
			return tcylocale.Error("speechOptions")
		}
	}
	return nil
}

func dialSpeechSocket(ctx context.Context, endpoint string, headers http.Header) (*websocket.Conn, func(), error) {
	client, release := providerClient(ctx)
	conn, response, err := websocket.Dial(ctx, endpoint, &websocket.DialOptions{
		HTTPClient: client,
		HTTPHeader: headers,
	})
	if err != nil {
		release()
		if ctx.Err() != nil {
			return nil, func() {}, ctx.Err()
		}
		if response != nil && response.Body != nil {
			defer response.Body.Close()
			// Recognition errors can echo private audio or the supplied credentials.
			return nil, func() {}, tcylocale.Error("speechHTTPStatus", response.StatusCode)
		}
		return nil, func() {}, tcylocale.Error("e26")
	}
	conn.SetReadLimit(speechResponseLimit)
	return conn, func() {
		_ = conn.CloseNow()
		release()
	}, nil
}

// Parse the bytes, not the extension: MediaRecorder's WebM is not raw Opus or PCM.
func preparePCMSpeechAudio(_ string, audio []byte) ([]byte, int, error) {
	invalid := tcylocale.Error("speechPCM")
	if len(audio) < 44 || string(audio[:4]) != "RIFF" || string(audio[8:12]) != "WAVE" {
		return nil, 0, invalid
	}
	end := int64(binary.LittleEndian.Uint32(audio[4:8])) + 8
	if end > int64(len(audio)) || end < 44 {
		return nil, 0, invalid
	}
	var pcm []byte
	var rate int
	validFormat := false
	for offset := int64(12); offset+8 <= end; {
		length := int64(binary.LittleEndian.Uint32(audio[offset+4 : offset+8]))
		start := offset + 8
		if length > end-start {
			return nil, 0, invalid
		}
		switch string(audio[offset : offset+4]) {
		case "fmt ":
			if length < 16 {
				return nil, 0, invalid
			}
			format := audio[start : start+16]
			rate = int(binary.LittleEndian.Uint32(format[4:8]))
			validFormat = binary.LittleEndian.Uint16(format[:2]) == 1 &&
				binary.LittleEndian.Uint16(format[2:4]) == 1 &&
				binary.LittleEndian.Uint16(format[12:14]) == 2 &&
				binary.LittleEndian.Uint16(format[14:16]) == 16 &&
				(rate == 8000 || rate == 16000 || rate == 24000 || rate == 48000) &&
				binary.LittleEndian.Uint32(format[8:12]) == uint32(rate*2)
		case "data":
			if pcm != nil || length == 0 || length%2 != 0 {
				return nil, 0, invalid
			}
			pcm = audio[start : start+length]
		}
		offset = start + length + length%2
	}
	if !validFormat || len(pcm) == 0 {
		return nil, 0, invalid
	}
	return pcm, rate, nil
}

func RecognizeSpeech(ctx context.Context, c Connection, filename string, audio []byte) (SpeechResult, error) {
	start := time.Now()
	result := SpeechResult{Endpoint: Endpoint(c)}
	if c.Speech != nil && c.Speech.Disabled {
		return result, tcylocale.Error("speechDisabled")
	}
	if len(audio) == 0 || len(audio) > 16*1024*1024 {
		return result, tcylocale.Error("speechSize")
	}
	if pcm, rate, err := preparePCMSpeechAudio(filename, audio); err == nil {
		result.AudioDurationMS = int64(len(pcm)) * 1000 / int64(rate*2)
	}
	// This is an explicit speech-request deadline, not a text-model output cap.
	ctx, cancel := context.WithTimeout(ctx, 10*time.Minute)
	defer cancel()
	onDelta := func(delta SpeechDelta) {
		if result.FirstTextMS == 0 && strings.TrimSpace(delta.Text) != "" {
			at := delta.ReceivedAt
			if at.IsZero() {
				at = time.Now()
			}
			result.FirstTextMS = max(1, at.Sub(start).Milliseconds())
		}
	}
	var err error
	switch c.EffectiveProtocol() {
	case "dashscope-asr":
		result.Text, err = transcribeDashScope(ctx, c, filename, audio, onDelta)
	case "qwen-asr-realtime":
		result.Text, err = transcribeQwenRealtime(ctx, c, filename, audio, onDelta)
	case "volcengine-asr":
		result.Text, err = transcribeVolcengine(ctx, c, filename, audio, onDelta)
	case "elevenlabs-realtime":
		result.Text, err = transcribeElevenLabsRealtime(ctx, c, filename, audio, onDelta)
	case "elevenlabs-transcription":
		result.Text, err = transcribeElevenLabs(ctx, c, filename, audio, onDelta)
	case "soniox-realtime":
		result.Text, err = transcribeSoniox(ctx, c, filename, audio, onDelta)
	case "openai-realtime":
		result.Text, err = transcribeOpenAIRealtime(ctx, c, filename, audio, onDelta)
	case "mimo-asr", "dashscope-file-asr", "sensevoice":
		result.Text, err = transcribeSpeechHTTP(ctx, c, filename, audio)
	default:
		result.Text, err = transcribeLegacy(ctx, c, filename, audio)
	}
	result.ElapsedMS = time.Since(start).Milliseconds()
	if err == nil && strings.TrimSpace(result.Text) == "" {
		err = tcylocale.Error("e34")
	}
	if err != nil && ctx.Err() != nil && !errors.Is(err, context.Canceled) {
		err = ctx.Err()
	}
	if err != nil {
		var localized *tcylocale.LocalizedError
		var streamError *ProviderStreamError
		if errors.As(err, &localized) && localized.Key == "tcymc.errors.chatUpstream" && len(localized.Args) > 0 {
			err = tcylocale.Error("speechHTTPStatus", localized.Args[0])
		} else if errors.As(err, &streamError) {
			err = tcylocale.Error("speechProviderRejected")
		}
	}
	return result, err
}
