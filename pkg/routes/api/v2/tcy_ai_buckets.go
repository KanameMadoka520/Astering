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
	"cmp"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/web"

	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// Bucket tools call the kanban models directly instead of looping through HTTP: list results stay
// compact, and every write runs its official Can* check, change and verification in one transaction.

type aiBucketArgs struct {
	ProjectID       int64   `json:"project_id"`
	ViewID          int64   `json:"view_id"`
	BucketID        *int64  `json:"bucket_id"`
	TaskID          int64   `json:"task_id"`
	Page            int     `json:"page"`
	Title           *string `json:"title"`
	Limit           *int64  `json:"limit"`
	AfterBucketID   *int64  `json:"after_bucket_id"`
	DefaultBucketID *int64  `json:"default_bucket_id"`
	DoneBucketID    *int64  `json:"done_bucket_id"`
}

func (a aiBucketArgs) bucketID() int64 {
	if a.BucketID == nil {
		return 0
	}
	return *a.BucketID
}

func parseAIBucketArgs(raw json.RawMessage) (aiBucketArgs, error) {
	var a aiBucketArgs
	if err := json.Unmarshal(raw, &a); err != nil {
		return a, tcyai.ToolFailure("INVALID_ARGUMENTS", "Bucket tool arguments must be a JSON object matching the discovered schema.")
	}
	if a.ProjectID == 0 || a.ProjectID == models.FavoritesPseudoProjectID {
		return a, tcyai.ToolFailure("INVALID_ARGUMENTS", "project_id must be a real project ID, or a saved filter's negative ID from list_projects. Favorites has no editable board.")
	}
	return a, nil
}

// aiBoard is one view and its manual buckets, ordered like the fallback Bucket.Delete picks (position, then id).
type aiBoard struct {
	view    *models.ProjectView
	buckets []*models.Bucket
}

func (b *aiBoard) find(id int64) (*models.Bucket, int) {
	for i, bucket := range b.buckets {
		if bucket.ID == id {
			return bucket, i
		}
	}
	return nil, -1
}

func (b *aiBoard) title(id int64) string {
	if bucket, _ := b.find(id); bucket != nil {
		return bucket.Title
	}
	return ""
}

// leftOf returns the bucket directly left of id, or 0 when id is leftmost.
func (b *aiBoard) leftOf(id int64) int64 {
	_, i := b.find(id)
	if i <= 0 {
		return 0
	}
	return b.buckets[i-1].ID
}

type aiBucketRow struct {
	ID       int64   `json:"id"`
	Title    string  `json:"title"`
	Limit    int64   `json:"limit"`
	Position float64 `json:"position"`
}

type aiBoardState struct {
	ProjectID       int64         `json:"project_id"`
	ViewID          int64         `json:"view_id"`
	ViewKind        string        `json:"view_kind"`
	Mode            string        `json:"bucket_configuration_mode"`
	DefaultBucketID int64         `json:"default_bucket_id"`
	DoneBucketID    int64         `json:"done_bucket_id"`
	Buckets         []aiBucketRow `json:"buckets"`
}

func (b *aiBoard) state() aiBoardState {
	rows := make([]aiBucketRow, 0, len(b.buckets))
	for _, bucket := range b.buckets {
		rows = append(rows, aiBucketRow{
			ID:       bucket.ID,
			Title:    bucket.Title,
			Limit:    bucket.Limit,
			Position: bucket.Position,
		})
	}
	return aiBoardState{
		ProjectID:       b.view.ProjectID,
		ViewID:          b.view.ID,
		ViewKind:        aiEnum(&b.view.ViewKind),
		Mode:            aiEnum(&b.view.BucketConfigurationMode),
		DefaultBucketID: b.view.DefaultBucketID,
		DoneBucketID:    b.view.DoneBucketID,
		Buckets:         rows,
	}
}

func (b *aiBoard) viewRef() map[string]any {
	return map[string]any{
		"id":                b.view.ID,
		"title":             b.view.Title,
		"project_id":        b.view.ProjectID,
		"default_bucket_id": b.view.DefaultBucketID,
		"done_bucket_id":    b.view.DoneBucketID,
	}
}

func (b *aiBoard) bucketRefs() []map[string]any {
	refs := make([]map[string]any, 0, len(b.buckets))
	for i, bucket := range b.buckets {
		refs = append(refs, map[string]any{
			"id":    bucket.ID,
			"title": bucket.Title,
			"limit": bucket.Limit,
			"order": i + 1,
		})
	}
	return refs
}

// The view enums only implement MarshalJSON on pointers; reusing it keeps names in sync with the API.
func aiEnum(value json.Marshaler) string {
	raw, err := value.MarshalJSON()
	if err != nil {
		return ""
	}
	var name string
	_ = json.Unmarshal(raw, &name)
	return name
}

func aiClip(text string, limit int) string {
	if utf8.RuneCountInString(text) <= limit {
		return text
	}
	return string([]rune(text)[:limit]) + "…"
}

func aiFilterText(filter *models.TaskCollection) string {
	if filter == nil {
		return ""
	}
	return aiClip(filter.Filter, 300)
}

func aiLocking(s *xorm.Session, lock bool) *xorm.Session {
	if kind := db.Type(); lock && (kind == schemas.MYSQL || kind == schemas.POSTGRES) {
		return s.ForUpdate()
	}
	return s
}

func aiViewBuckets(s *xorm.Session, viewID int64) ([]*models.Bucket, error) {
	buckets := []*models.Bucket{}
	err := s.
		Where("project_view_id = ?", viewID).
		OrderBy("COALESCE(position, 0) asc, id asc").
		Find(&buckets)
	return buckets, err
}

func (e *aiExecution) loadBoard(s *xorm.Session, a aiBucketArgs, lock bool) (*aiBoard, error) {
	if a.ViewID < 1 {
		return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "view_id is required; read it from list_project_views.")
	}
	view := &models.ProjectView{}
	exists, err := aiLocking(s, lock).
		Where("id = ? AND project_id = ?", a.ViewID, a.ProjectID).
		NoAutoCondition().
		Get(view)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("View %d is not a view of project %d. Read list_project_views instead of guessing IDs.", a.ViewID, a.ProjectID))
	}
	can, _, err := view.CanRead(s, e.auth)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, tcyai.ToolFailure("FORBIDDEN", "Current permissions deny reading this board.")
	}
	board := &aiBoard{view: view, buckets: []*models.Bucket{}}
	if view.ViewKind == models.ProjectViewKindKanban && view.BucketConfigurationMode == models.BucketConfigurationModeManual {
		board.buckets, err = aiViewBuckets(aiLocking(s, lock), view.ID)
	}
	return board, err
}

