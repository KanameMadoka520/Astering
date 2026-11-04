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
	"io"
	"net/http"
	"os"

	"github.com/KanameMadoka520/Astering/pkg/files"
)

// WriteProjectBackground streams a project's background file (its .File reader must be
// open) to the response, shared by the v1 and v2 background handlers. It does not close
// the reader; the caller owns it.
//
// The wire shape differs from WriteFileDownload on purpose and must stay byte-identical
// to v1: backgrounds are always served as image/jpg (no Content-Disposition, no
// Content-Length), with a cache-revalidation Last-Modified from the storage modtime
// rather than the file's DB Created timestamp.
func WriteProjectBackground(w http.ResponseWriter, r *http.Request, bgFile *files.File, stat os.FileInfo) {
	writeProjectBackground(w, r, bgFile, stat, "image/jpg")
}

// WriteProjectBackgroundInStoredFormat serves validated original or client-converted images on v2.
func WriteProjectBackgroundInStoredFormat(w http.ResponseWriter, r *http.Request, bgFile *files.File, stat os.FileInfo) {
	contentType := bgFile.Mime
	if contentType == "" {
		contentType = "image/jpeg"
	}
	writeProjectBackground(w, r, bgFile, stat, contentType)
}

func writeProjectBackground(w http.ResponseWriter, r *http.Request, bgFile *files.File, stat os.FileInfo, contentType string) {
	PrivateImageCache(w)
	etag := fileImageETag(bgFile)
	w.Header().Set("ETag", etag)
	modified := bgFile.Created
	if stat != nil && !stat.ModTime().IsZero() {
		modified = stat.ModTime()
	}
	if !modified.IsZero() {
		w.Header().Set("Last-Modified", modified.UTC().Format(http.TimeFormat))
	}
	if ImageNotModified(r, etag, modified) {
		w.WriteHeader(http.StatusNotModified)
		return
	}

	w.Header().Set("Content-Type", contentType)
	w.WriteHeader(http.StatusOK)
	_, _ = io.Copy(w, bgFile.File)
}
