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
	"encoding/json"
	"testing"

	"github.com/stretchr/testify/require"
)

func TestTCYAIPeriodRoutineToolContracts(t *testing.T) {
	write := RunInput{Mode: "write"}
	configure := json.RawMessage(`{"id":1,"enabled":true,"paused":false,"timezone":"Asia/Shanghai","revision":0,"period":"weekly","reset_hour":5,"reset_minute":0,"week_start":1,"month_day":1,"target":3,"unit":"sessions"}`)
	_, err := ValidateTool("configure_task_routine", configure, write)
	require.NoError(t, err)
	for _, raw := range []string{
		`{"id":1,"date":"2026-11-02","revision":1,"amount":2}`,
		`{"id":1,"date":"2026-11-02","revision":1,"amount":0}`,
	} {
		_, err = ValidateTool("set_task_routine_progress", json.RawMessage(raw), write)
		require.NoError(t, err)
	}
	for _, raw := range []string{
		`{"id":1,"date":"2026-11-02","amount":1}`,
		`{"id":1,"date":"2026-11-02","revision":1,"amount":-1}`,
		`{"id":1,"date":"2026-11-02","revision":1,"amount":1.5}`,
		`{"id":1,"date":"2026-11-02","revision":1,"amount":1,"increment":true}`,
	} {
		_, err = ValidateTool("set_task_routine_progress", json.RawMessage(raw), write)
		require.Error(t, err)
	}
	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	writer := NewAgentState(context.Background(), Connection{}, write)
	for _, name := range []string{
		"set_task_routine_progress",
		"set_task_repeat_bucket",
		"configure_task_routine",
	} {
		result, err := read.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		require.NotContains(t, result, `"name":"`+name+`"`)
		result, err = writer.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		require.Contains(t, result, `"name":"`+name+`"`)
	}
	result, err := read.discover(json.RawMessage(`{"query":"get_task_repeat_bucket"}`))
	require.NoError(t, err)
	require.Contains(t, result, `"name":"get_task_repeat_bucket"`)
	// Deferred abilities must not inflate every model request's fixed schemas.
	for _, definition := range Tools("write", false) {
		require.NotContains(t, toolName(definition), "routine")
		require.NotContains(t, toolName(definition), "repeat_bucket")
	}
	result = compactToolResult("set_task_routine_progress", json.RawMessage(`{"id":1,"amount":2}`), `{"id":1,"project_id":1,"routine":{"period":"weekly","date":"2026-11-02","current_amount":2,"target":3,"completed_period":false,"revision":1},"updated":"2026-11-02T01:00:00Z"}`)
	require.Contains(t, result, `"current_amount":2`)
	require.Contains(t, result, `"period":"weekly"`)
	require.Contains(t, result, `"revision":1`)
}

func TestTCYAIRelativeReminderToolContracts(t *testing.T) {
	for _, raw := range []string{
		`{"id":1,"reminders":[{"relative_to":"due_date","relative_period":-900}]}`,
		`{"id":1,"reminders":[{"relative_to":"routine_period_end","relative_period":-300}]}`,
		`{"id":1,"reminders":[{"reminder":"2026-11-03T09:00:00+08:00","relative_to":"","relative_period":0}]}`,
		`{"id":1,"reminders":[]}`,
	} {
		_, err := ValidateTool("update_task", json.RawMessage(raw), RunInput{Mode: "write"})
		require.NoError(t, err, raw)
	}
	for _, raw := range []string{
		`{"id":1,"reminders":[{}]}`,
		`{"id":1,"reminders":[{"relative_to":"due_date"}]}`,
		`{"id":1,"reminders":[{"relative_to":"unknown","relative_period":0}]}`,
		`{"id":1,"reminders":[{"relative_to":"due_date","relative_period":999999999999}]}`,
	} {
		_, err := ValidateTool("update_task", json.RawMessage(raw), RunInput{Mode: "write"})
		require.Error(t, err, raw)
	}
	_, err := ValidateTool("bulk_update_tasks", json.RawMessage(`{"updates":[{"id":1,"changes":{"reminders":[{"relative_to":"due_date","relative_period":-60}]}}]}`), RunInput{Mode: "write"})
	require.NoError(t, err)
}
