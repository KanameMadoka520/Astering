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
	"os"
	"strings"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func installActivityFixture(t *testing.T, record *conversationFile) {
	t.Helper()
	conversations.Lock()
	previous := conversations.live[liveKey(1, record.ID)]
	conversations.live[liveKey(1, record.ID)] = &liveConversation{uid: 1, id: record.ID, record: record}
	conversations.Unlock()
	t.Cleanup(func() {
		conversations.Lock()
		defer conversations.Unlock()
		if previous == nil {
			delete(conversations.live, liveKey(1, record.ID))
		} else {
			conversations.live[liveKey(1, record.ID)] = previous
		}
	})
}

func TestTCYAIActivityPreservesStorageAndDetachedLatestTurn(t *testing.T) {
	chat, attachment, _ := chatAttachmentFixture(t)
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	missing := ChatAttachment{ID: strings.Repeat("a", 64), Name: "missing.png"}
	record.Turns = []ChatTurn{
		{ID: "old", Status: "completed", Attachments: []ChatAttachment{attachment, missing}, Result: RunResult{Reply: "old reply"}},
		{ID: "latest", Status: "running", Attachments: []ChatAttachment{attachment}, Result: RunResult{
			Reply: "current reply", Context: []Message{{Role: "system", Content: "private"}},
			Configuration: &AssistantOptions{WriteProjectIDs: []int64{3}},
			Operations:    []Operation{{ProjectIDs: []int64{3}}},
		}},
	}
	require.NoError(t, writeConversation(1, record))
	installActivityFixture(t, record)
	full, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	activity, err := GetConversationActivity(1, chat.ID)
	require.NoError(t, err)
	require.NotNil(t, activity.Turn)
	assert.Equal(t, full.Storage, activity.Storage)
	assert.Equal(t, 2, activity.Storage.AttachmentCount)
	assert.Equal(t, 1, activity.Storage.MissingCount)
	assert.Equal(t, full.Turns[1], *activity.Turn)
	assert.Nil(t, activity.Turn.Result.Context)
	assert.False(t, record.Turns[0].Attachments[1].Missing, "read-side missing markers must not mutate durable state")

	activity.Turn.Attachments[0].Name = "changed"
	activity.Turn.Result.Configuration.WriteProjectIDs[0] = 99
	activity.Turn.Result.Operations[0].ProjectIDs[0] = 99
	assert.Equal(t, attachment.Name, record.Turns[1].Attachments[0].Name)
	assert.Equal(t, int64(3), record.Turns[1].Result.Configuration.WriteProjectIDs[0])
	assert.Equal(t, int64(3), record.Turns[1].Result.Operations[0].ProjectIDs[0])

	path, err := attachmentPath(1, attachment.ID)
	require.NoError(t, err)
	require.NoError(t, os.Remove(path))
	activity, err = GetConversationActivity(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, activity.Turn.Attachments[0].Missing)
	assert.Equal(t, 2, activity.Storage.MissingCount)
	assert.Zero(t, activity.Storage.AttachmentBytes)
	_, err = GetConversationActivity(2, chat.ID)
	require.ErrorIs(t, err, ErrConversationMissing)
}

func TestTCYAIActivityDoesNotCloneHistoricExecution(t *testing.T) {
	chat, _, _ := chatAttachmentFixture(t)
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: "latest", Status: "running", Result: RunResult{Reply: "current"}}}
	installActivityFixture(t, record)
	measure := func() float64 {
		return testing.AllocsPerRun(5, func() {
			activity, activityErr := GetConversationActivity(1, chat.ID)
			if activityErr != nil || activity.Turn.ID != "latest" {
				panic("activity snapshot failed")
			}
		})
	}
	short := measure()
	last := record.Turns[0]
	record.Turns = nil
	for range 128 {
		record.Turns = append(record.Turns, ChatTurn{Status: "completed", Result: RunResult{
			Steps: make([]ModelStep, 8), Actions: make([]Action, 8), Operations: make([]Operation, 8),
		}})
	}
	record.Turns = append(record.Turns, last)
	long := measure()
	assert.LessOrEqual(t, long, short+10, "SSE snapshot allocations must not grow with historical execution arrays")
}
