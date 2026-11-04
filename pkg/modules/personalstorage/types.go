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

// Package personalstorage inventories only the authenticated account's storage.
package personalstorage

import (
	"time"

	"github.com/KanameMadoka520/Astering/pkg/models"
)

type StorageCategory struct {
	ID        string `json:"id" required:"true" doc:"Mutually exclusive category: images, video, audio, documents, other, trash, previews, conversations, legacy_attachments or settings."`
	Count     int64  `json:"count" required:"true"`
	Bytes     int64  `json:"bytes" required:"true" doc:"Original logical bytes or independent encrypted/derived stored bytes; not filesystem allocated blocks."`
	Cleanable bool   `json:"cleanable" required:"true" doc:"Whether this category has a supported cleanup operation; individual references may still block it."`
}

type StorageSummary struct {
	AsOf                       time.Time         `json:"as_of" required:"true"`
	Complete                   bool              `json:"complete" required:"true" doc:"False means measured bytes are a lower bound, never proof of zero usage."`
	TotalBytes                 int64             `json:"total_bytes" required:"true" doc:"Unique original file bytes plus independent AI ciphertext and measured previews. Excludes database, backups and server/application files."`
	OriginalFileBytes          int64             `json:"original_file_bytes" required:"true" doc:"Database original lengths, once per file ID including recycle-bin originals."`
	PreviewBytes               int64             `json:"preview_bytes" required:"true" doc:"Actual measured derived thumbnail lengths, counted independently of their original files."`
	ConversationBytes          int64             `json:"conversation_bytes" required:"true"`
	IndependentAttachmentBytes int64             `json:"independent_attachment_bytes" required:"true" doc:"Legacy encrypted attachments counted once per stored content ID. New Drive attachments are already included in original_file_bytes."`
	SettingsBytes              int64             `json:"settings_bytes" required:"true" doc:"Protected encrypted model/MCP settings, never decrypted or removed by cleanup."`
	FileCount                  int64             `json:"file_count" required:"true"`
	DriveFileCount             int64             `json:"drive_file_count" required:"true"`
	TrashBytes                 int64             `json:"trash_bytes" required:"true" doc:"Subset of original_file_bytes; moving files to trash does not free these bytes."`
	TrashCount                 int64             `json:"trash_count" required:"true"`
	ConversationCount          int64             `json:"conversation_count" required:"true"`
	Categories                 []StorageCategory `json:"categories" required:"true"`
	Definitions                []string          `json:"definitions" required:"true" doc:"Stable accounting notes for presentation and diagnostics."`
}

type StorageFileItem struct {
	Kind            string    `json:"kind" required:"true" enum:"file"`
	ID              string    `json:"id" required:"true" doc:"Decimal file ID; never a storage path."`
	FileID          int64     `json:"file_id" required:"true"`
	Name            string    `json:"name" required:"true"`
	Mime            string    `json:"mime" required:"true"`
	Size            int64     `json:"size" required:"true" doc:"Logical original bytes from file metadata."`
	PreviewBytes    int64     `json:"preview_bytes" required:"true"`
	StorageComplete bool      `json:"storage_complete" required:"true" doc:"Whether original and derived storage metadata were available; missing original files make this false."`
	Created         time.Time `json:"created" required:"true"`
	Revision        string    `json:"revision" required:"true" doc:"Opaque cleanup revision; send exactly as returned."`
	Trash           bool      `json:"trash" required:"true"`
	Pinned          bool      `json:"pinned" required:"true"`
	InDrive         bool      `json:"in_drive" required:"true" doc:"Only Drive-owned originals can be trashed or permanently deleted here."`
	UsageCount      int       `json:"usage_count" required:"true" doc:"-1 means not scanned; expand the Drive usage endpoint or request cleanup preview for current references."`
	UsagesComplete  bool      `json:"usages_complete" required:"true"`
	CanTrash        bool      `json:"can_trash" required:"true" doc:"State eligibility only; cleanup preview rechecks all current references."`
	CanPurge        bool      `json:"can_purge" required:"true" doc:"State eligibility only; current references can still block permanent deletion."`
	URL             string    `json:"url" required:"true" doc:"Personal Drive location; protected non-Drive originals have an empty location."`
}

type StorageFilePage struct {
	Items      []StorageFileItem `json:"items" required:"true"`
	Total      int64             `json:"total" required:"true"`
	Page       int               `json:"page" required:"true"`
	PerPage    int               `json:"per_page" required:"true"`
	TotalPages int64             `json:"total_pages" required:"true"`
	Complete   bool              `json:"complete" required:"true" doc:"False means a bounded preview scan returned a partial list; totals are lower bounds."`
}

type FileQuery struct {
	Page, PerPage                       int
	Q, Category, Scope, SortBy, OrderBy string
}

type StorageSelection struct {
	Kind     string `json:"kind" enum:"file,conversation" required:"true"`
	ID       string `json:"id" minLength:"1" maxLength:"64" required:"true" doc:"File decimal ID or owned conversation UUID; never a path."`
	Revision string `json:"revision" minLength:"1" maxLength:"128" required:"true"`
	Action   string `json:"action" enum:"trash,purge,delete,clear_previews" required:"true"`
}

type StoragePreviewItem struct {
	StorageSelection
	Name               string              `json:"name" required:"true"`
	Allowed            bool                `json:"allowed" required:"true"`
	Reason             string              `json:"reason" required:"true" doc:"Stable reason code; empty when allowed."`
	Bytes              int64               `json:"bytes" required:"true" doc:"Unique original or encrypted conversation record length; attachments are not duplicated."`
	ExpectedFreedBytes int64               `json:"expected_freed_bytes" required:"true" doc:"Measured upper estimate for this operation; trash always frees zero. Revalidated at execution."`
	Usages             []models.DriveUsage `json:"usages" required:"true" doc:"Current permission-filtered references. Restricted locations never disclose their titles or URLs."`
	Token              string              `json:"token" required:"true" doc:"Short-lived signed confirmation bound to this account, target, action, revision and reference snapshot; absent for blocked items."`
}

type StoragePreview struct {
	Items              []StoragePreviewItem `json:"items" required:"true"`
	ExpectedFreedBytes int64                `json:"expected_freed_bytes" required:"true"`
	ExpiresAt          time.Time            `json:"expires_at" required:"true"`
}

type StorageExecuteItem struct {
	Kind          string `json:"kind" required:"true"`
	ID            string `json:"id" required:"true"`
	Action        string `json:"action" required:"true"`
	Status        string `json:"status" required:"true" enum:"completed,already_done,blocked,failed"`
	Reason        string `json:"reason" required:"true" doc:"Stable result code; retry requires a new preview unless purge_retry is returned."`
	FreedBytes    int64  `json:"freed_bytes" required:"true" doc:"Verified stored bytes removed during this execution only. Moving to recycle bin is always zero."`
	BytesComplete bool   `json:"bytes_complete" required:"true" doc:"False means freed_bytes is a conservative lower bound."`
}

type StorageExecute struct {
	Items      []StorageExecuteItem `json:"items" required:"true"`
	FreedBytes int64                `json:"freed_bytes" required:"true"`
	Completed  int                  `json:"completed" required:"true" doc:"Includes idempotent already_done outcomes."`
	Failed     int                  `json:"failed" required:"true" doc:"Blocked or failed individual targets; other targets may have succeeded."`
}
