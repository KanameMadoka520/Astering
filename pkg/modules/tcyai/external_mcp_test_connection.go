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

package tcyai

import (
	"context"
	"strings"
	"time"
)

func TestMCP(ctx context.Context, uid int64, connection MCPConnection) (MCPTestResult, error) {
	if err := validateMCPConnection(&connection); err != nil {
		return MCPTestResult{}, err
	}
	if connection.APIKey == "" {
		settings, err := LoadMCP(uid)
		if err != nil {
			return MCPTestResult{}, err
		}
		saved, exists := mcpSettingsConnection(settings, connection.ID)
		if !exists || !sameMCPCredentialDestination(saved, connection) {
			return MCPTestResult{}, ErrMCPCredentials
		}
		connection.APIKey = saved.APIKey
	}
	if strings.TrimSpace(connection.APIKey) == "" {
		return MCPTestResult{}, ErrMCPCredentials
	}
	ctx, cancel := context.WithTimeout(ctx, 20*time.Second)
	defer cancel()
	remote, err := connectMCP(ctx, uid, connection, func() error { return requireActiveAccount(uid) })
	if err != nil {
		return MCPTestResult{}, err
	}
	defer remote.close()
	tools, err := mcpCatalog(ctx, remote)
	if err != nil {
		return MCPTestResult{}, err
	}
	server := remote.session.InitializeResult().ServerInfo
	if server == nil {
		return MCPTestResult{}, ErrMCPConfiguration
	}
	return MCPTestResult{
		Endpoint:      connection.URL,
		ServerName:    mcpRedactText(server.Name, connection.APIKey),
		ServerVersion: mcpRedactText(server.Version, connection.APIKey),
		Tools:         tools,
		Matched:       len(tools),
	}, nil
}
