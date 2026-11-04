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
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"strings"
	"time"
)

var ErrConversationReplyChanged = errors.New("conversation_reply_changed")

type ConversationReadReceipt struct {
	ID                 string `json:"id" required:"true" readOnly:"true" doc:"The current account's conversation UUID."`
	ReadThroughReplyID string `json:"read_through_reply_id" required:"true" readOnly:"true" doc:"Opaque exact final-result version acknowledged by this account; monotonically advances by turn order."`
	LatestReplyID      string `json:"latest_reply_id" required:"true" readOnly:"true" doc:"Opaque version of the latest terminal assistant result, or empty when none exists."`
	Unread             bool   `json:"unread" required:"true" readOnly:"true" doc:"A newer terminal assistant result has not been explicitly acknowledged as visible."`
}

type conversationReplyCache struct {
	id        string
	status    string
	finished  time.Time
	reply     string
	errorCode string
	errorText string
	receipt   string
}

func unreadTerminalReply(turn ChatTurn) bool {
	switch turn.Status {
	case "completed":
		return true
	case "failed", "stopped", "interrupted":
		return turn.Result.Reply != "" || turn.Result.ErrorCode != "" || turn.Result.Error != ""
	}
	return false
}

func conversationReplyID(record *conversationFile, index int) string {
	turn := &record.Turns[index]
	if !unreadTerminalReply(*turn) {
		return ""
	}
	finished := time.Time{}
	if turn.Finished != nil {
		finished = *turn.Finished
	}
	cache := record.replyReadCache
	if cache != nil && cache.id == turn.ID && cache.status == turn.Status && cache.finished.Equal(finished) &&
		cache.reply == turn.Result.Reply && cache.errorCode == turn.Result.ErrorCode && cache.errorText == turn.Result.Error {
		return cache.receipt
	}
	// The ID represents one completed execution result, not just a turn: retrying
	// the same turn must invalidate an acknowledgement sent before that retry.
	raw, err := json.Marshal(struct {
		Finished  time.Time `json:"finished"`
		Status    string    `json:"status"`
		Reply     string    `json:"reply"`
		ErrorCode string    `json:"error_code"`
		Error     string    `json:"error"`
	}{
		Finished:  finished,
		Status:    turn.Status,
		Reply:     turn.Result.Reply,
		ErrorCode: turn.Result.ErrorCode,
		Error:     turn.Result.Error,
	})
	if err != nil {
		// Corrupt timestamps cannot produce a valid acknowledgement receipt.
		return ""
	}
	hash := sha256.Sum256(raw)
	receipt := turn.ID + ":" + hex.EncodeToString(hash[:])
	record.replyReadCache = &conversationReplyCache{
		id:        turn.ID,
		status:    turn.Status,
		finished:  finished,
		reply:     turn.Result.Reply,
		errorCode: turn.Result.ErrorCode,
		errorText: turn.Result.Error,
		receipt:   receipt,
	}
	return receipt
}

func latestConversationReply(record *conversationFile) (string, int) {
	for i := len(record.Turns) - 1; i >= 0; i-- {
		if unreadTerminalReply(record.Turns[i]) {
			return conversationReplyID(record, i), i
		}
	}
	return "", -1
}

func readReplyTurnIndex(record *conversationFile, receipt string) int {
	id, _, ok := strings.Cut(receipt, ":")
	if !ok || id == "" {
		return -1
	}
	for i := len(record.Turns) - 1; i >= 0; i-- {
		if record.Turns[i].ID == id {
			return i
		}
	}
	return -1
}

// A missing pointer is the legacy schema. Only normalize its in-memory baseline:
// reading history/SSE never writes an acknowledgement. The next explicit writer
// persists this baseline before appending a new result.
func initializeConversationReadCursor(record *conversationFile) {
	if record.ReadThroughReplyID == nil {
		latest, _ := latestConversationReply(record)
		record.ReadThroughReplyID = &latest
	}
}

func conversationReadStatus(record *conversationFile) ConversationReadReceipt {
	latest, latestIndex := latestConversationReply(record)
	cursor := latest
	if record.ReadThroughReplyID != nil {
		cursor = *record.ReadThroughReplyID
	}
	cursorIndex := readReplyTurnIndex(record, cursor)
	return ConversationReadReceipt{
		ID:                 record.ID,
		ReadThroughReplyID: cursor,
		LatestReplyID:      latest,
		Unread: latest != "" && (latestIndex > cursorIndex ||
			(latestIndex == cursorIndex && latest != cursor)),
	}
}

// MarkConversationRead is an explicit visibility acknowledgement. It neither
// changes conversation activity timestamps nor interrupts a live model/compact job.
func MarkConversationRead(uid int64, id, throughReplyID string) (ConversationReadReceipt, error) {
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, id)
	if err != nil {
		return ConversationReadReceipt{}, err
	}
	index := readReplyTurnIndex(record, throughReplyID)
	if index < 0 || conversationReplyID(record, index) != throughReplyID {
		return ConversationReadReceipt{}, ErrConversationReplyChanged
	}
	initializeConversationReadCursor(record)
	previous := record.ReadThroughReplyID
	previousIndex := readReplyTurnIndex(record, *previous)
	if index < previousIndex || *previous == throughReplyID {
		return conversationReadStatus(record), nil
	}
	record.ReadThroughReplyID = &throughReplyID
	if err = writeConversation(uid, record); err != nil {
		record.ReadThroughReplyID = previous
		return ConversationReadReceipt{}, err
	}
	return conversationReadStatus(record), nil
}
