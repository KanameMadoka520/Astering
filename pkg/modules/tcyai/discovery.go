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
	"encoding/json"
	"slices"
	"sort"
	"strings"
)

const deferredToolLimit = 8

type toolEntry struct {
	Name        string `json:"name"`
	Description string `json:"description,omitempty"`
}

func entry(t map[string]any) toolEntry {
	fn := t["function"].(map[string]any)
	return toolEntry{Name: toolName(t), Description: fn["description"].(string)}
}

// Discovery sends schemas once, in the next model request's tool declarations.
// Search intentionally excludes parameter names: "id" must not load the catalog.
func (state *AgentState) discover(raw json.RawMessage) (string, error) {
	var args struct {
		Query string `json:"query"`
		Limit int    `json:"limit"`
	}
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", err
	}
	if args.Limit < 1 || args.Limit > 5 {
		args.Limit = 5
	}
	query := strings.TrimSpace(strings.ToLower(args.Query))
	terms := strings.FieldsFunc(query, func(r rune) bool { return r == ' ' || r == ',' || r == '，' || r == '/' })
	type match struct {
		entry toolEntry
		score int
	}
	matches := []match{}
	for _, t := range state.catalog() {
		e := entry(t)
		score := 0
		for _, term := range terms {
			switch {
			case term == e.Name:
				score += 1000
			case strings.Contains(e.Name, term):
				score += 20
			case strings.Contains(strings.ToLower(e.Description), term):
				score++
			}
		}
		if score > 0 {
			matches = append(matches, match{e, score})
		}
	}
	// An exact tool name requests that contract only, not substring neighbors.
	if len(terms) == 1 && slices.ContainsFunc(matches, func(m match) bool { return m.entry.Name == query }) {
		matches = slices.DeleteFunc(matches, func(m match) bool { return m.entry.Name != query })
	}
	sort.SliceStable(matches, func(i, j int) bool { return matches[i].score > matches[j].score })
	total := len(matches)
	if len(matches) > args.Limit {
		matches = matches[:args.Limit]
	}
	selected := []toolEntry{}
	for _, m := range matches {
		selected = append(selected, m.entry)
		state.Available = slices.DeleteFunc(state.Available, func(name string) bool { return name == m.entry.Name })
		state.Available = append(state.Available, m.entry.Name)
	}
	state.trimTools()
	if state.CacheStable {
		definitions := []map[string]any{}
		for _, selectedTool := range selected {
			for _, t := range state.catalog() {
				if toolName(t) == selectedTool.Name {
					definitions = append(definitions, t["function"].(map[string]any))
				}
			}
		}
		data, err := json.Marshal(map[string]any{"transport": "invoke_tool_v1", "execution_configuration": runOptions(state.Input), "tools": definitions, "matched": total, "more_available": total > len(selected), "note": "Call invoke_tool with name and arguments matching these parameters. Reuse these definitions while in context; current execution_context and server checks govern permissions."})
		return string(data), err
	}
	data, err := json.Marshal(map[string]any{"tools": selected, "execution_configuration": runOptions(state.Input), "permission_note": "Mode and scope are current execution restrictions, not account ACL results. No matches does not prove account permission denial. Rediscover after changing mode. A nonempty write_project_ids forbids creating new projects; clear that restriction to permit project creation within account permissions.", "matched": total, "more_available": total > len(selected), "note": "These tools are loaded for subsequent rounds. Full parameter schemas are in tool declarations, not this result. Search a more specific name if needed."})
	return string(data), err
}

func (state *AgentState) trimTools() {
	if state.CacheStable {
		return
	}
	// Preserve core tools and pending calls. The working set converges back to
	// eight deferred definitions when no additional queued calls need pinning.
	pinned := map[string]bool{"web_search": state.SearchEnabled}
	for _, t := range coreTools(state.Input) {
		pinned[toolName(t)] = true
	}
	for _, call := range state.Pending {
		pinned[call.Function.Name] = true
	}
	if state.Approved != nil {
		pinned[state.Approved.Tool] = true
	}
	deferred := 0
	for _, name := range state.Available {
		if !pinned[name] {
			deferred++
		}
	}
	state.Available = slices.DeleteFunc(state.Available, func(name string) bool {
		if !pinned[name] && deferred > deferredToolLimit {
			deferred--
			return true
		}
		return false
	})
}

// Old persisted conversations may contain full schemas from previous versions.
// Compact only discovery receipts on replay; preserve signed native reasoning.
func compactDiscoveryMessages(messages []Message) []Message {
	discovery := map[string]bool{}
	for i, m := range messages {
		for _, call := range m.ToolCalls {
			if call.Function.Name == "find_tools" {
				discovery[call.ID] = true
			}
		}
		if m.Role != "tool" || !discovery[m.ToolCallID] {
			continue
		}
		var old struct {
			Tools []map[string]any `json:"tools"`
		}
		if json.Unmarshal([]byte(m.Content), &old) != nil {
			continue
		}
		entries := []toolEntry{}
		legacy := false
		for _, t := range old.Tools {
			if fn, ok := t["function"].(map[string]any); ok {
				name, _ := fn["name"].(string)
				desc, _ := fn["description"].(string)
				entries = append(entries, toolEntry{name, desc})
				legacy = true
			}
		}
		if legacy {
			data, err := json.Marshal(map[string]any{"tools": entries, "note": "Historical discovery directory. Discover again if a definition is not currently loaded."})
			if err == nil {
				messages[i].Content = string(data)
			}
		}
	}
	return messages
}
