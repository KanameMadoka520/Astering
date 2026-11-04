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

package files

import (
	"context"
	"errors"
	"io"
	"io/fs"
	"os"
	"strconv"
	"strings"
	"time"
)

type StoredUsage struct {
	OriginalBytes    int64
	OriginalComplete bool
	PreviewBytes     int64
	PreviewCount     int64
	Complete         bool
	PreviewsComplete bool
}

// storedMetadata never accepts a caller-provided path and rejects local symlinks.
func storedMetadata(ctx context.Context, name string) (os.FileInfo, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if local, ok := storage.(*localStorage); ok {
		root, err := os.OpenRoot(local.basePath)
		if err != nil {
			return nil, err
		}
		defer root.Close()
		if strings.HasPrefix(name, previewDir+"/") {
			info, err := root.Lstat(previewDir)
			if err != nil {
				return nil, err
			}
			if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
				return nil, fs.ErrInvalid
			}
		}
		info, err := root.Lstat(name)
		if err != nil {
			return nil, err
		}
		if !info.Mode().IsRegular() {
			return nil, fs.ErrInvalid
		}
		return info, nil
	}
	if storage == nil {
		return nil, fs.ErrInvalid
	}
	var info os.FileInfo
	var err error
	if bounded, ok := storage.(interface {
		statContext(context.Context, string) (os.FileInfo, error)
	}); ok {
		info, err = bounded.statContext(ctx, name)
	} else {
		info, err = storage.Stat(name)
	}
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() {
		return nil, fs.ErrInvalid
	}
	return info, nil
}

// MeasureStoredUsage returns stored lengths, including all known preview variants.
// Authorization belongs to the caller; no filenames or storage paths are exposed.
func MeasureStoredUsage(ctx context.Context, id int64) StoredUsage {
	result := StoredUsage{
		Complete:         id > 0,
		OriginalComplete: id > 0,
		PreviewsComplete: id > 0,
	}
	if id <= 0 {
		return result
	}
	f := &File{ID: id}
	info, err := storedMetadata(ctx, f.fileID())
	if err == nil {
		result.OriginalBytes = info.Size()
	} else {
		result.Complete = false
		result.OriginalComplete = errors.Is(err, fs.ErrNotExist)
	}
	for _, size := range StoredPreviewSizes {
		if ctx.Err() != nil {
			result.Complete = false
			result.PreviewsComplete = false
			return result
		}
		info, err = storedMetadata(ctx, f.previewPath(size))
		if errors.Is(err, fs.ErrNotExist) {
			continue
		}
		if err != nil {
			result.Complete = false
			result.PreviewsComplete = false
			continue
		}
		result.PreviewBytes += info.Size()
		result.PreviewCount++
	}
	return result
}

// MeasureOwnedPreviews scans local preview metadata once rather than issuing four
// requests for each original. Unknown objects and other accounts are never counted.
func MeasureOwnedPreviews(ctx context.Context, ids []int64) StoredUsage {
	result, _ := MeasureOwnedPreviewUsage(ctx, ids)
	return result
}

// MeasureOwnedPreviewUsage also returns per-original measurements for a genuine
// server-side cache filter, before pagination is applied.
func MeasureOwnedPreviewUsage(ctx context.Context, ids []int64) (StoredUsage, map[int64]StoredUsage) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	result := StoredUsage{Complete: true}
	byID := make(map[int64]StoredUsage)
	allowed := make(map[int64]bool, len(ids))
	for _, id := range ids {
		if id > 0 {
			allowed[id] = true
		}
	}
	local, ok := storage.(*localStorage)
	if !ok {
		// Avoid an unbounded network-HEAD sweep on object stores.
		result.Complete = len(allowed) <= 1000
		visited := 0
		for id := range allowed {
			if ctx.Err() != nil {
				result.Complete = false
				break
			}
			if visited >= 1000 {
				result.Complete = false
				break
			}
			visited++
			m := MeasureStoredUsage(ctx, id)
			byID[id] = m
			result.PreviewBytes += m.PreviewBytes
			result.PreviewCount += m.PreviewCount
			result.Complete = result.Complete && m.Complete
		}
		return result, byID
	}
	return measureLocalOwnedPreviews(ctx, local, allowed)
}

