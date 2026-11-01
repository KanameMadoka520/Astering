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
	"bytes"
	"encoding/json"
	"mime"
	"sort"
	"strconv"
	"strings"
)

const conversationDeltaProtocol = "delta-v1"

type conversationPatch struct {
	Op    string   `json:"op"`
	Path  []string `json:"path"`
	Value any      `json:"value"`
}

type conversationEventFrame struct {
	Base     uint64              `json:"base,omitempty"`
	Revision uint64              `json:"revision"`
	Snapshot json.RawMessage     `json:"snapshot,omitempty"`
	Patch    []conversationPatch `json:"patch,omitempty"`
}

type conversationEvent struct {
	name string
	data []byte
}

type conversationEventEncoder struct {
	delta    bool
	previous []byte
	state    any
	revision uint64
}

func acceptsConversationDeltas(accept string) bool {
	for _, part := range strings.Split(accept, ",") {
		mediaType, params, err := mime.ParseMediaType(strings.TrimSpace(part))
		if err == nil && mediaType == "text/event-stream" && params["vikunja-events"] == conversationDeltaProtocol {
			return true
		}
	}
	return false
}

// Each connection owns its baseline: reconnects never rely on an event the browser may have missed.
func (encoder *conversationEventEncoder) encode(state any) (*conversationEvent, error) {
	data, err := json.Marshal(state)
	if err != nil {
		return nil, err
	}
	if bytes.Equal(data, encoder.previous) {
		return nil, nil
	}
	if !encoder.delta {
		encoder.previous = data
		return &conversationEvent{name: "activity", data: data}, nil
	}

	var next any
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.UseNumber()
	if err = decoder.Decode(&next); err != nil {
		return nil, err
	}
	frame := conversationEventFrame{Revision: encoder.revision + 1, Snapshot: data}
	var event *conversationEvent
	snapshotSize := len(data) + len(strconv.FormatUint(frame.Revision, 10)) + len(`{"revision":,"snapshot":}`)
	if encoder.revision > 0 {
		patch := diffConversationValue(encoder.state, next, []string{}, nil)
		if len(patch) > 0 {
			candidate, encodeErr := json.Marshal(conversationEventFrame{
				Base:     encoder.revision,
				Revision: frame.Revision,
				Patch:    patch,
			})
			if encodeErr != nil {
				return nil, encodeErr
			}
			if len(candidate) < snapshotSize {
				event = &conversationEvent{name: "delta", data: candidate}
			}
		}
	}
	if event == nil {
		snapshot, encodeErr := json.Marshal(frame)
		if encodeErr != nil {
			return nil, encodeErr
		}
		event = &conversationEvent{name: "snapshot", data: snapshot}
	}
	encoder.previous = data
	encoder.state = next
	encoder.revision = frame.Revision
	return event, nil
}

func conversationPatchPath(path []string, key string) []string {
	next := make([]string, len(path)+1)
	copy(next, path)
	next[len(path)] = key
	return next
}

// Strings carry only their new suffix; stable tool outputs and earlier model rounds stay off the wire.
func diffConversationValue(previous, next any, path []string, patch []conversationPatch) []conversationPatch {
	set := func() []conversationPatch {
		return append(patch, conversationPatch{Op: "set", Path: path, Value: next})
	}
	switch value := next.(type) {
	case map[string]any:
		before, ok := previous.(map[string]any)
		if !ok {
			return set()
		}
		keys := make([]string, 0, len(before)+len(value))
		for key := range before {
			if _, exists := value[key]; !exists {
				keys = append(keys, key)
			}
		}
		sort.Strings(keys)
		for _, key := range keys {
			patch = append(patch, conversationPatch{Op: "remove", Path: conversationPatchPath(path, key)})
		}
		keys = keys[:0]
		for key := range value {
			keys = append(keys, key)
		}
		sort.Strings(keys)
		for _, key := range keys {
			child := conversationPatchPath(path, key)
			if old, exists := before[key]; exists {
				patch = diffConversationValue(old, value[key], child, patch)
			} else {
				patch = append(patch, conversationPatch{Op: "set", Path: child, Value: value[key]})
			}
		}
	case []any:
		before, ok := previous.([]any)
		if !ok || len(value) < len(before) {
			return set()
		}
		for index, item := range value {
			child := conversationPatchPath(path, strconv.Itoa(index))
			if index < len(before) {
				patch = diffConversationValue(before[index], item, child, patch)
			} else {
				patch = append(patch, conversationPatch{Op: "set", Path: child, Value: item})
			}
		}
	case string:
		before, ok := previous.(string)
		if ok && before == value {
			return patch
		}
		if ok && strings.HasPrefix(value, before) {
			return append(patch, conversationPatch{Op: "append", Path: path, Value: value[len(before):]})
		}
		return set()
	default:
		if previous != next {
			return set()
		}
	}
	return patch
}
