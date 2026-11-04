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

package models

import (
	"cmp"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"math"
	"regexp"
	"slices"
	"sort"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

const TaskOrderPageSize = 25

// TaskOrderScope names existing rows, not a new persistent resource.
type TaskOrderScope struct {
	ProjectID int64 `json:"project_id"`
	ViewID    int64 `json:"view_id"`
	BucketID  int64 `json:"bucket_id"`
}

type TaskOrderItem struct {
	ID        int64     `json:"id"`
	Title     string    `json:"title"`
	ProjectID int64     `json:"project_id"`
	Position  float64   `json:"position"`
	Done      bool      `json:"done"`
	StartDate time.Time `json:"start_date"`
	EndDate   time.Time `json:"end_date"`
	DueDate   time.Time `json:"due_date"`
}

type TaskOrderPage struct {
	TaskOrderScope
	ViewKind       ProjectViewKind `json:"view_kind"`
	OrderVersion   string          `json:"order_version"`
	Items          []TaskOrderItem `json:"items"`
	Total          int             `json:"total"`
	Page           int             `json:"page"`
	PerPage        int             `json:"per_page"`
	TotalPages     int             `json:"total_pages"`
	PreviousTaskID int64           `json:"previous_task_id"`
	NextTaskID     int64           `json:"next_task_id"`
	ManualOrder    bool            `json:"manual_order"`
}

type TaskOrderChange struct {
	TaskIDs      []int64 `json:"task_ids" minItems:"1" maxItems:"100" doc:"Distinct existing task IDs, in the desired order of the moved block. No task is created or deleted."`
	AfterTaskID  int64   `json:"after_task_id" minimum:"0" doc:"Neighbour before the block after removing task_ids; 0 means the beginning."`
	BeforeTaskID int64   `json:"before_task_id" minimum:"0" doc:"Neighbour after the block after removing task_ids; 0 means the end. Both neighbours must be adjacent."`
	OrderVersion string  `json:"order_version" minLength:"64" maxLength:"64" doc:"Latest version from the read endpoint; stale orders fail without mutation."`
	BucketID     int64   `json:"bucket_id" minimum:"0" doc:"Required positive bucket for manual kanban; 0 for list/table. Never moves tasks across buckets."`
}

type TaskOrderResult struct {
	TaskOrderScope
	ViewKind             ProjectViewKind `json:"view_kind"`
	TaskIDs              []int64         `json:"task_ids"`
	OrderVersion         string          `json:"order_version"`
	ChangedPositions     []*TaskPosition `json:"changed_positions"`
	PositionRecalculated bool            `json:"position_recalculated"`
	ManualOrderSaved     bool            `json:"manual_order_saved"`
	Verified             bool            `json:"verified"`
}

type TaskOrderError struct {
	Code    string
	Message string
}

func (err *TaskOrderError) Error() string { return err.Message }

func taskOrderFailure(code, message string) error {
	return &TaskOrderError{Code: code, Message: message}
}

type taskOrderRow struct {
	ID          int64
	ProjectID   int64
	Done        *bool
	Position    float64 `xorm:"-"`
	HasPosition bool    `xorm:"-"`
	BucketID    int64   `xorm:"-"`
}

type TaskOrderSnapshot struct {
	Scope   TaskOrderScope
	View    *ProjectView
	Version string
	Items   []TaskOrderItem
	rows    []taskOrderRow
}

var taskOrderDoneFilter = regexp.MustCompile(`(?i)^\s*done\s*=\s*(true|false)\s*$`)

func canReadTaskOrderScope(s *xorm.Session, a web.Auth, scope TaskOrderScope) (bool, int, error) {
	if scope.ProjectID <= 0 || scope.ViewID <= 0 {
		return false, 0, taskOrderFailure("UNSUPPORTED_VIEW", "Task ordering requires a real project and view; saved filters are not supported.")
	}
	return (&ProjectView{ID: scope.ViewID, ProjectID: scope.ProjectID}).CanRead(s, a)
}

func taskOrderView(s *xorm.Session, a web.Auth, scope TaskOrderScope, current bool) (*ProjectView, error) {
	can, _, err := canReadTaskOrderScope(s, a, scope)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, ErrGenericForbidden{}
	}
	view := &ProjectView{}
	query := s
	if current {
		query = routineCurrentRead(s)
	}
	exists, err := query.Where(builder.Eq{"id": scope.ViewID, "project_id": scope.ProjectID}).Get(view)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, taskOrderFailure("NOT_FOUND", "The requested project view does not exist.")
	}
	if view.ViewKind != ProjectViewKindList && view.ViewKind != ProjectViewKindTable && view.ViewKind != ProjectViewKindKanban {
		return nil, taskOrderFailure("UNSUPPORTED_VIEW", "Gantt placement is determined by dates, not manual task order.")
	}
	if view.ViewKind == ProjectViewKindKanban {
		if view.BucketConfigurationMode != BucketConfigurationModeManual || scope.BucketID <= 0 {
			return nil, taskOrderFailure("UNSUPPORTED_VIEW", "Choose an existing bucket in a manual kanban view.")
		}
		query = s
		if current {
			query = routineCurrentRead(s)
		}
		exists, err = query.Where(builder.Eq{"id": scope.BucketID, "project_view_id": view.ID}).Exist(&Bucket{})
		if err != nil {
			return nil, err
		}
		if !exists {
			return nil, taskOrderFailure("NOT_FOUND", "The bucket does not belong to this view.")
		}
	} else if scope.BucketID != 0 {
		return nil, taskOrderFailure("INVALID_ARGUMENTS", "List and table task orders do not accept a bucket.")
	}
	if view.Filter != nil && (view.Filter.Search != "" || (view.Filter.Filter != "" && !taskOrderDoneFilter.MatchString(view.Filter.Filter))) {
		return nil, taskOrderFailure("UNSUPPORTED_VIEW", "This ordering tool supports unfiltered views and done=true/false filters only. It does not ignore complex filters or search.")
	}
	return view, nil
}

