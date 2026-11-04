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
	"bytes"
	"io"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/require"
)

func TestTCYMediaPreserveOriginal(t *testing.T) {
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	for _, format := range []string{"png", "webp"} {
		raw := pngBytes(t)
		if format == "webp" {
			raw, err = os.ReadFile("testdata/tcymc-cover.webp")
			require.NoError(t, err)
		}
		for _, kind := range []string{"background", "avatar"} {
			t.Run(format+"/"+kind, func(t *testing.T) {
				path := "/api/v2/projects/1/backgrounds/upload"
				if kind == "avatar" {
					path = avatarUploadPath
				}
				body, contentType := multipartFileBody(t, kind, "fixture."+format, raw)
				req := httptest.NewRequest("PUT", path, body)
				req.Header.Set("Authorization", "Bearer "+token)
				req.Header.Set("Content-Type", contentType)
				mode := "original"
				if format == "webp" {
					mode = "webp"
				}
				req.Header.Set("X-Vikunja-Image-Mode", mode)
				rec := httptest.NewRecorder()
				e.ServeHTTP(rec, req)
				require.Equal(t, 200, rec.Code, rec.Body.String())
				s := db.NewReadSession()
				defer s.Close()
				var id int64
				if kind == "background" {
					p := models.Project{ID: 1}
					_, err = s.Get(&p)
					require.NoError(t, err)
					id = p.BackgroundFileID
				} else {
					u := user.User{ID: 1}
					_, err = s.Get(&u)
					require.NoError(t, err)
					id = u.AvatarFileID
				}
				f := files.File{ID: id}
				require.NoError(t, f.LoadFileByID())
				defer f.File.Close()
				stored, err := io.ReadAll(f.File)
				require.NoError(t, err)
				require.True(t, bytes.Equal(raw, stored), "Selected original bytes must not be silently transcoded")
				if kind == "background" {
					downloaded := humaRequest(t, e, "GET", "/api/v2/projects/1/background", "", token, "")
					require.Equal(t, 200, downloaded.Code, downloaded.Body.String())
					require.Equal(t, "image/"+format, downloaded.Header().Get("Content-Type"))
					require.Equal(t, raw, downloaded.Body.Bytes())
				}
			})
		}
	}

}
