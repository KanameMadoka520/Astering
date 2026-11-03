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
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"strings"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/danielgtaylor/huma/v2"
)

var compassSpaceEditable = []string{
	"title", "motto", "introduction", "theme", "background_file_id",
	"background_focus_x", "background_focus_y", "background_scrim", "revision",
}
var compassEntryEditable = []string{
	"kind", "title", "subtitle", "content", "quote", "category", "tags", "theme", "pinned", "state", "revision",
}

type compassToolRequest struct {
	path   string
	method string
	args   map[string]json.RawMessage
	query  url.Values
}

func compassToolID(args map[string]json.RawMessage, key string) (int64, error) {
	var id int64
	if json.Unmarshal(args[key], &id) != nil || id < 1 {
		return 0, tcyai.ToolFailure("INVALID_ARGUMENTS", "A real positive "+key+" is required.")
	}
	delete(args, key)
	return id, nil
}

func compassToolQuery(args map[string]json.RawMessage) (url.Values, error) {
	query := url.Values{"per_page": {"25"}}
	for key, raw := range args {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return nil, err
		}
		if key == "query" {
			key = "q"
		}
		switch value.(type) {
		case string, float64, bool:
			query.Set(key, fmt.Sprint(value))
		default:
			return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "Invalid Compass query value.")
		}
	}
	return query, nil
}

func compassToolRoute(name string, raw json.RawMessage) (r compassToolRequest, err error) {
	r.method = http.MethodGet
	if err = json.Unmarshal(raw, &r.args); err != nil {
		return r, err
	}
	if !tcyai.IsCompassTool(name) {
		return r, tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown Compass tool.")
	}
	if name == "list_compass_spaces" || name == "create_compass_space" {
		r.path = "/compass/spaces"
	} else {
		key := "id"
		if name == "list_compass_entries" || name == "create_compass_entry" || name == "list_compass_topics" {
			key = "space_id"
		}
		var id int64
		id, err = compassToolID(r.args, key)
		if err != nil {
			return r, err
		}
		switch name {
		case "get_compass_space", "update_compass_space":
			r.path = fmt.Sprintf("/compass/spaces/%d", id)
		case "list_compass_entries", "create_compass_entry":
			r.path = fmt.Sprintf("/compass/spaces/%d/entries", id)
		case "list_compass_topics":
			r.path = fmt.Sprintf("/compass/spaces/%d/topics", id)
		default:
			r.path = fmt.Sprintf("/compass/entries/%d", id)
		}
	}
	if name == "list_compass_revisions" {
		r.path += "/revisions"
	}
	if name == "get_compass_revision" || name == "restore_compass_revision" {
		var revision int64
		revision, err = compassToolID(r.args, "revision")
		if err != nil {
			return r, err
		}
		r.path += fmt.Sprintf("/revisions/%d", revision)
	}
	switch {
	case strings.HasPrefix(name, "create_"):
		r.method = http.MethodPost
	case strings.HasPrefix(name, "update_"):
		r.method = http.MethodPut
	case name == "restore_compass_revision":
		r.method = http.MethodPost
		r.path += "/restore"
	}
	if r.method == http.MethodGet {
		r.query, err = compassToolQuery(r.args)
		r.args = nil
	}
	return r, err
}

func readCompassToolObject(ctx context.Context, api huma.API, caller *http.Request, path string) (map[string]json.RawMessage, error) {
	data, err := serveAITool(ctx, api, caller, "get_compass_entry", path, http.MethodGet, nil, nil)
	if err != nil {
		return nil, err
	}
	var current map[string]json.RawMessage
	if err = json.Unmarshal([]byte(data), &current); err != nil {
		return nil, err
	}
	return current, nil
}

func compassExpectedRevision(args, current map[string]json.RawMessage, key string) error {
	var expected, actual int64
	if json.Unmarshal(args[key], &expected) != nil || expected < 1 {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "Read the Compass resource and provide its explicit current revision.")
	}
	if json.Unmarshal(current["revision"], &actual) != nil || expected != actual {
		return tcyai.ToolFailure("STATE_CONFLICT", "The Compass resource changed. Read it and prepare a new operation; do not overwrite a newer revision.")
	}
	return nil
}

