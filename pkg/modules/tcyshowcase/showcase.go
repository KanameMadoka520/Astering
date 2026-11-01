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

//nolint:gosmopolitan // This fork intentionally provides Chinese prompts and user-facing messages.
package tcyshowcase

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"sync"
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web/handler"
)

type ProjectRule struct {
	ID    int64  `json:"id" minimum:"1" doc:"Internal project ID, never included in the public projection."`
	Alias string `json:"alias" maxLength:"100" doc:"Public name. Empty uses a generic name, never the internal name."`
	Mode  string `json:"mode" enum:"hidden,busy,titles" doc:"hidden excludes the project; busy conceals task names; titles opts into task title disclosure."`
}
type TaskRule struct {
	ID     int64  `json:"id" minimum:"1" doc:"Internal task ID."`
	Alias  string `json:"alias" maxLength:"200" doc:"Public task title override, does not modify the original task."`
	Hidden bool   `json:"hidden" doc:"Exclude this task entirely from the public schedule."`
}
type Draft struct {
	CustomLayout bool          `json:"custom_layout" doc:"Use only custom content for the page body; public JSON disclosure rules still apply."`
	Slug         string        `json:"slug" pattern:"^[a-z0-9][a-z0-9-]{2,47}$" doc:"Public URL slug, 3 to 48 lowercase letters, digits or hyphens."`
	Title        string        `json:"title" maxLength:"100" doc:"Public page heading."`
	Intro        string        `json:"intro" maxLength:"500" doc:"Public introduction."`
	Content      string        `json:"content" maxLength:"80000" doc:"Custom Markdown or static HTML; rendered in an isolated sandbox."`
	Format       string        `json:"format" enum:"markdown,html" doc:"Custom page format."`
	Days         int           `json:"days" minimum:"1" maximum:"31" doc:"Rolling schedule horizon in days."`
	StartHour    int           `json:"start_hour" minimum:"0" maximum:"23" doc:"Daily availability window start, Asia/Shanghai."`
	EndHour      int           `json:"end_hour" minimum:"1" maximum:"24" doc:"Daily availability window end, Asia/Shanghai."`
	Weekdays     []int         `json:"weekdays" maxItems:"7" doc:"Available weekdays, Sunday=0 through Saturday=6."`
	Projects     []ProjectRule `json:"projects" maxItems:"20" doc:"Explicit per-project disclosure rules."`
	Tasks        []TaskRule    `json:"tasks" maxItems:"500" doc:"Optional task aliases and exclusions."`
}
type State struct {
	Draft       Draft     `json:"draft" doc:"Private editable draft."`
	Published   *Draft    `json:"published" doc:"Last published rules, null when disabled."`
	PublishedAt time.Time `json:"published_at" doc:"Last publication time."`
}
type Event struct {
	Title   string    `json:"title" doc:"Public title after applying aliases and concealment."`
	Project string    `json:"project" doc:"Public project alias."`
	Start   time.Time `json:"start" doc:"Start or deadline in RFC3339."`
	End     time.Time `json:"end" doc:"End in RFC3339; equals start for a deadline."`
	Kind    string    `json:"kind" enum:"busy,deadline" doc:"Only busy blocks reduce computed availability."`
}
type Interval struct {
	Start time.Time `json:"start"`
	End   time.Time `json:"end"`
}
type Page struct {
	CustomLayout bool       `json:"custom_layout"`
	Slug         string     `json:"slug"`
	Title        string     `json:"title"`
	Intro        string     `json:"intro"`
	Content      string     `json:"content"`
	Format       string     `json:"format"`
	Timezone     string     `json:"timezone"`
	GeneratedAt  time.Time  `json:"generated_at"`
	PublishedAt  time.Time  `json:"published_at"`
	Until        time.Time  `json:"until"`
	Projects     []string   `json:"projects" doc:"Public aliases only."`
	Events       []Event    `json:"events" doc:"Allowlisted schedule fields only; no internal IDs, descriptions or participants."`
	Free         []Interval `json:"free" doc:"Unoccupied periods within the configured availability windows; not a booking guarantee."`
}
type Source struct {
	ID        int64  `json:"id"`
	ProjectID int64  `json:"project_id"`
	Title     string `json:"title"`
}
type Preview struct {
	Page    Page     `json:"page"`
	Sources []Source `json:"sources" doc:"Private editing hints. Never returned by the public endpoint."`
}

var lock sync.Mutex
var slugPattern = regexp.MustCompile(`^[a-z0-9][a-z0-9-]{2,47}$`)