func aiNotKanban(view *models.ProjectView) error {
	return tcyai.ToolFailure("VIEW_NOT_KANBAN", fmt.Sprintf("View %d is a %s view without kanban buckets; pick a kanban view from list_project_views.", view.ID, aiEnum(&view.ViewKind)))
}

// Mirrors checkBucketLimit, so a listed count is exactly the one a move is limited by.
func aiBucketTaskCount(s *xorm.Session, a web.Auth, view *models.ProjectView, bucketID int64) (int64, error) {
	if view.ProjectID < 0 || (view.Filter != nil && view.Filter.Filter != "") || view.BucketConfigurationMode == models.BucketConfigurationModeFilter {
		tc := &models.TaskCollection{
			ProjectID:     view.ProjectID,
			ProjectViewID: view.ID,
			Filter:        "bucket_id = " + strconv.FormatInt(bucketID, 10),
		}
		_, _, total, err := tc.ReadAll(s, a, "", 1, 1)
		return total, err
	}
	return s.Where("bucket_id = ?", bucketID).GroupBy("task_id").Count(&models.TaskBucket{})
}

// aiCountIn counts rows whose column is in ids, in chunks that stay below every database's parameter limit.
func aiCountIn(s *xorm.Session, bean any, column string, ids []int64, cond builder.Cond) (int64, error) {
	var total int64
	for start := 0; start < len(ids); start += 500 {
		n, err := s.Where(builder.And(builder.In(column, ids[start:min(start+500, len(ids))]), cond)).Count(bean)
		if err != nil {
			return 0, err
		}
		total += n
	}
	return total, nil
}

func aiBucketError(err error) error {
	if err == nil || errors.Is(err, context.Canceled) || errors.Is(err, context.DeadlineExceeded) {
		return err
	}
	var toolErr *tcyai.ToolError
	if errors.As(err, &toolErr) {
		return err
	}
	var processor web.HTTPErrorProcessor
	if !errors.As(err, &processor) {
		return err
	}
	h := processor.HTTPError()
	code := fmt.Sprintf("API_%d", h.HTTPCode)
	switch {
	case h.Code == models.ErrCodeBucketLimitExceeded:
		code = "BUCKET_LIMIT_EXCEEDED"
	case h.Code == models.ErrCodeCannotRemoveLastBucket:
		code = "LAST_BUCKET"
	case h.Code == models.ErrCodeTooManyBuckets:
		code = "TOO_MANY_BUCKETS"
	case h.Code == models.ErrCodeProjectIsArchived:
		code = "PROJECT_ARCHIVED"
	case h.HTTPCode == http.StatusForbidden:
		code = "FORBIDDEN"
	case h.HTTPCode == http.StatusNotFound:
		code = "NOT_FOUND"
	}
	return tcyai.ToolFailure(code, h.Message)
}

func aiVerifyFailed(detail string) error {
	return tcyai.ToolFailure("VERIFY_FAILED", detail+" The transaction was rolled back and nothing changed; read the board again before retrying.")
}

// Saved filter boards are account-level and gather tasks from several projects, so they never satisfy an explicit project write scope.
func (e *aiExecution) bucketScope(projectID int64) error {
	if len(e.input.WriteProjectIDs) > 0 && projectID < 0 {
		return tcyai.ToolFailure("SCOPE_DENIED", "Saved filter boards are account-level and span projects; clear the explicit write scope to change them.")
	}
	return e.scope(projectID)
}

// readBuckets serves list_project_views and list_buckets.
func (e *aiExecution) readBuckets(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	a, err := parseAIBucketArgs(raw)
	if err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	// Never commit a read: kanban reads may materialize saved-filter task positions as a side effect.
	defer func() { _ = s.Rollback() }()
	var out any
	if name == "list_project_views" {
		out, err = e.listProjectViews(s, a)
	} else {
		out, err = e.listBuckets(s, a)
	}
	if err != nil {
		return "", aiBucketError(err)
	}
	return marshalAI(out)
}

type aiViewSummary struct {
	ID              int64  `json:"id"`
	Title           string `json:"title"`
	ViewKind        string `json:"view_kind"`
	Filter          string `json:"filter,omitempty"`
	Mode            string `json:"bucket_configuration_mode,omitempty"`
	DefaultBucketID int64  `json:"default_bucket_id,omitempty"`
	DoneBucketID    int64  `json:"done_bucket_id,omitempty"`
	BucketCount     *int64 `json:"bucket_count,omitempty"`
}

func (e *aiExecution) listProjectViews(s *xorm.Session, a aiBucketArgs) (any, error) {
	result, _, _, err := (&models.ProjectView{ProjectID: a.ProjectID}).ReadAll(s, e.auth, "", 0, 0)
	if err != nil {
		return nil, err
	}
	views, ok := result.([]*models.ProjectView)
	if !ok {
		return nil, fmt.Errorf("ProjectView.ReadAll returned unexpected type %T", result)
	}
	rows := make([]aiViewSummary, 0, len(views))
	for _, view := range views {
		row := aiViewSummary{
			ID:       view.ID,
			Title:    view.Title,
			ViewKind: aiEnum(&view.ViewKind),
			Filter:   aiFilterText(view.Filter),
		}
		if view.ViewKind == models.ProjectViewKindKanban {
			row.Mode = aiEnum(&view.BucketConfigurationMode)
			count := int64(len(view.BucketConfiguration))
			if view.BucketConfigurationMode == models.BucketConfigurationModeManual {
				row.DefaultBucketID = view.DefaultBucketID
				row.DoneBucketID = view.DoneBucketID
				count, err = s.Where("project_view_id = ?", view.ID).Count(&models.Bucket{})
				if err != nil {
					return nil, err
				}
			}
			row.BucketCount = &count
		}
		rows = append(rows, row)
	}
	out := map[string]any{
		"project_id": a.ProjectID,
		"views":      rows,
		"total":      len(rows),
		"note":       "Use a kanban view_id with list_buckets. Omitted default/done bucket IDs are unset.",
	}
	if filterID := models.GetSavedFilterIDFromProjectID(a.ProjectID); filterID > 0 {
		filter, err := models.GetSavedFilterSimpleByID(s, filterID)
		if err != nil {
			return nil, err
		}
		out["saved_filter"] = map[string]any{
			"title":  filter.Title,
			"filter": aiFilterText(filter.Filters),
			"note":   "Boards of a saved filter collect matching tasks from several projects; moving a task there also needs write access to the task's own project.",
		}
	}
	return out, nil
}