// This is deliberately a pure projection. TaskCollection.ReadAll may create
// positions; discovering order must never mutate a previously unopened view.
func ReadTaskViewOrder(s *xorm.Session, a web.Auth, scope TaskOrderScope) (*TaskOrderSnapshot, error) {
	return readTaskViewOrder(s, a, scope, false)
}

func readTaskViewOrder(s *xorm.Session, a web.Auth, scope TaskOrderScope, current bool) (*TaskOrderSnapshot, error) {
	view, err := taskOrderView(s, a, scope, current)
	if err != nil {
		return nil, err
	}
	rows := []taskOrderRow{}
	query := s
	if current {
		query = routineCurrentRead(s)
	}
	err = query.Table("tasks").Select("id, project_id, done").
		Where(builder.And(builder.Eq{"project_id": scope.ProjectID}, taskNotDeletedCond("tasks"))).OrderBy("id asc").Find(&rows)
	if err != nil {
		return nil, err
	}
	positions := []*TaskPosition{}
	query = s
	if current {
		query = routineCurrentRead(s)
	}
	err = query.Where(builder.Eq{"project_view_id": scope.ViewID}).Find(&positions)
	if err != nil {
		return nil, err
	}
	byID := make(map[int64]float64, len(positions))
	for _, position := range positions {
		byID[position.TaskID] = position.Position
	}
	buckets := []*TaskBucket{}
	if view.ViewKind == ProjectViewKindKanban {
		query = s
		if current {
			query = routineCurrentRead(s)
		}
		if err = query.Where(builder.Eq{"project_view_id": scope.ViewID}).Find(&buckets); err != nil {
			return nil, err
		}
	}
	bucketByTask := make(map[int64]int64, len(buckets))
	for _, bucket := range buckets {
		bucketByTask[bucket.TaskID] = bucket.BucketID
	}
	for i := range rows {
		rows[i].Position, rows[i].HasPosition = byID[rows[i].ID]
		rows[i].BucketID = bucketByTask[rows[i].ID]
		if math.IsNaN(rows[i].Position) || math.IsInf(rows[i].Position, 0) {
			return nil, taskOrderFailure("INVALID_POSITION", "The view contains a non-finite position; repair it before reordering.")
		}
	}
	sort.Slice(rows, func(i, j int) bool {
		if comparison := cmp.Compare(rows[i].Position, rows[j].Position); comparison != 0 {
			return comparison < 0
		}
		return rows[i].ID < rows[j].ID
	})
	snapshot := &TaskOrderSnapshot{
		Scope: scope,
		View:  view,
		rows:  rows,
		Items: []TaskOrderItem{},
	}
	for _, row := range rows {
		if !taskOrderVisible(row, view, scope) {
			continue
		}
		snapshot.Items = append(snapshot.Items, taskOrderItem(row))
	}
	snapshot.Version, err = taskOrderVersion(view, scope, rows)
	return snapshot, err
}

func taskOrderVisible(row taskOrderRow, view *ProjectView, scope TaskOrderScope) bool {
	if view.ViewKind == ProjectViewKindKanban && row.BucketID != scope.BucketID {
		return false
	}
	if view.Filter == nil || view.Filter.Filter == "" {
		return true
	}
	desired := taskOrderDoneFilter.FindStringSubmatch(view.Filter.Filter)[1]
	if row.Done == nil {
		return view.Filter.FilterIncludeNulls
	}
	return *row.Done == strings.EqualFold(desired, "true")
}

