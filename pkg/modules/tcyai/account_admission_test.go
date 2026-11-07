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
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYAIAccountAdmissionRejectsLateStartReviewAndCompaction(t *testing.T) {
	i18n.Init()
	const uid int64 = 91230
	accountCleanupFixture(t, uid)
	chat := concurrentConversation(t, uid)
	ctx := WithAccountRunAdmission(tcylocale.WithLanguage(context.Background(), "zh-CN"), uid)
	// This is the exact ordering where a request already passed its DB proof
	// check, but cancellation commits before it can register a live worker.
	CancelAccountRuns(uid)
	connection := accountSettings().Connections[0]
	_, err := StartConversation(ctx, uid, chat.ID, RunInput{Message: "must not start", RequestID: uuid.NewString()}, connection, nil)
	require.ErrorIs(t, err, ErrAccountAccessRevoked)
	_, err = ReviewConversation(ctx, uid, chat.ID, ReviewInput{Decision: "retry"}, connection, nil, nil)
	require.ErrorIs(t, err, ErrAccountAccessRevoked)
	_, err = CompactConversation(ctx, uid, chat.ID, connection)
	require.ErrorIs(t, err, ErrAccountAccessRevoked)
	returned, finish, err := RegisterAccountRun(ctx, uid)
	require.ErrorIs(t, err, ErrAccountAccessRevoked)
	assert.Nil(t, finish)
	require.NotNil(t, returned, "error rendering must retain a usable request context")
	localized := tcylocale.Render(returned, tcylocale.Error("accountRunRevoked"))
	assert.Equal(t, localized, ExplainError(returned, err))
	assert.NotEqual(t, ExplainError(tcylocale.WithLanguage(context.Background(), "en"), err), localized)
	stored, err := GetConversation(uid, chat.ID)
	require.NoError(t, err)
	assert.Len(t, stored.Turns, 1)
	assert.False(t, stored.Compacting)
	assert.False(t, ConversationJobRunning(uid, chat.ID))
	// A new browser authentication obtains a new admission fence. The previous
	// request must remain invalid even after every earlier worker has ended.
	fresh := WithAccountRunAdmission(context.Background(), uid)
	jobCtx, finish, err := RegisterAccountRun(fresh, uid)
	require.NoError(t, err)
	finish()
	require.ErrorIs(t, jobCtx.Err(), context.Canceled)
	_, _, err = RegisterAccountRun(ctx, uid)
	assert.ErrorIs(t, err, ErrAccountAccessRevoked)
}

func TestTCYAIAccountEphemeralRevocationAndCleanup(t *testing.T) {
	for index, action := range []string{"revoke", "delete-cleanup", "external-disable", "external-delete"} {
		t.Run(action, func(t *testing.T) {
			uid := int64(91240 + index)
			engine := accountCleanupFixture(t, uid)
			admitted := WithAccountRunAdmission(context.Background(), uid)
			jobCtx, finish, err := RegisterAccountRun(admitted, uid)
			require.NoError(t, err)
			t.Cleanup(finish)
			switch action {
			case "revoke":
				CancelAccountRuns(uid)
			case "external-disable":
				_, err = engine.ID(uid).Cols("status").Update(&user.User{Status: user.StatusDisabled})
				require.NoError(t, err)
			default:
				_, err = engine.ID(uid).Delete(&user.User{})
				require.NoError(t, err)
				if action == "delete-cleanup" {
					require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
				}
			}
			awaitAccountSignal(t, jobCtx.Done())
			finish()
			conversations.Lock()
			remaining := len(accountEphemeralRuns[accountKey(uid)])
			conversations.Unlock()
			assert.Zero(t, remaining, "%s must not retain cancellation slots after completion", action)
			assert.Equal(t, action == "delete-cleanup" || action == "external-delete", accountDeleted(uid))
		})
	}
}
