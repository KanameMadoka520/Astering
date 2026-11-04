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

//nolint:gosmopolitan // This fork intentionally provides Chinese prompts and user-facing messages.
package apiv2

import (
	"context"
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcyshowcase"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTCYShowcaseRoutes) }

func RegisterTCYShowcaseRoutes(api huma.API) {
	op := func(id, method, path, description string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: description, Description: description + "。草稿修改不会改变已发布规则。", Tags: []string{"tcymc-showcase"}, DefaultStatus: http.StatusOK}
	}
	Register(api, op("tcy-showcase-settings", "GET", "/showcase/settings", "读取个人公开主页草稿和发布状态"), func(ctx context.Context, _ *struct{}) (*singleBody[tcyshowcase.State], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyshowcase.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyshowcase.State]{Body: &s}, nil
	})
	Register(api, op("tcy-showcase-save", "POST", "/showcase/settings", "保存公开主页草稿"), func(ctx context.Context, in *struct{ Body tcyshowcase.Draft }) (*singleBody[tcyshowcase.State], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyshowcase.Save(uid, in.Body, false)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyshowcase.State]{Body: &s}, nil
	})
	Register(api, op("tcy-showcase-preview", "POST", "/showcase/preview", "使用当前草稿预览脱敏页面及可用时间段"), func(ctx context.Context, in *struct{ Body tcyshowcase.Draft }) (*singleBody[tcyshowcase.Preview], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		p, err := tcyshowcase.Build(ctx, uid, in.Body)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyshowcase.Preview]{Body: &p}, nil
	})
	Register(api, op("tcy-showcase-publish", "POST", "/showcase/publish", "发布当前草稿规则，日程按这些规则实时生成"), func(ctx context.Context, in *struct{ Body tcyshowcase.Draft }) (*singleBody[tcyshowcase.State], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if _, err = tcyshowcase.Build(ctx, uid, in.Body); err != nil {
			return nil, aiError(ctx, err)
		}
		s, err := tcyshowcase.Save(uid, in.Body, true)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyshowcase.State]{Body: &s}, nil
	})
	Register(api, op("tcy-showcase-unpublish", "POST", "/showcase/unpublish", "立即撤下个人公开主页和 JSON 接口"), func(ctx context.Context, _ *struct{}) (*singleBody[tcyshowcase.State], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyshowcase.Unpublish(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyshowcase.State]{Body: &s}, nil
	})
	public := op("tcy-showcase-public", "GET", "/public/{slug}", "公开的日程与忙闲 JSON，仅返回已发布且脱敏的字段")
	public.Security = []map[string][]string{}
	Register(api, public, func(ctx context.Context, in *struct {
		Slug string `path:"slug" maxLength:"48"`
	}) (*singleBody[tcyshowcase.Page], error) {
		uid, state, err := tcyshowcase.Public(in.Slug)
		if err != nil {
			return nil, huma.Error404NotFound(tcylocale.Render(ctx, tcylocale.Error("e53")))
		}
		p, err := tcyshowcase.Build(ctx, uid, *state.Published)
		if err != nil {
			return nil, huma.Error503ServiceUnavailable(tcylocale.Render(ctx, tcylocale.Error("e52")))
		}
		p.Page.PublishedAt = state.PublishedAt
		return &singleBody[tcyshowcase.Page]{Body: &p.Page}, nil
	})
}
