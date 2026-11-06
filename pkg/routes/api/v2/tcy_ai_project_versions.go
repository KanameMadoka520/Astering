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

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/danielgtaylor/huma/v2"
	"github.com/google/uuid"
)

type aiProjectVersionRequest struct {
	projectID int64
	versionID int64
	path      string
	method    string
	body      map[string]json.RawMessage
	query     url.Values
}

func aiProjectVersionRoute(name string, raw json.RawMessage) (r aiProjectVersionRequest, err error) {
	if !tcyai.IsProjectVersionTool(name) {
		return r, tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown project version tool.")
	}
	if err = json.Unmarshal(raw, &r.body); err != nil {
		return r, err
	}
	r.projectID, err = compassToolID(r.body, "project_id")
	if err != nil {
		return r, err
	}
	r.path, r.method = fmt.Sprintf("/projects/%d/versions", r.projectID), http.MethodGet
	if name != "list_project_versions" && name != "save_project_version" {
		r.versionID, err = compassToolID(r.body, "version_id")
		if err != nil {
			return r, err
		}
		r.path += fmt.Sprintf("/%d", r.versionID)
	}
	switch name {
	case "save_project_version":
		r.method = http.MethodPost
	case "restore_project_version":
		r.method, r.path = http.MethodPost, r.path+"/restore"
	case "get_project_version_preview":
		r.path += "/preview"
	case "list_project_version_entities":
		r.path += "/entities"
	case "get_project_version_entity":
		var kind, entity string
		if json.Unmarshal(r.body["kind"], &kind) != nil || json.Unmarshal(r.body["entity_id"], &entity) != nil || kind == "" || entity == "" || strings.ContainsAny(kind+entity, "/\\?#%") {
			return r, tcyai.ToolFailure("INVALID_ARGUMENTS", "Use a real kind and entity_id from the version index or preview.")
		}
		r.path += "/entities/" + url.PathEscape(kind) + "/" + url.PathEscape(entity)
		delete(r.body, "kind")
		delete(r.body, "entity_id")
	}
	if r.method == http.MethodGet {
		r.query = url.Values{}
		if name == "list_project_versions" || name == "list_project_version_entities" || name == "get_project_version_preview" {
			r.query.Set("per_page", "12")
		}
		for key, value := range r.body {
			if key == "kind" {
				var kind string
				if err = json.Unmarshal(value, &kind); err != nil {
					return r, err
				}
				r.query.Set(key, kind)
				continue
			}
			var number int64
			if (key != "page" && key != "per_page") || json.Unmarshal(value, &number) != nil || number < 1 {
				return r, tcyai.ToolFailure("INVALID_ARGUMENTS", "Invalid project version query.")
			}
			r.query.Set(key, fmt.Sprint(number))
		}
		r.body = nil
	}
	return r, nil
}

func dispatchProjectVersionAI(ctx context.Context, api huma.API, caller *http.Request, name string, raw json.RawMessage) (string, error) {
	r, err := aiProjectVersionRoute(name, raw)
	if err != nil {
		return "", err
	}
	if r.method == http.MethodPost {
		op := tcyai.CurrentOperation(ctx)
		if op == nil {
			return "", tcyai.ToolFailure("OPERATION_REQUIRED", "Project version writes require a persisted execution receipt.")
		}
		if _, err = uuid.Parse(op.ID); err != nil {
			return "", tcyai.ToolFailure("OPERATION_REQUIRED", "The execution receipt has no valid request identity.")
		}
		r.body["request_id"], err = json.Marshal(op.ID)
		if err != nil {
			return "", err
		}
	}
	return serveAITool(ctx, api, caller, name, r.path, r.method, r.body, r.query)
}

