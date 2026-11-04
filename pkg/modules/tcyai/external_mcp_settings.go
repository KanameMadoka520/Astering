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
	"crypto/rand"
	"encoding/json"
	"errors"
	"fmt"
	"net/netip"
	"net/url"
	"os"
	"path/filepath"
	"reflect"
	"regexp"
	"slices"
	"strings"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
)

var ErrMCPSettingsConflict = errors.New("MCP settings changed; reload before saving")
var ErrMCPConfiguration = errors.New("invalid MCP connection configuration")
var ErrMCPCredentials = errors.New("a bearer key is required; changing its destination requires entering it again")

var mcpIdentifier = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,80}$`)
var mcpToolName = regexp.MustCompile(`^[a-zA-Z0-9_.-]{1,128}$`)

// The existing conversation directory is covered by account deletion and its durable retry scan.
// This filename is deliberately not a conversation's .enc file.
func mcpSettingsPath(uid int64) string {
	return filepath.Join(conversationDir(uid), ".mcp-settings")
}

func readMCPSettings(uid int64) (MCPSettings, error) {
	settings := MCPSettings{Connections: []MCPConnection{}}
	if uid <= 0 || accountDeleted(uid) {
		return settings, ErrAccountDeleted
	}
	data, err := os.ReadFile(mcpSettingsPath(uid))
	if errors.Is(err, os.ErrNotExist) {
		return settings, nil
	}
	if err != nil {
		return settings, err
	}
	if len(data) > 512*1024 {
		return settings, ErrMCPConfiguration
	}
	a, err := aead()
	if err != nil {
		return settings, err
	}
	if len(data) < a.NonceSize() {
		return settings, ErrMCPConfiguration
	}
	plain, err := a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], []byte(fmt.Sprintf("mcp:%d", uid)))
	if err != nil {
		return settings, ErrMCPConfiguration
	}
	err = json.Unmarshal(plain, &settings)
	return settings, err
}

func LoadMCP(uid int64) (MCPSettings, error) {
	settingsLock.Lock()
	defer settingsLock.Unlock()
	return readMCPSettings(uid)
}

func RedactMCP(settings MCPSettings) MCPSettings {
	settings.Connections = append([]MCPConnection{}, settings.Connections...)
	for i := range settings.Connections {
		c := &settings.Connections[i]
		c.HasKey = c.APIKey != ""
		c.APIKey = ""
		c.ReadTools = append([]string{}, c.ReadTools...)
	}
	return settings
}

func mcpEndpoint(raw string) (*url.URL, error) {
	u, err := url.Parse(raw)
	if err != nil || len(raw) > 2048 || u == nil || u.Hostname() == "" || u.User != nil || u.Opaque != "" ||
		(u.Scheme != "http" && u.Scheme != "https") || u.RawQuery != "" || u.ForceQuery || u.Fragment != "" {
		return nil, ErrMCPConfiguration
	}
	if u.Scheme == "http" {
		address, err := netip.ParseAddr(u.Hostname())
		if err != nil || !address.IsLoopback() || !config.OutgoingRequestsAllowNonRoutableIPs.GetBool() {
			return nil, ErrMCPConfiguration
		}
	}
	return u, nil
}

func validateMCPConnection(c *MCPConnection) error {
	if !mcpIdentifier.MatchString(c.ID) || strings.TrimSpace(c.Name) == "" || len([]rune(c.Name)) > 100 ||
		len(c.APIKey) > 8192 || strings.ContainsAny(c.APIKey, "\r\n") || len(c.ReadTools) > 100 {
		return ErrMCPConfiguration
	}
	endpoint, err := mcpEndpoint(c.URL)
	if err != nil {
		return err
	}
	c.URL = endpoint.String()
	if c.Transport != "streamable_http" && c.Transport != "sse" {
		return ErrMCPConfiguration
	}
	if c.Preset != "custom" && c.Preset != "wallos" {
		return ErrMCPConfiguration
	}
	for _, name := range c.ReadTools {
		if !mcpToolName.MatchString(name) {
			return ErrMCPConfiguration
		}
	}
	c.ReadTools = append([]string{}, c.ReadTools...)
	slices.Sort(c.ReadTools)
	c.ReadTools = slices.Compact(c.ReadTools)
	c.HasKey = false
	return nil
}

func sameMCPCredentialDestination(a, b MCPConnection) bool {
	return a.URL == b.URL && a.Transport == b.Transport
}

func mcpSettingsConnection(settings MCPSettings, id string) (MCPConnection, bool) {
	for _, connection := range settings.Connections {
		if connection.ID == id {
			return connection, true
		}
	}
	return MCPConnection{}, false
}

func writeMCPSettings(uid int64, settings MCPSettings) error {
	return withAccountWrite(uid, func() error {
		plain, err := json.Marshal(settings)
		if err != nil {
			return err
		}
		a, err := aead()
		if err != nil {
			return err
		}
		nonce := make([]byte, a.NonceSize())
		if _, err = rand.Read(nonce); err != nil {
			return err
		}
		data := a.Seal(nonce, nonce, plain, []byte(fmt.Sprintf("mcp:%d", uid)))
		path := mcpSettingsPath(uid)
		if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
			return err
		}
		file, err := os.CreateTemp(filepath.Dir(path), ".mcp-settings-*")
		if err != nil {
			return err
		}
		defer os.Remove(file.Name())
		if _, err = file.Write(data); err == nil {
			err = file.Sync()
		}
		closeErr := file.Close()
		if err != nil {
			return err
		}
		if closeErr != nil {
			return closeErr
		}
		return os.Rename(file.Name(), path)
	})
}

func SaveMCP(uid int64, settings MCPSettings) (MCPSettings, error) {
	settingsLock.Lock()
	defer func() {
		settingsLock.Unlock()
		cleanupRevokedAccount(uid)
	}()
	old, err := readMCPSettings(uid)
	if err != nil {
		return MCPSettings{}, err
	}
	if settings.Revision != old.Revision {
		return MCPSettings{}, ErrMCPSettingsConflict
	}
	if len(settings.Connections) > 20 {
		return MCPSettings{}, ErrMCPConfiguration
	}
	settings.Connections = append([]MCPConnection{}, settings.Connections...)
	ids := map[string]bool{}
	for i := range settings.Connections {
		c := &settings.Connections[i]
		if err = validateMCPConnection(c); err != nil || ids[c.ID] {
			return MCPSettings{}, ErrMCPConfiguration
		}
		ids[c.ID] = true
		previous, exists := mcpSettingsConnection(old, c.ID)
		if c.APIKey == "" && exists && previous.APIKey != "" {
			if !sameMCPCredentialDestination(previous, *c) {
				return MCPSettings{}, ErrMCPCredentials
			}
			c.APIKey = previous.APIKey
		}
		if c.Enabled && strings.TrimSpace(c.APIKey) == "" {
			return MCPSettings{}, ErrMCPCredentials
		}
		c.Revision = previous.Revision
		if !exists || !reflect.DeepEqual(previous, *c) {
			c.Revision = uuid.NewString()
		}
	}
	settings.Revision++
	if err = writeMCPSettings(uid, settings); err != nil {
		return MCPSettings{}, err
	}
	revokeChangedMCPSessions(uid, settings)
	return RedactMCP(settings), nil
}
