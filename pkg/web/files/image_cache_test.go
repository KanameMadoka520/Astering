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
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"

	storagefiles "github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/stretchr/testify/require"
)

type imageCacheStat struct{ stamp time.Time }

func (s imageCacheStat) Name() string       { return "background.png" }
func (s imageCacheStat) Size() int64        { return 3 }
func (s imageCacheStat) Mode() os.FileMode  { return 0600 }
func (s imageCacheStat) ModTime() time.Time { return s.stamp }
func (s imageCacheStat) IsDir() bool        { return false }
func (s imageCacheStat) Sys() any           { return nil }

func TestPrivateImageBackgroundConditional(t *testing.T) {
	stamp := time.Date(2026, 11, 2, 4, 5, 6, 123456789, time.UTC)
	fetch := func(id int64, etag, since string) *httptest.ResponseRecorder {
		f := &storagefiles.File{
			ID:      id,
			Name:    "background.png",
			Mime:    "image/png",
			Size:    3,
			Created: stamp,
			File:    io.NopCloser(bytes.NewReader([]byte("img"))),
		}
		defer f.File.Close()
		req := httptest.NewRequest(http.MethodGet, "/background", nil)
		req.Header.Set("If-None-Match", etag)
		req.Header.Set("If-Modified-Since", since)
		rec := httptest.NewRecorder()
		WriteProjectBackgroundInStoredFormat(rec, req, f, imageCacheStat{stamp: stamp})
		return rec
	}
	first := fetch(1, "", "")
	require.Equal(t, http.StatusOK, first.Code)
	require.Equal(t, http.StatusNotModified, fetch(1, "", first.Header().Get("Last-Modified")).Code, "HTTP dates have second precision")
	require.NotEmpty(t, first.Header().Get("ETag"))
	require.Equal(t, "private, no-cache", first.Header().Get("Cache-Control"))
	cached := fetch(1, first.Header().Get("ETag"), "")
	require.Equal(t, http.StatusNotModified, cached.Code)
	require.Empty(t, cached.Body.Bytes())
	replacement := fetch(2, first.Header().Get("ETag"), first.Header().Get("Last-Modified"))
	require.Equal(t, http.StatusOK, replacement.Code, "different file identity must win over same-second dates")
	require.NotEqual(t, first.Header().Get("ETag"), replacement.Header().Get("ETag"))
}

func TestPrivateImageDownloadPreservesNoStore(t *testing.T) {
	for _, mime := range []string{"text/plain", "image/png"} {
		t.Run(mime, func(t *testing.T) {
			rec := httptest.NewRecorder()
			rec.Header().Set("Cache-Control", "private, no-store")
			f := &storagefiles.File{
				ID:   1,
				Name: "file",
				Mime: mime,
				Size: 3,
				File: io.NopCloser(bytes.NewReader([]byte("abc"))),
			}
			defer f.File.Close()
			WriteFileDownload(rec, httptest.NewRequest(http.MethodGet, "/file", nil), f)
			require.Equal(t, "private, no-store", rec.Header().Get("Cache-Control"))
			require.Equal(t, "abc", rec.Body.String())
		})
	}
}

type imageCacheSeeker struct{ *bytes.Reader }

func (s imageCacheSeeker) Close() error { return nil }

func TestPrivateImageDownloadHTTPConditions(t *testing.T) {
	stamp := time.Date(2026, 11, 2, 4, 5, 6, 123456789, time.UTC)
	for _, seekable := range []bool{false, true} {
		t.Run(fmt.Sprint(seekable), func(t *testing.T) {
			fetch := func(tag, since, byteRange string) *httptest.ResponseRecorder {
				var reader = io.NopCloser(bytes.NewReader([]byte("image")))
				if seekable {
					reader = imageCacheSeeker{Reader: bytes.NewReader([]byte("image"))}
				}
				f := &storagefiles.File{
					ID:      5,
					Name:    "image.png",
					Mime:    "image/png",
					Size:    5,
					Created: stamp,
					File:    reader,
				}
				defer f.File.Close()
				req := httptest.NewRequest(http.MethodGet, "/image", nil)
				req.Header.Set("If-None-Match", tag)
				req.Header.Set("If-Modified-Since", since)
				req.Header.Set("Range", byteRange)
				rec := httptest.NewRecorder()
				rec.Header().Set("Vary", "Accept-Encoding")
				PrivateImageCache(rec)
				WriteFileDownload(rec, req, f)
				return rec
			}
			first := fetch("", "", "")
			require.Equal(t, http.StatusOK, first.Code)
			tag := first.Header().Get("ETag")
			require.NotEmpty(t, tag)
			vary := strings.Join(first.Header().Values("Vary"), ",")
			require.Contains(t, vary, "Accept-Encoding")
			require.Contains(t, vary, "Authorization")
			require.Contains(t, vary, "Cookie")
			cached := fetch(`"different", W/`+tag, "", "")
			require.Equal(t, http.StatusNotModified, cached.Code)
			require.Empty(t, cached.Body.Bytes())
			require.Empty(t, cached.Header().Get("Content-Length"))
			require.Equal(t, http.StatusNotModified, fetch("", first.Header().Get("Last-Modified"), "").Code)
			require.Equal(t, http.StatusOK, fetch(`"wrong"`, stamp.Add(time.Hour).Format(http.TimeFormat), "").Code)
			if seekable {
				partial := fetch("", "", "bytes=1-2")
				require.Equal(t, http.StatusPartialContent, partial.Code)
				require.Equal(t, "ma", partial.Body.String())
				require.Equal(t, "bytes 1-2/5", partial.Header().Get("Content-Range"))
			}
		})
	}
}