type aiBucketSummary struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Order     int    `json:"order"`
	Limit     int64  `json:"limit"`
	TaskCount int64  `json:"task_count"`
	Full      bool   `json:"full,omitempty"`
	Default   bool   `json:"is_default,omitempty"`
	Done      bool   `json:"is_done,omitempty"`
	Filter    string `json:"filter,omitempty"`
}

type aiBucketTask struct {
	ID        int64  `json:"id"`
	Title     string `json:"title"`
	Done      bool   `json:"done"`
	ProjectID int64  `json:"project_id"`
	DueDate   string `json:"due_date,omitempty"`
	Priority  int64  `json:"priority,omitempty"`
}

func (e *aiExecution) listBuckets(s *xorm.Session, a aiBucketArgs) (any, error) {
	board, err := e.loadBoard(s, a, false)
	if err != nil {
		return nil, err
	}
	view := board.view
	if view.ViewKind != models.ProjectViewKindKanban || view.BucketConfigurationMode == models.BucketConfigurationModeNone {
		return nil, aiNotKanban(view)
	}
	summaries := []aiBucketSummary{}
	if view.BucketConfigurationMode == models.BucketConfigurationModeFilter {
		// Filter buckets are virtual: their IDs are 0-based positions in the view's configuration.
		for i, configuration := range view.BucketConfiguration {
			summaries = append(summaries, aiBucketSummary{
				ID:     int64(i),
				Title:  configuration.Title,
				Order:  i + 1,
				Filter: aiFilterText(configuration.Filter),
			})
		}
	}
	for i, bucket := range board.buckets {
		summaries = append(summaries, aiBucketSummary{
			ID:      bucket.ID,
			Title:   bucket.Title,
			Order:   i + 1,
			Limit:   bucket.Limit,
			Default: bucket.ID == view.DefaultBucketID,
			Done:    bucket.ID == view.DoneBucketID,
		})
	}
	viewRef := map[string]any{
		"id":                        view.ID,
		"title":                     view.Title,
		"bucket_configuration_mode": aiEnum(&view.BucketConfigurationMode),
		"default_bucket_id":         view.DefaultBucketID,
		"done_bucket_id":            view.DoneBucketID,
	}
	if view.BucketConfigurationMode == models.BucketConfigurationModeFilter {
		viewRef["note"] = "Buckets of this view are generated by filters and cannot be changed with bucket tools."
	}
	if a.BucketID == nil {
		if a.Page > 0 {
			return nil, tcyai.ToolFailure("INVALID_ARGUMENTS", "page pages one bucket's tasks; pass bucket_id as well.")
		}
		for i := range summaries {
			count, err := aiBucketTaskCount(s, e.auth, view, summaries[i].ID)
			if err != nil {
				return nil, err
			}
			summaries[i].TaskCount = count
			summaries[i].Full = summaries[i].Limit > 0 && count >= summaries[i].Limit
		}
		return map[string]any{
			"project_id": a.ProjectID,
			"view":       viewRef,
			"buckets":    summaries,
			"total":      len(summaries),
			"note":       "Buckets are ordered left to right. Pass bucket_id (and page) to read one bucket's tasks.",
		}, nil
	}
	index := slices.IndexFunc(summaries, func(row aiBucketSummary) bool { return row.ID == *a.BucketID })
	if index < 0 {
		return nil, tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("Bucket %d is not a bucket of view %d; list the buckets first.", *a.BucketID, view.ID))
	}
	page := max(a.Page, 1)
	tc := &models.TaskCollection{
		ProjectID:     view.ProjectID,
		ProjectViewID: view.ID,
		Filter:        "bucket_id = " + strconv.FormatInt(*a.BucketID, 10),
	}
	result, _, total, err := tc.ReadAll(s, e.auth, "", page, tcyai.BucketTasksPerPage)
	if err != nil {
		return nil, err
	}
	tasks, ok := result.([]*models.Task)
	if !ok {
		return nil, fmt.Errorf("TaskCollection.ReadAll returned unexpected type %T for a bucket filter", result)
	}
	rows := make([]aiBucketTask, 0, len(tasks))
	for _, task := range tasks {
		row := aiBucketTask{
			ID:        task.ID,
			Title:     task.Title,
			Done:      task.Done,
			ProjectID: task.ProjectID,
			Priority:  task.Priority,
		}
		if !task.DueDate.IsZero() {
			row.DueDate = task.DueDate.Format(time.RFC3339)
		}
		rows = append(rows, row)
	}
	bucket := summaries[index]
	bucket.TaskCount = total
	bucket.Full = bucket.Limit > 0 && total >= bucket.Limit
	return map[string]any{
		"project_id":  a.ProjectID,
		"view":        viewRef,
		"bucket":      bucket,
		"tasks":       rows,
		"page":        page,
		"per_page":    tcyai.BucketTasksPerPage,
		"total":       total,
		"total_pages": (total + tcyai.BucketTasksPerPage - 1) / tcyai.BucketTasksPerPage,
	}, nil
}

// aiBucketPlan is computed identically for the preview and inside the locked write transaction;
// state feeds the version, before/after are only built for the review preview.
type aiBucketPlan struct {
	board      *aiBoard
	bucket     *models.Bucket
	task       *models.Task
	state      map[string]any
	before     any
	after      map[string]any
	projectIDs []int64

	position     float64
	leftID       int64
	fromID       int64
	expectBucket int64
	expectDone   bool
	doneViews    []*models.ProjectView
	effects      []string
	moved        []int64
	destID       int64
	liveTasks    int64
	defaultID    int64
	doneID       int64
}

func (p *aiBucketPlan) version() (string, error) {
	_, version, err := aiSnapshotVersion([]map[string]any{p.state})
	return version, err
}

func (p *aiBucketPlan) addProject(id int64) {
	if id > 0 && !slices.Contains(p.projectIDs, id) {
		p.projectIDs = append(p.projectIDs, id)
	}
}