func compassToolPermission(current map[string]json.RawMessage, required int) error {
	var permission int
	if json.Unmarshal(current["max_permission"], &permission) != nil || permission < required {
		return tcyai.ToolFailure("FORBIDDEN", "Current Compass space membership does not allow this change.")
	}
	return nil
}

func dispatchCompassAI(ctx context.Context, api huma.API, caller *http.Request, name string, raw json.RawMessage) (string, error) {
	r, err := compassToolRoute(name, raw)
	if err != nil {
		return "", err
	}
	if r.method == http.MethodPut {
		current, readErr := readCompassToolObject(ctx, api, caller, r.path)
		if readErr != nil {
			return "", readErr
		}
		if err = compassExpectedRevision(r.args, current, "revision"); err != nil {
			return "", err
		}
		keys := compassEntryEditable
		if name == "update_compass_space" {
			keys = compassSpaceEditable
		}
		body := make(map[string]json.RawMessage, len(keys))
		for _, key := range keys {
			if value, ok := current[key]; ok {
				body[key] = value
			}
			if value, ok := r.args[key]; ok {
				body[key] = value
			}
		}
		r.args = body
	}
	if name == "create_compass_space" {
		if _, ok := r.args["theme"]; !ok {
			r.args["theme"] = json.RawMessage(`"aurora"`)
		}
	}
	if name == "create_compass_entry" {
		for key, value := range map[string]string{
			"kind":  `"note"`,
			"theme": `"inherit"`,
			"state": `"active"`,
		} {
			if _, ok := r.args[key]; !ok {
				r.args[key] = json.RawMessage(value)
			}
		}
	}
	return serveAITool(ctx, api, caller, name, r.path, r.method, r.args, r.query)
}

func (e *aiExecution) prepareCompass(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{
		Units:      1,
		ProjectIDs: []int64{},
		After:      string(raw),
	}
	if !tcyai.IsWriteTool(name) {
		return op, nil
	}
	r, err := compassToolRoute(name, raw)
	if err != nil {
		return op, err
	}
	if name == "create_compass_space" {
		var teamID int64
		if value, ok := r.args["team_id"]; ok {
			if err = json.Unmarshal(value, &teamID); err != nil {
				return op, err
			}
		}
		s := db.NewReadSession()
		defer s.Close()
		db.SetSessionContext(ctx, s)
		allowed, checkErr := (&models.CompassSpace{TeamID: teamID}).CanCreate(s, e.auth)
		if checkErr != nil {
			return op, checkErr
		}
		if !allowed {
			return op, tcyai.ToolFailure("FORBIDDEN", "Creating this Compass space requires its owner's or team's permission.")
		}
		op.Before = "null"
		return op, nil
	}
	readPath := r.path
	required := 1
	if name == "create_compass_entry" {
		readPath = strings.TrimSuffix(r.path, "/entries")
	}
	if name == "update_compass_space" {
		required = 2
	}
	if name == "restore_compass_revision" {
		readPath = strings.Split(r.path, "/revisions/")[0]
	}
	current, err := readCompassToolObject(ctx, e.api, e.caller, readPath)
	if err != nil {
		return op, err
	}
	if err = compassToolPermission(current, required); err != nil {
		return op, err
	}
	if name != "create_compass_entry" {
		key := "revision"
		if name == "restore_compass_revision" {
			key = "expected_revision"
		}
		if err = compassExpectedRevision(r.args, current, key); err != nil {
			return op, err
		}
	}
	if name == "restore_compass_revision" {
		if _, err = readCompassToolObject(ctx, e.api, e.caller, strings.TrimSuffix(r.path, "/restore")); err != nil {
			return op, err
		}
	}
	before := map[string]any{}
	for _, key := range []string{"id", "space_id", "team_id", "title", "kind", "state", "revision", "max_permission"} {
		if value, ok := current[key]; ok {
			before[key] = value
		}
	}
	op.Before, op.Version, err = aiSnapshotVersion([]map[string]any{before})
	return op, err
}

func (e *aiExecution) executeCompass(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	preview, err := e.prepareCompass(ctx, name, raw)
	if err != nil {
		return "", err
	}
	op := tcyai.CurrentOperation(ctx)
	if op != nil && op.Version != "" && op.Version != preview.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "Compass resource or access changed since review. Prepare a fresh operation.")
	}
	out, err := dispatchCompassAI(ctx, e.api, e.caller, name, raw)
	if err == nil && op != nil {
		op.Verified = true
	}
	return out, err
}
