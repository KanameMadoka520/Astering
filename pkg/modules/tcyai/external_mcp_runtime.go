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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"math"
	"slices"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/modelcontextprotocol/go-sdk/mcp"
)

type MCPConnectionMetadata struct {
	ServerID    string `json:"server_id" doc:"Selected account-owned connection."`
	Name        string `json:"name" doc:"Configured display name."`
	URL         string `json:"url" doc:"Configured endpoint without credentials."`
	AllowWrite  bool   `json:"allow_write" doc:"External writes require this switch and human review."`
	AllowDelete bool   `json:"allow_delete" doc:"Destructive external tools require this additional switch."`
}

type MCPRuntime struct {
	mu       sync.Mutex
	ctx      context.Context
	cancel   context.CancelFunc
	uid      int64
	selected []string
	remotes  map[string]*mcpRemote
	tickets  []MCPToolTicket
	prepared map[string]RunInput
	inFlight map[string]bool
}

func NewMCPRuntime(ctx context.Context, uid int64, selectedIDs []string) (*MCPRuntime, error) {
	if len(selectedIDs) > 20 || (uid <= 0 && len(selectedIDs) > 0) {
		return nil, ToolFailure("MCP_NOT_ALLOWED", "MCP servers must belong to an authenticated account.")
	}
	for _, id := range selectedIDs {
		if !mcpIdentifier.MatchString(id) {
			return nil, ErrMCPConfiguration
		}
	}
	owned, cancel := context.WithCancel(ctx)
	return &MCPRuntime{
		ctx:      owned,
		cancel:   cancel,
		uid:      uid,
		selected: slices.Compact(append([]string{}, selectedIDs...)),
		remotes:  map[string]*mcpRemote{},
		tickets:  []MCPToolTicket{},
		prepared: map[string]RunInput{},
		inFlight: map[string]bool{},
	}, nil
}

func (runtime *MCPRuntime) Close() {
	runtime.cancel()
	runtime.mu.Lock()
	remotes := runtime.remotes
	runtime.remotes = map[string]*mcpRemote{}
	runtime.mu.Unlock()
	mcpSessions.Lock()
	entries := mcpSessions.entries[accountKey(runtime.uid)]
	for _, remote := range remotes {
		delete(entries, remote)
	}
	if len(entries) == 0 {
		delete(mcpSessions.entries, accountKey(runtime.uid))
	}
	mcpSessions.Unlock()
	for _, remote := range remotes {
		remote.close()
	}
}

func (runtime *MCPRuntime) current(id string) (MCPConnection, error) {
	if runtime.ctx.Err() != nil {
		return MCPConnection{}, runtime.ctx.Err()
	}
	if !slices.Contains(runtime.selected, id) {
		return MCPConnection{}, ToolFailure("MCP_NOT_ALLOWED", "This MCP server was not selected for this turn.")
	}
	settings, err := LoadMCP(runtime.uid)
	if err != nil {
		return MCPConnection{}, err
	}
	connection, exists := mcpSettingsConnection(settings, id)
	if !exists || !connection.Enabled || connection.APIKey == "" {
		return MCPConnection{}, ToolFailure("MCP_DISABLED", "This MCP server is disabled or no longer available.")
	}
	return connection, nil
}

func (runtime *MCPRuntime) Connections() ([]MCPConnectionMetadata, error) {
	result := []MCPConnectionMetadata{}
	if len(runtime.selected) == 0 {
		return result, nil
	}
	settings, err := LoadMCP(runtime.uid)
	if err != nil {
		return nil, err
	}
	for _, c := range settings.Connections {
		if c.Enabled && slices.Contains(runtime.selected, c.ID) {
			result = append(result, MCPConnectionMetadata{
				ServerID:    c.ID,
				Name:        c.Name,
				URL:         c.URL,
				AllowWrite:  c.AllowWrite,
				AllowDelete: c.AllowDelete,
			})
		}
	}
	return result, nil
}