func (e *aiExecution) planBucket(s *xorm.Session, name string, a aiBucketArgs, preview bool) (*aiBucketPlan, error) {
	plan, err := e.buildBucketPlan(s, name, a, preview)
	return plan, aiBucketError(err)
}

func (e *aiExecution) buildBucketPlan(s *xorm.Session, name string, a aiBucketArgs, preview bool) (*aiBucketPlan, error) {
	if e.input.Mode != "write" {
		return nil, tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Bucket changes need write mode; this run is read-only.")
	}
	board, err := e.loadBoard(s, a, !preview)
	if err != nil {
		return nil, err
	}
	view := board.view
	if view.ViewKind != models.ProjectViewKindKanban || view.BucketConfigurationMode == models.BucketConfigurationModeNone {
		return nil, aiNotKanban(view)
	}
	if view.BucketConfigurationMode != models.BucketConfigurationModeManual {
		return nil, tcyai.ToolFailure("VIEW_NOT_MANUAL", fmt.Sprintf("View %d generates its buckets from filters; change them in the view settings, not with bucket tools.", view.ID))
	}
	if err = e.bucketScope(view.ProjectID); err != nil {
		return nil, err
	}
	plan := &aiBucketPlan{
		board:      board,
		projectIDs: []int64{},
		state:      map[string]any{"board": board.state()},
		after:      map[string]any{},
	}
	plan.addProject(view.ProjectID)
	switch name {
	case "create_bucket":
		err = e.planCreateBucket(s, a, plan)
	case "update_bucket":
		err = e.planUpdateBucket(s, a, plan, preview)
	case "move_task_to_bucket":
		err = e.planMoveTask(s, a, plan, preview)
	case "set_view_buckets":
		err = e.planViewBuckets(s, a, plan)
	case "delete_bucket":
		err = e.planDeleteBucket(s, a, plan, preview)
	default:
		err = tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown bucket tool.")
	}
	return plan, err
}

func aiBucketPosition(prev, next *models.Bucket) float64 {
	switch {
	case prev == nil && next == nil:
		return 0
	case prev == nil:
		return next.Position / 2
	case next == nil:
		return prev.Position + 65536
	}
	return prev.Position + (next.Position-prev.Position)/2
}

// aiPlacement resolves after_bucket_id with the board's drag math (calculateItemPosition). A nil
// after appends on create and keeps the position on update. Ties or exhausted gaps are refused
// rather than nudged, since a nudge could land on the wrong side of a neighbour.
func aiPlacement(buckets []*models.Bucket, moving int64, after *int64, appendByDefault bool) (left int64, position float64, change bool, err error) {
	others := slices.DeleteFunc(slices.Clone(buckets), func(b *models.Bucket) bool { return b.ID == moving })
	var prev, next *models.Bucket
	switch {
	case after == nil && !appendByDefault:
		return 0, 0, false, nil
	case after == nil:
		if len(others) > 0 {
			prev = others[len(others)-1]
		}
	case *after == 0:
		if len(others) > 0 {
			next = others[0]
		}
	default:
		if *after == moving {
			return 0, 0, false, tcyai.ToolFailure("INVALID_ARGUMENTS", "after_bucket_id cannot be the bucket itself.")
		}
		i := slices.IndexFunc(others, func(b *models.Bucket) bool { return b.ID == *after })
		if i < 0 {
			return 0, 0, false, tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("after_bucket_id %d is not a bucket of this view.", *after))
		}
		prev = others[i]
		if i+1 < len(others) {
			next = others[i+1]
		}
	}
	if prev != nil {
		left = prev.ID
	}
	if moving != 0 {
		i := slices.IndexFunc(buckets, func(b *models.Bucket) bool { return b.ID == moving })
		current := int64(0)
		if i > 0 {
			current = buckets[i-1].ID
		}
		if current == left {
			return left, 0, false, nil
		}
	}
	position = aiBucketPosition(prev, next)
	if (prev != nil && position <= prev.Position) || (next != nil && position >= next.Position) {
		return 0, 0, false, tcyai.ToolFailure("POSITION_UNAVAILABLE", "No free position exists at that place because neighbouring buckets share a position; reorder them on the board first.")
	}
	return left, position, true, nil
}

func (e *aiExecution) planCreateBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) error {
	board := plan.board
	if a.Title == nil {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "title is required.")
	}
	can, err := (&models.Bucket{ProjectID: a.ProjectID, ProjectViewID: board.view.ID}).CanCreate(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "Creating buckets needs write access to this board's project, or ownership of its saved filter.")
	}
	left, position, _, err := aiPlacement(board.buckets, 0, a.AfterBucketID, true)
	if err != nil {
		return err
	}
	plan.leftID = left
	plan.position = position
	limit := int64(0)
	if a.Limit != nil {
		limit = *a.Limit
	}
	// An object, not an array: there is no existing bucket to diff field by field.
	plan.before = map[string]any{
		"view":    board.viewRef(),
		"buckets": board.bucketRefs(),
	}
	plan.after = map[string]any{
		"title":              *a.Title,
		"limit":              limit,
		"after_bucket_id":    left,
		"after_bucket_title": board.title(left),
	}
	return nil
}

func (e *aiExecution) planUpdateBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan, preview bool) error {
	board := plan.board
	bucket, _ := board.find(a.bucketID())
	if bucket == nil {
		return tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("Bucket %d is not a bucket of view %d; read list_buckets.", a.bucketID(), board.view.ID))
	}
	if a.Title == nil && a.Limit == nil && a.AfterBucketID == nil {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "Include title, limit or after_bucket_id to change.")
	}
	can, err := (&models.Bucket{ID: bucket.ID, ProjectID: a.ProjectID, ProjectViewID: board.view.ID}).CanUpdate(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "Changing buckets needs write access to this board's project, or ownership of its saved filter.")
	}
	left, position, change, err := aiPlacement(board.buckets, bucket.ID, a.AfterBucketID, false)
	if err != nil {
		return err
	}
	plan.bucket = bucket
	plan.position = bucket.Position
	plan.leftID = board.leftOf(bucket.ID)
	if change {
		plan.position = position
		plan.leftID = left
	}
	if !preview {
		return nil
	}
	// One entity whose keys match the arguments, so the review table shows old and new values.
	plan.before = []map[string]any{{
		"id":              bucket.ID,
		"bucket_id":       bucket.ID,
		"title":           bucket.Title,
		"limit":           bucket.Limit,
		"after_bucket_id": board.leftOf(bucket.ID),
		"project_id":      a.ProjectID,
		"view_id":         board.view.ID,
	}}
	title, limit := bucket.Title, bucket.Limit
	if a.Title != nil {
		title = *a.Title
	}
	if a.Limit != nil {
		limit = *a.Limit
	}
	plan.after = map[string]any{
		"title":              title,
		"limit":              limit,
		"after_bucket_id":    plan.leftID,
		"after_bucket_title": board.title(plan.leftID),
	}
	if a.Limit != nil && limit > 0 {
		count, err := aiBucketTaskCount(s, e.auth, board.view, bucket.ID)
		if err != nil {
			return err
		}
		plan.after["task_count"] = count
		if count > limit {
			plan.after["warning"] = "limit_below_task_count: existing tasks stay; only new moves into this bucket are refused."
		}
	}
	return nil
}