func (e *aiExecution) prepareProjectVersion(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{Units: 1, After: string(raw)}
	r, err := aiProjectVersionRoute(name, raw)
	if err != nil {
		return op, err
	}
	if !tcyai.IsWriteTool(name) {
		return op, nil
	}
	if err = e.scope(r.projectID); err != nil {
		return op, err
	}
	currentRaw, err := serveAITool(ctx, e.api, e.caller, "get_project", fmt.Sprintf("/projects/%d", r.projectID), http.MethodGet, nil, nil)
	if err != nil {
		return op, err
	}
	var current map[string]json.RawMessage
	if err = json.Unmarshal([]byte(currentRaw), &current); err != nil {
		return op, err
	}
	required := 1
	if name == "restore_project_version" {
		required = 2
	}
	var permission int
	if json.Unmarshal(current["max_permission"], &permission) != nil || permission < required {
		return op, tcyai.ToolFailure("FORBIDDEN", "Current project permissions do not allow this version operation.")
	}
	before := map[string]any{"project_id": r.projectID, "title": current["title"], "max_permission": permission}
	if name == "restore_project_version" {
		versionRaw, readErr := serveAITool(ctx, e.api, e.caller, "get_project_version", strings.TrimSuffix(r.path, "/restore"), http.MethodGet, nil, nil)
		if readErr != nil {
			return op, readErr
		}
		var version models.ProjectVersionSummary
		if err = json.Unmarshal([]byte(versionRaw), &version); err != nil {
			return op, err
		}
		if version.ID != r.versionID || version.ProjectID != r.projectID {
			return op, tcyai.ToolFailure("STATE_CONFLICT", "The source checkpoint does not match the requested project.")
		}
		before["version_name"], before["target_sequence"] = version.Name, version.Sequence
		previewRaw, readErr := serveAITool(ctx, e.api, e.caller, "get_project_version_preview", strings.TrimSuffix(r.path, "/restore")+"/preview", http.MethodGet, nil, url.Values{"per_page": {"1"}})
		if readErr != nil {
			return op, readErr
		}
		var preview struct {
			CanRestore  bool            `json:"can_restore"`
			CurrentHash string          `json:"current_hash"`
			PlanHash    string          `json:"plan_hash"`
			Summary     json.RawMessage `json:"summary"`
			Preserved   json.RawMessage `json:"preserved"`
		}
		if err = json.Unmarshal([]byte(previewRaw), &preview); err != nil {
			return op, err
		}
		var expected, plan string
		if json.Unmarshal(r.body["expected_current_hash"], &expected) != nil || json.Unmarshal(r.body["plan_hash"], &plan) != nil || !preview.CanRestore || expected != preview.CurrentHash || plan != preview.PlanHash {
			return op, tcyai.ToolFailure("STATE_CONFLICT", "The restore preview is unavailable or changed. Read a fresh preview and resolve its conflicts before preparing a restore.")
		}
		before["version_id"], before["current_hash"], before["plan_hash"] = r.versionID, expected, plan
		before["summary"], before["preserved"] = preview.Summary, preview.Preserved
	}
	op.ProjectIDs = []int64{r.projectID}
	op.Before, op.Version, err = aiSnapshotVersion([]map[string]any{before})
	return op, err
}

func (e *aiExecution) executeProjectVersion(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	prepared, err := e.prepareProjectVersion(ctx, name, raw)
	if err != nil {
		return "", err
	}
	op := tcyai.CurrentOperation(ctx)
	if op != nil && op.Version != "" && op.Version != prepared.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The project or restore plan changed after review. Prepare a new operation.")
	}
	result, err := dispatchProjectVersionAI(ctx, e.api, e.caller, name, raw)
	if err != nil {
		return result, err
	}
	if tcyai.IsWriteTool(name) {
		r, routeErr := aiProjectVersionRoute(name, raw)
		if routeErr != nil {
			return "", routeErr
		}
		valid := false
		if name == "save_project_version" {
			var saved models.ProjectVersionSummary
			valid = json.Unmarshal([]byte(result), &saved) == nil && saved.ID > 0 && saved.ProjectID == r.projectID
		} else {
			var restored models.ProjectVersionRestoreResult
			valid = json.Unmarshal([]byte(result), &restored) == nil && restored.Verified && restored.ProjectID == r.projectID && restored.RestoredFromVersionID == r.versionID && restored.BeforeVersionID > 0 && restored.Version != nil && restored.Version.ProjectID == r.projectID && restored.Version.ID > 0
		}
		if !valid {
			return "", tcyai.ToolFailure("VERIFICATION_FAILED", "The checkpoint response did not verify the requested project operation. Do not blindly repeat a write with an unknown result.")
		}
	}
	if op != nil {
		op.Verified = true
	}
	return result, nil
}
