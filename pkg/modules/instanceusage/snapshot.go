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
	"context"
	"errors"
	"fmt"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/builder"
	"xorm.io/xorm"
)

const (
	cacheLifetime     = 30 * time.Second
	collectionTimeout = 10 * time.Second
	maxSnapshotUsers  = 100000
)

var ErrUnavailable = errors.New("usage snapshot unavailable")

type snapshot struct {
	users    []InstanceUserUsage
	overview AccountUsageOverview
}

type snapshotCache struct {
	sync.Mutex
	value   *snapshot
	key     string
	expires time.Time
	loading chan struct{}
}

var cachedSnapshot snapshotCache

func (c *snapshotCache) get(ctx context.Context, key string, load func(context.Context) (*snapshot, error)) (*snapshot, error) {
	for {
		c.Lock()
		if c.value != nil && c.key == key && time.Now().Before(c.expires) {
			value := c.value
			c.Unlock()
			return value, nil
		}
		if c.loading != nil {
			done := c.loading
			c.Unlock()
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-done:
				continue
			}
		}
		c.loading = make(chan struct{})
		c.Unlock()

		value, err := load(ctx)
		c.Lock()
		if err == nil {
			c.value = value
			c.key = key
			// Age starts before collection, not after a slow filesystem scan.
			c.expires = value.overview.AsOf.Add(cacheLifetime)
		}
		close(c.loading)
		c.loading = nil
		c.Unlock()
		return value, err
	}
}

func Read(ctx context.Context, query AccountUsageQuery) (*AccountUsageSnapshot, error) {
	basePath := config.FilesBasePath.GetString()
	value, err := cachedSnapshot.get(ctx, basePath, func(ctx context.Context) (*snapshot, error) {
		ctx, cancel := context.WithTimeout(ctx, collectionTimeout)
		defer cancel()
		return collect(ctx, basePath)
	})
	if err != nil {
		return nil, fmt.Errorf("%w: %w", ErrUnavailable, err)
	}
	return page(value, query), nil
}

type accountMetadata struct {
	ID                  int64
	Username            string
	Name                string
	Status              int
	IsAdmin             bool
	BotOwnerID          int64
	DeletionScheduledAt time.Time
	Created             time.Time
}

type aggregate struct {
	UserID int64
	Count  int64
	Bytes  int64
}

func collect(ctx context.Context, basePath string) (*snapshot, error) {
	value := &snapshot{
		overview: AccountUsageOverview{
			AsOf:             time.Now().UTC(),
			SnapshotComplete: true,
		},
	}
	s := db.NewReadSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	accounts := []accountMetadata{}
	err := s.Table("users").
		Select("id, username, name, status, is_admin, bot_owner_id, deletion_scheduled_at, created").
		OrderBy("id ASC").Limit(maxSnapshotUsers + 1).Find(&accounts)
	if err != nil {
		return nil, err
	}
	if len(accounts) > maxSnapshotUsers {
		return nil, ErrUnavailable
	}
	byID := make(map[int64]*InstanceUserUsage, len(accounts))
	value.users = make([]InstanceUserUsage, len(accounts))
	for i, account := range accounts {
		value.users[i] = InstanceUserUsage{
			ID:                account.ID,
			Username:          account.Username,
			Name:              account.Name,
			Status:            account.Status,
			IsBot:             account.BotOwnerID != 0,
			IsInstanceAdmin:   account.IsAdmin,
			DeletionScheduled: !account.DeletionScheduledAt.IsZero(),
			Created:           account.Created,
			Anomalies:         []string{},
		}
		byID[account.ID] = &value.users[i]
	}
	if err = collectDatabase(ctx, s, value.overview.AsOf, byID); err != nil {
		return nil, err
	}
	// Release the database session before enumerating filesystem metadata.
	if err = s.Close(); err != nil {
		return nil, err
	}
	scanner := newMetadataScanner(ctx, basePath)
	defer scanner.close()
	for i := range value.users {
		row := &value.users[i]
		scanner.scan(row)
		row.TotalStorageBytes = row.FileBytes + row.AIBytes
		row.Anomalies = anomalies(row.UsageCounts)
		addCounts(&value.overview.UsageCounts, row.UsageCounts)
		if row.Status == 0 {
			value.overview.ActiveUsers++
		}
		if len(row.Anomalies) > 0 {
			value.overview.FlaggedUsers++
		}
		if row.AIScanComplete {
			value.overview.ScannedUsers++
		} else {
			value.overview.SnapshotComplete = false
		}
	}
	value.overview.Users = int64(len(value.users))
	return value, nil
}

