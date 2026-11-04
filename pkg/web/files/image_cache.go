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
	"crypto/sha256"
	"fmt"
	"net/http"
	"strings"
	"time"

	storagefiles "github.com/KanameMadoka520/Astering/pkg/files"
)

// PrivateImageCache must only be enabled after the caller has checked current access.
func PrivateImageCache(w http.ResponseWriter) {
	w.Header().Set("Cache-Control", "private, no-cache")
	for _, name := range []string{"Authorization", "Cookie"} {
		found := false
		for _, value := range w.Header().Values("Vary") {
			for _, token := range strings.Split(value, ",") {
				if strings.EqualFold(strings.TrimSpace(token), name) || strings.TrimSpace(token) == "*" {
					found = true
				}
			}
		}
		if !found {
			w.Header().Add("Vary", name)
		}
	}
}

func IsCacheableImage(mime string) bool {
	return strings.HasPrefix(strings.ToLower(mime), "image/")
}

func ImageETag(data []byte) string { return fmt.Sprintf(`"%x"`, sha256.Sum256(data)) }

func fileImageETag(f *storagefiles.File) string {
	return ImageETag([]byte(fmt.Sprintf("file:%d:%d:%d:%s:%s", f.ID, f.Size, f.Created.UnixNano(), f.Mime, f.Name)))
}

// ImageNotModified is for authenticated GETs whose readers are not seekable.
// If-None-Match takes precedence over dates, including when no tag matches.
func ImageNotModified(r *http.Request, etag string, modified time.Time) bool {
	value := strings.Join(r.Header.Values("If-None-Match"), ",")
	if value != "" {
		return matchesImageETag(value, etag)
	}
	if modified.IsZero() {
		return false
	}
	since, err := http.ParseTime(r.Header.Get("If-Modified-Since"))
	return err == nil && !modified.UTC().Truncate(time.Second).After(since)
}

func matchesImageETag(value, etag string) bool {
	for value = strings.TrimSpace(value); value != ""; value = strings.TrimSpace(value) {
		if value[0] == ',' {
			value = value[1:]
			continue
		}
		if value == "*" {
			return true
		}
		value = strings.TrimPrefix(value, "W/")
		if len(value) < 2 || value[0] != '"' {
			return false
		}
		end := strings.IndexByte(value[1:], '"')
		if end < 0 {
			return false
		}
		end += 2
		tag := value[:end]
		if tag == etag {
			return true
		}
		value = strings.TrimSpace(value[end:])
		if value != "" && value[0] != ',' {
			return false
		}
	}
	return false
}