func (e *aiExecution) planMoveTask(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan, preview bool) error {
	board := plan.board
	view := board.view
	target, _ := board.find(a.bucketID())
	if target == nil {
		return tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("Bucket %d is not a bucket of view %d; read list_buckets.", a.bucketID(), view.ID))
	}
	if a.TaskID < 1 {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "task_id is required.")
	}
	// Check before reading the task so a preview never reveals a task the caller cannot write.
	can, err := (&models.TaskBucket{BucketID: target.ID, TaskID: a.TaskID, ProjectViewID: view.ID, ProjectID: a.ProjectID}).CanUpdate(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "This move needs write access to the board and to the task's own project, and the task must belong to the view: a project board holds only its project's tasks, a saved filter board only tasks matching its filter.")
	}
	task, err := models.GetTaskSimple(aiLocking(s, !preview), &models.Task{ID: a.TaskID})
	if err != nil {
		return err
	}
	if err = e.scope(task.ProjectID); err != nil {
		return err
	}
	plan.task = &task
	plan.addProject(task.ProjectID)
	current := &models.TaskBucket{}
	if _, err = s.Where("task_id = ? AND project_view_id = ?", task.ID, view.ID).Get(current); err != nil {
		return err
	}
	plan.fromID = current.BucketID

	// Expectations mirror updateTaskBucket, which owns the done-bucket rules.
	repeating := task.RepeatAfter > 0 || task.RepeatMode == models.TaskRepeatModeMonth
	doneID := view.DoneBucketID
	plan.expectBucket = target.ID
	plan.expectDone = task.Done
	plan.effects = []string{}
	switch {
	case current.BucketID == target.ID:
		plan.effects = append(plan.effects, "already_in_bucket")
	case doneID != 0 && target.ID == doneID && !task.Done && repeating:
		plan.effects = append(plan.effects, "repeating_task_advances_dates")
		plan.expectBucket = current.BucketID
		if view.DefaultBucketID != 0 {
			plan.expectBucket = view.DefaultBucketID
		}
		if plan.expectBucket == current.BucketID {
			plan.effects = append(plan.effects, "stays_in_current_bucket")
		} else {
			plan.effects = append(plan.effects, "returns_to_default_bucket")
		}
	case doneID != 0 && target.ID == doneID && !task.Done:
		plan.expectDone = true
		plan.effects = append(plan.effects, "marks_task_done")
		plan.doneViews = []*models.ProjectView{}
		err = s.
			Where(builder.And(
				builder.Eq{
					"project_id":                view.ProjectID,
					"view_kind":                 models.ProjectViewKindKanban,
					"bucket_configuration_mode": models.BucketConfigurationModeManual,
				},
				builder.Neq{"id": view.ID},
				builder.Neq{"done_bucket_id": 0},
			)).
			OrderBy("id asc").
			Find(&plan.doneViews)
		if err != nil {
			return err
		}
		if len(plan.doneViews) > 0 {
			plan.effects = append(plan.effects, "also_moves_into_done_bucket_of_other_views")
		}
	case doneID != 0 && current.BucketID == doneID && task.Done:
		plan.expectDone = false
		plan.effects = append(plan.effects, "reopens_task")
	}
	doneViews := make([]map[string]int64, 0, len(plan.doneViews))
	for _, other := range plan.doneViews {
		doneViews = append(doneViews, map[string]int64{
			"view_id":        other.ID,
			"done_bucket_id": other.DoneBucketID,
		})
	}
	plan.state["task"] = map[string]any{
		"id":           task.ID,
		"project_id":   task.ProjectID,
		"title":        task.Title,
		"done":         task.Done,
		"repeat_after": task.RepeatAfter,
		"repeat_mode":  task.RepeatMode,
		"due_date":     task.DueDate,
		"start_date":   task.StartDate,
		"end_date":     task.EndDate,
		"bucket_id":    current.BucketID,
	}
	plan.state["done_views"] = doneViews
	if !preview {
		return nil
	}
	if current.BucketID != target.ID && target.Limit > 0 {
		count, err := aiBucketTaskCount(s, e.auth, view, target.ID)
		if err != nil {
			return err
		}
		if count >= target.Limit {
			return tcyai.ToolFailure("BUCKET_LIMIT_EXCEEDED", fmt.Sprintf("Bucket %d (%s) is full: %d of %d tasks. Raise its limit or move another task out first.", target.ID, target.Title, count, target.Limit))
		}
	}
	plan.before = []map[string]any{{
		"id":                  task.ID,
		"title":               task.Title,
		"task_id":             task.ID,
		"project_id":          a.ProjectID,
		"view_id":             view.ID,
		"bucket_id":           current.BucketID,
		"bucket_title":        board.title(current.BucketID),
		"target_bucket_title": target.Title,
		"done":                task.Done,
		"repeating":           repeating,
		"task_project_id":     task.ProjectID,
		"effects":             plan.effects,
	}}
	plan.after = map[string]any{
		"bucket_id":    plan.expectBucket,
		"bucket_title": board.title(plan.expectBucket),
		"done":         plan.expectDone,
		"effects":      plan.effects,
		"done_views":   doneViews,
	}
	return nil
}

