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

package personalstorage

import (
	"cmp"
	"context"
	"errors"
	"slices"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/builder"
	"xorm.io/xorm"
)

var ErrForbidden = errors.New("storage_forbidden")
var ErrInvalid = errors.New("storage_invalid_selection")
var ErrUnavailable = errors.New("storage_unavailable")

var trashEpoch = time.Date(1971, 1, 1, 0, 0, 0, 0, time.UTC)

func Authorize(ctx context.Context, uid int64) error {
	active, err := instanceusage.ActiveHuman(ctx, uid)
	if err != nil {
		return ErrUnavailable
	}
	if !active {
		return ErrForbidden
	}
	return nil
}

type fileRecord struct {
	ID           int64
	Name         string
	Mime         string
	Size         int64
	Created      time.Time
	DriveID      int64
	DriveOwnerID int64
	Revision     int64
	TrashedAt    time.Time
	Pinned       bool
	Purging      bool
}

func ownedFiles(s *xorm.Session, uid int64) *xorm.Session {
	return s.Table("files").Join("LEFT", "drive_files", "drive_files.file_id = files.id").Where(builder.Or(
		builder.Eq{"drive_files.owner_id": uid},
		builder.And(builder.IsNull{"drive_files.file_id"}, builder.Eq{"files.created_by_id": uid}),
	))
}

const fileColumns = "files.id, files.name, files.mime, files.size, files.created, drive_files.file_id AS drive_id, drive_files.owner_id AS drive_owner_id, drive_files.revision, drive_files.trashed_at, drive_files.pinned, drive_files.purging"

func fileCategory(mime string) string {
	switch {
	case strings.HasPrefix(mime, "image/"):
		return "images"
	case strings.HasPrefix(mime, "video/"):
		return "video"
	case strings.HasPrefix(mime, "audio/"):
		return "audio"
	case strings.HasPrefix(mime, "text/"), strings.HasPrefix(mime, "application/pdf"), strings.HasPrefix(mime, "application/vnd"), strings.HasPrefix(mime, "application/msword"), strings.HasPrefix(mime, "application/rtf"):
		return "documents"
	default:
		return "other"
	}
}

func categoryCondition(category string) builder.Cond {
	image := builder.Like{
		"files.mime",
		"image/%",
	}
	video := builder.Like{
		"files.mime",
		"video/%",
	}
	audio := builder.Like{
		"files.mime",
		"audio/%",
	}
	documents := builder.Or(builder.Like{
		"files.mime",
		"text/%",
	}, builder.Like{
		"files.mime",
		"application/pdf%",
	}, builder.Like{
		"files.mime",
		"application/vnd%",
	}, builder.Like{
		"files.mime",
		"application/msword%",
	}, builder.Like{
		"files.mime",
		"application/rtf%",
	})
	switch category {
	case "images":
		return image
	case "video":
		return video
	case "audio":
		return audio
	case "documents":
		return documents
	case "other":
		return builder.Or(builder.IsNull{"files.mime"}, builder.Not{builder.Or(image, video, audio, documents)})
	default:
		return builder.NewCond()
	}
}

func normalizePage(page, perPage int) (int, int) {
	if page < 1 {
		page = 1
	}
	if perPage < 1 {
		perPage = 25
	}
	return page, min(perPage, 100)
}

