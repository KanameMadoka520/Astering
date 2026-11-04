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
	"mime"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/files"
)

// WriteFileDownload streams a loaded file (its .File reader must be open) to the
// response as an attachment download: http.ServeContent for seekable local files
// (Range + If-Modified-Since for free), a manual 304 + io.Copy otherwise. It does
// not close the reader; the caller owns it.
func WriteFileDownload(w http.ResponseWriter, r *http.Request, f *files.File) {
	// Handlers explicitly opt authorized images in; preserve stricter caller policies.
	cacheImage := IsCacheableImage(f.Mime) && !strings.Contains(strings.ToLower(w.Header().Get("Cache-Control")), "no-store")
	if cacheImage {
		PrivateImageCache(w)
		w.Header().Set("ETag", fileImageETag(f))
	} else if !strings.Contains(strings.ToLower(w.Header().Get("Cache-Control")), "no-store") {
		w.Header().Set("Cache-Control", "private, no-store")
	}

	mimeToReturn := f.Mime
	if mimeToReturn == "" {
		mimeToReturn = "application/octet-stream"
	}
	w.Header().Set("Content-Disposition", mime.FormatMediaType("attachment", map[string]string{"filename": f.Name}))
	w.Header().Set("Content-Type", mimeToReturn)
	// Never let the browser sniff a type other than the one we detected.
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("Content-Length", strconv.FormatUint(f.Size, 10))
	w.Header().Set("Last-Modified", f.Created.UTC().Format(http.TimeFormat))

	// Local files are *os.File (seekable), so ServeContent gives Range +
	// If-Modified-Since for free; s3 (and the in-memory test storage) return a
	// non-seekable reader, so check If-Modified-Since manually and io.Copy.
	if seeker, ok := f.File.(io.ReadSeeker); ok {
		http.ServeContent(w, r, f.Name, f.Created, seeker)
		return
	}

	notModified := cacheImage && ImageNotModified(r, w.Header().Get("ETag"), f.Created)
	if !cacheImage {
		// Preserve conditional downloads for non-seekable storage without enabling cache storage.
		since, err := http.ParseTime(r.Header.Get("If-Modified-Since"))
		notModified = err == nil && !f.Created.UTC().Truncate(time.Second).After(since)
	}
	if notModified {
		w.Header().Del("Content-Length")
		w.WriteHeader(http.StatusNotModified)
		return
	}
	_, _ = io.Copy(w, f.File)
}