func (e *aiExecution) planViewBuckets(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) error {
	board := plan.board
	view := board.view
	if a.DefaultBucketID == nil && a.DoneBucketID == nil {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "Include default_bucket_id or done_bucket_id to change.")
	}
	can, err := (&models.ProjectView{ID: view.ID, ProjectID: view.ProjectID}).CanUpdate(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "Choosing the default or done bucket needs project admin permission, or ownership of the saved filter.")
	}
	stale := []string{}
	resolve := func(field string, requested *int64, stored int64) (int64, error) {
		if requested == nil {
			// ProjectView.Update drops a stored id whose bucket is gone; show that instead of hiding it.
			if bucket, _ := board.find(stored); bucket == nil {
				if stored != 0 {
					stale = append(stale, field)
				}
				return 0, nil
			}
			return stored, nil
		}
		if *requested == 0 {
			return 0, nil
		}
		// Update would silently store 0 for an unknown bucket, so an unknown id is an error here.
		if bucket, _ := board.find(*requested); bucket == nil {
			return 0, tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("%s %d is not a bucket of view %d; read list_buckets.", field, *requested, view.ID))
		}
		return *requested, nil
	}
	if plan.defaultID, err = resolve("default_bucket_id", a.DefaultBucketID, view.DefaultBucketID); err != nil {
		return err
	}
	if plan.doneID, err = resolve("done_bucket_id", a.DoneBucketID, view.DoneBucketID); err != nil {
		return err
	}
	if plan.defaultID != 0 && plan.defaultID == plan.doneID {
		return tcyai.ToolFailure("INVALID_ARGUMENTS", "The default and done bucket must differ: new tasks would land in the done column without being done.")
	}
	plan.before = []map[string]any{{
		"id":                view.ID,
		"title":             view.Title,
		"view_id":           view.ID,
		"project_id":        a.ProjectID,
		"default_bucket_id": view.DefaultBucketID,
		"done_bucket_id":    view.DoneBucketID,
		"buckets":           board.bucketRefs(),
	}}
	plan.after = map[string]any{
		"default_bucket_id":    plan.defaultID,
		"default_bucket_title": board.title(plan.defaultID),
		"done_bucket_id":       plan.doneID,
		"done_bucket_title":    board.title(plan.doneID),
		"stale_ids_cleared":    stale,
		"note":                 "Existing tasks keep their done state and bucket; the done bucket applies to later moves and completions.",
	}
	return nil
}

func (e *aiExecution) planDeleteBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan, preview bool) error {
	board := plan.board
	view := board.view
	bucket, _ := board.find(a.bucketID())
	if bucket == nil {
		return tcyai.ToolFailure("NOT_FOUND", fmt.Sprintf("Bucket %d is not a bucket of view %d; read list_buckets.", a.bucketID(), view.ID))
	}
	can, err := (&models.Bucket{ID: bucket.ID, ProjectID: a.ProjectID, ProjectViewID: view.ID}).CanDelete(s, e.auth)
	if err != nil {
		return err
	}
	if !can {
		return tcyai.ToolFailure("FORBIDDEN", "Deleting buckets needs write access to this board's project, or ownership of its saved filter.")
	}
	if len(board.buckets) <= 1 {
		return tcyai.ToolFailure("LAST_BUCKET", fmt.Sprintf("Bucket %d is the only bucket of view %d; a board keeps at least one bucket.", bucket.ID, view.ID))
	}
	plan.bucket = bucket

	// Mirror Bucket.Delete: ids pointing at the bucket are cleared, and its view update drops stale ids.
	plan.defaultID, plan.doneID = view.DefaultBucketID, view.DoneBucketID
	cleared := []string{}
	if plan.defaultID == bucket.ID {
		plan.defaultID = 0
		cleared = append(cleared, "default_bucket_id")
	}
	if plan.doneID == bucket.ID {
		plan.doneID = 0
		cleared = append(cleared, "done_bucket_id")
	}
	if len(cleared) > 0 {
		if other, _ := board.find(plan.defaultID); other == nil {
			plan.defaultID = 0
		}
		if other, _ := board.find(plan.doneID); other == nil {
			plan.doneID = 0
		}
	}
	plan.destID = plan.defaultID
	if plan.destID == 0 {
		for _, candidate := range board.buckets {
			if candidate.ID != bucket.ID {
				plan.destID = candidate.ID
				break
			}
		}
	}
	plan.moved = []int64{}
	err = aiLocking(s, !preview).
		Table(&models.TaskBucket{}).
		Where("bucket_id = ?", bucket.ID).
		Cols("task_id").
		OrderBy("task_id asc").
		Find(&plan.moved)
	if err != nil {
		return err
	}
	if len(plan.moved) > 0 {
		if dest, _ := board.find(plan.destID); dest == nil {
			return tcyai.ToolFailure("BUCKET_IS_FALLBACK", fmt.Sprintf("View %d's default_bucket_id %d points to a bucket that no longer exists, so the %d tasks would be left in no column. Choose a valid default bucket with set_view_buckets first.", view.ID, plan.destID, len(plan.moved)))
		}
	}
	plan.liveTasks, err = aiCountIn(s, &models.Task{}, "id", plan.moved, builder.NewCond())
	if err != nil {
		return err
	}
	doneTasks, err := aiCountIn(s, &models.Task{}, "id", plan.moved, builder.Eq{"done": true})
	if err != nil {
		return err
	}
	plan.state["moved_task_ids"] = plan.moved
	plan.state["done_tasks"] = doneTasks
	if !preview {
		return nil
	}
	sample := []map[string]any{}
	hidden := 0
	if len(plan.moved) > 0 {
		tasks, err := models.GetTasksSimpleByIDs(s, plan.moved[:min(len(plan.moved), 20)])
		if err != nil {
			return err
		}
		slices.SortFunc(tasks, func(x, y *models.Task) int { return cmp.Compare(x.ID, y.ID) })
		readable := map[int64]bool{}
		for _, task := range tasks {
			can, seen := readable[task.ProjectID]
			if !seen {
				can, _, err = (&models.Project{ID: task.ProjectID}).CanRead(s, e.auth)
				if err != nil {
					return err
				}
				readable[task.ProjectID] = can
			}
			if !can {
				hidden++
				continue
			}
			sample = append(sample, map[string]any{
				"id":    task.ID,
				"title": task.Title,
				"done":  task.Done,
			})
		}
	}
	destID, destTitle := int64(0), ""
	if len(plan.moved) > 0 {
		destID, destTitle = plan.destID, board.title(plan.destID)
	}
	plan.before = []map[string]any{{
		"id":                   bucket.ID,
		"title":                bucket.Title,
		"bucket_id":            bucket.ID,
		"view_id":              view.ID,
		"project_id":           a.ProjectID,
		"limit":                bucket.Limit,
		"is_default_bucket":    view.DefaultBucketID == bucket.ID,
		"is_done_bucket":       view.DoneBucketID == bucket.ID,
		"tasks_moved":          len(plan.moved),
		"done_tasks_moved":     doneTasks,
		"tasks_deleted":        0,
		"move_to_bucket_id":    destID,
		"move_to_bucket_title": destTitle,
		"clears":               cleared,
		"task_done_state":      "unchanged",
		"sample_tasks":         sample,
		"hidden_sample_tasks":  hidden,
	}}
	plan.after = map[string]any{
		"deleted_bucket_id": bucket.ID,
		"tasks_moved":       len(plan.moved),
		"move_to_bucket_id": destID,
		"default_bucket_id": plan.defaultID,
		"done_bucket_id":    plan.doneID,
		"tasks_deleted":     0,
	}
	return nil
}

