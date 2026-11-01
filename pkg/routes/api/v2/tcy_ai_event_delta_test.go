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
	"encoding/json"
	"fmt"
	"os"
	"os/exec"
	"runtime"
	"strconv"
	"strings"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestConversationDeltaNegotiation(t *testing.T) {
	for _, accept := range []string{
		"text/event-stream; vikunja-events=delta-v1",
		`application/json, text/event-stream; vikunja-events="delta-v1"`,
	} {
		assert.True(t, acceptsConversationDeltas(accept), accept)
	}
	for _, accept := range []string{
		"",
		"application/json",
		"text/event-stream",
		"text/event-stream; vikunja-events=delta-v2",
		"application/json; vikunja-events=delta-v1",
		"text/event-stream; broken",
	} {
		assert.False(t, acceptsConversationDeltas(accept), accept)
	}
}

func TestConversationEventLegacyAndSnapshot(t *testing.T) {
	state := map[string]any{
		"compacting":  false,
		"compactions": []any{},
	}
	legacy := conversationEventEncoder{}
	event, err := legacy.encode(state)
	require.NoError(t, err)
	require.Equal(t, "activity", event.name)
	assert.JSONEq(t, `{"compacting":false,"compactions":[]}`, string(event.data))
	event, err = legacy.encode(state)
	require.NoError(t, err)
	assert.Nil(t, event)

	encoder := conversationEventEncoder{delta: true}
	event, err = encoder.encode(state)
	require.NoError(t, err)
	require.Equal(t, "snapshot", event.name)
	assert.JSONEq(t, `{"revision":1,"snapshot":{"compacting":false,"compactions":[]}}`, string(event.data))
	event, err = encoder.encode(state)
	require.NoError(t, err)
	assert.Nil(t, event)
	assert.EqualValues(t, 1, encoder.revision)

	// A new connection always supplies an independent baseline, even for a completed conversation.
	reconnected := conversationEventEncoder{delta: true}
	event, err = reconnected.encode(state)
	require.NoError(t, err)
	assert.JSONEq(t, `{"revision":1,"snapshot":{"compacting":false,"compactions":[]}}`, string(event.data))
}

func TestConversationDeltaPreservesTranscriptAndState(t *testing.T) {
	stableResult := strings.Repeat("stable tool result ", 100)
	state := map[string]any{
		"compacting":  false,
		"compactions": []any{},
		"turn": map[string]any{
			"id":     "turn-1",
			"status": "running",
			"result": map[string]any{
				"steps": []any{
					map[string]any{"round": 1, "text": "Earlier intermediate reply"},
					map[string]any{"round": 2, "text": "\u4f60\u597d", "reasoning": "Checking"},
				},
				"actions": []any{map[string]any{"tool": "get_task", "result": stableResult}},
				"pause":   "review",
			},
		},
	}
	encoder := conversationEventEncoder{delta: true}
	_, err := encoder.encode(state)
	require.NoError(t, err)
	result := state["turn"].(map[string]any)["result"].(map[string]any)
	step := result["steps"].([]any)[1].(map[string]any)
	require.Len(t, step["text"].(string), 6, "The fixture is two real UTF-8 characters, not escaped JSON text")
	step["text"] = "\u4f60\u597d\uff0c\u4e16\u754c🌏"
	require.Len(t, step["text"].(string), 19)
	step["reasoning"] = "Checking tools"
	result["actions"] = append(result["actions"].([]any), map[string]any{"tool": "update_task", "result": "Saved"})
	delete(result, "pause")
	state["turn"].(map[string]any)["status"] = "completed"
	state["compacting"] = true
	state["compact_text"] = "Preparing summary"
	state["compact_progress"] = map[string]any{"stage": "model"}
	event, err := encoder.encode(state)
	require.NoError(t, err)
	require.Equal(t, "delta", event.name)
	assert.NotContains(t, string(event.data), stableResult)
	assert.NotContains(t, string(event.data), "Earlier intermediate reply")
	var frame conversationEventFrame
	require.NoError(t, json.Unmarshal(event.data, &frame))
	assert.EqualValues(t, 1, frame.Base)
	assert.EqualValues(t, 2, frame.Revision)
	assert.Contains(t, frame.Patch, conversationPatch{
		Op:    "append",
		Path:  []string{"turn", "result", "steps", "1", "text"},
		Value: "\uff0c\u4e16\u754c🌏",
	})
	assert.Contains(t, frame.Patch, conversationPatch{
		Op:   "remove",
		Path: []string{"turn", "result", "pause"},
	})
	assert.Contains(t, frame.Patch, conversationPatch{
		Op:    "set",
		Path:  []string{"turn", "status"},
		Value: "completed",
	})
	assert.Contains(t, frame.Patch, conversationPatch{
		Op:    "set",
		Path:  []string{"compacting"},
		Value: true,
	})
	assert.Contains(t, frame.Patch, conversationPatch{
		Op:    "set",
		Path:  []string{"turn", "result", "actions", "1"},
		Value: map[string]any{"tool": "update_task", "result": "Saved"},
	})
}

