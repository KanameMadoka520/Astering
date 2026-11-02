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
	"fmt"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

// CalendarTask is a query projection, not a persistent calendar entity.
type CalendarTask struct {
	ID           int64     `json:"id" doc:"Existing task ID; open the normal task endpoint for details or editing."`
	Title        string    `json:"title"`
	ProjectID    int64     `json:"project_id"`
	ProjectTitle string    `json:"project_title"`
	ProjectColor string    `json:"project_color"`
	HexColor     string    `json:"hex_color"`
	Priority     int64     `json:"priority"`
	Done         bool      `json:"done"`
	StartDate    time.Time `json:"start_date" doc:"Stored instant, unchanged; year 1 means unset. No all-day intent is inferred."`
	EndDate      time.Time `json:"end_date" doc:"Stored end instant, unchanged; never substituted with the due date."`
	DueDate      time.Time `json:"due_date" doc:"Independent stored deadline instant; year 1 means unset."`
	Updated      time.Time `json:"updated"`
}

type CalendarDayBoundary struct {
	Date    string    `json:"date" doc:"Civil YYYY-MM-DD label in timezone."`
	StartAt time.Time `json:"start_at" doc:"Inclusive instant of the local day's beginning."`
	EndAt   time.Time `json:"end_at" doc:"Exclusive beginning of the next civil day; a day can have fewer or more than 24 hours."`
}

type CalendarOptions struct {
	From            string
	To              string
	Timezone        string
	ProjectID       int64
	Done            string
	IncludeArchived bool
	Page            int
	PerPage         int
}

type CalendarProjection struct {
	Items    []CalendarTask
	Total    int64
	Timezone string
	From     string
	To       string
	Days     []CalendarDayBoundary
}

// CalendarInputError contains only fixed validation text, never private data.
type CalendarInputError struct{ Message string }

func (err *CalendarInputError) Error() string { return err.Message }

func calendarInput(message string) error { return &CalendarInputError{Message: message} }

func calendarCivil(value string) (time.Time, error) {
	parsed, err := time.Parse(time.DateOnly, value)
	if err != nil || parsed.Format(time.DateOnly) != value || parsed.Year() < 1970 || parsed.Year() > 9998 {
		return time.Time{}, calendarInput("Use a valid YYYY-MM-DD date between 1970 and 9998.")
	}
	return parsed, nil
}

// Advance labels in UTC, not local time: AddDate on a nonexistent local date can
// normalize backwards and repeat forever (e.g. Pacific/Apia 2011-12-30).
func calendarDayStart(civil time.Time, loc *time.Location) (time.Time, error) {
	y, m, d := civil.Date()
	start := time.Date(y, m, d, 0, 0, 0, 0, loc)
	if start.Format(time.DateOnly) == civil.Format(time.DateOnly) {
		return start, nil
	}
	noon := time.Date(y, m, d, 12, 0, 0, 0, loc)
	if noon.Format(time.DateOnly) != civil.Format(time.DateOnly) {
		return time.Time{}, calendarInput("The requested range contains a civil date that does not exist in this timezone.")
	}
	// Some DST transitions omit midnight but not the day (e.g. Santiago).
	// Find the first representable second of that date, with a bounded search.
	low, high := noon.Add(-24*time.Hour).Unix(), noon.Unix()
	label := civil.Format(time.DateOnly)
	for low < high {
		mid := low + (high-low)/2
		if time.Unix(mid, 0).In(loc).Format(time.DateOnly) < label {
			low = mid + 1
		} else {
			high = mid
		}
	}
	return time.Unix(low, 0).In(loc), nil
}

func calendarDays(from, to string, loc *time.Location) ([]CalendarDayBoundary, error) {
	first, err := calendarCivil(from)
	if err != nil {
		return nil, err
	}
	limit, err := calendarCivil(to)
	if err != nil {
		return nil, err
	}
	count := int(limit.Sub(first) / (24 * time.Hour))
	if count < 1 || count > 62 {
		return nil, calendarInput("The calendar range must contain between 1 and 62 civil days; to is exclusive.")
	}
	days := make([]CalendarDayBoundary, 0, count)
	start, err := calendarDayStart(first, loc)
	if err != nil {
		return nil, err
	}
	for label := first; label.Before(limit); label = label.AddDate(0, 0, 1) {
		end, boundaryErr := calendarDayStart(label.AddDate(0, 0, 1), loc)
		if boundaryErr != nil {
			return nil, boundaryErr
		}
		if !end.After(start) {
			return nil, calendarInput("The requested timezone has an unsupported civil-day transition.")
		}
		days = append(days, CalendarDayBoundary{
			Date:    label.Format(time.DateOnly),
			StartAt: start.UTC(),
			EndAt:   end.UTC(),
		})
		start = end
	}
	return days, nil
}

