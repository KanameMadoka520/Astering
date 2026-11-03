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
)

// ToolModules restricts this run; it never grants account or resource permissions.
type ToolModules struct {
	ProjectTasks string `json:"project_tasks,omitempty" enum:"off,read,write" doc:"Project and task tools. Omission preserves legacy access under the global mode."`
	Compass      string `json:"compass,omitempty" enum:"off,read,write" doc:"Private star-chart spaces and entries. Omission disables these tools."`
}

func normalizedToolModules(modules ToolModules) ToolModules {
	normalize := func(value, fallback string) string {
		switch value {
		case "":
			return fallback
		case "off", "read", "write":
			return value
		default:
			return "off"
		}
	}
	return ToolModules{
		ProjectTasks: normalize(modules.ProjectTasks, "write"),
		Compass:      normalize(modules.Compass, "off"),
	}
}

func validToolModules(modules ToolModules) bool {
	valid := func(value string) bool {
		return value == "" || value == "off" || value == "read" || value == "write"
	}
	return valid(modules.ProjectTasks) && valid(modules.Compass)
}

func effectiveToolModules(in RunInput) ToolModules {
	modules := normalizedToolModules(in.ToolModules)
	if in.Mode != "write" {
		if modules.ProjectTasks == "write" {
			modules.ProjectTasks = "read"
		}
		if modules.Compass == "write" {
			modules.Compass = "read"
		}
	}
	return modules
}

func sharedTool(name string) bool {
	switch name {
	case "find_tools", "ask_user", "web_search", "read_tool_result", "view_attachment", "delegate_tasks", "find_mcp_tools", "call_mcp_tool":
		return true
	}
	return false
}

func moduleAllowsTool(in RunInput, name string, readResult bool) bool {
	if sharedTool(name) {
		return true
	}
	modules := effectiveToolModules(in)
	mode := modules.ProjectTasks
	if IsCompassTool(name) {
		mode = modules.Compass
	}
	return mode != "off" && (readResult || !IsWriteTool(name) || mode == "write")
}

// ScopedTools is the same catalog contract used by discovery and hard validation.
func ScopedTools(in RunInput) []map[string]any {
	return filterModuleTools(in, AllTools(in.Mode, in.AllowDelete))
}

func filterModuleTools(in RunInput, tools []map[string]any) []map[string]any {
	result := slices.DeleteFunc(tools, func(definition map[string]any) bool {
		return !moduleAllowsTool(in, toolName(definition), false)
	})
	if effectiveToolModules(in).ProjectTasks == "off" {
		for _, definition := range result {
			if toolName(definition) == "find_tools" {
				definition["function"].(map[string]any)["description"] = "Discover tools within the enabled modules using an exact tool name or specific capability keywords. Only the current execution_context grants module access; discovery performs no writes."
			}
		}
	}
	return result
}

func coreTools(in RunInput) []map[string]any {
	return filterModuleTools(in, Tools(in.Mode, in.AllowDelete))
}

func moduleResultReadable(in RunInput, action Action, resolve func(string) (Action, bool), visited map[string]bool) bool {
	if !moduleAllowsTool(in, action.Tool, true) {
		return false
	}
	if action.Tool == "read_tool_result" {
		var args struct {
			Ref string `json:"result_ref"`
		}
		if json.Unmarshal([]byte(action.Arguments), &args) != nil || args.Ref == "" || visited[args.Ref] || len(visited) >= 32 {
			return false
		}
		visited[args.Ref] = true
		defer delete(visited, args.Ref)
		original, exists := resolve(args.Ref)
		return exists && moduleResultReadable(in, original, resolve, visited)
	}
	if action.Tool == "find_tools" {
		var directory struct {
			Tools []struct {
				Name     string `json:"name"`
				Function struct {
					Name string `json:"name"`
				} `json:"function"`
			} `json:"tools"`
		}
		if json.Unmarshal([]byte(action.Result), &directory) != nil {
			return false
		}
		for _, definition := range directory.Tools {
			if definition.Name == "" && definition.Function.Name == "" {
				return false
			}
			if definition.Name != "" && !moduleAllowsTool(in, definition.Name, true) {
				return false
			}
			if definition.Function.Name != "" && !moduleAllowsTool(in, definition.Function.Name, true) {
				return false
			}
		}
	}
	if action.Tool == "delegate_tasks" {
		var group struct {
			Children []struct {
				Findings []struct {
					Tool      string          `json:"tool"`
					Arguments json.RawMessage `json:"arguments"`
					Result    string          `json:"result"`
				} `json:"findings"`
			} `json:"children"`
		}
		if json.Unmarshal([]byte(action.Result), &group) != nil {
			return false
		}
		for _, child := range group.Children {
			for _, finding := range child.Findings {
				// Compact findings store arguments as an object, not Action's string.
				// Missing/compacted reference provenance is rejected by the same guard.
				if !moduleResultReadable(in, Action{
					Tool:      finding.Tool,
					Arguments: string(finding.Arguments),
					Result:    finding.Result,
				}, resolve, visited) {
					return false
				}
			}
		}
	}
	return true
}