func (runtime *MCPRuntime) LoadTickets(tickets []MCPToolTicket) error {
	if len(tickets) > 32 {
		return ErrMCPConfiguration
	}
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	runtime.tickets = nil
	for _, ticket := range tickets {
		if slices.Contains(runtime.selected, ticket.ServerID) && mcpToolName.MatchString(ticket.Name) &&
			len(ticket.SchemaHash) == 64 && len(ticket.ConnectionRevision) <= 80 {
			runtime.tickets = append(runtime.tickets, ticket)
		}
	}
	return nil
}

func (runtime *MCPRuntime) Tickets() []MCPToolTicket {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	return append([]MCPToolTicket{}, runtime.tickets...)
}

func (runtime *MCPRuntime) remote(ctx context.Context, connection MCPConnection) (*mcpRemote, error) {
	runtime.mu.Lock()
	defer runtime.mu.Unlock()
	if existing := runtime.remotes[connection.ID]; existing != nil && existing.ctx.Err() == nil && existing.connection.Revision == connection.Revision {
		return existing, nil
	}
	if old := runtime.remotes[connection.ID]; old != nil {
		old.close()
		mcpSessions.Lock()
		delete(mcpSessions.entries[accountKey(runtime.uid)], old)
		mcpSessions.Unlock()
		delete(runtime.remotes, connection.ID)
	}
	check := func() error {
		current, err := runtime.current(connection.ID)
		if err == nil && current.Revision != connection.Revision {
			err = ToolFailure("MCP_CONFIGURATION_CHANGED", "The MCP connection changed; previous discoveries and approvals are invalid.")
		}
		return err
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	connectCtx, cancelConnect := context.WithCancel(runtime.ctx)
	stopCallerCancel := context.AfterFunc(ctx, cancelConnect)
	remote, err := connectMCP(connectCtx, runtime.uid, connection, check) //nolint:contextcheck // Session inherits the run owner; caller cancellation is linked only through initialization.
	stopCallerCancel()
	if err != nil {
		cancelConnect()
	}
	if err != nil {
		return nil, err
	}
	if err = check(); err != nil {
		remote.close()
		return nil, err
	}
	mcpSessions.Lock()
	key := accountKey(runtime.uid)
	if mcpSessions.entries[key] == nil {
		mcpSessions.entries[key] = map[*mcpRemote]struct{}{}
	}
	mcpSessions.entries[key][remote] = struct{}{}
	mcpSessions.Unlock()
	runtime.remotes[connection.ID] = remote
	return remote, nil
}

func mcpToolPolicy(connection MCPConnection, name string) (readOnly, destructive bool) {
	if connection.Preset == "wallos" && connection.URL == "https://wallos.tcymc.space/api/agent/mcp.php" {
		switch name {
		case "wallos_context", "wallos_subscriptions_list", "wallos_subscriptions_get", "wallos_payments_list",
			"wallos_references_list", "wallos_budgets_get", "wallos_audit_list":
			return true, false
		case "wallos_subscriptions_create", "wallos_subscriptions_update", "wallos_subscriptions_restore",
			"wallos_payments_create", "wallos_payments_update", "wallos_references_save", "wallos_budgets_update":
			return false, false
		case "wallos_subscriptions_trash", "wallos_payments_delete", "wallos_references_delete", "wallos_price_rules_set":
			return false, true
		}
		return false, true
	}
	if slices.Contains(connection.ReadTools, name) {
		return true, false
	}
	return false, true
}

func mcpDefinition(connection MCPConnection, tool *mcp.Tool) (MCPToolDefinition, error) {
	if tool == nil || (connection.APIKey != "" && strings.Contains(tool.Name, connection.APIKey)) {
		return MCPToolDefinition{}, ErrMCPConfiguration
	}
	if mcpUnsafeSDKNumbers(tool.InputSchema) {
		return MCPToolDefinition{}, ToolFailure("MCP_SCHEMA_UNSUPPORTED", "The MCP schema contains integer constants outside the SDK's exact numeric range. Use string identifiers instead.")
	}
	encoded, err := json.Marshal(tool.InputSchema)
	if err != nil || len(encoded) > 64*1024 || !mcpToolName.MatchString(tool.Name) || len(tool.Description) > 16000 {
		return MCPToolDefinition{}, ErrMCPConfiguration
	}
	var parameters map[string]any
	if mcpDecodeJSON(encoded, &parameters) != nil || parameters == nil || parameters["type"] != "object" {
		return MCPToolDefinition{}, ErrMCPConfiguration
	}
	contract, err := json.Marshal(struct {
		Name        string
		Description string
		Input       any
		Output      any
	}{
		Name:        tool.Name,
		Description: tool.Description,
		Input:       tool.InputSchema,
		Output:      tool.OutputSchema,
	})
	if err != nil {
		return MCPToolDefinition{}, err
	}
	digest := sha256.Sum256(contract)
	parameters = mcpRedactValue(parameters, connection.APIKey).(map[string]any)
	readOnly, destructive := mcpToolPolicy(connection, tool.Name)
	return MCPToolDefinition{
		Name:        tool.Name,
		Description: mcpRedactText(tool.Description, connection.APIKey),
		Parameters:  parameters,
		ReadOnly:    readOnly,
		Destructive: destructive,
		Ticket: MCPToolTicket{
			ServerID:           connection.ID,
			Name:               tool.Name,
			SchemaHash:         hex.EncodeToString(digest[:]),
			ConnectionRevision: connection.Revision,
		},
	}, nil
}

func mcpCatalog(ctx context.Context, remote *mcpRemote) ([]MCPToolDefinition, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	result := []MCPToolDefinition{}
	cursor := ""
	seen := map[string]bool{}
	bytes := 0
	for range 20 {
		page, err := remote.session.ListTools(ctx, &mcp.ListToolsParams{Cursor: cursor})
		if err != nil {
			remote.close()
			return nil, ToolFailure("MCP_CATALOG_FAILED", "The MCP tool catalog could not be read.")
		}
		for _, tool := range page.Tools {
			definition, err := mcpDefinition(remote.connection, tool)
			if err != nil {
				return nil, err
			}
			if seen[definition.Name] || len(result) >= 100 {
				return nil, ErrMCPConfiguration
			}
			encoded, err := json.Marshal(definition)
			if err != nil {
				return nil, ErrMCPConfiguration
			}
			bytes += len(encoded)
			if bytes > mcpResponseLimit {
				return nil, ErrMCPConfiguration
			}
			seen[definition.Name] = true
			result = append(result, definition)
		}
		if page.NextCursor == "" {
			return result, nil
		}
		if seen["cursor:"+page.NextCursor] {
			return nil, ErrMCPConfiguration
		}
		seen["cursor:"+page.NextCursor] = true
		cursor = page.NextCursor
	}
	return nil, ErrMCPConfiguration
}

func (runtime *MCPRuntime) Discover(ctx context.Context, serverID, query string, limit int) (MCPDiscovery, error) {
	connection, err := runtime.current(serverID)
	if err != nil {
		return MCPDiscovery{}, err
	}
	remote, err := runtime.remote(ctx, connection)
	if err != nil {
		return MCPDiscovery{}, err
	}
	catalog, err := mcpCatalog(ctx, remote)
	if err != nil {
		return MCPDiscovery{}, err
	}
	if limit < 1 || limit > 5 {
		limit = 5
	}
	query = strings.ToLower(strings.TrimSpace(query))
	matches := slices.DeleteFunc(catalog, func(tool MCPToolDefinition) bool {
		return query != "" && !strings.Contains(strings.ToLower(tool.Name+" "+tool.Description), query)
	})
	sort.SliceStable(matches, func(i, j int) bool {
		return strings.ToLower(matches[i].Name) == query && strings.ToLower(matches[j].Name) != query
	})
	result := MCPDiscovery{
		ServerID:   serverID,
		ServerName: connection.Name,
		Matched:    len(matches),
		Tools:      []MCPToolDefinition{},
	}
	for _, definition := range matches[:min(limit, len(matches))] {
		result.Tools = append(result.Tools, definition)
		encoded, err := json.Marshal(result)
		if err != nil {
			return MCPDiscovery{}, ErrMCPConfiguration
		}
		if len(encoded) > 96*1024 {
			result.Tools = result.Tools[:len(result.Tools)-1]
			break
		}
	}
	result.MoreAvailable = len(matches) > len(result.Tools)
	runtime.mu.Lock()
	for _, tool := range result.Tools {
		runtime.tickets = slices.DeleteFunc(runtime.tickets, func(ticket MCPToolTicket) bool {
			return ticket.ServerID == serverID && ticket.Name == tool.Name
		})
		runtime.tickets = append(runtime.tickets, tool.Ticket)
	}
	if len(runtime.tickets) > 32 {
		runtime.tickets = slices.Clone(runtime.tickets[len(runtime.tickets)-32:])
	}
	runtime.mu.Unlock()
	return result, nil
}

func mcpValidateArguments(definition MCPToolDefinition, raw json.RawMessage) (json.RawMessage, error) {
	canonical, err := mcpCanonicalArguments(raw)
	if err != nil {
		return nil, err
	}
	encoded, err := json.Marshal(definition.Parameters)
	if err != nil {
		return nil, ErrMCPConfiguration
	}
	var schema jsonschema.Schema
	if json.Unmarshal(encoded, &schema) != nil {
		return nil, ErrMCPConfiguration
	}
	resolved, err := schema.Resolve(nil)
	if err != nil {
		return nil, ToolFailure("MCP_SCHEMA_UNSUPPORTED", "The MCP tool uses an unsupported schema. Remote schema references are not fetched.")
	}
	var arguments map[string]any
	_ = mcpDecodeJSON(canonical, &arguments)
	instance, err := mcpValidationInstance(arguments)
	if err != nil {
		return nil, err
	}
	if resolved.Validate(instance) != nil {
		return nil, ToolFailure("INVALID_ARGUMENTS", "Arguments do not match the discovered MCP tool schema.")
	}
	return canonical, nil
}

// jsonschema-go v0.4.3 treats json.Number as a string for type checks. Normalize
// only its disposable validation copy; the canonical request retains its exact digits.
func mcpValidationInstance(value any) (any, error) {
	switch current := value.(type) {
	case json.Number:
		if integer, err := strconv.ParseInt(current.String(), 10, 64); err == nil {
			return integer, nil
		}
		if integer, err := strconv.ParseUint(current.String(), 10, 64); err == nil {
			return integer, nil
		}
		if !strings.ContainsAny(current.String(), ".eE") {
			return nil, mcpUnsupportedNumber()
		}
		number, err := strconv.ParseFloat(current.String(), 64)
		if err != nil || math.IsInf(number, 0) || math.IsNaN(number) ||
			(math.Abs(number) >= 1<<53 && math.Trunc(number) == number) {
			return nil, mcpUnsupportedNumber()
		}
		if number == 0 {
			mantissa := strings.SplitN(strings.ToLower(current.String()), "e", 2)[0]
			if strings.ContainsAny(mantissa, "123456789") {
				return nil, mcpUnsupportedNumber()
			}
		}
		return number, nil
	case map[string]any:
		for key, child := range current {
			converted, err := mcpValidationInstance(child)
			if err != nil {
				return nil, err
			}
			current[key] = converted
		}
	case []any:
		for index, child := range current {
			converted, err := mcpValidationInstance(child)
			if err != nil {
				return nil, err
			}
			current[index] = converted
		}
	}
	return value, nil
}

func mcpUnsupportedNumber() error {
	return ToolFailure("MCP_SCHEMA_UNSUPPORTED", "Numeric arguments exceed the supported exact validation range. Use an integer literal within int64/uint64, or a string identifier.")
}

func mcpCheckPolicy(definition MCPToolDefinition, connection MCPConnection, input RunInput) error {
	if definition.ReadOnly {
		return nil
	}
	if input.Mode != "write" || !connection.AllowWrite || len(input.WriteProjectIDs) != 0 {
		return ToolFailure("MCP_WRITE_DENIED", "External writes require write mode, an enabled connection write switch, and no Vikunja-only project restriction.")
	}
	if definition.Destructive && !connection.AllowDelete {
		return ToolFailure("MCP_DELETE_DENIED", "Destructive or unknown external tools require this connection's deletion permission and a separate human review.")
	}
	return nil
}

func (runtime *MCPRuntime) Prepare(ctx context.Context, serverID, name string, raw json.RawMessage, input RunInput) (MCPPreparedOperation, error) {
	connection, err := runtime.current(serverID)
	if err != nil {
		return MCPPreparedOperation{}, err
	}
	var ticket MCPToolTicket
	for _, discovered := range runtime.Tickets() {
		if discovered.ServerID == serverID && discovered.Name == name {
			ticket = discovered
		}
	}
	if ticket.Name == "" || ticket.ConnectionRevision != connection.Revision {
		return MCPPreparedOperation{}, ToolFailure("TOOL_NOT_LOADED", "Discover this MCP tool under the current connection settings before calling it.")
	}
	remote, err := runtime.remote(ctx, connection)
	if err != nil {
		return MCPPreparedOperation{}, err
	}
	catalog, err := mcpCatalog(ctx, remote)
	if err != nil {
		return MCPPreparedOperation{}, err
	}
	for _, definition := range catalog {
		if definition.Name != name {
			continue
		}
		if definition.Ticket != ticket {
			return MCPPreparedOperation{}, ToolFailure("MCP_DEFINITION_CHANGED", "The remote tool changed. Discover its current contract and review it again.")
		}
		if err = mcpCheckPolicy(definition, connection, input); err != nil {
			return MCPPreparedOperation{}, err
		}
		canonical, err := mcpValidateArguments(definition, raw)
		if err != nil {
			return MCPPreparedOperation{}, err
		}
		prepared := MCPPreparedOperation{
			ServerID:           serverID,
			ServerName:         connection.Name,
			Tool:               name,
			ReadOnly:           definition.ReadOnly,
			Destructive:        definition.Destructive,
			ConnectionRevision: connection.Revision,
			DefinitionHash:     ticket.SchemaHash,
		}
		version, err := json.Marshal(prepared)
		if err != nil {
			return MCPPreparedOperation{}, ErrMCPConfiguration
		}
		digest := sha256.Sum256(append(version, canonical...))
		prepared.Version = hex.EncodeToString(digest[:])
		runtime.mu.Lock()
		if len(runtime.prepared) >= 32 {
			clear(runtime.prepared)
		}
		input.WriteProjectIDs = slices.Clone(input.WriteProjectIDs)
		runtime.prepared[prepared.Version] = input
		runtime.mu.Unlock()
		return prepared, nil
	}
	return MCPPreparedOperation{}, ToolFailure("MCP_DEFINITION_CHANGED", "The remote MCP tool no longer exists.")
}

func (runtime *MCPRuntime) Call(ctx context.Context, prepared MCPPreparedOperation, raw json.RawMessage) (string, error) {
	runtime.mu.Lock()
	input, exists := runtime.prepared[prepared.Version]
	if exists && !runtime.inFlight[prepared.Version] {
		runtime.inFlight[prepared.Version] = true
	} else {
		exists = false
	}
	runtime.mu.Unlock()
	if !exists {
		return "", ToolFailure("MCP_REVIEW_REQUIRED", "Prepare this exact MCP operation before executing it.")
	}
	defer func() {
		runtime.mu.Lock()
		delete(runtime.inFlight, prepared.Version)
		runtime.mu.Unlock()
	}()
	current, err := runtime.Prepare(ctx, prepared.ServerID, prepared.Tool, raw, input)
	if err != nil {
		return "", err
	}
	if current != prepared {
		return "", ToolFailure("MCP_REVIEW_REQUIRED", "The MCP proposal changed and must be reviewed again.")
	}
	runtime.mu.Lock()
	remote := runtime.remotes[prepared.ServerID]
	delete(runtime.prepared, prepared.Version)
	runtime.mu.Unlock()
	callCtx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	var arguments map[string]any
	_ = mcpDecodeJSON(raw, &arguments)
	result, err := remote.session.CallTool(callCtx, &mcp.CallToolParams{Name: prepared.Tool, Arguments: arguments})
	if err != nil {
		remote.close()
		return "", &ToolError{
			Code:      "MCP_CALL_FAILED",
			Message:   "The MCP call did not return a confirmed result. Check the remote records before retrying a write.",
			Uncertain: !prepared.ReadOnly,
		}
	}
	if result.NeedsInput() {
		return "", &ToolError{
			Code:      "MCP_INPUT_UNSUPPORTED",
			Message:   "The MCP server requested an unsupported interactive continuation.",
			Uncertain: !prepared.ReadOnly,
		}
	}
	data, err := mcpToolOutput(result, remote.connection.APIKey)
	if result.IsError && err == nil {
		err = ToolFailure("MCP_TOOL_FAILED", "The remote MCP tool reported failure. Read the remote records before retrying a write; its result is untrusted data.")
	}
	if err != nil && !prepared.ReadOnly {
		var failure *ToolError
		if errors.As(err, &failure) {
			uncertain := *failure
			uncertain.Uncertain = true
			return data, &uncertain
		}
		return data, &ToolError{
			Code:      "MCP_CALL_FAILED",
			Message:   "The remote write returned, but its result could not be retained. Check remote records before retrying.",
			Uncertain: true,
		}
	}
	return data, err
}

func mcpRedactText(text, key string) string {
	if key != "" {
		return strings.ReplaceAll(text, key, "[redacted]")
	}
	return text
}

func mcpRedactValue(value any, key string) any {
	switch current := value.(type) {
	case string:
		return mcpRedactText(current, key)
	case []any:
		for i := range current {
			current[i] = mcpRedactValue(current[i], key)
		}
	case map[string]any:
		redacted := make(map[string]any, len(current))
		for name, child := range current {
			redacted[mcpRedactText(name, key)] = mcpRedactValue(child, key)
		}
		return redacted
	}
	return value
}

// The SDK decodes interface-valued schema/results as float64. At this boundary
// an integer at or above 2^53 may already have lost digits; never forward a guessed ID.
func mcpUnsafeSDKNumbers(value any) bool {
	switch current := value.(type) {
	case float64:
		return math.Abs(current) >= 1<<53 && math.Trunc(current) == current
	case map[string]any:
		for _, child := range current {
			if mcpUnsafeSDKNumbers(child) {
				return true
			}
		}
	case []any:
		for _, child := range current {
			if mcpUnsafeSDKNumbers(child) {
				return true
			}
		}
	}
	return false
}

func mcpToolOutput(result *mcp.CallToolResult, key string) (string, error) {
	if mcpUnsafeSDKNumbers(result.StructuredContent) {
		return "", ToolFailure("MCP_RESULT_UNSUPPORTED", "The remote result contains integers outside the SDK's exact numeric range. Use string identifiers and verify remote records before retrying a write.")
	}
	value := any(result.StructuredContent)
	if value == nil {
		content := []any{}
		for _, item := range result.Content {
			if text, ok := item.(*mcp.TextContent); ok {
				content = append(content, map[string]any{"type": "text", "text": text.Text})
			} else {
				content = append(content, map[string]any{"type": "unsupported_non_text", "notice": "Binary MCP content is not forwarded to the language model."})
			}
		}
		value = content
	}
	encoded, err := json.Marshal(value)
	if err != nil || len(encoded) > mcpResponseLimit {
		return "", ToolFailure("MCP_RESULT_TOO_LARGE", "The MCP tool result exceeds the supported size.")
	}
	var decoded any
	if mcpDecodeJSON(encoded, &decoded) != nil {
		return "", errors.New("invalid MCP result")
	}
	encoded, err = json.Marshal(map[string]any{
		"source":    "external_mcp",
		"untrusted": true,
		"success":   !result.IsError,
		"result":    mcpRedactValue(decoded, key),
	})
	return string(encoded), err
}