func calendarTimezone(s *xorm.Session, a web.Auth, requested string) (*time.Location, error) {
	if requested == "" {
		requested = config.GetTimeZone().String()
		if account, ok := a.(*user.User); ok {
			stored, err := user.GetUserByID(s, account.ID)
			if err != nil {
				return nil, err
			}
			if stored.Timezone != "" {
				requested = stored.Timezone
			}
		}
	}
	loc, err := time.LoadLocation(requested)
	if err != nil {
		return nil, calendarInput("Use a valid IANA timezone.")
	}
	return loc, nil
}

func calendarDateCondition(from, to time.Time) builder.Cond {
	// Match Xorm datetime storage exactly. Binding time.Time through the raw
	// table query adds a driver-specific offset suffix on SQLite and shifts
	// equality at both inclusive/exclusive boundaries.
	fromValue, toValue := from.UTC().Format(dbTimeFormat), to.UTC().Format(dbTimeFormat)
	points := builder.Or()
	for _, field := range []string{"tasks.start_date", "tasks.end_date", "tasks.due_date"} {
		points = points.Or(builder.And(builder.Gte{field: fromValue}, builder.Lt{field: toValue}))
	}
	// No due-date fallback and no invented start. Reversed ranges can still
	// contribute their independently valid date points through the OR above.
	// A reversed span passing these bounds has both points inside the window,
	// so the union is identical without a database-specific column comparison.
	span := builder.And(
		builder.Gt{"tasks.start_date": time.Time{}.UTC().Format(dbTimeFormat)},
		builder.Lt{"tasks.start_date": toValue},
		builder.Gt{"tasks.end_date": fromValue},
	)
	return builder.Or(points, span)
}

// GetCalendarTasks applies resource ACLs before count, paging or projection.
// It fetches only the visible interval's minimal task columns; no relation hydration.
func GetCalendarTasks(s *xorm.Session, a web.Auth, opts CalendarOptions) (*CalendarProjection, error) {
	if opts.ProjectID < 0 || opts.Page < 1 || opts.Page > 10000000 || opts.PerPage < 1 || opts.PerPage > config.ServiceMaxItemsPerPage.GetInt() {
		return nil, calendarInput("Invalid calendar project or pagination parameters.")
	}
	loc, err := calendarTimezone(s, a, opts.Timezone)
	if err != nil {
		return nil, err
	}
	days, err := calendarDays(opts.From, opts.To, loc)
	if err != nil {
		return nil, err
	}
	access, err := accessibleProjectIDsCond(s, a, "projects.id")
	if err != nil {
		return nil, err
	}
	cond := builder.And(access, taskNotDeletedCond("tasks"), calendarDateCondition(days[0].StartAt, days[len(days)-1].EndAt))
	if opts.ProjectID > 0 {
		cond = cond.And(builder.Eq{"tasks.project_id": opts.ProjectID})
	}
	if !opts.IncludeArchived {
		cond = cond.And(builder.Eq{"projects.is_archived": false})
	}
	switch opts.Done {
	case "", "open":
		cond = cond.And(builder.Or(builder.Eq{"tasks.done": false}, builder.IsNull{"tasks.done"}))
	case "done":
		cond = cond.And(builder.Eq{"tasks.done": true})
	case "all":
	default:
		return nil, calendarInput("done must be all, open or done.")
	}
	query := func() *xorm.Session {
		return s.Table("tasks").Join("INNER", "projects", "projects.id = tasks.project_id").Where(cond)
	}
	total, err := query().Count()
	if err != nil {
		return nil, fmt.Errorf("count calendar tasks: %w", err)
	}
	items := []CalendarTask{}
	err = query().Select("tasks.id, tasks.title, tasks.project_id, projects.title AS project_title, projects.hex_color AS project_color, tasks.hex_color, tasks.priority, tasks.done, tasks.start_date, tasks.end_date, tasks.due_date, tasks.updated").
		OrderBy("tasks.id asc").Limit(opts.PerPage, (opts.Page-1)*opts.PerPage).Find(&items)
	if err != nil {
		return nil, fmt.Errorf("read calendar tasks: %w", err)
	}
	return &CalendarProjection{
		Items:    items,
		Total:    total,
		Timezone: loc.String(),
		From:     opts.From,
		To:       opts.To,
		Days:     days,
	}, nil
}