func ListFiles(ctx context.Context, uid int64, query FileQuery) (*StorageFilePage, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := Authorize(ctx, uid); err != nil {
		return nil, err
	}
	page, perPage := normalizePage(query.Page, query.PerPage)
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	q := ownedFiles(s, uid).And(categoryCondition(query.Category))
	if query.Q != "" {
		q = q.And(db.ILIKE("files.name", query.Q))
	}
	switch query.Scope {
	case "trash":
		q = q.And(builder.Gt{"drive_files.trashed_at": trashEpoch})
	case "active":
		q = q.And(builder.Or(builder.IsNull{"drive_files.trashed_at"}, builder.Lte{"drive_files.trashed_at": trashEpoch}))
	}
	sort := "files.size"
	switch query.SortBy {
	case "created":
		sort = "files.created"
	case "name":
		sort = "files.name"
	}
	direction := " DESC"
	if query.OrderBy == "asc" {
		direction = " ASC"
	}
	rows := []fileRecord{}
	var total int64
	var err error
	complete := true
	if query.Category == "previews" || query.SortBy == "preview_bytes" {
		err = q.Select(fileColumns).OrderBy("files.id ASC").Limit(100001).Find(&rows)
		_ = s.Close()
		if err != nil {
			return nil, err
		}
		if len(rows) > 100000 {
			rows = rows[:100000]
			complete = false
		}
		ids := make([]int64, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, row.ID)
		}
		measured, previewByID := files.MeasureOwnedPreviewUsage(ctx, ids)
		complete = complete && measured.Complete
		if query.Category == "previews" {
			rows = slices.DeleteFunc(rows, func(row fileRecord) bool { return previewByID[row.ID].PreviewBytes == 0 })
		}
		slices.SortFunc(rows, func(a, b fileRecord) int {
			var order int
			switch query.SortBy {
			case "preview_bytes":
				order = cmp.Compare(previewByID[a.ID].PreviewBytes, previewByID[b.ID].PreviewBytes)
			case "created":
				order = a.Created.Compare(b.Created)
			case "name":
				order = strings.Compare(a.Name, b.Name)
			default:
				order = cmp.Compare(a.Size, b.Size)
			}
			if query.OrderBy != "asc" {
				order = -order
			}
			if order == 0 {
				return cmp.Compare(b.ID, a.ID)
			}
			return order
		})
		total = int64(len(rows))
		start := min(len(rows), (page-1)*perPage)
		end := min(len(rows), start+perPage)
		rows = rows[start:end]
	} else {
		total, err = q.Select(fileColumns).OrderBy(sort+direction+", files.id DESC").Limit(perPage, (page-1)*perPage).FindAndCount(&rows)
	}
	if err != nil {
		return nil, err
	}
	_ = s.Close()
	result := &StorageFilePage{
		Items:      []StorageFileItem{},
		Total:      total,
		Page:       page,
		PerPage:    perPage,
		TotalPages: (total + int64(perPage) - 1) / int64(perPage),
		Complete:   complete,
	}
	for _, row := range rows {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		m := files.MeasureStoredUsage(ctx, row.ID)
		inDrive := row.DriveID > 0 && row.DriveOwnerID == uid
		trashed := row.TrashedAt.After(trashEpoch)
		url := ""
		if inDrive {
			url = "/drive"
		}
		result.Items = append(result.Items, StorageFileItem{
			Kind:            "file",
			ID:              strconv.FormatInt(row.ID, 10),
			FileID:          row.ID,
			Name:            row.Name,
			Mime:            row.Mime,
			Size:            row.Size,
			PreviewBytes:    m.PreviewBytes,
			StorageComplete: m.Complete,
			Created:         row.Created,
			Revision:        strconv.FormatInt(row.Revision, 10),
			Trash:           trashed,
			Pinned:          row.Pinned,
			InDrive:         inDrive,
			UsageCount:      -1,
			UsagesComplete:  false,
			CanTrash:        inDrive && !trashed && !row.Purging,
			CanPurge:        inDrive && trashed,
			URL:             url,
		})
	}
	return result, nil
}

