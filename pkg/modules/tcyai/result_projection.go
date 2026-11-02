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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"unicode/utf8"
)

// Audits retain the complete result. Only model-facing payloads are projected;
// a valid JSON envelope always explains where omitted content can be read.
func modelToolResult(name string, raw json.RawMessage, data, ref string) string {
	projected := compactToolResult(name, raw, data)
	if name == "read_tool_result" {
		return projected
	}
	// Discovery already bounds its catalog selection. Cutting its structured
	// contracts would tell the model a tool is loaded without usable parameters.
	needsPreview := name != "find_tools" && name != "find_mcp_tools" && utf8.RuneCountInString(projected) > 16000
	decode := json.Unmarshal
	if isMCPAgentTool(name) {
		decode = mcpDecodeJSON
	}
	var result any
	if needsPreview {
		var original map[string]any
		_ = decode([]byte(projected), &original)
		preview := selectFields(original, "id", "title", "project_id", "total", "page", "per_page", "total_pages", "success", "code", "message", "retryable", "source", "untrusted")
		preview["preview"] = string([]rune(projected)[:16000])
		preview["preview_is_partial"] = true
		preview["details_omitted"] = true
		result = preview
	} else if decode([]byte(projected), &result) != nil {
		result = map[string]any{"text": projected}
	}
	// Wrapping arrays rather than mutating them keeps paged/array contracts valid.
	object, ok := result.(map[string]any)
	if !ok {
		object = map[string]any{"result": result}
	}
	if ref != "" {
		object["result_ref"] = ref
	}
	if projected != data || needsPreview {
		if ref != "" {
			object["read_more"] = "read_tool_result"
		} else {
			object["read_more"] = "Query the source tool again for details; this legacy audit has no result reference."
		}
	}
	encoded, err := json.Marshal(object)
	if err != nil {
		return projected
	}
	return string(encoded)
}

func compactChangedFields(fields map[string]any) map[string]any {
	for key, value := range fields {
		if text, ok := value.(string); ok && len([]rune(text)) > 512 {
			digest := sha256.Sum256([]byte(text))
			fields[key] = map[string]any{"stored": true, "characters": len([]rune(text)), "sha256": hex.EncodeToString(digest[:])}
		}
	}
	return fields
}

func compactActions(actions []Action) []map[string]any {
	out := make([]map[string]any, 0, len(actions))
	for _, action := range actions {
		var args map[string]any
		decode := json.Unmarshal
		if isMCPAgentTool(action.Tool) {
			decode = mcpDecodeJSON
		}
		_ = decode([]byte(action.Arguments), &args)
		out = append(out, map[string]any{"tool": action.Tool, "arguments": compactChangedFields(args), "success": action.Success, "result": modelToolResult(action.Tool, json.RawMessage(action.Arguments), action.Result, action.ResultRef)})
	}
	return out
}

func compactReceipts(receipts []Operation) []map[string]any {
	out := make([]map[string]any, 0, len(receipts))
	for _, op := range receipts {
		out = append(out, map[string]any{"id": op.ID, "tool": op.Tool, "status": op.Status, "verified": op.Verified, "error_code": op.ErrorCode, "project_ids": op.ProjectIDs})
	}
	return out
}

// Joined worker receipts belong to the same conversation and stay readable after replay.
func findToolResult(result RunResult, ref, part string) (string, bool) {
	find := func(actions []Action) (string, bool) {
		for _, action := range actions {
			if action.ResultRef == ref {
				if part == "arguments" {
					return action.Arguments, true
				}
				return action.Result, true
			}
		}
		return "", false
	}
	if data, ok := find(result.Actions); ok {
		return data, true
	}
	for _, child := range result.Subagents {
		if data, ok := find(child.Actions); ok {
			return data, true
		}
	}
	return "", false
}

func (state *AgentState) readToolResult(raw json.RawMessage) (string, error) {
	var args struct {
		Ref      string `json:"result_ref"`
		Part     string `json:"part"`
		Offset   int    `json:"offset"`
		MaxChars int    `json:"max_chars"`
	}
	if json.Unmarshal(raw, &args) != nil || args.Ref == "" || args.Offset < 0 || args.MaxChars < 0 || args.MaxChars > 32000 {
		return "", ToolFailure("INVALID_ARGUMENTS", "Invalid result reference or page.")
	}
	if args.Part != "" && args.Part != "result" && args.Part != "arguments" {
		return "", ToolFailure("INVALID_ARGUMENTS", "Unknown result part.")
	}
	if args.MaxChars == 0 {
		args.MaxChars = 8000
	}
	data, found := findToolResult(state.Result, args.Ref, args.Part)
	if !found && state.OwnerID > 0 && state.ConversationID != "" {
		conversations.Lock()
		record, err := readConversation(state.OwnerID, state.ConversationID)
		if err == nil {
			for _, turn := range record.Turns {
				data, found = findToolResult(turn.Result, args.Ref, args.Part)
				if found {
					break
				}
			}
		}
		conversations.Unlock()
	}
	if !found {
		return "", ToolFailure("RESULT_NOT_FOUND", "This result is not available in the current conversation; query the source again if needed.")
	}
	chars := []rune(data)
	if args.Offset > len(chars) {
		return "", ToolFailure("INVALID_ARGUMENTS", "Offset exceeds result size.")
	}
	end := min(args.Offset+args.MaxChars, len(chars))
	page := map[string]any{"result_ref": args.Ref, "content": string(chars[args.Offset:end]), "offset": args.Offset, "total_characters": len(chars), "complete": end == len(chars)}
	if end < len(chars) {
		page["next_offset"] = end
	}
	encoded, err := json.Marshal(page)
	return string(encoded), err
}

// One-time compatibility projection for old histories. v31 could cut a tool
// result before JSON decoding, so retrying that same malformed blob would keep
// inflating context forever. Do not touch small stable-prefix messages.
func projectLegacyMessages(history []Message) []Message {
	calls := map[string]ToolCall{}
	for i, m := range history {
		for _, call := range m.ToolCalls {
			if resolved, err := resolveInvocation(call); err == nil {
				calls[call.ID] = resolved
			}
		}
		if m.Role != "tool" || len(m.Content) <= 16000 {
			continue
		}
		call, ok := calls[m.ToolCallID]
		if !ok {
			continue
		}
		if !json.Valid([]byte(m.Content)) {
			history[i].Content = `{"legacy_result_incomplete":true,"instruction":"An older version truncated this result before JSON parsing. Query the source again if the missing details are needed; never infer them."}`
			continue
		}
		history[i].Content = modelToolResult(call.Function.Name, json.RawMessage(call.Function.Arguments), m.Content, "")
	}
	return history
}