func taskOrderItem(row taskOrderRow) TaskOrderItem {
	return TaskOrderItem{
		ID:        row.ID,
		ProjectID: row.ProjectID,
		Position:  row.Position,
		Done:      row.Done != nil && *row.Done,
	}
}

func hydrateTaskOrderItems(s *xorm.Session, items []TaskOrderItem) ([]TaskOrderItem, error) {
	if len(items) == 0 {
		return []TaskOrderItem{}, nil
	}
	ids := make([]int64, 0, len(items))
	for _, item := range items {
		ids = append(ids, item.ID)
	}
	rows := []TaskOrderItem{}
	if err := s.Table("tasks").Select("id, title, project_id, done, start_date, end_date, due_date").Where(builder.And(builder.In("id", ids), taskNotDeletedCond("tasks"))).Find(&rows); err != nil {
		return nil, err
	}
	byID := make(map[int64]TaskOrderItem, len(rows))
	for _, row := range rows {
		byID[row.ID] = row
	}
	result := make([]TaskOrderItem, 0, len(items))
	for _, item := range items {
		row, ok := byID[item.ID]
		if !ok {
			return nil, taskOrderFailure("STATE_CONFLICT", "A task disappeared while reading its order; read again.")
		}
		row.Position = item.Position
		result = append(result, row)
	}
	return result, nil
}

func (snapshot *TaskOrderSnapshot) SelectedItems(s *xorm.Session, ids []int64) ([]TaskOrderItem, error) {
	items := []TaskOrderItem{}
	for _, item := range snapshot.Items {
		if slices.Contains(ids, item.ID) {
			items = append(items, item)
		}
	}
	return hydrateTaskOrderItems(s, items)
}

func taskOrderVersion(view *ProjectView, scope TaskOrderScope, rows []taskOrderRow) (string, error) {
	versionRows := slices.Clone(rows)
	if view.Filter == nil || view.Filter.Filter == "" {
		for i := range versionRows {
			versionRows[i].Done = nil
		}
	}
	state := struct {
		Scope    TaskOrderScope
		ViewKind ProjectViewKind
		Mode     BucketConfigurationModeKind
		Filter   *TaskCollection
		Rows     []taskOrderRow
	}{
		Scope:    scope,
		ViewKind: view.ViewKind,
		Mode:     view.BucketConfigurationMode,
		Filter:   view.Filter,
		Rows:     versionRows,
	}
	raw, err := json.Marshal(state)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(raw)
	return hex.EncodeToString(digest[:]), nil
}

func (snapshot *TaskOrderSnapshot) Page(s *xorm.Session, page int) (*TaskOrderPage, error) {
	if page < 1 || page > 10000000 {
		return nil, taskOrderFailure("INVALID_ARGUMENTS", "Page must be between 1 and 10000000.")
	}
	start := min((page-1)*TaskOrderPageSize, len(snapshot.Items))
	end := min(start+TaskOrderPageSize, len(snapshot.Items))
	previous, next := int64(0), int64(0)
	if start > 0 {
		previous = snapshot.Items[start-1].ID
	}
	if end < len(snapshot.Items) {
		next = snapshot.Items[end].ID
	}
	items, err := hydrateTaskOrderItems(s, snapshot.Items[start:end])
	if err != nil {
		return nil, err
	}
	return &TaskOrderPage{
		TaskOrderScope: snapshot.Scope,
		ViewKind:       snapshot.View.ViewKind,
		OrderVersion:   snapshot.Version,
		Items:          items,
		Total:          len(snapshot.Items),
		Page:           page,
		PerPage:        TaskOrderPageSize,
		TotalPages:     (len(snapshot.Items) + TaskOrderPageSize - 1) / TaskOrderPageSize,
		PreviousTaskID: previous,
		NextTaskID:     next,
		ManualOrder:    true,
	}, nil
}

