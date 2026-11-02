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
	"io"
	"mime/multipart"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"
)

func transcribeSpeechHTTP(ctx context.Context, c Connection, filename string, audio []byte) (string, error) {
	if c.EffectiveProtocol() == "sensevoice" {
		return transcribeSenseVoice(ctx, c, filename, audio)
	}
	format := strings.TrimPrefix(strings.ToLower(filepath.Ext(filename)), ".")
	if format != "wav" && format != "mp3" {
		return "", tcylocale.Error("e5")
	}
	mediaType := "audio/wav"
	if format == "mp3" {
		mediaType = "audio/mpeg"
	}
	inputAudio := map[string]any{
		"data": "data:" + mediaType + ";base64," + base64.StdEncoding.EncodeToString(audio),
	}
	content := []any{map[string]any{
		"type":        "input_audio",
		"input_audio": inputAudio,
	}}
	messages := []any{map[string]any{
		"role":    "user",
		"content": content,
	}}
	body := map[string]any{
		"model": c.Model,
	}
	if c.EffectiveProtocol() == "mimo-asr" {
		inputAudio["format"] = format
		body["messages"] = messages
		body["stream"] = !c.NonStreaming
		if c.Speech != nil && c.Speech.Language != "" {
			body["asr_options"] = map[string]any{"language": c.Speech.Language}
		}
	} else {
		parameters := map[string]any{"format": format}
		if _, rate, err := preparePCMSpeechAudio(filename, audio); err == nil {
			parameters["sample_rate"] = rate
		}
		if c.Speech != nil {
			s := c.Speech
			if s.Language != "" && s.Language != "auto" {
				parameters["language_hints"] = []string{s.Language}
			}
			if s.VocabularyID != "" {
				parameters["vocabulary_id"] = s.VocabularyID
			}
			contextText := strings.TrimSpace(strings.Join(append([]string{s.Prompt}, s.Hotwords...), " "))
			if len([]rune(contextText)) > 400 {
				return "", tcylocale.Error("speechContextLimit", 400)
			}
			if contextText != "" {
				messages = append([]any{map[string]any{
					"role": "user",
					"content": []any{map[string]any{
						"type": "input_text",
						"text": contextText,
					}},
				}}, messages...)
			}
		}
		body["input"] = map[string]any{"messages": messages}
		body["parameters"] = parameters
		c.NonStreaming = true
	}
	encoded, err := json.Marshal(body)
	if err != nil {
		return "", err
	}
	endpoint := Endpoint(c)
	c.BaseURL = endpoint
	var response struct {
		Output struct {
			Text string `json:"text"`
		} `json:"output"`
		Choices []struct {
			Message struct {
				Content string `json:"content"`
			} `json:"message"`
		} `json:"choices"`
	}
	if err = requestSpeechHTTP(ctx, c, "application/json", bytes.NewReader(encoded), &response); err != nil {
		return "", err
	}
	if c.EffectiveProtocol() == "mimo-asr" && len(response.Choices) > 0 {
		return response.Choices[0].Message.Content, nil
	}
	return response.Output.Text, nil
}

// SenseVoice's own FastAPI contract uses files/lang and result[], not OpenAI fields.
func transcribeSenseVoice(ctx context.Context, c Connection, filename string, audio []byte) (string, error) {
	var body bytes.Buffer
	writer := multipart.NewWriter(&body)
	language := "auto"
	if c.Speech != nil && c.Speech.Language != "" {
		language = c.Speech.Language
	}
	if err := writer.WriteField("lang", language); err != nil {
		return "", err
	}
	if err := writer.WriteField("use_itn", "true"); err != nil {
		return "", err
	}
	part, err := writer.CreateFormFile("files", filepath.Base(filename))
	if err != nil {
		return "", err
	}
	if _, err = part.Write(audio); err != nil {
		return "", err
	}
	if err = writer.Close(); err != nil {
		return "", err
	}
	var response struct {
		Result []struct {
			Text string `json:"text"`
		} `json:"result"`
	}
	c.BaseURL = Endpoint(c)
	c.NonStreaming = true
	if err = requestSpeechHTTP(ctx, c, writer.FormDataContentType(), &body, &response); err != nil {
		return "", err
	}
	texts := make([]string, 0, len(response.Result))
	for _, item := range response.Result {
		if strings.TrimSpace(item.Text) != "" {
			texts = append(texts, item.Text)
		}
	}
	return strings.Join(texts, "\n"), nil
}

// Keep private recognition errors out of saved diagnostics and bound decoded output.
// LLM requests retain their richer error handling in request().
func requestSpeechHTTP(ctx context.Context, c Connection, contentType string, body io.Reader, target any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, c.BaseURL, body)
	if err != nil {
		return tcylocale.Error("e38")
	}
	req.Header.Set("Content-Type", contentType)
	if c.APIKey != "" {
		req.Header.Set("Authorization", "Bearer "+c.APIKey)
	}
	client, release := providerClient(ctx)
	defer release()
	resp, err := client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return ctx.Err()
		}
		return tcylocale.Error("e26")
	}
	defer resp.Body.Close()
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return tcylocale.Error("speechHTTPStatus", resp.StatusCode)
	}
	reader := &io.LimitedReader{R: resp.Body, N: speechResponseLimit + 1}
	var raw []byte
	if strings.Contains(resp.Header.Get("Content-Type"), "text/event-stream") {
		raw, err = readStream(reader, "openai-chat", &observation{start: time.Now()})
	} else {
		raw, err = io.ReadAll(reader)
	}
	if ctx.Err() != nil {
		return ctx.Err()
	}
	if reader.N == 0 || len(raw) > speechResponseLimit {
		return tcylocale.Error("speechTranscriptSize")
	}
	if err != nil {
		return tcylocale.Error("speechStream")
	}
	if json.Unmarshal(raw, target) != nil {
		return tcylocale.Error("speechStream")
	}
	return nil
}
