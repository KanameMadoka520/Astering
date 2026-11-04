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
	"encoding/json"
	"fmt"
	"strings"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
)

func toolCall(id, name string, args json.RawMessage) ToolCall {
	c := ToolCall{ID: id, Type: "function"}
	c.Function.Name = name
	c.Function.Arguments = string(args)
	return c
}

func responsesChat(ctx context.Context, c Connection, messages []Message, tools []map[string]any) (Message, error) {
	input := []any{}
	for _, m := range messages {
		if len(m.Native) > 0 {
			var items []json.RawMessage
			if err := json.Unmarshal(m.Native, &items); err != nil {
				return Message{}, err
			}
			for _, item := range items {
				input = append(input, item)
			}
			continue
		}
		if m.Role == "tool" {
			input = append(input, map[string]any{"type": "function_call_output", "call_id": m.ToolCallID, "output": m.Content})
			continue
		}
		var content any = m.Content
		if len(m.imageData) > 0 {
			parts := []any{map[string]any{"type": "input_text", "text": m.Content}}
			for _, image := range m.imageData {
				parts = append(parts, map[string]any{"type": "input_image", "image_url": image.dataURL()})
			}
			content = parts
		}
		input = append(input, map[string]any{"role": m.Role, "content": content})
	}
	req := map[string]any{"model": c.Model, "input": input, "store": false, "include": []string{"reasoning.encrypted_content"}}
	if limit := c.Capabilities().MaxOutputTokens; limit > 0 {
		req["max_output_tokens"] = limit
	}
	if len(tools) > 0 {
		defs := []any{}
		for _, t := range tools {
			f := t["function"].(map[string]any)
			defs = append(defs, map[string]any{"type": "function", "name": f["name"], "description": f["description"], "parameters": f["parameters"], "strict": false})
		}
		req["tools"] = defs
	}
	var response struct {
		Output     json.RawMessage `json:"output"`
		Status     string          `json:"status"`
		Incomplete struct {
			Reason string `json:"reason"`
		} `json:"incomplete_details"`
	}
	if err := requestJSON(ctx, c, req, &response); err != nil {
		return Message{}, err
	}
	var items []struct {
		Type      string `json:"type"`
		CallID    string `json:"call_id"`
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
		Content   []struct {
			Type string `json:"type"`
			Text string `json:"text"`
		} `json:"content"`
	}
	if err := json.Unmarshal(response.Output, &items); err != nil {
		return Message{}, tcylocale.Error("e8")
	}
	m := Message{Role: "assistant", Native: response.Output}
	for _, item := range items {
		if item.Type == "function_call" {
			m.ToolCalls = append(m.ToolCalls, toolCall(item.CallID, item.Name, json.RawMessage(item.Arguments)))
		}
		for _, part := range item.Content {
			if part.Type == "output_text" {
				m.Content += part.Text
			}
		}
	}
	if response.Incomplete.Reason == "max_output_tokens" {
		return Message{}, tcylocale.Error("chatOutputLimit")
	}
	if response.Status == "incomplete" || response.Status == "failed" {
		return Message{}, tcylocale.Error("e10")
	}
	return checkMessage(m)
}

type anthropicTurn struct {
	Role    string            `json:"role"`
	Content []json.RawMessage `json:"content"`
}

func rawPart(v any) (json.RawMessage, error) { return json.Marshal(v) }
func anthropicChat(ctx context.Context, c Connection, messages []Message, tools []map[string]any) (Message, error) {
	turns := []anthropicTurn{}
	system := ""
	for _, m := range messages {
		if m.Role == "system" {
			system += m.Content + "\n"
			continue
		}
		role := m.Role
		var parts []json.RawMessage
		if len(m.Native) > 0 {
			if err := json.Unmarshal(m.Native, &parts); err != nil {
				return Message{}, err
			}
		} else {
			part := map[string]any{"type": "text", "text": m.Content}
			if role == "tool" {
				role = "user"
				part = map[string]any{"type": "tool_result", "tool_use_id": m.ToolCallID, "content": m.Content}
			}
			raw, err := rawPart(part)
			if err != nil {
				return Message{}, err
			}
			parts = []json.RawMessage{raw}
			for _, image := range m.imageData {
				part, err := rawPart(map[string]any{"type": "image", "source": map[string]any{"type": "base64", "media_type": image.MIME, "data": image.Data}})
				if err != nil {
					return Message{}, err
				}
				parts = append(parts, part)
			}
		}
		if len(turns) > 0 && turns[len(turns)-1].Role == role {
			turns[len(turns)-1].Content = append(turns[len(turns)-1].Content, parts...)
		} else {
			turns = append(turns, anthropicTurn{Role: role, Content: parts})
		}
	}
	req := map[string]any{"model": c.Model, "system": system, "messages": turns, "max_tokens": c.Capabilities().MaxOutputTokens}
	if len(tools) > 0 {
		defs := []any{}
		for _, t := range tools {
			f := t["function"].(map[string]any)
			defs = append(defs, map[string]any{"name": f["name"], "description": f["description"], "input_schema": f["parameters"]})
		}
		req["tools"] = defs
	}
	var response struct {
		Content json.RawMessage `json:"content"`
		Stop    string          `json:"stop_reason"`
	}
	if err := requestJSON(ctx, c, req, &response); err != nil {
		return Message{}, err
	}
	var parts []struct {
		Type  string          `json:"type"`
		Text  string          `json:"text"`
		ID    string          `json:"id"`
		Name  string          `json:"name"`
		Input json.RawMessage `json:"input"`
	}
	if err := json.Unmarshal(response.Content, &parts); err != nil {
		return Message{}, tcylocale.Error("e6")
	}
	m := Message{Role: "assistant", Native: response.Content}
	for _, p := range parts {
		switch p.Type {
		case "text":
			m.Content += p.Text
		case "tool_use":
			m.ToolCalls = append(m.ToolCalls, toolCall(p.ID, p.Name, p.Input))
		}
	}
	if response.Stop == "max_tokens" {
		return Message{}, tcylocale.Error("chatOutputLimit")
	}
	return checkMessage(m)
}

