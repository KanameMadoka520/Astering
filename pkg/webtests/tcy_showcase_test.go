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

//nolint:gosmopolitan // Exercise Chinese user content and messages of the fork.
package webtests

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/modules/tcyshowcase"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYShowcaseIntegration(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath) })
	create := humaRequest(t, e, "POST", "/api/v2/projects", `{"title":"SECRET PROJECT"}`, token, "")
	require.Equal(t, 201, create.Code, create.Body.String())
	var project struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(create.Body.Bytes(), &project))
	zone := time.FixedZone("Asia/Shanghai", 8*3600)
	now := time.Now().In(zone).AddDate(0, 0, 1)
	start := time.Date(now.Year(), now.Month(), now.Day(), 10, 0, 0, 0, zone)
	end := start.Add(time.Hour)
	taskBody := fmt.Sprintf(`{"title":"SECRET TASK","description":"SECRET NOTES","start_date":%q,"end_date":%q}`, start.Format(time.RFC3339), end.Format(time.RFC3339))
	created := humaRequest(t, e, "POST", fmt.Sprintf("/api/v2/projects/%d/tasks", project.ID), taskBody, token, "")
	require.Equal(t, 201, created.Code, created.Body.String())
	var task struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &task))
	d := tcyshowcase.Default()
	d.Slug = "my-schedule"
	d.Projects = []tcyshowcase.ProjectRule{{ID: project.ID, Alias: "公开别名", Mode: "busy"}}
	d.Weekdays = []int{0, 1, 2, 3, 4, 5, 6}
	body := func() string { data, e := json.Marshal(d); require.NoError(t, e); return string(data) }
	assert.Equal(t, 401, humaRequest(t, e, "GET", "/api/v2/showcase/settings", "", "", "").Code)
	assert.Equal(t, 404, humaRequest(t, e, "GET", "/api/v2/public/my-schedule", "", "", "").Code)
	preview := humaRequest(t, e, "POST", "/api/v2/showcase/preview", body(), token, "")
	require.Equal(t, 200, preview.Code, preview.Body.String())
	var p tcyshowcase.Preview
	require.NoError(t, json.Unmarshal(preview.Body.Bytes(), &p))
	require.Len(t, p.Page.Events, 1)
	assert.Equal(t, "Busy", p.Page.Events[0].Title)
	assert.Equal(t, "SECRET TASK", p.Sources[0].Title)
	assert.NotEmpty(t, p.Page.Free)
	denied := humaRequest(t, e, "POST", "/api/v2/showcase/publish", body(), other, "")
	assert.Equal(t, 400, denied.Code, denied.Body.String())
	published := humaRequest(t, e, "POST", "/api/v2/showcase/publish", body(), token, "")
	require.Equal(t, 200, published.Code, published.Body.String())
	public := humaRequest(t, e, "GET", "/api/v2/public/my-schedule", "", "", "")
	require.Equal(t, 200, public.Code, public.Body.String())
	for _, secret := range []string{"SECRET", `"sources"`, `"project_id"`, `"id"`, `"description"`} {
		assert.NotContains(t, public.Body.String(), secret)
	}
	assert.Contains(t, public.Body.String(), "公开别名")
	assert.Contains(t, public.Body.String(), "Busy")
	// A private draft must not change an already published page.
	d.Projects[0].Mode = "titles"
	saved := humaRequest(t, e, "POST", "/api/v2/showcase/settings", body(), token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	assert.NotContains(t, humaRequest(t, e, "GET", "/api/v2/public/my-schedule", "", "", "").Body.String(), "SECRET TASK")
	d.Tasks = []tcyshowcase.TaskRule{{ID: task.ID, Alias: "公开任务别名"}}
	require.Equal(t, 200, humaRequest(t, e, "POST", "/api/v2/showcase/publish", body(), token, "").Code)
	public = humaRequest(t, e, "GET", "/api/v2/public/my-schedule", "", "", "")
	assert.Contains(t, public.Body.String(), "公开任务别名")
	assert.NotContains(t, public.Body.String(), "SECRET")
	d.Tasks[0].Hidden = true
	hidden := humaRequest(t, e, "POST", "/api/v2/showcase/preview", body(), token, "")
	require.Equal(t, 200, hidden.Code, hidden.Body.String())
	require.NoError(t, json.Unmarshal(hidden.Body.Bytes(), &p))
	assert.Empty(t, p.Page.Events)
	require.Equal(t, 200, humaRequest(t, e, "POST", "/api/v2/showcase/unpublish", "", token, "").Code)
	assert.Equal(t, 404, humaRequest(t, e, "GET", "/api/v2/public/my-schedule", "", "", "").Code)
	original := humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/tasks/%d", task.ID), "", token, "")
	assert.Contains(t, original.Body.String(), "SECRET TASK")
}

