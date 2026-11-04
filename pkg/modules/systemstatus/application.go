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

package systemstatus

import (
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/xorm/schemas"
)

type ApplicationSnapshot struct {
	CPUPercent  *float64        `json:"cpu_percent" doc:"Application cgroup CPU delta. 100 percent means one fully used logical CPU; may exceed 100. Null until two samples exist."`
	CPUCores    *float64        `json:"cpu_cores" doc:"Effective application CPU capacity after quota and cpuset; null if unavailable."`
	MemoryUsed  *uint64         `json:"memory_used" doc:"Application cgroup RAM including charged page cache, bytes."`
	MemoryLimit *uint64         `json:"memory_limit" doc:"Configured cgroup memory limit, null if unlimited or unavailable."`
	GPUStatus   string          `json:"gpu_status" enum:"not_assigned,unavailable" doc:"No compute device assigned, or telemetry unsupported. Remote model-provider GPUs are not local application usage."`
	GPUPercent  *float64        `json:"gpu_percent" doc:"Null when trustworthy per-application GPU telemetry is unavailable; never fabricated as zero."`
	Storage     StorageSnapshot `json:"storage"`
}
type StorageSnapshot struct {
	FilesBytes    *uint64    `json:"files_bytes" doc:"Regular-file sizes under application data directory, including uploads and conversations. Symlinks excluded."`
	DatabaseBytes *uint64    `json:"database_bytes" doc:"PostgreSQL current database relation size, including indexes. Excludes WAL, image layers, backups and other databases."`
	Sampled       *time.Time `json:"sampled" doc:"Last completed storage measurement, refreshed at most once per minute."`
	Refreshing    bool       `json:"refreshing" doc:"A bounded asynchronous storage measurement is in progress."`
}
type applicationCounters struct {
	usage uint64
	at    time.Time
	valid bool
}

func applicationCPU(before, after applicationCounters) *float64 {
	if !before.valid || !after.valid || after.usage < before.usage || !after.at.After(before.at) {
		return nil
	}
	value := float64(after.usage-before.usage) / (after.at.Sub(before.at).Seconds() * 1e6) * 100
	return &value
}

var storageCache struct {
	sync.Mutex
	value   StorageSnapshot
	started time.Time
	path    string
}

func readStorage(path string) StorageSnapshot {
	storageCache.Lock()
	defer storageCache.Unlock()
	if storageCache.path != path {
		storageCache.path = path
		storageCache.value = StorageSnapshot{}
		storageCache.started = time.Time{}
	}
	if !storageCache.value.Refreshing && time.Since(storageCache.started) >= time.Minute {
		storageCache.started = time.Now()
		storageCache.value.Refreshing = true
		go collectStorage(path)
	}
	return storageCache.value
}
func scanFiles(ctx context.Context, root string) (*uint64, error) {
	var total uint64
	count := 0
	err := filepath.WalkDir(root, func(_ string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if err = ctx.Err(); err != nil {
			return err
		}
		count++
		if count > 1000000 {
			return context.DeadlineExceeded
		}
		if entry.Type()&os.ModeSymlink != 0 || entry.IsDir() {
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if info.Mode().IsRegular() && info.Size() >= 0 {
			total += uint64(info.Size())
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &total, nil
}
func collectStorage(path string) {
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	files, _ := scanFiles(ctx, path)
	var database *uint64
	if db.Type() == schemas.POSTGRES && ctx.Err() == nil {
		s := db.NewReadSession()
		db.SetSessionContext(ctx, s)
		var row struct {
			Size uint64 `xorm:"size"`
		}
		ok, err := s.SQL("SELECT pg_database_size(current_database()) AS size").Get(&row)
		if err == nil && ok {
			database = &row.Size
		}
		_ = s.Close()
	}
	now := time.Now().UTC()
	storageCache.Lock()
	defer storageCache.Unlock()
	if storageCache.path == path {
		storageCache.value = StorageSnapshot{FilesBytes: files, DatabaseBytes: database, Sampled: &now}
	}
}