func (e *aiExecution) prepareBucket(ctx context.Context, name string, raw json.RawMessage) (tcyai.Operation, error) {
	op := tcyai.Operation{Units: 1, ProjectIDs: []int64{}, After: string(raw)}
	if !tcyai.IsWriteTool(name) {
		return op, nil
	}
	a, err := parseAIBucketArgs(raw)
	if err != nil {
		return op, err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	defer func() { _ = s.Rollback() }()
	plan, err := e.planBucket(s, name, a, true)
	if err != nil {
		return op, err
	}
	op.ProjectIDs = plan.projectIDs
	if op.Version, err = plan.version(); err != nil {
		return op, err
	}
	if op.Before, err = marshalAI(plan.before); err != nil {
		return op, err
	}
	op.After, err = marshalAI(plan.after)
	return op, err
}

func (e *aiExecution) executeBucket(ctx context.Context, name string, raw json.RawMessage) (string, error) {
	if !tcyai.IsWriteTool(name) {
		return e.readBuckets(ctx, name, raw)
	}
	if e.input.Mode != "write" {
		return "", tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Bucket changes need write mode; this run is read-only.")
	}
	op := tcyai.CurrentOperation(ctx)
	if op == nil || op.Version == "" {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "Bucket changes only run from a prepared preview; prepare the operation again.")
	}
	// Independent of the runtime review policy: a delete never runs without an approved preview.
	if name == "delete_bucket" && !op.Approved {
		return "", tcyai.ToolFailure("REVIEW_REQUIRED", "Deleting a bucket always needs the user's approval of its preview.")
	}
	a, err := parseAIBucketArgs(raw)
	if err != nil {
		return "", err
	}
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	db.SetSessionContext(ctx, s)
	plan, err := e.planBucket(s, name, a, false)
	if err != nil {
		return "", err
	}
	version, err := plan.version()
	if err != nil {
		return "", err
	}
	if version != op.Version {
		return "", tcyai.ToolFailure("STATE_CONFLICT", "The board changed after the preview. Read it again with list_buckets and prepare a fresh operation.")
	}
	var result map[string]any
	switch name {
	case "create_bucket":
		result, err = e.applyCreateBucket(s, a, plan)
	case "update_bucket":
		result, err = e.applyUpdateBucket(s, a, plan)
	case "move_task_to_bucket":
		result, err = e.applyMoveTask(s, a, plan)
	case "set_view_buckets":
		result, err = e.applyViewBuckets(s, plan)
	case "delete_bucket":
		result, err = e.applyDeleteBucket(s, a, plan)
	default:
		err = tcyai.ToolFailure("TOOL_NOT_ALLOWED", "Unknown bucket tool.")
	}
	if err != nil {
		return "", aiBucketError(err)
	}
	if err = ctx.Err(); err != nil {
		return "", err
	}
	if err = s.Commit(); err != nil {
		return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: "Database commit failed; read the board with list_buckets before any new change. This operation will not be replayed.", Uncertain: true}
	}
	events.DispatchPending(ctx, s)
	op.Verified = true
	result["success"] = true
	result["verified"] = true
	return marshalAI(result)
}

func (e *aiExecution) applyCreateBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) (map[string]any, error) {
	view := plan.board.view
	bucket := &models.Bucket{
		ProjectID:     a.ProjectID,
		ProjectViewID: view.ID,
		Title:         *a.Title,
		Position:      plan.position,
	}
	if a.Limit != nil {
		bucket.Limit = *a.Limit
	}
	if err := bucket.Create(s, e.auth); err != nil {
		return nil, err
	}
	buckets, err := aiViewBuckets(s, view.ID)
	if err != nil {
		return nil, err
	}
	board := &aiBoard{view: view, buckets: buckets}
	created, i := board.find(bucket.ID)
	if created == nil || created.Title != bucket.Title || created.Limit != bucket.Limit || board.leftOf(bucket.ID) != plan.leftID {
		return nil, aiVerifyFailed("The stored bucket does not match the requested title, limit or place.")
	}
	return map[string]any{
		"bucket": map[string]any{
			"id":    created.ID,
			"title": created.Title,
			"limit": created.Limit,
			"order": i + 1,
		},
		"buckets": board.bucketRefs(),
	}, nil
}

func (e *aiExecution) applyUpdateBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) (map[string]any, error) {
	view := plan.board.view
	// Bucket.Update writes title, limit and position together, so start from the stored row.
	bucket := &models.Bucket{
		ID:            plan.bucket.ID,
		ProjectID:     a.ProjectID,
		ProjectViewID: view.ID,
		Title:         plan.bucket.Title,
		Limit:         plan.bucket.Limit,
		Position:      plan.position,
	}
	if a.Title != nil {
		bucket.Title = *a.Title
	}
	if a.Limit != nil {
		bucket.Limit = *a.Limit
	}
	if err := bucket.Update(s, e.auth); err != nil {
		return nil, err
	}
	buckets, err := aiViewBuckets(s, view.ID)
	if err != nil {
		return nil, err
	}
	board := &aiBoard{view: view, buckets: buckets}
	got, i := board.find(bucket.ID)
	if got == nil || got.Title != bucket.Title || got.Limit != bucket.Limit || got.Position != bucket.Position || board.leftOf(bucket.ID) != plan.leftID {
		return nil, aiVerifyFailed("The stored bucket does not match the requested title, limit or place.")
	}
	return map[string]any{
		"bucket": map[string]any{
			"id":    got.ID,
			"title": got.Title,
			"limit": got.Limit,
			"order": i + 1,
		},
		"previous": map[string]any{
			"title":           plan.bucket.Title,
			"limit":           plan.bucket.Limit,
			"after_bucket_id": plan.board.leftOf(plan.bucket.ID),
		},
		"buckets": board.bucketRefs(),
	}, nil
}

