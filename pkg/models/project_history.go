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
	"sort"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

type ProjectLifecycleEvent struct {
	ID         int64     `xorm:"bigint autoincr not null pk" json:"id"`
	ProjectID  int64     `xorm:"bigint not null index" json:"project_id"`
	Kind       string    `xorm:"varchar(20) not null" json:"kind" doc:"completed, reopened, archived or unarchived."`
	OccurredAt time.Time `xorm:"null index" json:"occurred_at" doc:"Server-recorded time. Zero means a legacy archive with unknown date."`
}

func (*ProjectLifecycleEvent) TableName() string { return "project_lifecycle_events" }

func recordProjectArchive(s *xorm.Session, id int64, archived bool) error {
	kind := "unarchived"
	if archived {
		kind = "archived"
	}
	_, err := s.Insert(&ProjectLifecycleEvent{ProjectID: id, Kind: kind, OccurredAt: time.Now()})
	return err
}

// SetProjectCompleted requires project administration even when archived. It never
// modifies tasks or cascades completion to child projects. A guarded update makes
// retries idempotent; the event and state change share the caller's transaction.
func SetProjectCompleted(s *xorm.Session, a web.Auth, id int64, completed bool) (*Project, error) {
	p := &Project{ID: id}
	allowed, err := p.IsAdmin(s, a)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrGenericForbidden{}
	}
	stamp := time.Time{}
	kind := "reopened"
	if completed {
		stamp = time.Now()
		kind = "completed"
	}
	changed, err := s.ID(id).Where(builder.Eq{"is_completed": !completed}).Cols("is_completed", "completed_at").Update(&Project{IsCompleted: completed, CompletedAt: stamp})
	if err != nil {
		return nil, err
	}
	if changed > 0 {
		_, err = s.Insert(&ProjectLifecycleEvent{ProjectID: id, Kind: kind, OccurredAt: time.Now()})
		if err != nil {
			return nil, err
		}
	}
	p = &Project{}
	exists, err := s.ID(id).Get(p)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrProjectDoesNotExist{ID: id}
	}
	err = p.ReadOne(s, a)
	return p, err
}

type ProjectHistoryItem struct {
	ProjectLifecycleEvent `xorm:"extends"`
	Title                 string    `json:"title"`
	Created               time.Time `json:"created" doc:"Project creation time, for displaying the recorded project span, not a planned work schedule."`
	IsArchived            bool      `json:"is_archived"`
	IsCompleted           bool      `json:"is_completed"`
}

type ProjectHistoryScope struct {
	Projects  int `json:"projects" doc:"Current accessible projects matching project and search filters, including archived."`
	Completed int `json:"completed" doc:"Projects in this scope currently marked completed."`
	Archived  int `json:"archived" doc:"Projects in this scope currently archived; may also be completed."`
}

type ProjectHistory struct {
	Scope      *ProjectHistoryScope  `json:"scope" doc:"Current project states, independent of year, event kind, day and pagination."`
	Days       map[string]int        `json:"days" doc:"Number of project milestones per local YYYY-MM-DD; never task counts."`
	Years      []int                 `json:"years"`
	Unknown    int                   `json:"unknown" doc:"Matching legacy milestones without an original date."`
	Milestones int                   `json:"milestones" doc:"Matching milestones in the selected year."`
	Projects   int                   `json:"projects" doc:"Distinct projects with a matching milestone in the selected year."`
	ActiveDays int                   `json:"active_days"`
	Items      []*ProjectHistoryItem `json:"items"`
	Total      int64                 `json:"total"`
	Page       int                   `json:"page"`
	TotalPages int                   `json:"total_pages"`
}

type ProjectHistoryOptions struct {
	Year      int
	Timezone  string
	ProjectID int64
	Kind      string
	Day       string
	Unknown   bool
	Search    string
	Page      int
}

