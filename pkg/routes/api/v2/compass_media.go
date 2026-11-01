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

package apiv2

import (
	"context"
	"fmt"
	"io"
	"mime"
	"net/http"
	"strconv"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/models"
	webfiles "code.vikunja.io/api/pkg/web/files"

	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
)

func init() { AddRouteRegistrar(registerCompassImageRoutes) }
func registerCompassImageRoutes(api huma.API) {
	op := huma.Operation{OperationID: "compass-images-read", Method: http.MethodGet, Path: "/compass/spaces/{space}/images/{file}", Summary: "Read a space-authorized image or an owned draft image", Description: "Checks current space membership on every read, including cache revalidation. History keeps its image references. Does not grant access to other Drive files.", Tags: []string{"compass"}, Responses: map[string]*huma.Response{"200": {Description: "Raster image", Content: map[string]*huma.MediaType{"image/png": {Schema: &huma.Schema{Type: "string", Format: "binary"}}, "image/jpeg": {Schema: &huma.Schema{Type: "string", Format: "binary"}}, "image/webp": {Schema: &huma.Schema{Type: "string", Format: "binary"}}, "image/gif": {Schema: &huma.Schema{Type: "string", Format: "binary"}}}}}}
	Register(api, op, func(ctx context.Context, in *struct {
		Space int64 `path:"space" minimum:"1"`
		File  int64 `path:"file" minimum:"1"`
	}) (*huma.StreamResponse, error) {
		a, err := authFromCtx(ctx)
		if err != nil {
			return nil, err
		}
		s := db.NewReadSession()
		defer s.Close()
		f, err := models.GetCompassImage(s, a, in.Space, in.File)
		if err != nil {
			return nil, translateDomainError(err)
		}
		if err = f.LoadFileByID(); err != nil {
			return nil, huma.Error404NotFound("Image file is unavailable.")
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			defer f.File.Close()
			ec := humaecho.Unwrap(hctx)
			w, r := (*ec).Response(), (*ec).Request()
			etag := fmt.Sprintf(`"ci-%d"`, f.ID)
			webfiles.PrivateImageCache(w)
			w.Header().Set("ETag", etag)
			w.Header().Set("Content-Type", f.Mime)
			w.Header().Set("X-Content-Type-Options", "nosniff")
			w.Header().Set("Content-Disposition", mime.FormatMediaType("inline", map[string]string{"filename": f.Name}))
			if webfiles.ImageNotModified(r, etag, time.Time{}) {
				w.WriteHeader(http.StatusNotModified)
				return
			}
			if seeker, ok := f.File.(io.ReadSeeker); ok {
				http.ServeContent(w, r, f.Name, f.Created, seeker)
				return
			}
			w.Header().Set("Content-Length", strconv.FormatUint(f.Size, 10))
			w.Header().Set("Last-Modified", f.Created.UTC().Format(http.TimeFormat))
			w.WriteHeader(http.StatusOK)
			_, _ = io.Copy(w, f.File) // Client disconnects can stop an already-started response.
		}}, nil
	})
}
