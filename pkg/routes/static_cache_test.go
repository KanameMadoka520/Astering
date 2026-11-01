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

package routes

import (
	"io/fs"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"testing/fstest"
	"time"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestStaticCachePolicy(t *testing.T) {
	const immutable = "public, max-age=31536000, immutable"
	tests := []struct {
		name        string
		requestPath string
		fileName    string
		body        string
		want        string
	}{
		{
			name:        "hashed JavaScript with a charset MIME parameter",
			requestPath: "/assets/index-Q_XnkVXn.js",
			fileName:    "index-Q_XnkVXn.js",
			body:        "export const version = 1",
			want:        immutable,
		},
		{
			name:        "hashed CSS with a charset MIME parameter",
			requestPath: "/assets/index-Dq491oVJ.css",
			fileName:    "index-Dq491oVJ.css",
			body:        "body { color: black }",
			want:        immutable,
		},
		{
			name:        "hashed asset under a frontend base path",
			requestPath: "/personal/tasks/assets/avatar-Q_XnkVXn.svg",
			fileName:    "avatar-Q_XnkVXn.svg",
			body:        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
			want:        immutable,
		},
		{
			name:        "hashed font",
			requestPath: "/assets/OpenSans_wght__c9a8fe68-5f21f1e7.woff2",
			fileName:    "OpenSans_wght__c9a8fe68-5f21f1e7.woff2",
			body:        "font fixture",
			want:        immutable,
		},
		{
			name:        "versioned Workbox runtime under a base path",
			requestPath: "/personal/workbox-v7.4.0/workbox-sw.js",
			fileName:    "workbox-sw.js",
			body:        "const workbox = {}",
			want:        immutable,
		},
		{
			name:        "versioned Workbox module",
			requestPath: "/workbox-v7.4.0/workbox-strategies.prod.js",
			fileName:    "workbox-strategies.prod.js",
			body:        "const strategies = {}",
			want:        immutable,
		},
		{
			name:        "unversioned logo",
			requestPath: "/images/brand/logo.svg",
			fileName:    "logo.svg",
			body:        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
			want:        "no-cache",
		},
		{
			name:        "icon query version is mutable at a fixed path",
			requestPath: "/images/icons/android-chrome-192x192.png?v=x33",
			fileName:    "android-chrome-192x192.png",
			body:        "image fixture",
			want:        "no-cache",
		},
		{
			name:        "fixed CSS",
			requestPath: "/assets/theme.css",
			fileName:    "theme.css",
			body:        "body { color: black }",
			want:        "no-cache",
		},
		{
			name:        "fixed JavaScript",
			requestPath: "/assets/config.js",
			fileName:    "config.js",
			body:        "const config = {}",
			want:        "no-cache",
		},
		{
			name:        "hash-like name outside the build assets directory",
			requestPath: "/images/brand/logo-Q_XnkVXn.svg",
			fileName:    "logo-Q_XnkVXn.svg",
			body:        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
			want:        "no-cache",
		},
		{
			name:        "asset directory escaped by a dot segment",
			requestPath: "/assets/../images/logo-Q_XnkVXn.svg",
			fileName:    "logo-Q_XnkVXn.svg",
			body:        "<svg xmlns=\"http://www.w3.org/2000/svg\"/>",
			want:        "no-cache",
		},
		{
			name:        "unversioned Workbox filename",
			requestPath: "/workbox-sw.js",
			fileName:    "workbox-sw.js",
			body:        "const workbox = {}",
			want:        "no-cache",
		},
		{
			name:        "nonversioned Workbox directory",
			requestPath: "/workbox-latest/workbox-sw.js",
			fileName:    "workbox-sw.js",
			body:        "const workbox = {}",
			want:        "no-cache",
		},
		{
			name:        "unknown hashed asset falling back to HTML",
			requestPath: "/assets/missing-Q_XnkVXn.js",
			fileName:    "index.html",
			body:        "<!doctype html><p>Application</p>",
			want:        "no-cache",
		},
		{
			name:        "HTML is not a reusable static asset",
			requestPath: "/assets/page-Q_XnkVXn.html",
			fileName:    "page-Q_XnkVXn.html",
			body:        "<!doctype html><p>Application</p>",
			want:        "no-cache",
		},
		{
			name:        "service worker",
			requestPath: "/sw.js",
			fileName:    "sw.js",
			body:        "self.addEventListener('install', () => {})",
			want:        "no-cache",
		},
		{
			name:        "web manifest",
			requestPath: "/manifest.webmanifest",
			fileName:    "manifest.webmanifest",
			body:        "{\"name\":\"vikunja-x\"}",
			want:        "no-cache",
		},
	}

	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			files := fstest.MapFS{tt.fileName: {Data: []byte(tt.body), Mode: 0o444}}
			info, err := fs.Stat(files, tt.fileName)
			require.NoError(t, err)
			e := echo.New()
			rec := httptest.NewRecorder()
			c := e.NewContext(httptest.NewRequest(http.MethodGet, tt.requestPath, nil), rec)
			err = serveFile(c, strings.NewReader(tt.body), info, `"cache-fixture"`)
			require.NoError(t, err)
			assert.Equal(t, http.StatusOK, rec.Code)
			assert.Equal(t, tt.want, rec.Header().Get("Cache-Control"))
			assert.Equal(t, `"cache-fixture"`, rec.Header().Get("ETag"))
		})
	}
}

func TestStaticCacheConditionalRevalidation(t *testing.T) {
	const body = "body { color: black }"
	files := fstest.MapFS{"theme.css": {Data: []byte(body), Mode: 0o444, ModTime: time.Unix(1, 0)}}
	info, err := fs.Stat(files, "theme.css")
	require.NoError(t, err)
	e := echo.New()
	request := httptest.NewRequest(http.MethodGet, "/assets/theme.css", nil)
	request.Header.Set("If-None-Match", `"cache-fixture"`)
	rec := httptest.NewRecorder()
	require.NoError(t, serveFile(e.NewContext(request, rec), strings.NewReader(body), info, `"cache-fixture"`))
	assert.Equal(t, http.StatusNotModified, rec.Code)
	assert.Empty(t, rec.Body.String())
	assert.Equal(t, "no-cache", rec.Header().Get("Cache-Control"))
	assert.Equal(t, `"cache-fixture"`, rec.Header().Get("ETag"))
}

func TestStaticCacheIndexRevalidation(t *testing.T) {
	e := newStaticTestEcho()
	initial := httptest.NewRecorder()
	e.ServeHTTP(initial, httptest.NewRequest(http.MethodGet, "/", nil))
	require.Equal(t, http.StatusOK, initial.Code)
	assert.Equal(t, "no-cache", initial.Header().Get("Cache-Control"))
	etag := initial.Header().Get("ETag")
	require.NotEmpty(t, etag)

	// SPA routes serve the same runtime-configured index, with the same validator.
	request := httptest.NewRequest(http.MethodGet, "/projects/1/1", nil)
	request.Header.Set("If-None-Match", etag)
	validated := httptest.NewRecorder()
	e.ServeHTTP(validated, request)
	assert.Equal(t, http.StatusNotModified, validated.Code)
	assert.Empty(t, validated.Body.String())
	assert.Equal(t, "no-cache", validated.Header().Get("Cache-Control"))
	assert.Equal(t, etag, validated.Header().Get("ETag"))
}
