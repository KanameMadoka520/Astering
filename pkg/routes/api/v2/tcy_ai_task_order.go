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
	"errors"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
)

type aiTaskOrderArgs struct {
	models.TaskOrderChange
	ProjectID int64 `json:"project_id"`
	ViewID    int64 `json:"view_id"`
	Page      int   `json:"page"`
}

func (args aiTaskOrderArgs) scope() models.TaskOrderScope {
	return models.TaskOrderScope{
		ProjectID: args.ProjectID,
		ViewID:    args.ViewID,
		BucketID:  args.BucketID,
	}
}

func aiTaskOrderError(err error) error {
	var orderErr *models.TaskOrderError
	if errors.As(err, &orderErr) {
		return tcyai.ToolFailure(orderErr.Code, orderErr.Message)
	}
	return aiBucketError(err)
}

func parseAITaskOrder(raw json.RawMessage) (aiTaskOrderArgs, error) {
	var args aiTaskOrderArgs
	if err := json.Unmarshal(raw, &args); err != nil {
		return args, err
	}
	if args.Page == 0 {
		args.Page = 1
	}
	return args, nil
}

func (e *aiExecution) prepareTaskOrder(ctx context.Context, raw json.RawMessage) (tcyai.Operation, error) {
	var op tcyai.Operation
	args, err := parseAITaskOrder(raw)
	if err != nil {
		return op, err
	}
	if e.input.Mode != "write" {
		return op, tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Task reordering requires write mode.")
	}
	if err = e.scope(args.ProjectID); err != nil {
		return op, err
	}
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	snapshot, err := models.ReadTaskViewOrder(s, e.auth, args.scope())
	if err != nil {
		return op, aiTaskOrderError(err)
	}
	can, err := snapshot.CanUpdate(s, e.auth, args.TaskOrderChange)
	if err != nil {
		return op, aiTaskOrderError(err)
	}
	if !can {
		return op, tcyai.ToolFailure("FORBIDDEN", "Current permissions deny task reordering.")
	}
	items, err := snapshot.SelectedItems(s, args.TaskIDs)
	if err != nil {
		return op, aiTaskOrderError(err)
	}
	op.Units = len(args.TaskIDs)
	op.ProjectIDs = []int64{args.ProjectID}
	op.Version = snapshot.Version
	op.Before, err = marshalAI(struct {
		models.TaskOrderScope
		OrderVersion string                 `json:"order_version"`
		Items        []models.TaskOrderItem `json:"items"`
	}{
		TaskOrderScope: args.scope(),
		OrderVersion:   snapshot.Version,
		Items:          items,
	})
	if err != nil {
		return op, err
	}
	op.After = string(raw)
	return op, nil
}

func (e *aiExecution) executeTaskOrder(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	args, err := parseAITaskOrder(raw)
	if err != nil {
		return "", err
	}
	if name == "list_view_tasks" {
		s := db.NewSession()
		defer s.Close()
		db.SetSessionContext(ctx, s)
		snapshot, readErr := models.ReadTaskViewOrder(s, e.auth, args.scope())
		if readErr != nil {
			return "", aiTaskOrderError(readErr)
		}
		page, readErr := snapshot.Page(s, args.Page)
		if readErr != nil {
			return "", aiTaskOrderError(readErr)
		}
		return marshalAI(page)
	}
	preview, err := e.prepareTaskOrder(ctx, raw)
	if err != nil {
		return "", err
	}
	operation := tcyai.CurrentOperation(ctx)
	if operation != nil && operation.Version != "" && operation.Version != preview.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The view changed after review; read its task order again.")
	}
	result, err := applyTaskOrder(ctx, e.auth, args.scope(), args.TaskOrderChange)
	if err != nil {
		return "", aiTaskOrderError(err)
	}
	if operation != nil {
		operation.Verified = true
	}
	return marshalAI(result)
}
