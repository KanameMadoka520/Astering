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
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/modules/systemstatus"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterSystemStatusRoutes) }

type systemStatusBody struct {
	CacheControl string `header:"Cache-Control"`
	Body         systemstatus.Snapshot
}

func RegisterSystemStatusRoutes(api huma.API) {
	Register(api, huma.Operation{OperationID: "system-status", Method: http.MethodGet, Path: "/system/status", Tags: []string{"system"}, Summary: "Read host load and application runtime status", Description: "Authenticated user sessions only, excluding public shares and API tokens. Returns host CPU/RAM, load averages and boot uptime from four explicit read-only host proc file mounts; also reports data-filesystem usage, application uptime and build version. Without the mounts, host counters are unavailable, never silently substituted with container counters. Samples are cached server-wide for 15 seconds. Disk is filesystem usage, not a container disk quota. Missing platform counters are null."}, func(ctx context.Context, _ *struct{}) (*systemStatusBody, error) {
		if _, err := aiUser(ctx); err != nil {
			return nil, err
		}
		return &systemStatusBody{CacheControl: "no-store", Body: systemstatus.Read()}, nil
	})
}