func Default() Draft {
	return Draft{Title: "", Format: "markdown", Days: 7, StartHour: 9, EndHour: 21, Weekdays: []int{1, 2, 3, 4, 5}, Projects: []ProjectRule{}, Tasks: []TaskRule{}}
}
func path() string {
	return filepath.Join(config.FilesBasePath.GetString(), ".tcymc-public", "pages.json")
}
func read() (map[string]State, error) {
	states := map[string]State{}
	data, err := os.ReadFile(path())
	if errors.Is(err, os.ErrNotExist) {
		return states, nil
	}
	if err != nil {
		return nil, err
	}
	err = json.Unmarshal(data, &states)
	return states, err
}
func write(states map[string]State) error {
	data, err := json.Marshal(states)
	if err != nil {
		return err
	}
	if err = os.MkdirAll(filepath.Dir(path()), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(filepath.Dir(path()), ".pages-*")
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path())
}
func Load(uid int64) (State, error) {
	lock.Lock()
	defer lock.Unlock()
	if ownerDeleted(uid) {
		return State{}, ErrAccountDeleted
	}
	states, err := read()
	if err != nil {
		return State{}, err
	}
	s, ok := states[strconv.FormatInt(uid, 10)]
	if !ok {
		s.Draft = Default()
	}
	return s, nil
}
func Validate(d Draft) error {
	if !slugPattern.MatchString(d.Slug) || d.Days < 1 || d.Days > 31 || d.StartHour < 0 || d.EndHour > 24 || d.EndHour <= d.StartHour || len(d.Content) > 80000 || len(d.Projects) > 20 || len(d.Tasks) > 500 || len(d.Weekdays) > 7 {
		return tcylocale.Error("e48")
	}
	if d.Format != "markdown" && d.Format != "html" {
		return tcylocale.Error("e19")
	}
	ids := map[int64]bool{}
	for _, p := range d.Projects {
		if p.ID < 1 || ids[p.ID] || (p.Mode != "hidden" && p.Mode != "busy" && p.Mode != "titles") {
			return tcylocale.Error("e54")
		}
		ids[p.ID] = true
	}
	for _, day := range d.Weekdays {
		if day < 0 || day > 6 {
			return tcylocale.Error("e28")
		}
	}
	return nil
}
func Save(uid int64, d Draft, publish bool) (State, error) {
	if err := Validate(d); err != nil {
		return State{}, err
	}
	lock.Lock()
	defer lock.Unlock()
	if ownerDeleted(uid) {
		return State{}, ErrAccountDeleted
	}
	lease, err := acquireStoreLock()
	if err != nil {
		return State{}, err
	}
	defer lease.Close()
	states, err := read()
	if err != nil {
		return State{}, err
	}
	key := strconv.FormatInt(uid, 10)
	s := states[key]
	s.Draft = d
	if publish {
		for other, state := range states {
			if other != key && state.Published != nil && state.Published.Slug == d.Slug {
				return State{}, tcylocale.Error("e44")
			}
		}
		s.Published = &d
		s.PublishedAt = time.Now()
	}
	states[key] = s
	err = models.WithAccountWrite(uid, func() error { return write(states) })
	if errors.Is(err, models.ErrAccountCleanupUserMissing) {
		err = ErrAccountDeleted
	}
	return s, err
}
func Unpublish(uid int64) (State, error) {
	lock.Lock()
	defer lock.Unlock()
	if ownerDeleted(uid) {
		return State{}, ErrAccountDeleted
	}
	lease, err := acquireStoreLock()
	if err != nil {
		return State{}, err
	}
	defer lease.Close()
	states, err := read()
	if err != nil {
		return State{}, err
	}
	key := strconv.FormatInt(uid, 10)
	s, ok := states[key]
	if !ok {
		s.Draft = Default()
	}
	s.Published = nil
	states[key] = s
	err = models.WithAccountWrite(uid, func() error { return write(states) })
	if errors.Is(err, models.ErrAccountCleanupUserMissing) {
		err = ErrAccountDeleted
	}
	return s, err
}
func Public(slug string) (int64, State, error) {
	lock.Lock()
	defer lock.Unlock()
	states, err := read()
	if err != nil {
		return 0, State{}, err
	}
	for id, s := range states {
		if s.Published != nil && s.Published.Slug == slug {
			uid, e := strconv.ParseInt(id, 10, 64)
			if ownerDeleted(uid) {
				continue
			}
			return uid, s, e
		}
	}
	return 0, State{}, os.ErrNotExist
}