type geminiTurn struct {
	Role  string            `json:"role"`
	Parts []json.RawMessage `json:"parts"`
}

func geminiChat(ctx context.Context, c Connection, messages []Message, tools []map[string]any, audio map[string]any) (Message, error) {
	turns := []geminiTurn{}
	system := ""
	names := map[string]string{}
	for _, m := range messages {
		if m.Role == "system" {
			system += m.Content + "\n"
			continue
		}
		for _, call := range m.ToolCalls {
			names[call.ID] = call.Function.Name
		}
		role := m.Role
		if role == "assistant" {
			role = "model"
		}
		var parts []json.RawMessage
		if len(m.Native) > 0 {
			if err := json.Unmarshal(m.Native, &parts); err != nil {
				return Message{}, err
			}
		} else {
			part := map[string]any{"text": m.Content}
			if role == "tool" {
				role = "user"
				f := map[string]any{"name": names[m.ToolCallID], "response": map[string]any{"result": m.Content}}
				if !strings.HasPrefix(m.ToolCallID, "gemini-call-") {
					f["id"] = m.ToolCallID
				}
				part = map[string]any{"functionResponse": f}
			}
			raw, err := rawPart(part)
			if err != nil {
				return Message{}, err
			}
			parts = []json.RawMessage{raw}
			parts = append(parts, geminiImageParts(m.imageData)...)
		}
		if len(turns) > 0 && turns[len(turns)-1].Role == role {
			turns[len(turns)-1].Parts = append(turns[len(turns)-1].Parts, parts...)
		} else {
			turns = append(turns, geminiTurn{Role: role, Parts: parts})
		}
	}
	if audio != nil && len(turns) > 0 {
		raw, err := rawPart(audio)
		if err != nil {
			return Message{}, err
		}
		turns[len(turns)-1].Parts = append(turns[len(turns)-1].Parts, raw)
	}
	req := map[string]any{"contents": turns}
	if limit := c.Capabilities().MaxOutputTokens; limit > 0 {
		req["generationConfig"] = map[string]any{"maxOutputTokens": limit}
	}
	if system != "" {
		req["systemInstruction"] = map[string]any{"parts": []any{map[string]string{"text": system}}}
	}
	if len(tools) > 0 {
		defs := []any{}
		for _, t := range tools {
			f := t["function"].(map[string]any)
			defs = append(defs, map[string]any{"name": f["name"], "description": f["description"], "parametersJsonSchema": f["parameters"]})
		}
		req["tools"] = []any{map[string]any{"functionDeclarations": defs}}
	}
	var response struct {
		Candidates []struct {
			Content struct {
				Parts json.RawMessage `json:"parts"`
			} `json:"content"`
			Finish string `json:"finishReason"`
		} `json:"candidates"`
	}
	if err := requestJSON(ctx, c, req, &response); err != nil {
		return Message{}, err
	}
	if len(response.Candidates) == 0 {
		return Message{}, tcylocale.Error("e9")
	}
	candidate := response.Candidates[0]
	if candidate.Finish == "MAX_TOKENS" {
		return Message{}, tcylocale.Error("chatOutputLimit")
	}
	if candidate.Finish != "" && candidate.Finish != "STOP" {
		return Message{}, tcylocale.Error("e10")
	}
	var parts []struct {
		Text    string `json:"text"`
		Thought bool   `json:"thought"`
		Call    *struct {
			ID   string          `json:"id"`
			Name string          `json:"name"`
			Args json.RawMessage `json:"args"`
		} `json:"functionCall"`
	}
	if err := json.Unmarshal(candidate.Content.Parts, &parts); err != nil {
		return Message{}, tcylocale.Error("e7")
	}
	m := Message{Role: "assistant", Native: candidate.Content.Parts}
	for n, p := range parts {
		if !p.Thought {
			m.Content += p.Text
		}
		if p.Call != nil {
			id := p.Call.ID
			if id == "" {
				id = fmt.Sprintf("gemini-call-%d", n)
			}
			m.ToolCalls = append(m.ToolCalls, toolCall(id, p.Call.Name, p.Call.Args))
		}
	}
	return checkMessage(m)
}
func checkMessage(m Message) (Message, error) {
	if strings.TrimSpace(m.Content) == "" && len(m.ToolCalls) == 0 {
		return m, tcylocale.Error("e9")
	}
	return m, nil
}

func geminiImageParts(images []imagePayload) []json.RawMessage {
	out := make([]json.RawMessage, 0, len(images))
	for _, p := range images {
		//nolint:errchkjson // Both map levels contain only strings, so encoding cannot fail.
		raw, _ := json.Marshal(map[string]map[string]string{"inlineData": {"mimeType": p.MIME, "data": p.Data}})
		out = append(out, raw)
	}
	return out
}
