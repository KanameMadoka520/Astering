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

package instanceusage

import (
	"cmp"
	"slices"
	"strings"
)

func page(value *snapshot, q AccountUsageQuery) *AccountUsageSnapshot {
	if q.Page < 1 {
		q.Page = 1
	}
	if q.PerPage < 1 {
		q.PerPage = 25
	}
	if q.PerPage > 100 {
		q.PerPage = 100
	}
	needle := strings.ToLower(strings.TrimSpace(q.Q))
	rows := make([]InstanceUserUsage, 0, len(value.users))
	for _, row := range value.users {
		row.IsUsageAdmin = row.Status == 0 && !row.IsBot && CanView(row.ID)
		if !matches(row, q, needle) {
			continue
		}
		rows = append(rows, row)
	}
	slices.SortFunc(rows, func(a, b InstanceUserUsage) int {
		order := compare(a, b, q.SortBy)
		if q.OrderBy == "desc" {
			order = -order
		}
		if order == 0 {
			return cmp.Compare(a.ID, b.ID)
		}
		return order
	})
	total := int64(len(rows))
	totalPages := (total + int64(q.PerPage) - 1) / int64(q.PerPage)
	items := []InstanceUserUsage{}
	if int64(q.Page) <= totalPages {
		start := (q.Page - 1) * q.PerPage
		end := min(start+q.PerPage, len(rows))
		items = rows[start:end]
	}
	return &AccountUsageSnapshot{
		Items:      items,
		Total:      total,
		Page:       q.Page,
		PerPage:    q.PerPage,
		TotalPages: totalPages,
		AsOf:       value.overview.AsOf,
		Overview:   value.overview,
		Definitions: []string{
			"overview_account_attribution_only: totals cover persisted accounts; orphaned resources and link-share uploads without a positive user ID are excluded",
			"projects_current_owner: archived included; no persisted original project creator exists; recent counts use current owner and created timestamp",
			"tasks_non_deleted: owned means current project owner; created means persisted task created_by_id; assignees and shared access do not change attribution",
			"files_logical_original_bytes: each files ID counted once by uploader, including retained recycle-bin files; Drive metrics overlap and must not be added",
			"ai_metadata_only: canonical encrypted files only; Drive attachments already counted in files are excluded; no titles, messages, secrets or model/MCP settings are decrypted",
			"storage_not_total_disk: file_bytes plus independent ai_bytes excludes previews, database/index/WAL, backups, orphan/temp files and allocated-block overhead",
			"snapshot_best_effort: collection may overlap writes; 30-second cache, 10-second collection deadline, 100000-account and 250000-directory-entry limits; incomplete AI values are lower bounds, not zero usage",
			"anomaly_hints_only: projects_owned>=1000, recent24h>=100, recent7d>=500; no creation limits or account actions",
		},
	}
}

func matches(row InstanceUserUsage, q AccountUsageQuery, needle string) bool {
	if needle != "" && !strings.Contains(strings.ToLower(row.Username), needle) && !strings.Contains(strings.ToLower(row.Name), needle) {
		return false
	}
	statuses := map[string]int{
		"active":                      0,
		"email_confirmation_required": 1,
		"disabled":                    2,
		"account_locked":              3,
	}
	if status, filter := statuses[q.Status]; filter && row.Status != status {
		return false
	}
	if q.Anomaly == "flagged" && len(row.Anomalies) == 0 {
		return false
	}
	switch q.Role {
	case "human":
		return !row.IsBot
	case "bot":
		return row.IsBot
	case "instance_admin":
		return row.IsInstanceAdmin
	case "usage_admin":
		return row.IsUsageAdmin
	}
	return true
}

func compare(a, b InstanceUserUsage, sortBy string) int {
	switch sortBy {
	case "username":
		return cmp.Compare(strings.ToLower(a.Username), strings.ToLower(b.Username))
	case "created":
		return a.Created.Compare(b.Created)
	case "projects_owned":
		return cmp.Compare(a.ProjectsOwned, b.ProjectsOwned)
	case "projects_created_24h":
		return cmp.Compare(a.ProjectsCreated24h, b.ProjectsCreated24h)
	case "projects_created_7d":
		return cmp.Compare(a.ProjectsCreated7d, b.ProjectsCreated7d)
	case "tasks_owned":
		return cmp.Compare(a.TasksOwned, b.TasksOwned)
	case "tasks_created":
		return cmp.Compare(a.TasksCreated, b.TasksCreated)
	case "file_bytes":
		return cmp.Compare(a.FileBytes, b.FileBytes)
	case "ai_bytes":
		return cmp.Compare(a.AIBytes, b.AIBytes)
	default:
		return cmp.Compare(a.ID, b.ID)
	}
}