func TestTCYFreeTimes(t *testing.T) {
	zone := time.FixedZone("Asia/Shanghai", 8*3600)
	day := time.Date(2026, 10, 26, 0, 0, 0, 0, zone)
	at := func(h int) time.Time { return day.Add(time.Duration(h) * time.Hour) }
	d := tcyshowcase.Default()
	d.Days = 1
	d.StartHour = 9
	d.EndHour = 18
	events := []tcyshowcase.Event{{Start: at(10), End: at(12), Kind: "busy"}, {Start: at(11), End: at(13), Kind: "busy"}, {Start: at(14), End: at(14), Kind: "deadline"}, {Start: at(17), End: at(20), Kind: "busy"}}
	assert.Equal(t, []tcyshowcase.Interval{{Start: at(9), End: at(10)}, {Start: at(13), End: at(17)}}, tcyshowcase.FreeTimes(day, day, d, events))
	assert.Equal(t, []tcyshowcase.Interval{{Start: at(15), End: at(17)}}, tcyshowcase.FreeTimes(day, at(15), d, events))
}

func TestTCYShowcaseAllDayPrivacyAndAvailability(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath) })
	created := humaRequest(t, e, "POST", "/api/v2/projects", `{"title":"PRIVATE CIVIL PROJECT"}`, token, "")
	require.Equal(t, 201, created.Code, created.Body.String())
	var project struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &project))
	zone := time.FixedZone("Asia/Shanghai", 8*3600)
	now := time.Now().In(zone)
	tomorrow := time.Date(now.Year(), now.Month(), now.Day()+1, 0, 0, 0, 0, zone)
	end := tomorrow.AddDate(0, 0, 2)
	body := fmt.Sprintf(`{"title":"PRIVATE CIVIL TASK","all_day":true,"all_day_start":%q,"all_day_end":%q}`, tomorrow.Format(time.DateOnly), end.Format(time.DateOnly))
	created = humaRequest(t, e, "POST", fmt.Sprintf("/api/v2/projects/%d/tasks", project.ID), body, token, "")
	require.Equal(t, 201, created.Code, created.Body.String())
	var task struct {
		ID int64 `json:"id"`
	}
	require.NoError(t, json.Unmarshal(created.Body.Bytes(), &task))
	draft := tcyshowcase.Default()
	draft.Slug = "civil-availability"
	draft.Days = 5
	draft.Weekdays = []int{0, 1, 2, 3, 4, 5, 6}
	draft.Projects = []tcyshowcase.ProjectRule{{ID: project.ID, Alias: "Public alias", Mode: "busy"}}
	payload := func() string { b, err := json.Marshal(draft); require.NoError(t, err); return string(b) }
	denied := humaRequest(t, e, "POST", "/api/v2/showcase/preview", payload(), other, "")
	require.GreaterOrEqual(t, denied.Code, 400)
	preview := humaRequest(t, e, "POST", "/api/v2/showcase/preview", payload(), token, "")
	require.Equal(t, 200, preview.Code, preview.Body.String())
	var p tcyshowcase.Preview
	require.NoError(t, json.Unmarshal(preview.Body.Bytes(), &p))
	require.Len(t, p.Page.Events, 1)
	require.Len(t, p.Sources, 1)
	assert.True(t, p.Page.Events[0].AllDay)
	assert.Equal(t, "busy", p.Page.Events[0].Kind)
	assert.Equal(t, "Busy", p.Page.Events[0].Title)
	assert.True(t, p.Page.Events[0].Start.Equal(tomorrow))
	assert.True(t, p.Page.Events[0].End.Equal(end))
	for _, free := range p.Page.Free {
		assert.False(t, free.Start.Before(end) && free.End.After(tomorrow), "Explicit all-day busy dates cannot be reported free")
	}
	published := humaRequest(t, e, "POST", "/api/v2/showcase/publish", payload(), token, "")
	require.Equal(t, 200, published.Code, published.Body.String())
	public := humaRequest(t, e, "GET", "/api/v2/public/civil-availability", "", "", "")
	require.Equal(t, 200, public.Code, public.Body.String())
	for _, secret := range []string{"PRIVATE", `"sources"`, `"project_id"`, `"id"`} {
		assert.NotContains(t, public.Body.String(), secret)
	}
	assert.Contains(t, public.Body.String(), `"all_day":true`)
	// A valid civil range outside the public horizon must still expose its
	// independently selected deadline, without turning it into a busy block.
	due := tomorrow.Add(12 * time.Hour)
	path := fmt.Sprintf("/api/v2/tasks/%d", task.ID)
	patch := fmt.Sprintf(`{"all_day_start":%q,"all_day_end":%q,"due_date":%q}`, tomorrow.AddDate(0, 0, -3).Format(time.DateOnly), tomorrow.AddDate(0, 0, -2).Format(time.DateOnly), due.Format(time.RFC3339))
	updated := humaRequest(t, e, "PATCH", path, patch, token, "")
	require.Equal(t, 200, updated.Code, updated.Body.String())
	public = humaRequest(t, e, "GET", "/api/v2/public/civil-availability", "", "", "")
	require.Equal(t, 200, public.Code, public.Body.String())
	var page tcyshowcase.Page
	require.NoError(t, json.Unmarshal(public.Body.Bytes(), &page))
	require.Len(t, page.Events, 1)
	assert.Equal(t, "deadline", page.Events[0].Kind)
	assert.False(t, page.Events[0].AllDay)
	assert.True(t, page.Events[0].Start.Equal(due))
	assert.True(t, page.Events[0].End.Equal(due))
	assert.NotContains(t, public.Body.String(), "PRIVATE")
	// Bringing the range back retains the established one-event busy priority,
	// even though its independent deadline also falls within this window.
	patch = fmt.Sprintf(`{"all_day_start":%q,"all_day_end":%q}`, tomorrow.Format(time.DateOnly), end.Format(time.DateOnly))
	updated = humaRequest(t, e, "PATCH", path, patch, token, "")
	require.Equal(t, 200, updated.Code, updated.Body.String())
	public = humaRequest(t, e, "GET", "/api/v2/public/civil-availability", "", "", "")
	require.Equal(t, 200, public.Code, public.Body.String())
	require.NoError(t, json.Unmarshal(public.Body.Bytes(), &page))
	require.Len(t, page.Events, 1)
	assert.Equal(t, "busy", page.Events[0].Kind)
	assert.True(t, page.Events[0].AllDay)
	draft.Tasks = []tcyshowcase.TaskRule{{ID: task.ID, Hidden: true}}
	preview = humaRequest(t, e, "POST", "/api/v2/showcase/preview", payload(), token, "")
	require.Equal(t, 200, preview.Code, preview.Body.String())
	require.NoError(t, json.Unmarshal(preview.Body.Bytes(), &p))
	assert.Empty(t, p.Page.Events)
	draft.Tasks = nil
	draft.Projects[0].Mode = "hidden"
	preview = humaRequest(t, e, "POST", "/api/v2/showcase/preview", payload(), token, "")
	require.Equal(t, 200, preview.Code, preview.Body.String())
	require.NoError(t, json.Unmarshal(preview.Body.Bytes(), &p))
	assert.Empty(t, p.Page.Events)
	assert.Empty(t, p.Sources)
}
