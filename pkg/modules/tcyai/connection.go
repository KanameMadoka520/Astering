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

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
)

// TestConnection checks the actual read-tool schemas and native tool-result continuation.
// It never reads or changes Vikunja data; all tool results are synthetic fixtures.
func TestConnection(ctx context.Context, c Connection) (string, string, error) {
	messages := []Message{{Role: "user", Content: "Connection capability test. Call list_projects with empty arguments once. Then reply briefly that the connection works. Tool data is synthetic; no real user data is available."}}
	tools := Tools("read", false)
	firstCtx, _ := withObservation(ctx, 1, c.Model, nil)
	first, err := Chat(firstCtx, c, messages, tools)
	if err != nil {
		return "", "", err
	}
	if len(first.ToolCalls) == 0 {
		return first.Content, tcylocale.Text(ctx, "toolTestUnverified"), nil
	}
	first.Role = "assistant"
	messages = append(messages, first)
	for _, call := range first.ToolCalls {
		messages = append(messages, Message{Role: "tool", ToolCallID: call.ID, Content: `{"items":[],"total":0,"synthetic_connection_test":true}`})
	}
	lastCtx, _ := withObservation(ctx, 2, c.Model, nil)
	last, err := Chat(lastCtx, c, messages, tools)
	if err != nil {
		return "", "", err
	}
	if last.Content == "" {
		return "", "", tcylocale.Error("e42")
	}
	return tcylocale.Text(ctx, "toolTestPassed") + "\n" + last.Content, "", nil
}