func (e *aiExecution) applyMoveTask(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) (map[string]any, error) {
	view := plan.board.view
	move := &models.TaskBucket{
		BucketID:      a.bucketID(),
		TaskID:        plan.task.ID,
		ProjectViewID: view.ID,
		ProjectID:     a.ProjectID,
	}
	if err := move.Update(s, e.auth); err != nil {
		return nil, err
	}
	bucketOf := func(viewID int64) (int64, error) {
		row := &models.TaskBucket{}
		_, err := s.Where("task_id = ? AND project_view_id = ?", plan.task.ID, viewID).Get(row)
		return row.BucketID, err
	}
	got, err := bucketOf(view.ID)
	if err != nil {
		return nil, err
	}
	task, err := models.GetTaskSimple(s, &models.Task{ID: plan.task.ID})
	if err != nil {
		return nil, err
	}
	if got != plan.expectBucket || task.Done != plan.expectDone {
		return nil, aiVerifyFailed(fmt.Sprintf("Task %d ended in bucket %d with done=%t instead of bucket %d with done=%t.", task.ID, got, task.Done, plan.expectBucket, plan.expectDone))
	}
	for _, other := range plan.doneViews {
		bucketID, err := bucketOf(other.ID)
		if err != nil {
			return nil, err
		}
		if bucketID != other.DoneBucketID {
			return nil, aiVerifyFailed(fmt.Sprintf("Task %d was not placed in done bucket %d of view %d.", task.ID, other.DoneBucketID, other.ID))
		}
	}
	return map[string]any{
		"task": map[string]any{
			"id":         task.ID,
			"title":      task.Title,
			"done":       task.Done,
			"project_id": task.ProjectID,
		},
		"bucket": map[string]any{
			"id":    got,
			"title": plan.board.title(got),
		},
		"previous_bucket_id": plan.fromID,
		"effects":            plan.effects,
	}, nil
}

func (e *aiExecution) applyViewBuckets(s *xorm.Session, plan *aiBucketPlan) (map[string]any, error) {
	view := plan.board.view
	// ProjectView.Update rewrites every column, so send the full stored row with only the two ids changed.
	updated := *view
	updated.DefaultBucketID = plan.defaultID
	updated.DoneBucketID = plan.doneID
	if err := updated.Update(s, e.auth); err != nil {
		return nil, err
	}
	got, err := models.GetProjectViewByIDAndProject(s, view.ID, view.ProjectID)
	if err != nil {
		return nil, err
	}
	before, err := json.Marshal(view.Filter)
	if err != nil {
		return nil, err
	}
	after, err := json.Marshal(got.Filter)
	if err != nil {
		return nil, err
	}
	if got.DefaultBucketID != plan.defaultID || got.DoneBucketID != plan.doneID || got.Title != view.Title || got.ViewKind != view.ViewKind ||
		got.BucketConfigurationMode != view.BucketConfigurationMode || got.Position != view.Position || string(before) != string(after) {
		return nil, aiVerifyFailed("The stored view does not match the requested default and done buckets, or other view settings changed.")
	}
	return map[string]any{
		"view": map[string]any{
			"id":                   got.ID,
			"title":                got.Title,
			"default_bucket_id":    got.DefaultBucketID,
			"default_bucket_title": plan.board.title(got.DefaultBucketID),
			"done_bucket_id":       got.DoneBucketID,
			"done_bucket_title":    plan.board.title(got.DoneBucketID),
		},
		"previous": map[string]any{
			"default_bucket_id": view.DefaultBucketID,
			"done_bucket_id":    view.DoneBucketID,
		},
	}, nil
}

func (e *aiExecution) applyDeleteBucket(s *xorm.Session, a aiBucketArgs, plan *aiBucketPlan) (map[string]any, error) {
	view := plan.board.view
	bucket := &models.Bucket{
		ID:            plan.bucket.ID,
		ProjectID:     a.ProjectID,
		ProjectViewID: view.ID,
	}
	if err := bucket.Delete(s, e.auth); err != nil {
		return nil, err
	}
	exists, err := s.Where("id = ?", bucket.ID).Exist(&models.Bucket{})
	if err != nil {
		return nil, err
	}
	left, err := s.Where("bucket_id = ?", bucket.ID).Count(&models.TaskBucket{})
	if err != nil {
		return nil, err
	}
	arrived, err := aiCountIn(s, &models.TaskBucket{}, "task_id", plan.moved, builder.Eq{"bucket_id": plan.destID})
	if err != nil {
		return nil, err
	}
	live, err := aiCountIn(s, &models.Task{}, "id", plan.moved, builder.NewCond())
	if err != nil {
		return nil, err
	}
	got, err := models.GetProjectViewByIDAndProject(s, view.ID, view.ProjectID)
	if err != nil {
		return nil, err
	}
	if exists || left != 0 || arrived != int64(len(plan.moved)) || live != plan.liveTasks || got.DefaultBucketID != plan.defaultID || got.DoneBucketID != plan.doneID {
		return nil, aiVerifyFailed(fmt.Sprintf("Deleting bucket %d did not end as previewed (%d of %d tasks arrived in bucket %d).", bucket.ID, arrived, len(plan.moved), plan.destID))
	}
	result := map[string]any{
		"deleted_bucket_id":    plan.bucket.ID,
		"deleted_bucket_title": plan.bucket.Title,
		"tasks_moved":          len(plan.moved),
		"tasks_deleted":        0,
		"view": map[string]any{
			"default_bucket_id": got.DefaultBucketID,
			"done_bucket_id":    got.DoneBucketID,
		},
	}
	if len(plan.moved) > 0 {
		result["moved_to_bucket"] = map[string]any{
			"id":    plan.destID,
			"title": plan.board.title(plan.destID),
		}
	}
	return result, nil
}