// Plan validates membership, version and adjacent anchors before a review card
// can be offered. It changes neither persistent rows nor the snapshot itself.
func (snapshot *TaskOrderSnapshot) Plan(change TaskOrderChange) ([]TaskOrderItem, error) {
	if change.OrderVersion != snapshot.Version {
		return nil, taskOrderFailure("STATE_CONFLICT", "The task order changed. Read the view again before reordering.")
	}
	if len(change.TaskIDs) < 1 || len(change.TaskIDs) > 100 || change.AfterTaskID < 0 || change.BeforeTaskID < 0 {
		return nil, taskOrderFailure("INVALID_ARGUMENTS", "Choose 1–100 distinct tasks and valid neighbouring task IDs.")
	}
	selected := make(map[int64]bool, len(change.TaskIDs))
	available := make(map[int64]TaskOrderItem, len(snapshot.Items))
	for _, item := range snapshot.Items {
		available[item.ID] = item
	}
	for _, id := range change.TaskIDs {
		if id <= 0 || selected[id] {
			return nil, taskOrderFailure("INVALID_ARGUMENTS", "Task IDs must be positive and distinct.")
		}
		if _, ok := available[id]; !ok {
			return nil, taskOrderFailure("STATE_CONFLICT", "A selected task is outside this visible view or bucket.")
		}
		selected[id] = true
	}
	remaining := make([]TaskOrderItem, 0, len(snapshot.Items)-len(selected))
	for _, item := range snapshot.Items {
		if !selected[item.ID] {
			remaining = append(remaining, item)
		}
	}
	at := -1
	for index := 0; index <= len(remaining); index++ {
		left, right := int64(0), int64(0)
		if index > 0 {
			left = remaining[index-1].ID
		}
		if index < len(remaining) {
			right = remaining[index].ID
		}
		if left == change.AfterTaskID && right == change.BeforeTaskID {
			at = index
			break
		}
	}
	if at < 0 {
		return nil, taskOrderFailure("STATE_CONFLICT", "The target neighbours are no longer adjacent after removing the selected tasks.")
	}
	ordered := make([]TaskOrderItem, 0, len(snapshot.Items))
	ordered = append(ordered, remaining[:at]...)
	for _, id := range change.TaskIDs {
		ordered = append(ordered, available[id])
	}
	ordered = append(ordered, remaining[at:]...)
	return ordered, nil
}

func (snapshot *TaskOrderSnapshot) CanUpdate(s *xorm.Session, a web.Auth, change TaskOrderChange) (bool, error) {
	if _, err := snapshot.Plan(change); err != nil {
		return false, err
	}
	for _, id := range change.TaskIDs {
		tp := &TaskPosition{TaskID: id, ProjectViewID: snapshot.Scope.ViewID}
		can, err := tp.CanUpdate(s, a)
		if err != nil || !can {
			return false, err
		}
	}
	return true, nil
}

// Place the whole block before writing any position. Normal moves touch only
// selected tasks. Exhausted float space or missing/tied old positions triggers
// one full-view spacing pass, retaining hidden rows and other buckets.
func (snapshot *TaskOrderSnapshot) positions(change TaskOrderChange) ([]*TaskPosition, bool) {
	selected := make(map[int64]bool, len(change.TaskIDs))
	byID := make(map[int64]taskOrderRow, len(snapshot.rows))
	for _, id := range change.TaskIDs {
		selected[id] = true
	}
	remaining := make([]taskOrderRow, 0, len(snapshot.rows)-len(selected))
	firstSelected := -1
	for _, row := range snapshot.rows {
		byID[row.ID] = row
		if selected[row.ID] {
			if firstSelected < 0 {
				firstSelected = len(remaining)
			}
		} else {
			remaining = append(remaining, row)
		}
	}
	at := min(firstSelected, len(remaining))
	for i, row := range remaining {
		if change.BeforeTaskID > 0 && row.ID == change.BeforeTaskID {
			at = i
			break
		}
		if change.BeforeTaskID == 0 && change.AfterTaskID > 0 && row.ID == change.AfterTaskID {
			at = i + 1
			break
		}
	}
	ordered := make([]taskOrderRow, 0, len(snapshot.rows))
	ordered = append(ordered, remaining[:at]...)
	for _, id := range change.TaskIDs {
		ordered = append(ordered, byID[id])
	}
	ordered = append(ordered, remaining[at:]...)
	heal := false
	for i, row := range snapshot.rows {
		if !row.HasPosition || row.Position < MinPositionSpacing || (i > 0 && row.Position-snapshot.rows[i-1].Position < MinPositionSpacing) {
			heal = true
			break
		}
	}
	proposed, gapOK := taskOrderGap(remaining, at, len(change.TaskIDs))
	heal = heal || !gapOK
	changed := []*TaskPosition{}
	for i, row := range ordered {
		position := row.Position
		if heal {
			position = float64(i+1) * 65536
		} else if selected[row.ID] {
			position = proposed[i-at]
		}
		if row.HasPosition && math.Float64bits(row.Position) == math.Float64bits(position) {
			continue
		}
		changed = append(changed, &TaskPosition{
			TaskID:        row.ID,
			ProjectViewID: snapshot.Scope.ViewID,
			Position:      position,
		})
	}
	return changed, heal
}

