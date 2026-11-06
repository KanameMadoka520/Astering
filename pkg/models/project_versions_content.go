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

// Version DTOs deliberately do not embed database/API models. Schema 1 stays
// stable when ordinary models later gain permissions, display state or fields.
type versionFilterContent struct {
	Search             string   `json:"s"`
	SortBy             []string `json:"sort_by"`
	OrderBy            []string `json:"order_by"`
	Filter             string   `json:"filter"`
	FilterIncludeNulls bool     `json:"filter_include_nulls"`
}

func versionFilter(filter *TaskCollection) *versionFilterContent {
	if filter == nil {
		return nil
	}
	return &versionFilterContent{
		Search:             filter.Search,
		SortBy:             filter.SortBy,
		OrderBy:            filter.OrderBy,
		Filter:             filter.Filter,
		FilterIncludeNulls: filter.FilterIncludeNulls,
	}
}

type versionBucketConfigurationContent struct {
	Title  string                `json:"title"`
	Filter *versionFilterContent `json:"filter"`
}
type versionViewContent struct {
	ID                      int64                                `json:"id"`
	ProjectID               int64                                `json:"project_id"`
	Title                   string                               `json:"title"`
	ViewKind                string                               `json:"view_kind"`
	Filter                  *versionFilterContent                `json:"filter"`
	Position                float64                              `json:"position"`
	BucketConfigurationMode string                               `json:"bucket_configuration_mode"`
	BucketConfiguration     []*versionBucketConfigurationContent `json:"bucket_configuration"`
	DefaultBucketID         int64                                `json:"default_bucket_id"`
	DoneBucketID            int64                                `json:"done_bucket_id"`
}

func newVersionViewContent(view *ProjectView) versionViewContent {
	kinds := map[ProjectViewKind]string{
		ProjectViewKindList:   "list",
		ProjectViewKindGantt:  "gantt",
		ProjectViewKindTable:  "table",
		ProjectViewKindKanban: "kanban",
	}
	modes := map[BucketConfigurationModeKind]string{
		BucketConfigurationModeNone:   "none",
		BucketConfigurationModeManual: "manual",
		BucketConfigurationModeFilter: "filter",
	}
	var buckets []*versionBucketConfigurationContent
	if view.BucketConfiguration != nil {
		buckets = []*versionBucketConfigurationContent{}
	}
	for _, bucket := range view.BucketConfiguration {
		if bucket == nil {
			buckets = append(buckets, nil)
			continue
		}
		buckets = append(buckets, &versionBucketConfigurationContent{
			Title:  bucket.Title,
			Filter: versionFilter(bucket.Filter),
		})
	}
	return versionViewContent{
		ID:                      view.ID,
		ProjectID:               view.ProjectID,
		Title:                   view.Title,
		ViewKind:                kinds[view.ViewKind],
		Filter:                  versionFilter(view.Filter),
		Position:                view.Position,
		BucketConfigurationMode: modes[view.BucketConfigurationMode],
		BucketConfiguration:     buckets,
		DefaultBucketID:         view.DefaultBucketID,
		DoneBucketID:            view.DoneBucketID,
	}
}

type versionBucketContent struct {
	ID            int64   `json:"id"`
	ProjectViewID int64   `json:"project_view_id"`
	Title         string  `json:"title"`
	Limit         int64   `json:"limit"`
	Position      float64 `json:"position"`
}

func newVersionBucketContent(bucket *Bucket) versionBucketContent {
	return versionBucketContent{
		ID:            bucket.ID,
		ProjectViewID: bucket.ProjectViewID,
		Title:         bucket.Title,
		Limit:         bucket.Limit,
		Position:      bucket.Position,
	}
}

type versionRoutineContent struct {
	TaskID      int64  `json:"task_id"`
	Enabled     bool   `json:"enabled"`
	Paused      bool   `json:"paused"`
	Timezone    string `json:"timezone"`
	Period      string `json:"period"`
	ResetHour   int    `json:"reset_hour"`
	ResetMinute int    `json:"reset_minute"`
	WeekStart   int    `json:"week_start"`
	MonthDay    int    `json:"month_day"`
	Target      int64  `json:"target"`
	Unit        string `json:"unit"`
}

func newVersionRoutineContent(r *TaskRoutine) versionRoutineContent {
	return versionRoutineContent{
		TaskID:      r.TaskID,
		Enabled:     r.Enabled,
		Paused:      r.Paused,
		Timezone:    r.Timezone,
		Period:      r.Period,
		ResetHour:   r.ResetHour,
		ResetMinute: r.ResetMinute,
		WeekStart:   r.WeekStart,
		MonthDay:    r.MonthDay,
		Target:      r.Target,
		Unit:        r.Unit,
	}
}

type versionAnnouncementContent struct {
	ProjectID int64  `json:"project_id"`
	Title     string `json:"title"`
	Content   string `json:"content"`
}

func newVersionAnnouncementContent(a *ProjectAnnouncement) versionAnnouncementContent {
	return versionAnnouncementContent{
		ProjectID: a.ProjectID,
		Title:     a.Title,
		Content:   a.Content,
	}
}
