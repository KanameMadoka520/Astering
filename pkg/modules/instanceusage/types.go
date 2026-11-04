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

// Package instanceusage exposes operational aggregates without granting access to
// the underlying projects, writings, files, credentials or conversation content.
package instanceusage

import "time"

type UsageCounts struct {
	ProjectsOwned       int64 `json:"projects_owned" required:"true" doc:"Projects currently owned by this account, including archived projects; not the original creator count."`
	ProjectsArchived    int64 `json:"projects_archived" required:"true" doc:"Archived subset of projects_owned."`
	ProjectsCreated24h  int64 `json:"projects_created_24h" required:"true" doc:"Currently owned projects created in the 24 hours before as_of; ownership transfers affect attribution."`
	ProjectsCreated7d   int64 `json:"projects_created_7d" required:"true" doc:"Currently owned projects created in the 7 days before as_of; ownership transfers affect attribution."`
	TasksOwned          int64 `json:"tasks_owned" required:"true" doc:"Non-deleted tasks in currently owned projects, regardless of task creator or assignee."`
	TasksCreated        int64 `json:"tasks_created" required:"true" doc:"Non-deleted tasks whose persisted created_by_id is this account."`
	FilesUploaded       int64 `json:"files_uploaded" required:"true" doc:"Distinct files rows uploaded by this account, including retained recycle-bin files and exports."`
	FileBytes           int64 `json:"file_bytes" required:"true" doc:"Sum of uploaded files.size once per file ID. Logical original bytes; excludes previews, database overhead and AI encrypted files."`
	DriveFiles          int64 `json:"drive_files" required:"true" doc:"Distinct personal Drive originals, including the recycle bin. Overlaps files_uploaded; do not add the counts."`
	DriveFileBytes      int64 `json:"drive_file_bytes" required:"true" doc:"Logical original bytes in personal Drive, including the recycle bin. Overlaps file_bytes; do not add them."`
	DriveTrashedFiles   int64 `json:"drive_trashed_files" required:"true" doc:"Recycle-bin subset of drive_files."`
	DriveTrashedBytes   int64 `json:"drive_trashed_bytes" required:"true" doc:"Recycle-bin subset of drive_file_bytes."`
	CompassSpacesOwned  int64 `json:"compass_spaces_owned" required:"true" doc:"Spaces attributed to their persisted owner_id, including team spaces; does not imply access."`
	CompassEntriesOwned int64 `json:"compass_entries_owned" required:"true" doc:"Entries in those spaces, including archived and trashed entries; excludes historical revisions."`
	AIConversations     int64 `json:"ai_conversations" required:"true" doc:"Canonical UUID-named encrypted conversation files; includes archived conversations without decrypting them."`
	AIConversationBytes int64 `json:"ai_conversation_bytes" required:"true" doc:"Actual lengths of canonical encrypted conversation files, including encryption overhead."`
	AIAttachmentBytes   int64 `json:"ai_attachment_bytes" required:"true" doc:"Actual lengths of legacy SHA-256-named encrypted attachment files; excludes Drive originals already included in file_bytes."`
	AISettingsBytes     int64 `json:"ai_settings_bytes" required:"true" doc:"Actual lengths of the account's encrypted model and MCP settings files. No settings are decrypted."`
	AIBytes             int64 `json:"ai_bytes" required:"true" doc:"Sum of independent AI encrypted conversation, legacy attachment and settings file lengths. A lower bound when ai_scan_complete is false."`
	TotalStorageBytes   int64 `json:"total_storage_bytes" required:"true" doc:"file_bytes plus independent ai_bytes. Mixed logical original and encrypted file lengths, not filesystem allocated bytes or total server disk use; incomplete when AI scan is incomplete."`
}

type InstanceUserUsage struct {
	UsageCounts
	ID                int64     `json:"id" required:"true" doc:"Account ID; no resource access is granted."`
	Username          string    `json:"username" required:"true" doc:"Account username; no email or identity-provider details are returned."`
	Name              string    `json:"name" required:"true" doc:"Account display name."`
	Status            int       `json:"status" required:"true" doc:"0 active, 1 awaiting email confirmation, 2 disabled, 3 locked."`
	IsBot             bool      `json:"is_bot" required:"true" doc:"Read-only account-kind flag."`
	IsInstanceAdmin   bool      `json:"is_instance_admin" required:"true" doc:"Read-only stored instance-admin flag; does not grant licensed capabilities."`
	IsUsageAdmin      bool      `json:"is_usage_admin" required:"true" doc:"Whether this active human account is explicitly listed in ASTERING_USAGE_ADMIN_IDS at response time."`
	DeletionScheduled bool      `json:"deletion_scheduled" required:"true" doc:"Whether account deletion is scheduled; this route cannot change it."`
	Created           time.Time `json:"created" required:"true" doc:"Account creation time, not last activity."`
	AIScanComplete    bool      `json:"ai_scan_complete" required:"true" doc:"False means AI counts and bytes are incomplete or unavailable, never proof of zero usage."`
	Anomalies         []string  `json:"anomalies" required:"true" doc:"Read-only hints: projects_owned_1000, projects_created_24h_100, projects_created_7d_500. No action is taken."`
}

type AccountUsageOverview struct {
	UsageCounts
	Users            int64     `json:"users" required:"true" doc:"Number of accounts in this snapshot, before search and filters."`
	ActiveUsers      int64     `json:"active_users" required:"true" doc:"Accounts with status 0, including bots."`
	FlaggedUsers     int64     `json:"flagged_users" required:"true" doc:"Accounts meeting at least one documented project-volume threshold."`
	ScannedUsers     int64     `json:"scanned_users" required:"true" doc:"Accounts whose AI metadata scan completed."`
	SnapshotComplete bool      `json:"snapshot_complete" required:"true" doc:"Whether every account's AI metadata scan completed; SQL failures return 503 instead of fabricated zeroes."`
	AsOf             time.Time `json:"as_of" required:"true" doc:"Snapshot collection start, UTC; collection is read-only and may overlap concurrent writes."`
}

type AccountUsageSnapshot struct {
	Items       []InstanceUserUsage  `json:"items" required:"true"`
	Total       int64                `json:"total" required:"true" doc:"Accounts matching search and filters, before pagination."`
	Page        int                  `json:"page" required:"true"`
	PerPage     int                  `json:"per_page" required:"true"`
	TotalPages  int64                `json:"total_pages" required:"true"`
	AsOf        time.Time            `json:"as_of" required:"true" doc:"Snapshot collection start, UTC; cached for at most 30 seconds."`
	Overview    AccountUsageOverview `json:"overview" required:"true"`
	Definitions []string             `json:"definitions" required:"true" doc:"Stable explanatory notes for attribution, byte totals and collection limits."`
}

type AccountUsageQuery struct {
	Page    int
	PerPage int
	Q       string
	Status  string
	Role    string
	Anomaly string
	SortBy  string
	OrderBy string
}
