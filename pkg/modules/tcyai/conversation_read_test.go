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
	"errors"
	"os"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func appendReadTestReply(t *testing.T, chatID, text, status string) *conversationFile {
	t.Helper()
	record, err := readConversation(1, chatID)
	require.NoError(t, err)
	now := time.Now().UTC()
	record.Turns = append(record.Turns, ChatTurn{
		ID:       uuid.NewString(),
		Status:   status,
		Started:  now.Add(-time.Second),
		Finished: &now,
		Result: RunResult{
			Reply: text,
		},
	})
	record.Contexts = append(record.Contexts, []storedMessage{})
	require.NoError(t, writeConversation(1, record))
	return record
}

func TestTCYAIConversationUnreadRequiresExplicitAcknowledgement(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "unread results")
	require.NoError(t, err)
	assert.False(t, chat.Unread)
	assert.Empty(t, chat.LatestReplyID)
	record := appendReadTestReply(t, chat.ID, "a new final reply", "completed")
	path, err := conversationPath(1, chat.ID)
	require.NoError(t, err)
	before, err := os.ReadFile(path)
	require.NoError(t, err)
	visible, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, visible.Unread)
	assert.NotEmpty(t, visible.LatestReplyID)
	activity, err := GetConversationActivity(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, activity.Unread)
	assert.Equal(t, visible.LatestReplyID, activity.LatestReplyID)
	history, err := ListConversations(1)
	require.NoError(t, err)
	require.Len(t, history, 1)
	assert.True(t, history[0].Unread)
	assert.Equal(t, visible.LatestReplyID, history[0].LatestReplyID)
	after, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, before, after, "GET, history and SSE snapshots must never persist read state")
	_, err = MarkConversationRead(2, chat.ID, visible.LatestReplyID)
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = MarkConversationRead(1, chat.ID, record.Turns[0].ID)
	require.ErrorIs(t, err, ErrConversationReplyChanged, "a turn ID is not an exact result acknowledgement")
	ack, err := MarkConversationRead(1, chat.ID, visible.LatestReplyID)
	require.NoError(t, err)
	assert.False(t, ack.Unread)
	assert.Equal(t, visible.LatestReplyID, ack.ReadThroughReplyID)
	saved, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.False(t, saved.Unread)
	assert.Equal(t, record.Updated, saved.Updated, "viewing results must not reorder conversation history")
}

func TestTCYAIConversationUnreadCursorIsMonotonicAndRetrySpecific(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "retry versions")
	require.NoError(t, err)
	appendReadTestReply(t, chat.ID, "first result", "completed")
	first, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	_, err = MarkConversationRead(1, chat.ID, first.LatestReplyID)
	require.NoError(t, err)
	appendReadTestReply(t, chat.ID, "second result", "completed")
	second, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	ack, err := MarkConversationRead(1, chat.ID, first.LatestReplyID)
	require.NoError(t, err)
	assert.True(t, ack.Unread, "a late ack for the previous result cannot consume a new result")
	_, err = MarkConversationRead(1, chat.ID, second.LatestReplyID)
	require.NoError(t, err)
	ack, err = MarkConversationRead(1, chat.ID, first.LatestReplyID)
	require.NoError(t, err)
	assert.Equal(t, second.LatestReplyID, ack.ReadThroughReplyID, "older tabs cannot move the cursor backwards")
	assert.False(t, ack.Unread)
	// The same turn retries and returns the same text. Its new finish timestamp
	// still identifies a distinct completion, which needs another visible ack.
	record, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	finished := record.Turns[1].Finished.Add(time.Second)
	record.Turns[1].Finished = &finished
	require.NoError(t, writeConversation(1, record))
	retried, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, retried.Unread)
	assert.NotEqual(t, second.LatestReplyID, retried.LatestReplyID)
	_, err = MarkConversationRead(1, chat.ID, second.LatestReplyID)
	require.ErrorIs(t, err, ErrConversationReplyChanged)
	ack, err = MarkConversationRead(1, chat.ID, retried.LatestReplyID)
	require.NoError(t, err)
	assert.False(t, ack.Unread)
}

