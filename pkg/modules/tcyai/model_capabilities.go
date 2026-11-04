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
	"net/url"
	"slices"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
)

// Capabilities describe one exact provider/model connection, never global agent budgets.
type ModelCapabilities struct {
	ContextWindow   int64    `json:"context_window,omitempty" minimum:"0" maximum:"9007199254740991" doc:"Declared context capacity in tokens. Zero means unknown, not zero capacity."`
	MaxOutputTokens int64    `json:"max_output_tokens,omitempty" minimum:"0" maximum:"9007199254740991" doc:"Per-request output allowance, including reasoning where applicable. Zero uses provider defaults unless the protocol requires a value."`
	InputTypes      []string `json:"input_types,omitempty" maxItems:"2" uniqueItems:"true" doc:"Declared model input capabilities: text and optionally image."`
}

func (c Connection) officialDeepSeek() bool {
	u, err := url.Parse(c.BaseURL)
	return err == nil && u.Hostname() == "api.deepseek.com" && u.Scheme == "https" && (u.Port() == "" || u.Port() == "443")
}

func (c Connection) Capabilities() ModelCapabilities {
	out := ModelCapabilities{ContextWindow: c.ContextWindow, MaxOutputTokens: c.MaxOutputTokens, InputTypes: append([]string{}, c.InputTypes...)}
	// Verified official /models metadata on 2026-10-27; custom gateways are never inferred by name.
	if c.officialDeepSeek() && (c.Model == "deepseek-flash" || c.Model == "deepseek-v4-pro") {
		if out.ContextWindow == 0 {
			out.ContextWindow = 1048576
		}
		if out.MaxOutputTokens == 0 {
			out.MaxOutputTokens = 393216
		}
		if len(out.InputTypes) == 0 && c.Model == "deepseek-flash" {
			out.InputTypes = []string{"text", "image"}
		}
	}
	// Messages requires max_tokens. Use the modern Harness fallback, exposed in the settings UI.
	if out.MaxOutputTokens == 0 && c.EffectiveProtocol() == "anthropic" {
		out.MaxOutputTokens = 128000
	}
	if len(out.InputTypes) == 0 {
		out.InputTypes = []string{"text"}
	}
	return out
}

func (c Connection) validateCapabilities() error {
	const maxSafeInteger = 9007199254740991
	if c.AutoCompactTokens < 0 || c.AutoCompactTokens > maxSafeInteger || c.ContextWindow < 0 || c.MaxOutputTokens < 0 || c.ContextWindow > maxSafeInteger || c.MaxOutputTokens > maxSafeInteger {
		return tcylocale.Error("modelCapacityInvalid")
	}
	if c.OutputTokenField != "" && c.OutputTokenField != "max_tokens" && c.OutputTokenField != "max_completion_tokens" {
		return tcylocale.Error("modelCapacityInvalid")
	}
	if len(c.InputTypes) > 2 {
		return tcylocale.Error("modelCapacityInvalid")
	}
	if len(c.InputTypes) > 0 && !slices.Contains(c.InputTypes, "text") {
		return tcylocale.Error("modelCapacityInvalid")
	}
	for i, v := range c.InputTypes {
		if (v != "text" && v != "image") || slices.Contains(c.InputTypes[:i], v) {
			return tcylocale.Error("modelCapacityInvalid")
		}
	}
	return nil
}

func (c Connection) outputTokenField() string {
	if c.OutputTokenField != "" {
		return c.OutputTokenField
	}
	if c.officialDeepSeek() {
		return "max_tokens"
	}
	return "max_completion_tokens"
}

// The official Messages API has no /anthropic/models endpoint. Only this exact
// first-party host uses the bearer-authenticated directory; arbitrary gateways keep their paths.
func modelListConnection(c Connection) Connection {
	if c.officialDeepSeek() && c.EffectiveProtocol() == "anthropic" {
		c.BaseURL = "https://api.deepseek.com"
		c.Protocol = "openai-chat"
	}
	return c
}