// GetProjectHistory applies the shared inherited/team/link-share ACL before all
// statistics and pagination. Reopening never erases earlier completion events.
func GetProjectHistory(s *xorm.Session, a web.Auth, opts ProjectHistoryOptions) (*ProjectHistory, error) {
	if opts.Year < 1970 || opts.Year > 9998 || opts.Page < 1 || opts.Page > 10000000 || opts.ProjectID < 0 {
		return nil, InvalidFieldErrorWithMessage([]string{"year", "page", "project"}, "Invalid project history range")
	}
	loc, err := time.LoadLocation(opts.Timezone)
	if err != nil {
		return nil, InvalidFieldErrorWithMessage([]string{"timezone"}, "Use a valid IANA timezone")
	}
	start := time.Date(opts.Year, 1, 1, 0, 0, 0, 0, loc)
	end := start.AddDate(1, 0, 0)
	if opts.Day != "" {
		day, parseErr := time.ParseInLocation(time.DateOnly, opts.Day, loc)
		if parseErr != nil || day.Year() != opts.Year || opts.Unknown {
			return nil, InvalidFieldErrorWithMessage([]string{"day"}, "Select a date in the selected year")
		}
	}
	access, err := accessibleProjectIDsCond(s, a, "projects.id")
	if err != nil {
		return nil, err
	}
	scopeCond := builder.And(access)
	if opts.ProjectID > 0 {
		scopeCond = scopeCond.And(builder.Eq{"projects.id": opts.ProjectID})
	}
	if opts.Search != "" {
		scopeCond = scopeCond.And(db.ILIKE("projects.title", opts.Search))
	}
	cond := builder.And(scopeCond)
	switch opts.Kind {
	case "", "milestones":
		cond = cond.And(builder.In("e.kind", []string{"completed", "archived"}))
	case "all":
	case "completed", "archived", "reopened", "unarchived":
		cond = cond.And(builder.Eq{"e.kind": opts.Kind})
	default:
		return nil, InvalidFieldErrorWithMessage([]string{"kind"}, "Invalid project event kind")
	}
	scope, err := projectHistoryScope(s, scopeCond)
	if err != nil {
		return nil, err
	}
	result := &ProjectHistory{Scope: scope, Days: map[string]int{}, Years: []int{}, Items: []*ProjectHistoryItem{}, Page: opts.Page}
	years := map[int]bool{}
	projects := map[int64]bool{}
	err = s.Table("project_lifecycle_events").Alias("e").Join("INNER", "projects", "projects.id = e.project_id").Select("e.occurred_at, e.project_id").Where(cond).Iterate(new(ProjectLifecycleEvent), func(_ int, bean interface{}) error {
		event := bean.(*ProjectLifecycleEvent)
		date := event.OccurredAt.In(loc)
		if event.OccurredAt.IsZero() || date.Year() < 1970 {
			result.Unknown++
			return nil
		}
		years[date.Year()] = true
		if date.Year() == opts.Year {
			result.Days[date.Format(time.DateOnly)]++
			result.Milestones++
			projects[event.ProjectID] = true
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	for year := range years {
		result.Years = append(result.Years, year)
	}
	sort.Sort(sort.Reverse(sort.IntSlice(result.Years)))
	result.ActiveDays = len(result.Days)
	result.Projects = len(projects)
	if opts.Unknown {
		cond = cond.And(builder.Or(builder.IsNull{"e.occurred_at"}, builder.Lt{"e.occurred_at": time.Date(1970, 1, 1, 0, 0, 0, 0, time.UTC)}))
	} else {
		if opts.Day != "" {
			start, _ = time.ParseInLocation(time.DateOnly, opts.Day, loc)
			end = start.AddDate(0, 0, 1)
		}
		cond = cond.And(builder.Gte{"e.occurred_at": start.UTC().Format(dbTimeFormat)}, builder.Lt{"e.occurred_at": end.UTC().Format(dbTimeFormat)})
	}
	result.Total, err = s.Table("project_lifecycle_events").Alias("e").Join("INNER", "projects", "projects.id = e.project_id").Where(cond).Count(new(ProjectLifecycleEvent))
	if err != nil {
		return nil, err
	}
	const pageSize = 24
	result.TotalPages = int((result.Total + pageSize - 1) / pageSize)
	err = s.Table("project_lifecycle_events").Alias("e").Select("e.*, projects.title, projects.created, projects.is_archived, projects.is_completed").Join("INNER", "projects", "projects.id = e.project_id").Where(cond).OrderBy("e.occurred_at DESC, e.id DESC").Limit(pageSize, (opts.Page-1)*pageSize).Find(&result.Items)
	return result, err
}

// The scope intentionally does not join events: active projects with no event
// must still explain an empty lifecycle view. Iterate only short state columns.
func projectHistoryScope(s *xorm.Session, cond builder.Cond) (*ProjectHistoryScope, error) {
	scope := &ProjectHistoryScope{}
	err := s.Table("projects").Select("is_completed, is_archived").Where(cond).Iterate(new(Project), func(_ int, bean interface{}) error {
		project := bean.(*Project)
		scope.Projects++
		if project.IsCompleted {
			scope.Completed++
		}
		if project.IsArchived {
			scope.Archived++
		}
		return nil
	})
	return scope, err
}