func TestTCYAIConversationUnreadSurvivesRunningAndCompaction(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "busy with unread")
	require.NoError(t, err)
	record := appendReadTestReply(t, chat.ID, "prior final answer", "completed")
	before := conversationReadStatus(record)
	record.Turns = append(record.Turns, ChatTurn{
		ID:     uuid.NewString(),
		Status: "running",
	})
	record.Contexts = append(record.Contexts, []storedMessage{})
	record.States = []*AgentState{{}, {}}
	record.Compacting = true
	require.NoError(t, writeConversation(1, record))
	cancelled := false
	live := &liveConversation{
		uid:        1,
		id:         chat.ID,
		record:     record,
		compacting: true,
		cancel:     func() { cancelled = true },
	}
	conversations.Lock()
	conversations.live[liveKey(1, chat.ID)] = live
	conversations.Unlock()
	history, err := ListConversations(1)
	require.NoError(t, err)
	require.Len(t, history, 1)
	assert.True(t, history[0].Unread)
	assert.True(t, history[0].Running, "unread and working are independent states")
	ack, err := MarkConversationRead(1, chat.ID, before.LatestReplyID)
	require.NoError(t, err)
	assert.False(t, ack.Unread)
	assert.False(t, cancelled)
	assert.True(t, live.compacting)
	assert.True(t, live.record.Compacting)
	assert.Equal(t, "running", live.record.Turns[1].Status)
	assert.Len(t, live.record.States, 2)
	assert.Same(t, live, conversations.live[liveKey(1, chat.ID)])
	// Saving a later worker result must retain the ack saved on that same record.
	require.NoError(t, writeConversation(1, live.record))
	saved, err := readConversation(1, chat.ID)
	require.NoError(t, err)
	require.NotNil(t, saved.ReadThroughReplyID)
	assert.Equal(t, before.LatestReplyID, *saved.ReadThroughReplyID)
}

func TestTCYAIConversationUnreadLegacyMigrationAndForkBaseline(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "historical record")
	require.NoError(t, err)
	record := appendReadTestReply(t, chat.ID, "before unread support existed", "completed")
	record.ReadThroughReplyID = nil
	require.NoError(t, writeConversation(1, record))
	path, err := conversationPath(1, chat.ID)
	require.NoError(t, err)
	before, err := os.ReadFile(path)
	require.NoError(t, err)
	old, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.False(t, old.Unread, "the release must not label all historical replies as new")
	after, err := os.ReadFile(path)
	require.NoError(t, err)
	assert.Equal(t, before, after, "legacy GET must not rewrite encrypted records")
	record = appendReadTestReply(t, chat.ID, "new result after migration", "completed")
	current, err := GetConversation(1, chat.ID)
	require.NoError(t, err)
	assert.True(t, current.Unread)
	branch, err := ForkConversation(1, chat.ID, record.Turns[1].ID)
	require.NoError(t, err)
	assert.False(t, branch.Unread, "forking copies already-present results rather than generating new ones")
	appendReadTestReply(t, branch.ID, "a new branch result", "completed")
	branch, err = GetConversation(1, branch.ID)
	require.NoError(t, err)
	assert.True(t, branch.Unread)
}

func TestTCYAIConversationUnreadFailureAndWriteRollback(t *testing.T) {
	personalStorageFixture(t)
	chat, err := CreateConversation(1, "failure needs attention")
	require.NoError(t, err)
	record := appendReadTestReply(t, chat.ID, "", "failed")
	record.Turns[0].Result.ErrorCode = "UPSTREAM_STREAM_CLOSED"
	require.NoError(t, writeConversation(1, record))
	result := conversationReadStatus(record)
	assert.True(t, result.Unread)
	conversations.Lock()
	conversations.live[liveKey(1, chat.ID)] = &liveConversation{
		uid:    1,
		id:     chat.ID,
		record: record,
	}
	conversations.Unlock()
	previous := *record.ReadThroughReplyID
	originalWrite := accountWrite
	accountWrite = func(int64, func() error) error { return errors.New("isolated write failure") }
	t.Cleanup(func() { accountWrite = originalWrite })
	_, err = MarkConversationRead(1, chat.ID, result.LatestReplyID)
	require.Error(t, err)
	assert.Equal(t, previous, *record.ReadThroughReplyID, "a failed ack cannot erase an unread state in the live record")
	assert.True(t, conversationReadStatus(record).Unread)
	accountWrite = originalWrite
}
