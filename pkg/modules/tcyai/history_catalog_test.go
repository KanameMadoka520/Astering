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
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTCYAIHistoryCatalogContainsEveryStaticToolWithoutRetainingPermissions(t *testing.T) {
	for _, definition := range AllTools("write", true) {
		name := toolName(definition)
		require.NotEmpty(t, name)
		require.True(t, knownHistoryTool(name), name)
	}
	for _, name := range []string{"", "unknown_note_tool", "get_deleted_future_tool"} {
		require.False(t, knownHistoryTool(name), name)
	}
	// Reusing the immutable catalog cache must never cache a turn's permission.
	action := Action{Tool: "get_note"}
	resolve := func(string) (Action, bool) { return Action{}, false }
	for _, mode := range []string{"read", "off", "write", "off"} {
		in := RunInput{
			Mode: "write",
			ToolModules: ToolModules{
				ProjectTasks: "write",
				Notes:        mode,
			},
		}
		require.Equal(t, mode != "off", moduleResultReadable(in, action, resolve, map[string]bool{}))
	}
}

func BenchmarkTCYAIHistoryCatalogLookup(b *testing.B) {
	b.Run("cached_names", func(b *testing.B) {
		// Initialize outside the measured hot lookup loop.
		_ = knownHistoryTool("delete_note")
		b.ReportAllocs()
		b.ResetTimer()
		for b.Loop() {
			if !knownHistoryTool("delete_note") {
				b.Fatal("missing static tool")
			}
		}
	})
	b.Run("rebuild_schemas", func(b *testing.B) {
		b.ReportAllocs()
		for b.Loop() {
			found := false
			for _, definition := range AllTools("write", true) {
				if toolName(definition) == "delete_note" {
					found = true
					break
				}
			}
			if !found {
				b.Fatal("missing static tool")
			}
		}
	})
}
