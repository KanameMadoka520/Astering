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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package tcyai

import (
	"context"
	"encoding/json"
	"slices"
	"strings"
	"testing"

	"github.com/google/jsonschema-go/jsonschema"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func bucketToolNamesIn(tools []map[string]any) []string {
	names := []string{}
	for _, t := range tools {
		if IsBucketTool(toolName(t)) {
			names = append(names, toolName(t))
		}
	}
	return names
}

func TestTCYAIBucketToolContracts(t *testing.T) {
	readToolNames := []string{
		"list_project_views",
		"list_buckets",
		"get_task_repeat_bucket",
	}
	assert.Equal(t, readToolNames, bucketToolNamesIn(bucketTools("read")))
	assert.Equal(t, bucketToolNames, bucketToolNamesIn(bucketTools("write")))
	assert.False(t, IsBucketTool("update_task"))
	assert.True(t, bucketAlwaysReviewed("delete_bucket"))
	assert.False(t, bucketAlwaysReviewed("move_task_to_bucket"))

	schemas := map[string]*jsonschema.Resolved{}
	for _, definition := range bucketTools("write") {
		name := toolName(definition)
		function := definition["function"].(map[string]any)
		assert.Equal(t, slices.Contains(readToolNames, name), !IsWriteTool(name), name)
		// Discovery searches descriptions; a schema keyword there would make parameter-only queries match.
		assert.NotContains(t, function["description"], "additionalProperties", name)
		raw, err := json.Marshal(function["parameters"])
		require.NoError(t, err)
		var schema jsonschema.Schema
		require.NoError(t, json.Unmarshal(raw, &schema), name)
		resolved, err := schema.Resolve(nil)
		require.NoError(t, err, name)
		schemas[name] = resolved
	}
	validate := func(name, arguments string) error {
		var instance map[string]any
		require.NoError(t, json.Unmarshal([]byte(arguments), &instance))
		return schemas[name].Validate(instance)
	}
	for name, arguments := range map[string]string{
		"list_project_views":     `{"project_id":-2}`,
		"list_buckets":           `{"project_id":1,"view_id":4,"bucket_id":0,"page":2}`,
		"get_task_repeat_bucket": `{"project_id":1,"view_id":4,"task_id":1}`,
		"set_task_repeat_bucket": `{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"bucket","repeat_return_bucket_id":3}`,
		"create_bucket":          `{"project_id":1,"view_id":4,"title":"Review","limit":0,"after_bucket_id":0}`,
		"update_bucket":          `{"project_id":1,"view_id":4,"bucket_id":3,"after_bucket_id":1}`,
		"move_task_to_bucket":    `{"project_id":-2,"view_id":9,"bucket_id":3,"task_id":1}`,
		"set_view_buckets":       `{"project_id":1,"view_id":4,"done_bucket_id":0}`,
		"delete_bucket":          `{"project_id":1,"view_id":4,"bucket_id":2}`,
	} {
		require.NoError(t, validate(name, arguments), name)
	}
	for name, arguments := range map[string]string{
		"list_buckets":           `{"project_id":1}`,
		"get_task_repeat_bucket": `{"project_id":1,"view_id":4}`,
		"set_task_repeat_bucket": `{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"invalid","repeat_return_bucket_id":0}`,
		"create_bucket":          `{"project_id":1,"view_id":4}`,
		"update_bucket":          `{"project_id":1,"view_id":4,"bucket_id":3,"position":7}`,
		"move_task_to_bucket":    `{"project_id":1,"view_id":4,"bucket_id":3}`,
		"set_view_buckets":       `{"project_id":1,"view_id":4,"done_bucket_id":-1}`,
		"delete_bucket":          `{"project_id":"1","view_id":4,"bucket_id":2}`,
	} {
		require.Error(t, validate(name, arguments), name)
	}
	for _, arguments := range []string{
		`{"project_id":-2,"view_id":4,"task_id":1,"repeat_return_mode":"default","repeat_return_bucket_id":0}`,
		`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"keep","repeat_return_bucket_id":0}`,
	} {
		require.NoError(t, validate("set_task_repeat_bucket", arguments), arguments)
	}
	for _, arguments := range []string{
		`{"project_id":1,"view_id":0,"task_id":1}`,
		`{"project_id":1,"view_id":4,"task_id":-1}`,
		`{"project_id":1,"view_id":4,"task_id":"1"}`,
		`{"project_id":1,"view_id":4,"task_id":1,"unexpected":true}`,
	} {
		require.Error(t, validate("get_task_repeat_bucket", arguments), arguments)
	}
	for _, arguments := range []string{
		`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_bucket_id":0}`,
		`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"keep"}`,
		`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"bucket","repeat_return_bucket_id":-1}`,
		`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"keep","repeat_return_bucket_id":0,"unexpected":true}`,
	} {
		require.Error(t, validate("set_task_repeat_bucket", arguments), arguments)
	}
	require.Error(t, validate("create_bucket", `{"project_id":1,"view_id":4,"title":"`+strings.Repeat("x", 251)+`"}`))
	require.Error(t, validate("update_bucket", `{"project_id":1,"view_id":4,"bucket_id":3,"limit":-1}`))
}

// The remaining assertions cover the root wiring of bucketTools, bucketAlwaysReviewed and the
// find_tools description (see worklogs/v32-bucket-handoff.md); they fail until it is in place.
func TestTCYAIBucketToolWiring(t *testing.T) {
	for _, mode := range []string{"read", "write"} {
		assert.Equal(t, bucketToolNamesIn(bucketTools(mode)), bucketToolNamesIn(AllTools(mode, false)), mode)
	}
	// Task deletion permission does not gate bucket deletion; review does.
	assert.Contains(t, bucketToolNamesIn(AllTools("write", false)), "delete_bucket")
	assert.Empty(t, bucketToolNamesIn(Tools("write", true)))
	assert.Empty(t, bucketToolNamesIn(stableEntryTools(RunInput{})))

	for _, approval := range []string{"auto", "smart", "review"} {
		assert.True(t, NeedsReview("delete_bucket", RunInput{Mode: "write", Approval: approval}), approval)
	}
	assert.False(t, NeedsReview("list_buckets", RunInput{Mode: "write", Approval: "review"}))
	assert.False(t, NeedsReview("get_task_repeat_bucket", RunInput{Mode: "read", Approval: "review"}))
	assert.True(t, NeedsReview("set_task_repeat_bucket", RunInput{Mode: "write", Approval: "review"}))
	assert.False(t, NeedsReview("move_task_to_bucket", RunInput{Mode: "write", Approval: "smart"}))
	assert.True(t, NeedsReview("move_task_to_bucket", RunInput{Mode: "write", Approval: "review"}))

	_, err := ValidateTool("create_bucket", json.RawMessage(`{"project_id":1,"view_id":4,"title":"Review"}`), RunInput{Mode: "read"})
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	_, err = ValidateTool("list_buckets", json.RawMessage(`{"project_id":1,"view_id":4}`), RunInput{Mode: "read"})
	require.NoError(t, err)
	repeatArgs := json.RawMessage(`{"project_id":1,"view_id":4,"task_id":1,"repeat_return_mode":"keep","repeat_return_bucket_id":0}`)
	_, err = ValidateTool("get_task_repeat_bucket", json.RawMessage(`{"project_id":1,"view_id":4,"task_id":1}`), RunInput{Mode: "read"})
	require.NoError(t, err)
	_, err = ValidateTool("set_task_repeat_bucket", repeatArgs, RunInput{Mode: "read"})
	require.ErrorContains(t, err, "TOOL_NOT_ALLOWED")
	_, err = ValidateTool("set_task_repeat_bucket", repeatArgs, RunInput{Mode: "write"})
	require.NoError(t, err)
	_, err = ValidateTool("delete_bucket", json.RawMessage(`{"project_id":1,"view_id":4,"bucket_id":2}`), RunInput{Mode: "write"})
	require.NoError(t, err)
	_, err = ValidateTool("create_bucket", json.RawMessage(`{"project_id":1,"view_id":4,"title":"  "}`), RunInput{Mode: "write"})
	require.ErrorContains(t, err, "INVALID_ARGUMENTS")

	read := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "read"})
	write := NewAgentState(context.Background(), Connection{}, RunInput{Mode: "write"})
	before, err := json.Marshal(write.tools())
	require.NoError(t, err)
	for _, name := range []string{
		"create_bucket",
		"update_bucket",
		"move_task_to_bucket",
		"set_task_repeat_bucket",
		"set_view_buckets",
		"delete_bucket",
	} {
		result, err := read.discover(json.RawMessage(`{"query":"` + name + `"}`))
		require.NoError(t, err)
		assert.NotContains(t, result, `"name":"`+name+`"`, "read mode must not discover "+name)
	}
	for query, name := range map[string]string{
		"list_project_views":     "list_project_views",
		"get_task_repeat_bucket": "get_task_repeat_bucket",
		"set_task_repeat_bucket": "set_task_repeat_bucket",
		"看板栏目":                   "list_buckets",
		"移动到栏目":                  "move_task_to_bucket",
		"move task to bucket":    "move_task_to_bucket",
		"设置完成列":                  "set_view_buckets",
		"done bucket":            "set_view_buckets",
		"删除栏目":                   "delete_bucket",
		"新建栏目":                   "create_bucket",
	} {
		result, err := write.discover(json.RawMessage(`{"query":"` + query + `"}`))
		require.NoError(t, err)
		assert.Contains(t, result, `"name":"`+name+`"`, query)
	}
	result, err := read.discover(json.RawMessage(`{"query":"list_buckets"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"name":"list_buckets"`)
	result, err = read.discover(json.RawMessage(`{"query":"get_task_repeat_bucket"}`))
	require.NoError(t, err)
	assert.Contains(t, result, `"name":"get_task_repeat_bucket"`)
	// Discovery returns definitions as a tool result; the provider-facing tool prefix stays byte-identical.
	after, err := json.Marshal(write.tools())
	require.NoError(t, err)
	assert.Equal(t, string(before), string(after))
	assert.NotContains(t, string(after), "list_buckets")
}
