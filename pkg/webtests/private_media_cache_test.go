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

package webtests

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"

	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/require"
)

func conditionalMediaRequest(e *echo.Echo, path, token, etag string) *httptest.ResponseRecorder {
	req := httptest.NewRequest(http.MethodGet, path, nil)
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if etag != "" {
		req.Header.Set("If-None-Match", etag)
	}
	rec := httptest.NewRecorder()
	e.ServeHTTP(rec, req)
	return rec
}

func TestPrivateMediaCacheHTTP(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	owner := chatDrive{
		t:     t,
		e:     e,
		token: humaTokenFor(t, &testuser1),
	}
	other := humaTokenFor(t, &testuser2)
	inaccessible := humaTokenFor(t, &testuser13)
	png := chatDrivePNG(t, 120)
	taskAttachment := uploadOneAttachment(t, e, owner.token, "picture.png", png)
	fileID := owner.driveUpload("picture.png", png)
	conversation := owner.conversation("Media caching")
	attached := owner.chatUpload(conversation, "picture.png", png)
	for _, tc := range []struct {
		name        string
		path        string
		deniedToken string
	}{
		{
			name:        "task original",
			path:        fmt.Sprintf("/api/v2/tasks/1/attachments/%d", taskAttachment),
			deniedToken: inaccessible,
		},
		{
			name:        "task preview",
			path:        previewURL("1", taskAttachment, "?size=md"),
			deniedToken: inaccessible,
		},
		{
			name:        "drive original",
			path:        fmt.Sprintf("/api/v2/drive/files/%d/download", fileID),
			deniedToken: other,
		},
		{
			name:        "drive preview",
			path:        fmt.Sprintf("/api/v2/drive/files/%d/preview", fileID),
			deniedToken: other,
		},
		{
			name:        "chat image",
			path:        "/api/v2/ai/conversations/" + conversation + "/attachments/" + attached.ID,
			deniedToken: other,
		},
		{
			name:        "avatar",
			path:        "/api/v2/avatar/user1",
			deniedToken: "",
		},
	} {
		t.Run(tc.name, func(t *testing.T) {
			first := conditionalMediaRequest(e, tc.path, owner.token, "")
			require.Equal(t, http.StatusOK, first.Code)
			require.Equal(t, "private, no-cache", first.Header().Get("Cache-Control"))
			etag := first.Header().Get("ETag")
			require.NotEmpty(t, etag)
			for _, response := range []*httptest.ResponseRecorder{first, conditionalMediaRequest(e, tc.path, owner.token, etag)} {
				vary := strings.Join(response.Header().Values("Vary"), ",")
				require.Contains(t, vary, "Authorization")
				require.Contains(t, vary, "Cookie")
			}
			cached := conditionalMediaRequest(e, tc.path, owner.token, `"unrelated", W/`+etag)
			require.Equal(t, http.StatusNotModified, cached.Code)
			require.Empty(t, cached.Body.Bytes())
			require.Equal(t, etag, cached.Header().Get("ETag"))
			require.Equal(t, http.StatusOK, conditionalMediaRequest(e, tc.path, owner.token, `"wrong"`).Code)
			denied := conditionalMediaRequest(e, tc.path, tc.deniedToken, etag)
			require.Contains(t, []int{401, 403, 404}, denied.Code, "conditional reads must still enforce current authorization")
			require.Equal(t, http.StatusUnauthorized, conditionalMediaRequest(e, tc.path, "", etag).Code)
		})
	}
	original := conditionalMediaRequest(e, previewURL("1", taskAttachment, "?size=md"), owner.token, "")
	different := conditionalMediaRequest(e, previewURL("1", taskAttachment, "?size=lg"), owner.token, original.Header().Get("ETag"))
	require.Equal(t, http.StatusOK, different.Code, "preview variant validators must be distinct")
	chatPath := "/api/v2/ai/conversations/" + conversation + "/attachments/" + attached.ID
	chatTag := conditionalMediaRequest(e, chatPath, owner.token, "").Header().Get("ETag")
	remove := owner.do(http.MethodDelete, "/api/v2/ai/conversations/"+conversation+"/attachments/"+attached.ID, "")
	require.Contains(t, []int{200, 204}, remove.Code)
	require.Equal(t, http.StatusNotFound, conditionalMediaRequest(e, "/api/v2/ai/conversations/"+conversation+"/attachments/"+attached.ID, owner.token, chatTag).Code)
	beforeAvatar := conditionalMediaRequest(e, "/api/v2/avatar/user1", owner.token, "")
	body, contentType := multipartAvatarBody(t, "avatar", "changed.png", chatDrivePNG(t, 210))
	uploaded := uploadAvatarRequest(t, e, body, contentType, owner.token)
	require.Equal(t, http.StatusOK, uploaded.Code)
	afterAvatar := conditionalMediaRequest(e, "/api/v2/avatar/user1", owner.token, beforeAvatar.Header().Get("ETag"))
	require.Equal(t, http.StatusOK, afterAvatar.Code)
	require.NotEqual(t, beforeAvatar.Header().Get("ETag"), afterAvatar.Header().Get("ETag"))
}

func TestPrivateMediaCacheSensitiveDownloadsRemainNoStore(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	owner := chatDrive{
		t:     t,
		e:     e,
		token: humaTokenFor(t, &testuser1),
	}
	id := owner.conversation("Private files")
	text := owner.chatUpload(id, "notes.txt", []byte("private text"))
	fileID := owner.driveUpload("notes.txt", []byte("private text"))
	task := uploadOneAttachment(t, e, owner.token, "notes.txt", []byte("private text"))
	for _, path := range []string{
		"/api/v2/ai/conversations/" + id + "/attachments/" + text.ID,
		"/api/v2/ai/conversations/" + id + "/export?format=json",
		"/api/v2/ai/conversations/" + id,
		fmt.Sprintf("/api/v2/drive/files/%d/download", fileID),
		fmt.Sprintf("/api/v2/tasks/1/attachments/%d", task),
	} {
		rec := conditionalMediaRequest(e, path, owner.token, "")
		require.Equal(t, http.StatusOK, rec.Code, path)
		require.Contains(t, rec.Header().Get("Cache-Control"), "no-store", path)
	}
}
