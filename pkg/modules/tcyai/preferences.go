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
	"errors"
	"fmt"
	"strings"
)

// Profiles contain execution preferences, never messages, credentials or permissions grants.
type AssistantOptions struct {
	StopAtSegmentLimit bool    `json:"stop_at_segment_limit,omitempty" doc:"Pause at segment limits instead of automatically continuing. Explicit token budgets always pause."`
	EnableSubagents    bool    `json:"enable_subagents,omitempty" doc:"Experimental parallel read-only workers with isolated context; writes stay with the parent."`
	SearchMode         string  `json:"search_mode,omitempty" enum:"auto,off,required" doc:"Per-turn web search policy: auto lets the model choose; off forbids search execution; required forces a search attempt before answering."`
	ConnectionID       string  `json:"connection_id" maxLength:"80" doc:"Empty follows the configured assistant connection."`
	ProjectID          int64   `json:"project_id" minimum:"0" doc:"Context project only, not a permission boundary."`
	Mode               string  `json:"mode" enum:"read,write" doc:"Read only or execute writes within existing account permissions."`
	AllowDelete        bool    `json:"allow_delete" doc:"Enable task deletion; destructive actions still require review."`
	Approval           string  `json:"approval" enum:"smart,review,auto" doc:"Review policy; destructive and notification operations always require review."`
	WriteProjectIDs    []int64 `json:"write_project_ids" maxItems:"50" doc:"Optional additional write restriction, never a permission grant."`
	MaxRounds          int     `json:"max_rounds" minimum:"1" maximum:"40" doc:"Model requests per execution segment."`
	MaxOperations      int     `json:"max_operations" minimum:"1" maximum:"100" doc:"Tool operations per execution segment."`
	TimeoutSeconds     int     `json:"timeout_seconds" minimum:"1" maximum:"600" doc:"Execution segment deadline in seconds."`
	TokenBudget        int64   `json:"token_budget" minimum:"0" maximum:"1000000" doc:"Provider reported token soft limit; zero disables it."`
}
type AssistantProfile struct {
	ID      string           `json:"id" minLength:"1" maxLength:"80" doc:"Stable custom profile ID, prefixed custom-."`
	Name    string           `json:"name" minLength:"1" maxLength:"80" doc:"Personal display name."`
	Options AssistantOptions `json:"options" doc:"Options applied to future requests when selected."`
}
type AssistantPreferences struct {
	Revision       int64              `json:"revision" minimum:"0" doc:"Optimistic concurrency revision; stale writes return 409."`
	DefaultProfile string             `json:"default_profile" maxLength:"80" doc:"Built-in ask, plan, assist, batch, or custom profile ID; empty means ask."`
	Profiles       []AssistantProfile `json:"profiles" maxItems:"20" doc:"Account-owned custom scenario templates."`
}

var ErrPreferencesConflict = errors.New("assistant preferences changed in another window; reload before saving")

func SavePreferences(uid int64, p AssistantPreferences) (AssistantPreferences, error) {
	settingsLock.Lock()
	defer settingsLock.Unlock()
	s, err := read(uid)
	if err != nil {
		return p, err
	}
	if p.Revision != s.Preferences.Revision {
		return p, ErrPreferencesConflict
	}
	if len(p.Profiles) > 20 {
		return p, errors.New("at most 20 profiles")
	}
	ids := map[string]bool{"": true, "ask": true, "plan": true, "assist": true, "batch": true}
	for _, profile := range p.Profiles {
		o := profile.Options
		if !strings.HasPrefix(profile.ID, "custom-") || len(profile.ID) > 80 || ids[profile.ID] || strings.TrimSpace(profile.Name) == "" || len([]rune(profile.Name)) > 80 {
			return p, errors.New("invalid profile name or ID")
		}
		ids[profile.ID] = true
		if !validAssistantOptions(o) {
			return p, fmt.Errorf("invalid options for profile %s", profile.ID)
		}
		for _, id := range o.WriteProjectIDs {
			if id < 1 {
				return p, errors.New("invalid project ID")
			}
		}
	}
	if !ids[p.DefaultProfile] {
		return p, errors.New("default profile does not exist")
	}
	p.Revision++
	if p.Profiles == nil {
		p.Profiles = []AssistantProfile{}
	}
	s.Preferences = p
	_, err = writeSettings(uid, s)
	return p, err
}

func runOptions(input RunInput) *AssistantOptions {
	in := normalizeRun(input)
	return &AssistantOptions{StopAtSegmentLimit: in.StopAtSegmentLimit, EnableSubagents: in.EnableSubagents, SearchMode: in.SearchMode, ConnectionID: in.ConnectionID, ProjectID: in.ProjectID, Mode: in.Mode,
		AllowDelete: in.AllowDelete && in.Mode == "write", Approval: in.Approval,
		WriteProjectIDs: append([]int64{}, in.WriteProjectIDs...), MaxRounds: in.MaxRounds,
		MaxOperations: in.MaxOperations, TimeoutSeconds: in.TimeoutSeconds, TokenBudget: in.TokenBudget}
}

func validAssistantOptions(o AssistantOptions) bool {
	return (o.SearchMode == "" || o.SearchMode == "auto" || o.SearchMode == "off" || o.SearchMode == "required") && (o.Mode == "read" || o.Mode == "write") &&
		(o.Approval == "smart" || o.Approval == "review" || o.Approval == "auto") &&
		(o.Mode != "read" || !o.AllowDelete) && o.ProjectID >= 0 && len(o.ConnectionID) <= 80 &&
		o.MaxRounds >= 1 && o.MaxRounds <= 40 && o.MaxOperations >= 1 && o.MaxOperations <= 100 &&
		o.TimeoutSeconds >= 1 && o.TimeoutSeconds <= 600 && o.TokenBudget >= 0 && o.TokenBudget <= 1000000 &&
		len(o.WriteProjectIDs) <= 50
}