func measureLocalOwnedPreviews(ctx context.Context, local *localStorage, allowed map[int64]bool) (StoredUsage, map[int64]StoredUsage) {
	result := StoredUsage{Complete: true}
	byID := make(map[int64]StoredUsage)
	base, err := os.OpenRoot(local.basePath)
	if err != nil {
		result.Complete = false
		return result, byID
	}
	defer base.Close()
	info, err := base.Lstat(previewDir)
	if errors.Is(err, fs.ErrNotExist) {
		return result, byID
	}
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		result.Complete = false
		return result, byID
	}
	root, err := base.OpenRoot(previewDir)
	if err != nil {
		result.Complete = false
		return result, byID
	}
	defer root.Close()
	current, err := root.Stat(".")
	if err != nil || !os.SameFile(info, current) {
		result.Complete = false
		return result, byID
	}
	dir, err := root.Open(".")
	if err != nil {
		result.Complete = false
		return result, byID
	}
	defer dir.Close()
	remaining := 250000
	for {
		if ctx.Err() != nil || remaining <= 0 {
			result.Complete = false
			return result, byID
		}
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			remaining--
			parts := strings.Split(entry.Name(), "_")
			if len(parts) != 2 || GetPreviewSizeFromString(parts[1]) == PreviewSizeUnknown {
				continue
			}
			id, parseErr := strconv.ParseInt(parts[0], 10, 64)
			if parseErr != nil || strconv.FormatInt(id, 10) != parts[0] || !allowed[id] {
				continue
			}
			metadata, statErr := root.Lstat(entry.Name())
			if errors.Is(statErr, fs.ErrNotExist) {
				continue
			}
			if statErr != nil || !metadata.Mode().IsRegular() {
				result.Complete = false
				continue
			}
			result.PreviewBytes += metadata.Size()
			result.PreviewCount++
			item := byID[id]
			item.PreviewBytes += metadata.Size()
			item.PreviewCount++
			item.Complete = true
			byID[id] = item
		}
		if errors.Is(readErr, io.EOF) {
			return result, byID
		}
		if readErr != nil {
			result.Complete = false
			return result, byID
		}
	}
}

func removeStoredPreview(ctx context.Context, f *File, size PreviewSize) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	local, ok := storage.(*localStorage)
	if !ok {
		if bounded, ok := storage.(contextStorage); ok {
			return bounded.removeContext(ctx, f.previewPath(size))
		}
		return storage.Remove(f.previewPath(size))
	}
	base, err := os.OpenRoot(local.basePath)
	if err != nil {
		return err
	}
	defer base.Close()
	before, err := base.Lstat(previewDir)
	if err != nil {
		return err
	}
	if !before.IsDir() || before.Mode()&os.ModeSymlink != 0 {
		return fs.ErrInvalid
	}
	root, err := base.OpenRoot(previewDir)
	if err != nil {
		return err
	}
	defer root.Close()
	after, err := root.Stat(".")
	if err != nil {
		return err
	}
	if !os.SameFile(before, after) {
		return fs.ErrInvalid
	}
	return root.Remove(f.fileID() + "_" + string(size))
}

// ClearStoredPreviews removes only regenerable known variants for one authorized
// original, retaining failures for retry and reporting only verified removed bytes.
func ClearStoredPreviews(ctx context.Context, id int64) (freed int64, complete bool, err error) {
	if id <= 0 {
		return 0, false, fs.ErrInvalid
	}
	complete = true
	f := &File{ID: id}
	for _, size := range StoredPreviewSizes {
		if ctx.Err() != nil {
			return freed, false, ctx.Err()
		}
		name := f.previewPath(size)
		before, statErr := storedMetadata(ctx, name)
		if errors.Is(statErr, fs.ErrNotExist) {
			continue
		}
		if statErr != nil {
			complete = false
			err = statErr
			continue
		}
		removeErr := removeStoredPreview(ctx, f, size)
		if removeErr != nil && !errors.Is(removeErr, fs.ErrNotExist) {
			complete = false
			err = removeErr
			continue
		}
		_, afterErr := storedMetadata(ctx, name)
		if removeErr == nil && errors.Is(afterErr, fs.ErrNotExist) {
			freed += before.Size()
		} else if afterErr != nil && !errors.Is(afterErr, fs.ErrNotExist) {
			complete = false
		}
	}
	return freed, complete, err
}