func TestConversationDeltaReplacementAndSnapshotBoundary(t *testing.T) {
	patch := diffConversationValue(map[string]any{
		"text": "old text",
		"list": []any{1, 2, 3},
	}, map[string]any{
		"text": "new text",
		"list": []any{1},
	}, []string{}, nil)
	assert.Contains(t, patch, conversationPatch{
		Op:    "set",
		Path:  []string{"text"},
		Value: "new text",
	})
	assert.Contains(t, patch, conversationPatch{
		Op:    "set",
		Path:  []string{"list"},
		Value: []any{1},
	})
	encoder := conversationEventEncoder{delta: true}
	_, err := encoder.encode(map[string]any{"x": "a"})
	require.NoError(t, err)
	event, err := encoder.encode(map[string]any{"x": "b"})
	require.NoError(t, err)
	assert.Equal(t, "snapshot", event.name, "A patch must not cost more bytes than the complete snapshot")
	assert.JSONEq(t, `{"revision":2,"snapshot":{"x":"b"}}`, string(event.data))
}

func TestConversationDeltaSyntheticBytes(t *testing.T) {
	steps := make([]any, 40)
	for index := range steps {
		steps[index] = map[string]any{"round": index + 1, "text": fmt.Sprintf("Round %d completed", index+1)}
	}
	actions := make([]any, 200)
	for index := range actions {
		actions[index] = map[string]any{
			"round":     index/5 + 1,
			"tool":      "get_task",
			"arguments": fmt.Sprintf(`{"id":%d}`, index+1),
			"result":    strings.Repeat("r", 2048),
		}
	}
	state := map[string]any{
		"compacting":  false,
		"compactions": []any{},
		"turn": map[string]any{
			"id":     "synthetic",
			"status": "running",
			"result": map[string]any{"steps": steps, "actions": actions},
		},
	}
	text := strings.Repeat("t", 80*1024)
	clockTicks := 0.0
	if ticks, err := exec.CommandContext(t.Context(), "getconf", "CLK_TCK").Output(); err == nil {
		clockTicks, _ = strconv.ParseFloat(strings.TrimSpace(string(ticks)), 64)
	}
	readCPU := func() time.Duration {
		stat, err := os.ReadFile("/proc/self/stat")
		if err != nil || clockTicks <= 0 {
			return 0
		}
		fields := strings.Fields(string(stat)[strings.LastIndex(string(stat), ")")+1:])
		if len(fields) < 13 {
			return 0
		}
		userTicks, _ := strconv.ParseFloat(fields[11], 64)
		systemTicks, _ := strconv.ParseFloat(fields[12], 64)
		return time.Duration((userTicks + systemTicks) / clockTicks * float64(time.Second))
	}
	type measurement struct {
		bytes        int
		wall         time.Duration
		cpu          time.Duration
		retainedHeap float64
	}
	measure := func(delta bool) measurement {
		encoder := conversationEventEncoder{delta: delta}
		bytes := 0
		runtime.GC()
		runtime.GC()
		var before runtime.MemStats
		runtime.ReadMemStats(&before)
		cpuStarted := readCPU()
		started := time.Now()
		for frame := 0; frame < 250; frame++ {
			steps[39].(map[string]any)["text"] = text[:len(text)*(frame+1)/250]
			event, err := encoder.encode(state)
			require.NoError(t, err)
			require.NotNil(t, event)
			bytes += len(event.data) + len(event.name) + len("event: \ndata: \n\n")
		}
		wall := time.Since(started)
		cpu := readCPU() - cpuStarted
		runtime.GC()
		runtime.GC()
		var after runtime.MemStats
		runtime.ReadMemStats(&after)
		runtime.KeepAlive(encoder)
		runtime.KeepAlive(state)
		return measurement{
			bytes:        bytes,
			wall:         wall,
			cpu:          cpu,
			retainedHeap: float64(after.HeapAlloc) - float64(before.HeapAlloc),
		}
	}
	legacy := measure(false)
	delta := measure(true)
	assert.Less(t, delta.bytes, legacy.bytes/50)
	t.Logf("synthetic 40 steps / 200 receipts x 2KiB / 80KiB text / 250 frames: "+
		"legacy=%d bytes, wall=%s, processCPU=%s, retainedHeap=%.0f B; "+
		"delta=%d bytes, wall=%s, processCPU=%s, retainedHeap=%.0f B; reduction=%.2f%%; "+
		"CPU from Linux procfs clock ticks, heap after GC, not production latency",
		legacy.bytes, legacy.wall, legacy.cpu, legacy.retainedHeap,
		delta.bytes, delta.wall, delta.cpu, delta.retainedHeap,
		(1-float64(delta.bytes)/float64(legacy.bytes))*100)
}
