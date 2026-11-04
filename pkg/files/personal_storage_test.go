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
	"bytes"
	"context"
	"io/fs"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestOwnedPreviewStorageMeasuresUniqueOwnersAndClearsOnlyDerivedData(t *testing.T) {
	for name, newBackend := range previewBackends() {
		t.Run(name, func(t *testing.T) {
			useStorage(t, newBackend(t))
			file := &File{ID: 42}
			other := &File{ID: 43}
			require.NoError(t, file.Save(bytes.NewReader([]byte("keep original"))))
			require.NoError(t, other.Save(bytes.NewReader([]byte("other original"))))
			require.NoError(t, file.SavePreview(PreviewSmall, []byte("small")))
			require.NoError(t, file.SavePreview(PreviewLarge, []byte("large preview")))
			require.NoError(t, other.SavePreview(PreviewSmall, []byte("private other preview")))
			measured, byID := MeasureOwnedPreviewUsage(context.Background(), []int64{
				42,
				42,
			})
			assert.True(t, measured.Complete)
			assert.EqualValues(t, len("small")+len("large preview"), measured.PreviewBytes)
			assert.EqualValues(t, 2, measured.PreviewCount)
			assert.Len(t, byID, 1)
			freed, complete, err := ClearStoredPreviews(context.Background(), 42)
			require.NoError(t, err)
			assert.True(t, complete)
			assert.Equal(t, measured.PreviewBytes, freed)
			assert.EqualValues(t, len("keep original"), MeasureStoredUsage(context.Background(), 42).OriginalBytes)
			preview, _, err := other.OpenPreview(PreviewSmall)
			require.NoError(t, err)
			require.NoError(t, preview.Close())
			freed, _, err = ClearStoredPreviews(context.Background(), 42)
			require.NoError(t, err)
			assert.Zero(t, freed, "a retry must never claim the previous deletion again")
		})
	}
}

func TestOwnedPreviewStorageRejectsSymlinkedPreviewDirectory(t *testing.T) {
	base := t.TempDir()
	other := t.TempDir()
	useStorage(t, newLocalStorage(base))
	require.NoError(t, os.WriteFile(filepath.Join(base, "42"), []byte("original"), 0600))
	require.NoError(t, os.WriteFile(filepath.Join(other, "42_sm"), []byte("other account"), 0600))
	require.NoError(t, os.Symlink(other, filepath.Join(base, previewDir)))
	measurement := MeasureOwnedPreviews(context.Background(), []int64{42})
	assert.False(t, measurement.Complete)
	assert.Zero(t, measurement.PreviewBytes)
	freed, complete, err := ClearStoredPreviews(context.Background(), 42)
	require.Error(t, err)
	assert.False(t, complete)
	assert.Zero(t, freed)
	data, err := os.ReadFile(filepath.Join(other, "42_sm"))
	require.NoError(t, err)
	assert.Equal(t, "other account", string(data))
	_, _, err = (&File{ID: 0}).OpenPreview(PreviewSizeUnknown)
	require.Error(t, err)
	_, _, err = ClearStoredPreviews(context.Background(), 0)
	require.ErrorIs(t, err, fs.ErrInvalid)
}

type boundedMetadataStorage struct {
	FileStorage
	stats int
}

func (s *boundedMetadataStorage) Stat(name string) (os.FileInfo, error) {
	s.stats++
	return s.FileStorage.Stat(name)
}

func TestOwnedPreviewStorageBoundsRemoteMetadataEvenWithoutAnyPreviews(t *testing.T) {
	backend := &boundedMetadataStorage{FileStorage: newMemStorage()}
	useStorage(t, backend)
	ids := make([]int64, 1005)
	for i := range ids {
		ids[i] = int64(i + 1)
	}
	result := MeasureOwnedPreviews(context.Background(), ids)
	assert.False(t, result.Complete)
	assert.LessOrEqual(t, backend.stats, 5000, "absent previews must not evade the visited-original bound")
}

type cancellableMetadataStorage struct {
	FileStorage
	started chan struct{}
}

func (s *cancellableMetadataStorage) statContext(ctx context.Context, name string) (os.FileInfo, error) {
	if ctx.Done() == nil {
		return s.Stat(name)
	}
	close(s.started)
	<-ctx.Done()
	return nil, ctx.Err()
}

func TestOwnedPreviewStoragePropagatesCancellationIntoRemoteMetadata(t *testing.T) {
	backend := &cancellableMetadataStorage{
		FileStorage: newMemStorage(),
		started:     make(chan struct{}),
	}
	useStorage(t, backend)
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	result := make(chan StoredUsage, 1)
	go func() { result <- MeasureOwnedPreviews(ctx, []int64{42}) }()
	select {
	case <-backend.started:
	case <-time.After(time.Second):
		t.Fatal("remote metadata did not receive the request context")
	}
	cancel()
	select {
	case measured := <-result:
		assert.False(t, measured.Complete)
	case <-time.After(time.Second):
		t.Fatal("remote metadata did not stop when the request was cancelled")
	}
}

type unavailableMetadataStorage struct {
	FileStorage
	unavailable string
}

func (s *unavailableMetadataStorage) Stat(name string) (os.FileInfo, error) {
	if name == s.unavailable {
		return nil, fs.ErrPermission
	}
	return s.FileStorage.Stat(name)
}

func TestOwnedPreviewStorageSeparatesUnknownOriginalAndPreviewMeasurements(t *testing.T) {
	memory := newMemStorage()
	useStorage(t, memory)
	file := &File{ID: 42}
	require.NoError(t, file.Save(bytes.NewReader([]byte("original"))))
	require.NoError(t, file.SavePreview(PreviewSmall, []byte("preview")))
	backend := &unavailableMetadataStorage{
		FileStorage: memory,
		unavailable: file.fileID(),
	}
	storage = backend
	measured := MeasureStoredUsage(context.Background(), file.ID)
	assert.False(t, measured.Complete)
	assert.False(t, measured.OriginalComplete)
	assert.True(t, measured.PreviewsComplete)
	assert.EqualValues(t, len("preview"), measured.PreviewBytes)
	backend.unavailable = file.previewPath(PreviewSmall)
	measured = MeasureStoredUsage(context.Background(), file.ID)
	assert.False(t, measured.Complete)
	assert.True(t, measured.OriginalComplete)
	assert.False(t, measured.PreviewsComplete)
	assert.EqualValues(t, len("original"), measured.OriginalBytes)
	backend.unavailable = ""
	require.NoError(t, memory.Remove(file.fileID()))
	measured = MeasureStoredUsage(context.Background(), file.ID)
	assert.False(t, measured.Complete, "a missing original remains an inventory inconsistency")
	assert.True(t, measured.OriginalComplete, "confirmed absence can safely measure post-purge original bytes")
	assert.Zero(t, measured.OriginalBytes)
}