func Build(ctx context.Context, uid int64, d Draft) (Preview, error) {
	if err := Validate(d); err != nil {
		return Preview{}, err
	}
	session := db.NewReadSession()
	u, err := user.GetUserByID(session, uid)
	_ = session.Close()
	if err != nil {
		return Preview{}, err
	}
	zone := time.FixedZone("Asia/Shanghai", 8*3600)
	now := time.Now().In(zone)
	from := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, zone)
	until := from.AddDate(0, 0, d.Days)
	preview := Preview{Page: Page{CustomLayout: d.CustomLayout, Slug: d.Slug, Title: d.Title, Intro: d.Intro, Content: d.Content, Format: d.Format, Timezone: "Asia/Shanghai", GeneratedAt: now, Until: until, Projects: []string{}, Events: []Event{}, Free: []Interval{}}, Sources: []Source{}}
	overrides := map[int64]TaskRule{}
	for _, rule := range d.Tasks {
		overrides[rule.ID] = rule
	}
	for _, rule := range d.Projects {
		if rule.Mode == "hidden" {
			continue
		}
		project := &models.Project{ID: rule.ID}
		if _, err = handler.DoReadOne(ctx, project, u); err != nil {
			return Preview{}, tcylocale.Error("e31")
		}
		alias := rule.Alias
		if alias == "" {
			alias = tcylocale.Text(ctx, "privateProject")
		}
		preview.Page.Projects = append(preview.Page.Projects, alias)
		filter := fmt.Sprintf(`done = false && ((start_date < '%s' && end_date > '%s') || (due_date >= '%s' && due_date < '%s'))`, until.Format(time.RFC3339), from.Format(time.RFC3339), from.Format(time.RFC3339), until.Format(time.RFC3339))
		for page := 1; page <= 40; page++ {
			collection := &models.TaskCollection{ProjectID: rule.ID, Filter: filter}
			collection.SetForceFlatTasks()
			result, count, total, e := handler.DoReadAll(ctx, collection, u, "", page, 50)
			if e != nil {
				return Preview{}, e
			}
			tasks, ok := result.([]*models.Task)
			if !ok {
				return Preview{}, tcylocale.Error("e16")
			}
			for _, task := range tasks {
				preview.Sources = append(preview.Sources, Source{ID: task.ID, ProjectID: task.ProjectID, Title: task.Title})
				override := overrides[task.ID]
				if override.Hidden {
					continue
				}
				title := tcylocale.Text(ctx, "busy")
				if rule.Mode == "titles" {
					title = task.Title
				}
				if override.Alias != "" {
					title = override.Alias
				}
				if !task.StartDate.IsZero() && task.EndDate.After(task.StartDate) {
					start, end := task.StartDate, task.EndDate
					if start.Before(from) {
						start = from
					}
					if end.After(until) {
						end = until
					}
					if end.After(start) {
						preview.Page.Events = append(preview.Page.Events, Event{Title: title, Project: alias, Start: start, End: end, Kind: "busy"})
					}
				} else if !task.DueDate.Before(from) && task.DueDate.Before(until) {
					preview.Page.Events = append(preview.Page.Events, Event{Title: title, Project: alias, Start: task.DueDate, End: task.DueDate, Kind: "deadline"})
				}
			}
			if count == 0 || int64(page*50) >= total {
				break
			}
			if page == 40 {
				return Preview{}, tcylocale.Error("e27")
			}
		}
	}
	sort.Slice(preview.Page.Events, func(i, j int) bool { return preview.Page.Events[i].Start.Before(preview.Page.Events[j].Start) })
	preview.Page.Free = FreeTimes(from, now, d, preview.Page.Events)
	return preview, nil
}

func FreeTimes(from, now time.Time, d Draft, events []Event) []Interval {
	free := []Interval{}
	days := map[int]bool{}
	for _, day := range d.Weekdays {
		days[day] = true
	}
	for n := 0; n < d.Days; n++ {
		day := from.AddDate(0, 0, n)
		if !days[int(day.Weekday())] {
			continue
		}
		start := day.Add(time.Duration(d.StartHour) * time.Hour)
		end := day.Add(time.Duration(d.EndHour) * time.Hour)
		if start.Before(now) {
			start = now
		}
		if !end.After(start) {
			continue
		}
		busy := append([]Event{}, events...)
		sort.Slice(busy, func(i, j int) bool { return busy[i].Start.Before(busy[j].Start) })
		cursor := start
		for _, event := range busy {
			if event.Kind != "busy" || !event.End.After(cursor) || !event.Start.Before(end) {
				continue
			}
			if event.Start.After(cursor) {
				free = append(free, Interval{Start: cursor, End: event.Start})
			}
			if event.End.After(cursor) {
				cursor = event.End
			}
			if !cursor.Before(end) {
				break
			}
		}
		if cursor.Before(end) {
			free = append(free, Interval{Start: cursor, End: end})
		}
	}
	return free
}
