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

package richtext

import (
	"errors"
	"io"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"golang.org/x/net/html"
)

var attachmentImagePath = regexp.MustCompile(`^(?:/api/v[12])?/tasks/([0-9]+)/attachments/([0-9]+)(?:/preview)?/?$`)

// FilterAttachmentImages edits only matching image tags, preserving all other
// source bytes (text, links, formatting and external images) unchanged.
func FilterAttachmentImages(source, publicURL string, remove func(taskID, attachmentID int64) bool, apiURLs ...string) string {
	roots, documentScheme := attachmentImageRoots(append([]string{publicURL}, apiURLs...))
	z := html.NewTokenizer(strings.NewReader(source))
	var out strings.Builder
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if !errors.Is(z.Err(), io.EOF) {
				return source
			}
			break
		}
		raw := string(z.Raw())
		if kind == html.StartTagToken || kind == html.SelfClosingTagToken {
			token := z.Token()
			if token.Data == "img" {
				var src, data string
				for _, attr := range token.Attr {
					if attr.Key == "src" {
						src = attr.Val
					}
					if attr.Key == "data-src" {
						data = attr.Val
					}
				}
				if data != "" {
					src = data
				}
				if tid, aid, ok := localAttachmentImage(src, roots, documentScheme); ok && remove(tid, aid) {
					continue
				}
			}
		}
		out.WriteString(raw)
	}
	return out.String()
}

// Each configured root owns its own deployment prefix. Never combine one
// origin with another root's path, or infer trusted hosts from image content.
func attachmentImageRoots(values []string) ([]*url.URL, string) {
	documentScheme := ""
	roots := make([]*url.URL, 0, len(values))
	for i, value := range values {
		u, err := url.Parse(value)
		if err != nil || u.User != nil || u.Hostname() == "" || (u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.Fragment != "" {
			continue
		}
		if i == 0 {
			documentScheme = u.Scheme
		}
		u.Path = strings.TrimRight(u.EscapedPath(), "/")
		// An API endpoint root may include the version segment, as API_URL does.
		if i > 0 {
			for _, suffix := range []string{"/api/v1", "/api/v2"} {
				if strings.HasSuffix(u.Path, suffix) {
					u.Path = strings.TrimSuffix(u.Path, suffix)
					break
				}
			}
		}
		roots = append(roots, u)
	}
	return roots, documentScheme
}

func attachmentImagePort(u *url.URL, scheme string) string {
	if port := u.Port(); port != "" {
		return port
	}
	if scheme == "https" {
		return "443"
	}
	return "80"
}

func attachmentImageLocalPath(u *url.URL, roots []*url.URL, documentScheme string) string {
	// Canonical relative references are independent of the browser/API origin.
	if u.Host == "" && u.Scheme == "" && attachmentImagePath.MatchString(u.EscapedPath()) {
		return u.EscapedPath()
	}
	for _, root := range roots {
		if u.Host != "" {
			scheme := u.Scheme
			if scheme == "" { // Protocol-relative images inherit the frontend document's scheme.
				scheme = documentScheme
			}
			if scheme != root.Scheme || !strings.EqualFold(u.Hostname(), root.Hostname()) || attachmentImagePort(u, scheme) != attachmentImagePort(root, root.Scheme) {
				continue
			}
		} else if u.Scheme != "" {
			continue
		}
		path := u.EscapedPath()
		if root.Path != "" {
			if !strings.HasPrefix(path, root.Path+"/") {
				continue
			}
			path = strings.TrimPrefix(path, root.Path)
		}
		if attachmentImagePath.MatchString(path) {
			return path
		}
	}
	return ""
}

func localAttachmentImage(source string, roots []*url.URL, documentScheme string) (taskID, attachmentID int64, ok bool) {
	u, err := url.Parse(source)
	if err != nil || u.User != nil || u.Opaque != "" || (u.Scheme != "" && u.Scheme != "http" && u.Scheme != "https") {
		return 0, 0, false
	}
	match := attachmentImagePath.FindStringSubmatch(attachmentImageLocalPath(u, roots, documentScheme))
	if match == nil {
		return 0, 0, false
	}
	taskID, e1 := strconv.ParseInt(match[1], 10, 64)
	attachmentID, e2 := strconv.ParseInt(match[2], 10, 64)
	return taskID, attachmentID, e1 == nil && e2 == nil && taskID > 0 && attachmentID > 0
}