func collectDatabase(ctx context.Context, s *xorm.Session, now time.Time, users map[int64]*InstanceUserUsage) error {
	db.SetSessionContext(ctx, s)
	// Separate grouped queries avoid cross-join multiplication and never select
	// resource names, bodies, email addresses or credential-bearing settings.
	queries := []struct {
		query func() *xorm.Session
		apply func(*InstanceUserUsage, aggregate)
	}{
		{
			query: func() *xorm.Session {
				return s.Table("projects").Select("owner_id AS user_id, COUNT(*) AS count").GroupBy("owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.ProjectsOwned = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("projects").Select("owner_id AS user_id, COUNT(*) AS count").Where(builder.Eq{"is_archived": true}).GroupBy("owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.ProjectsArchived = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("projects").Select("owner_id AS user_id, COUNT(*) AS count").
					Where(builder.Gte{"created": now.Add(-24 * time.Hour)}).And(builder.Lte{"created": now}).GroupBy("owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.ProjectsCreated24h = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("projects").Select("owner_id AS user_id, COUNT(*) AS count").
					Where(builder.Gte{"created": now.Add(-7 * 24 * time.Hour)}).And(builder.Lte{"created": now}).GroupBy("owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.ProjectsCreated7d = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("tasks").Select("projects.owner_id AS user_id, COUNT(*) AS count").
					Join("INNER", "projects", "projects.id = tasks.project_id").Where(builder.IsNull{"tasks.deleted_at"}).GroupBy("projects.owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.TasksOwned = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("tasks").Select("created_by_id AS user_id, COUNT(*) AS count").Where(builder.IsNull{"deleted_at"}).GroupBy("created_by_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.TasksCreated = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("files").Select("created_by_id AS user_id, COUNT(*) AS count, SUM(size) AS bytes").GroupBy("created_by_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) {
				u.FilesUploaded = a.Count
				u.FileBytes = a.Bytes
			},
		},
		{
			query: func() *xorm.Session {
				return s.Table("drive_files").Select("drive_files.owner_id AS user_id, COUNT(*) AS count, SUM(files.size) AS bytes").
					Join("INNER", "files", "files.id = drive_files.file_id").GroupBy("drive_files.owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) {
				u.DriveFiles = a.Count
				u.DriveFileBytes = a.Bytes
			},
		},
		{
			query: func() *xorm.Session {
				return s.Table("drive_files").Select("drive_files.owner_id AS user_id, COUNT(*) AS count, SUM(files.size) AS bytes").
					Join("INNER", "files", "files.id = drive_files.file_id").
					Where(builder.Gt{"drive_files.trashed_at": time.Date(1971, 1, 1, 0, 0, 0, 0, time.UTC)}).GroupBy("drive_files.owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) {
				u.DriveTrashedFiles = a.Count
				u.DriveTrashedBytes = a.Bytes
			},
		},
		{
			query: func() *xorm.Session {
				return s.Table("compass_spaces").Select("owner_id AS user_id, COUNT(*) AS count").GroupBy("owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.CompassSpacesOwned = a.Count },
		},
		{
			query: func() *xorm.Session {
				return s.Table("compass_entries").Select("compass_spaces.owner_id AS user_id, COUNT(*) AS count").
					Join("INNER", "compass_spaces", "compass_spaces.id = compass_entries.space_id").GroupBy("compass_spaces.owner_id")
			},
			apply: func(u *InstanceUserUsage, a aggregate) { u.CompassEntriesOwned = a.Count },
		},
	}
	for _, query := range queries {
		rows := []aggregate{}
		if err := query.query().Find(&rows); err != nil {
			return err
		}
		for _, row := range rows {
			if u := users[row.UserID]; u != nil {
				query.apply(u, row)
			}
		}
	}
	return nil
}

func anomalies(c UsageCounts) []string {
	result := []string{}
	if c.ProjectsOwned >= 1000 {
		result = append(result, "projects_owned_1000")
	}
	if c.ProjectsCreated24h >= 100 {
		result = append(result, "projects_created_24h_100")
	}
	if c.ProjectsCreated7d >= 500 {
		result = append(result, "projects_created_7d_500")
	}
	return result
}

func addCounts(a *UsageCounts, b UsageCounts) {
	a.ProjectsOwned += b.ProjectsOwned
	a.ProjectsArchived += b.ProjectsArchived
	a.ProjectsCreated24h += b.ProjectsCreated24h
	a.ProjectsCreated7d += b.ProjectsCreated7d
	a.TasksOwned += b.TasksOwned
	a.TasksCreated += b.TasksCreated
	a.FilesUploaded += b.FilesUploaded
	a.FileBytes += b.FileBytes
	a.DriveFiles += b.DriveFiles
	a.DriveFileBytes += b.DriveFileBytes
	a.DriveTrashedFiles += b.DriveTrashedFiles
	a.DriveTrashedBytes += b.DriveTrashedBytes
	a.CompassSpacesOwned += b.CompassSpacesOwned
	a.CompassEntriesOwned += b.CompassEntriesOwned
	a.AIConversations += b.AIConversations
	a.AIConversationBytes += b.AIConversationBytes
	a.AIAttachmentBytes += b.AIAttachmentBytes
	a.AISettingsBytes += b.AISettingsBytes
	a.AIBytes += b.AIBytes
	a.TotalStorageBytes += b.TotalStorageBytes
}