func ReadSummary(ctx context.Context, uid int64) (*StorageSummary, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	if err := Authorize(ctx, uid); err != nil {
		return nil, err
	}
	result := &StorageSummary{
		AsOf:       time.Now().UTC(),
		Complete:   true,
		Categories: []StorageCategory{},
		Definitions: []string{
			"unique_originals_and_independent_ciphertext",
			"new_chat_attachments_are_drive_originals",
			"trash_retains_original_bytes",
			"previews_are_regenerable_and_may_return",
			"database_backups_and_server_files_excluded",
			"note_text_bytes_are_separate_logical_utf8_not_file_total_or_reclaimable_disk",
			"shared_resource_ownership_is_not_content_access",
		},
	}
	s := db.NewReadSession()
	db.SetSessionContext(ctx, s)
	notes, err := models.AsterNotesStorage(s, uid)
	if err != nil {
		_ = s.Close()
		return nil, err
	}
	result.NoteCount = notes.Count
	result.NoteContentBytes = notes.ContentBytes
	result.NoteTranscriptBytes = notes.TranscriptBytes
	result.NoteTextBytes = notes.TextBytes
	rows := []fileRecord{}
	err = ownedFiles(s, uid).Select(fileColumns).OrderBy("files.id ASC").Limit(100001).Find(&rows)
	_ = s.Close()
	if err != nil {
		return nil, err
	}
	if len(rows) > 100000 {
		rows = rows[:100000]
		result.Complete = false
	}
	categories := map[string]*StorageCategory{}
	for _, id := range []string{
		"images",
		"video",
		"audio",
		"documents",
		"other",
		"trash",
	} {
		categories[id] = &StorageCategory{
			ID:        id,
			Cleanable: true,
		}
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		ids = append(ids, row.ID)
		result.FileCount++
		result.OriginalFileBytes += row.Size
		if row.DriveID > 0 {
			result.DriveFileCount++
		}
		category := fileCategory(row.Mime)
		if row.TrashedAt.After(trashEpoch) {
			category = "trash"
			result.TrashCount++
			result.TrashBytes += row.Size
		}
		categories[category].Count++
		categories[category].Bytes += row.Size
	}
	for _, id := range []string{
		"images",
		"video",
		"audio",
		"documents",
		"other",
		"trash",
	} {
		result.Categories = append(result.Categories, *categories[id])
	}
	previews := files.MeasureOwnedPreviews(ctx, ids)
	result.PreviewBytes = previews.PreviewBytes
	result.Complete = result.Complete && previews.Complete
	ai, err := tcyai.GetPersonalStorage(ctx, uid)
	if err != nil {
		return nil, err
	}
	result.ConversationBytes = ai.ConversationBytes
	result.ConversationCount = ai.ConversationCount
	result.IndependentAttachmentBytes = ai.LegacyAttachmentBytes
	result.SettingsBytes = ai.SettingsBytes
	result.Complete = result.Complete && ai.Complete
	result.Categories = append(result.Categories,
		StorageCategory{
			ID:        "previews",
			Count:     previews.PreviewCount,
			Bytes:     previews.PreviewBytes,
			Cleanable: true,
		},
		StorageCategory{
			ID:        "conversations",
			Count:     ai.ConversationCount,
			Bytes:     ai.ConversationBytes,
			Cleanable: true,
		},
		StorageCategory{
			ID:        "legacy_attachments",
			Count:     ai.LegacyAttachmentCount,
			Bytes:     ai.LegacyAttachmentBytes,
			Cleanable: false,
		},
		StorageCategory{
			ID:        "settings",
			Count:     1,
			Bytes:     ai.SettingsBytes,
			Cleanable: false,
		},
	)
	result.TotalBytes = result.OriginalFileBytes + result.PreviewBytes + result.ConversationBytes + result.IndependentAttachmentBytes + result.SettingsBytes
	return result, nil
}

func currentOwnedFile(ctx context.Context, uid, id int64) (*fileRecord, error) {
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	row := &fileRecord{}
	found, err := ownedFiles(s, uid).And(builder.Eq{"files.id": id}).Select(fileColumns).Get(row)
	if err != nil {
		return nil, err
	}
	if !found {
		return nil, ErrForbidden
	}
	return row, nil
}

func authFor(uid int64) web.Auth {
	return user.RestrictToResourcePermissions(&user.User{ID: uid})
}
