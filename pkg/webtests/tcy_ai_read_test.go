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

package webtests

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// The fixture writes the documented encrypted record format under t.TempDir,
// without invoking an upstream model or adding a production mutation API.
func saveReadAPIConversation(t *testing.T, uid int64, chat tcyai.Conversation, cursor string) {
	t.Helper()
	key := sha256.Sum256([]byte("tcymc-ai-settings-v1:" + config.ServiceSecret.GetString()))
	block, err := aes.NewCipher(key[:])
	require.NoError(t, err)
	aead, err := cipher.NewGCM(block)
	require.NoError(t, err)
	plain, err := json.Marshal(struct {
		tcyai.Conversation
		ReadThroughReplyID string  `json:"read_through_reply_id"`
		Contexts           [][]any `json:"contexts"`
	}{
		Conversation:       chat,
		ReadThroughReplyID: cursor,
		Contexts:           [][]any{{}},
	})
	require.NoError(t, err)
	nonce := make([]byte, aead.NonceSize())
	_, err = rand.Read(nonce)
	require.NoError(t, err)
	data := aead.Seal(nonce, nonce, plain, []byte(fmt.Sprintf("conversation:%d:%s", uid, chat.ID)))
	path := filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai", "conversations", fmt.Sprint(uid), chat.ID+".enc")
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, data, 0600))
}

func TestTCYAIConversationReadAPI(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token, other := humaTokenFor(t, &testuser1), humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath) })
	chat, err := tcyai.CreateConversation(testuser1.ID, "exact read acknowledgements")
	require.NoError(t, err)
	finished := time.Now().UTC()
	chat.Turns = []tcyai.ChatTurn{{
		ID:       uuid.NewString(),
		Status:   "completed",
		Finished: &finished,
		Result: tcyai.RunResult{
			Reply: "Synthetic fixture result",
		},
	}}
	saveReadAPIConversation(t, testuser1.ID, chat, "")
	path := "/api/v2/ai/conversations/" + chat.ID
	get := humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, get.Code, get.Body.String())
	require.NoError(t, json.Unmarshal(get.Body.Bytes(), &chat))
	assert.True(t, chat.Unread)
	assert.NotEmpty(t, chat.LatestReplyID)
	body, err := json.Marshal(map[string]string{"through_reply_id": chat.LatestReplyID})
	require.NoError(t, err)
	assert.Equal(t, 401, humaRequest(t, e, "POST", path+"/read", string(body), "", "").Code)
	assert.Equal(t, 404, humaRequest(t, e, "POST", path+"/read", string(body), other, "").Code)
	share, err := auth.NewLinkShareJWTAuthtoken(&models.LinkSharing{
		ID:        1,
		Hash:      "test",
		ProjectID: 1,
	})
	require.NoError(t, err)
	assert.Contains(t, []int{401, 403}, humaRequest(t, e, "POST", path+"/read", string(body), share, "").Code)
	assert.Equal(t, 409, humaRequest(t, e, "POST", path+"/read", `{"through_reply_id":"stale-result"}`, token, "").Code)
	ack := humaRequest(t, e, "POST", path+"/read", string(body), token, "")
	require.Equal(t, 200, ack.Code, ack.Body.String())
	assert.Equal(t, "no-store", ack.Header().Get("Cache-Control"))
	var receipt tcyai.ConversationReadReceipt
	require.NoError(t, json.Unmarshal(ack.Body.Bytes(), &receipt))
	assert.False(t, receipt.Unread)
	assert.Equal(t, chat.LatestReplyID, receipt.ReadThroughReplyID)
	// The cursor survives a real API reload, not only the POST response.
	get = humaRequest(t, e, "GET", path, "", token, "")
	require.Equal(t, 200, get.Code, get.Body.String())
	require.NoError(t, json.Unmarshal(get.Body.Bytes(), &chat))
	assert.False(t, chat.Unread)
	// A retry reuses the turn ID but produces a new exact result version.
	finished = finished.Add(time.Second)
	chat.Turns[0].Finished = &finished
	saveReadAPIConversation(t, testuser1.ID, chat, receipt.ReadThroughReplyID)
	assert.Equal(t, 409, humaRequest(t, e, "POST", path+"/read", string(body), token, "").Code)
	get = humaRequest(t, e, "GET", path, "", token, "")
	require.NoError(t, json.Unmarshal(get.Body.Bytes(), &chat))
	assert.True(t, chat.Unread, "an obsolete retry acknowledgement must not consume the new result")
	// Stale JWT identity information cannot let a bot enter this human-only API.
	s := db.NewSession()
	_, err = s.ID(testuser2.ID).Cols("bot_owner_id").Update(&user.User{BotOwnerID: testuser1.ID})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	assert.Equal(t, 403, humaRequest(t, e, "POST", path+"/read", string(body), other, "").Code)
}