func taskOrderGap(remaining []taskOrderRow, at, count int) ([]float64, bool) {
	if at < 0 || at > len(remaining) || count <= 0 {
		return nil, false
	}
	left := float64(0)
	leftIndex := at - 1
	if leftIndex >= 0 && leftIndex < len(remaining) {
		left = remaining[leftIndex].Position
	}
	right := left + float64(count+1)*65536
	if at < len(remaining) {
		right = remaining[at].Position
	}
	step := (right - left) / float64(count+1)
	if math.IsInf(step, 0) || math.IsNaN(step) || step < MinPositionSpacing {
		return nil, false
	}
	positions := make([]float64, count)
	previous := left
	for i := range positions {
		value := left + float64(i+1)*step
		if math.IsInf(value, 0) || math.IsNaN(value) || value < MinPositionSpacing || value-previous < MinPositionSpacing || right-value < MinPositionSpacing {
			return nil, false
		}
		positions[i] = value
		previous = value
	}
	return positions, true
}

func ReorderTaskView(ctx context.Context, s *xorm.Session, a web.Auth, scope TaskOrderScope, change TaskOrderChange) (*TaskOrderResult, error) {
	// Check visibility before any lock; lock the official view order before tasks.
	if _, err := taskOrderView(s, a, scope, false); err != nil {
		return nil, err
	}
	if db.Type() == schemas.SQLITE {
		if _, err := s.NoAutoTime().ID(scope.ViewID).Cols("id").Update(&ProjectView{ID: scope.ViewID}); err != nil {
			return nil, err
		}
	}
	if err := LockProjectViewsForTaskMutation(s, scope.ProjectID); err != nil {
		return nil, err
	}
	snapshot, err := readTaskViewOrder(s, a, scope, true)
	if err != nil {
		return nil, err
	}
	ordered, err := snapshot.Plan(change)
	if err != nil {
		return nil, err
	}
	changed, healed := snapshot.positions(change)
	if err = authorizeTaskOrderWrite(ctx, s, a, snapshot, change, changed); err != nil {
		return nil, err
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	if err = bulkInsertTaskPositions(s, changed, true); err != nil {
		return nil, err
	}
	actual, err := readTaskViewOrder(s, a, scope, true)
	if err != nil {
		return nil, err
	}
	if len(actual.Items) != len(ordered) {
		return nil, taskOrderFailure("STATE_CONFLICT", "The visible task membership changed during reordering.")
	}
	for i := range ordered {
		if actual.Items[i].ID != ordered[i].ID {
			return nil, taskOrderFailure("VERIFY_FAILED", "The final order did not match the requested placement; nothing was committed.")
		}
	}
	for _, position := range changed {
		if err = triggerTaskUpdatedEventForTaskID(s, a, position.TaskID); err != nil {
			return nil, fmt.Errorf("queue task order event: %w", err)
		}
	}
	return &TaskOrderResult{
		TaskOrderScope:       scope,
		TaskIDs:              slices.Clone(change.TaskIDs),
		ViewKind:             snapshot.View.ViewKind,
		OrderVersion:         actual.Version,
		ChangedPositions:     changed,
		PositionRecalculated: healed,
		ManualOrderSaved:     true,
		Verified:             true,
	}, nil
}

// MySQL RR plus the session memo may preserve grants read before waiting for
// view locks. A short independent permission read observes committed revocation.
// SQLite already holds its write lock and must reuse this transaction (a second
// connection cannot see uncommitted fixtures and could wait on the writer).
func authorizeTaskOrderWrite(ctx context.Context, s *xorm.Session, a web.Auth, snapshot *TaskOrderSnapshot, change TaskOrderChange, changed []*TaskPosition) error {
	permissionSession := s
	if db.Type() != schemas.SQLITE {
		bounded, cancel := context.WithTimeout(ctx, 2*time.Second)
		defer cancel()
		permissionSession = db.NewAutocommitSession()
		defer permissionSession.Close()
		db.SetSessionContext(bounded, permissionSession)
	}
	can, err := snapshot.CanUpdate(permissionSession, a, change)
	if err != nil {
		return err
	}
	if !can {
		return ErrGenericForbidden{}
	}
	for _, position := range changed {
		if slices.Contains(change.TaskIDs, position.TaskID) {
			continue
		}
		can, err = position.CanUpdate(permissionSession, a)
		if err != nil {
			return err
		}
		if !can {
			return ErrGenericForbidden{}
		}
	}
	return nil
}
