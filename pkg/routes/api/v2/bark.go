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
	"errors"

	"github.com/KanameMadoka520/Astering/pkg/modules/bark"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/danielgtaylor/huma/v2"
)

type barkResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         bark.BarkStatus
}

func barkOut(ctx context.Context, s bark.BarkStatus, e error) (*barkResponse, error) {
	if errors.Is(e, bark.ErrConflict) {
		return nil, huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("barkConflict")))
	}
	if errors.Is(e, bark.ErrInvalid) {
		return nil, huma.Error400BadRequest(tcylocale.Render(ctx, tcylocale.Error("barkInvalid")))
	}
	if e != nil {
		return nil, huma.Error500InternalServerError(tcylocale.Render(ctx, tcylocale.Error("barkStorage")))
	}
	return &barkResponse{CacheControl: "no-store", Body: s}, nil
}
func init() { AddRouteRegistrar(RegisterBarkRoutes) }
func RegisterBarkRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: summary, Description: "Personal Bark push settings. Human account sessions only; API tokens and link shares cannot read or use saved device keys. Secrets are never returned.", Tags: []string{"notifications"}}
	}
	Register(api, op("bark-settings", "GET", "/user/push/bark", "Read personal Bark configuration and recent delivery status"), func(ctx context.Context, _ *struct{}) (*barkResponse, error) {
		uid, e := aiUser(ctx)
		if e != nil {
			return nil, e
		}
		value, err := bark.Get(uid)
		return barkOut(ctx, value, err)
	})
	Register(api, op("bark-save", "POST", "/user/push/bark", "Save personal Bark settings; enabling starts with future notifications"), func(ctx context.Context, in *struct{ Body bark.BarkSettings }) (*barkResponse, error) {
		uid, e := aiUser(ctx)
		if e != nil {
			return nil, e
		}
		value, err := bark.Save(uid, in.Body)
		return barkOut(ctx, value, err)
	})
	Register(api, op("bark-test", "POST", "/user/push/bark/test", "Send a test to the saved Bark device and record the result"), func(ctx context.Context, _ *struct{}) (*barkResponse, error) {
		uid, e := aiUser(ctx)
		if e != nil {
			return nil, e
		}
		value, err := bark.Test(ctx, uid)
		return barkOut(ctx, value, err)
	})
}
