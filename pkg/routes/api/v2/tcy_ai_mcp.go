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
	"net/http"
	"time"

	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/danielgtaylor/huma/v2"
)

type aiMCPSettingsResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.MCPSettings
}

type aiMCPTestResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.MCPTestResult
}

func init() { AddRouteRegistrar(RegisterTCYAIMCPRoutes) }

func RegisterTCYAIMCPRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID:     id,
			Method:          method,
			Path:            path,
			Summary:         summary,
			Description:     "Private settings for the current human account. Saved credentials are encrypted and never returned. Not exposed as an MCP server tool.",
			Tags:            []string{"tcymc-ai"},
			DefaultStatus:   http.StatusOK,
			MaxBodyBytes:    512 * 1024,
			BodyReadTimeout: 10 * time.Second,
		}
	}
	path := "/user/settings/tcy-ai/mcp"
	Register(api, op("tcy-ai-mcp-settings", http.MethodGet, path, "Read private remote MCP settings"),
		func(ctx context.Context, _ *struct{}) (*aiMCPSettingsResponse, error) {
			uid, err := aiUser(ctx)
			if err != nil {
				return nil, err
			}
			settings, err := tcyai.LoadMCP(uid)
			if err != nil {
				return nil, aiError(ctx, err)
			}
			return &aiMCPSettingsResponse{CacheControl: "no-store", Body: tcyai.RedactMCP(settings)}, nil
		})
	Register(api, op("tcy-ai-mcp-save-settings", http.MethodPut, path, "Replace remote MCP settings using an optimistic revision"),
		func(ctx context.Context, input *struct{ Body tcyai.MCPSettings }) (*aiMCPSettingsResponse, error) {
			uid, err := aiUser(ctx)
			if err != nil {
				return nil, err
			}
			settings, err := tcyai.SaveMCP(uid, input.Body)
			if errors.Is(err, tcyai.ErrMCPSettingsConflict) {
				return nil, huma.Error409Conflict(tcyai.ExplainError(ctx, err))
			}
			if err != nil {
				return nil, aiError(ctx, err)
			}
			return &aiMCPSettingsResponse{CacheControl: "no-store", Body: settings}, nil
		})
	Register(api, op("tcy-ai-mcp-test", http.MethodPost, path+"/test", "Test a remote MCP handshake and list its tools without executing them"),
		func(ctx context.Context, input *struct{ Body tcyai.MCPConnection }) (*aiMCPTestResponse, error) {
			uid, err := aiUser(ctx)
			if err != nil {
				return nil, err
			}
			result, err := tcyai.TestMCP(ctx, uid, input.Body)
			if err != nil {
				return nil, aiError(ctx, err)
			}
			return &aiMCPTestResponse{CacheControl: "no-store", Body: result}, nil
		})
}
