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
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/user"

	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func accountCleanupFixture(t *testing.T, uid int64) *xorm.Engine {
	t.Helper()
	previousWrite, previousExists := accountWrite, accountUserExists
	accountWrite, accountUserExists = models.WithAccountWrite, readAccountUserExists
	t.Cleanup(func() { accountWrite, accountUserExists = previousWrite, previousExists })
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	oldNetwork := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("account-cleanup-fixture")
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
		config.OutgoingRequestsAllowNonRoutableIPs.Set(oldNetwork)
	})
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, engine.Sync2(&user.User{}))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	_, err = engine.Insert(&user.User{ID: uid, Username: fmt.Sprintf("cleanup-%d", uid), Email: "fixture@example.com"})
	require.NoError(t, err)
	t.Cleanup(func() {
		_, cleanupErr := engine.ID(uid).Delete(&user.User{})
		assert.NoError(t, cleanupErr)
	})
	return engine
}

func accountSettings() Settings {
	return Settings{Connections: []Connection{{ID: "fixture", Name: "Fixture", Kind: "chat", Protocol: "openai-chat", BaseURL: "https://example.com/v1", Model: "fixture", APIKey: "private-fixture-key"}}, Assistant: "fixture"}
}

func awaitAccountSignal(t *testing.T, done <-chan struct{}) {
	t.Helper()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("account lifecycle operation did not finish")
	}
}

func TestTCYAIAccountCleanupPreservesExistingAccount(t *testing.T) {
	const uid int64 = 91101
	accountCleanupFixture(t, uid)
	chat, err := CreateConversation(uid, "Keep this account")
	require.NoError(t, err)
	_, err = Save(uid, accountSettings())
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.False(t, accountDeleted(uid))
	_, err = GetConversation(uid, chat.ID)
	require.NoError(t, err)
	settings, err := Load(uid)
	require.NoError(t, err)
	assert.Equal(t, "private-fixture-key", settings.Connections[0].APIKey)
}

func TestTCYAIAccountCleanupRetriesAfterFailureAndRestart(t *testing.T) {
	const uid int64 = 91102
	engine := accountCleanupFixture(t, uid)
	chat, err := CreateConversation(uid, "Private history")
	require.NoError(t, err)
	legacyChatAttachment(t, uid, chat.ID, "private.txt", []byte("private legacy attachment"))
	_, err = Save(uid, accountSettings())
	require.NoError(t, err)
	root := accountKey(uid).root
	temporary := filepath.Join(root, fmt.Sprintf(".settings-%d-crash", uid))
	require.NoError(t, os.WriteFile(temporary, []byte("encrypted temporary file"), 0600))
	untouched := filepath.Join(root, "system-note")
	require.NoError(t, os.WriteFile(untouched, []byte("not an account"), 0600))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)

	injected := errors.New("temporary storage failure")
	bridge := accountCleanupBridge{removeAll: func(path string) error {
		if path == fileFor(uid) {
			return injected
		}
		return os.RemoveAll(path)
	}}
	require.ErrorIs(t, bridge.CleanupDeletedUser(uid), injected)
	assert.True(t, accountDeleted(uid))
	assert.FileExists(t, fileFor(uid), "failed private data is the durable retry index")
	_, err = Save(uid, accountSettings())
	require.ErrorIs(t, err, ErrAccountDeleted)

	// An already revoked UID must still retry I/O, rather than report success.
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.NoFileExists(t, fileFor(uid))
	assert.NoDirExists(t, conversationDir(uid))
	assert.NoFileExists(t, temporary)
	assert.FileExists(t, untouched)

	// Simulate a crash before the original hook: the DB row stays absent, but
	// there is no in-memory fence. A leftover UID directory alone must suffice.
	deletedAccounts.Delete(accountKey(uid))
	require.NoError(t, os.MkdirAll(conversationDir(uid), 0700))
	require.NoError(t, os.WriteFile(filepath.Join(conversationDir(uid), "leftover"), []byte("encrypted"), 0600))
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.True(t, accountDeleted(uid))
	assert.NoDirExists(t, conversationDir(uid))
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(0))
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(-1))
	assert.FileExists(t, untouched)
}

type delayedAccountUpload struct {
	started chan struct{}
	release chan struct{}
	data    *bytes.Reader
	first   bool
}

func (reader *delayedAccountUpload) Read(p []byte) (int, error) {
	if !reader.first {
		reader.first = true
		close(reader.started)
		<-reader.release
	}
	return reader.data.Read(p)
}

func TestTCYAIAccountCleanupCancelsJobsAndRejectsLateWriters(t *testing.T) {
	i18n.Init()
	for index, variant := range []struct{ compact, external bool }{{false, false}, {true, false}, {false, true}, {true, true}} {
		compact := variant.compact
		t.Run(fmt.Sprintf("compacting-%t-external-%t", compact, variant.external), func(t *testing.T) {
			uid := int64(91110 + index)
			engine := accountCleanupFixture(t, uid)
			chat, err := CreateConversation(uid, "Account deletion race")
			require.NoError(t, err)
			_, err = Save(uid, accountSettings())
			require.NoError(t, err)
			record, err := readConversation(uid, chat.ID)
			require.NoError(t, err)
			if compact {
				record.Turns = []ChatTurn{{ID: uuid.NewString(), Prompt: "Keep the goal", Status: "completed", Result: RunResult{Reply: "Remember the outcome"}}}
				record.Contexts = [][]storedMessage{{}}
				require.NoError(t, writeConversation(uid, record))
			}
			started, cancelled := make(chan struct{}), make(chan struct{})
			var requests atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(_ http.ResponseWriter, request *http.Request) {
				_, _ = io.Copy(io.Discard, request.Body)
				requests.Add(1)
				close(started)
				<-request.Context().Done()
				close(cancelled)
			}))
			t.Cleanup(server.Close)
			connection := Connection{Protocol: "openai-chat", BaseURL: server.URL, Model: "fixture", NonStreaming: true}
			if compact {
				_, err = CompactConversation(context.Background(), uid, chat.ID, connection)
			} else {
				_, err = StartConversation(context.Background(), uid, chat.ID, RunInput{Message: "Wait for the result", RequestID: uuid.NewString()}, connection, nil)
			}
			require.NoError(t, err)
			conversations.Lock()
			live := conversations.live[liveKey(uid, chat.ID)]
			conversations.Unlock()
			require.NotNil(t, live)
			t.Cleanup(live.cancel)
			awaitAccountSignal(t, started)

			upload := &delayedAccountUpload{started: make(chan struct{}), release: make(chan struct{}), data: bytes.NewReader([]byte("upload admitted before deletion"))}
			uploadResult := make(chan error, 1)
			go func() {
				_, uploadErr := UploadChatAttachment(uid, chat.ID, "late.txt", upload)
				uploadResult <- uploadErr
			}()
			awaitAccountSignal(t, upload.started)
			_, err = engine.ID(uid).Delete(&user.User{})
			require.NoError(t, err)
			if variant.external {
				awaitAccountSignal(t, cancelled)
			}
			saveResult, cleanupResult := make(chan error, 1), make(chan error, 1)
			go func() { _, saveErr := Save(uid, accountSettings()); saveResult <- saveErr }()
			go func() {
				if variant.external {
					cleanupResult <- nil // No in-process deletion hook: the active watcher must notice the DB commit.
				} else {
					cleanupResult <- (accountCleanupBridge{}).CleanupDeletedUser(uid)
				}
			}()
			select {
			case err = <-cleanupResult:
				require.NoError(t, err)
			case <-time.After(5 * time.Second):
				t.Fatal("cleanup deadlocked with running job or settings write")
			}
			close(upload.release)
			require.ErrorIs(t, <-uploadResult, ErrAccountDeleted)
			err = <-saveResult
			require.True(t, err == nil || errors.Is(err, ErrAccountDeleted), "concurrent settings result: %T: %v", err, err)
			awaitAccountSignal(t, cancelled)
			awaitAccountSignal(t, live.done)
			awaitAccountSignal(t, live.watchDone)
			assert.EqualValues(t, 1, requests.Load(), "cancelled jobs must not start another model request")
			assert.False(t, ConversationJobRunning(uid, chat.ID))
			assert.NoFileExists(t, fileFor(uid))
			assert.NoDirExists(t, conversationDir(uid), "late checkpoints must not recreate deleted history")
			conversations.Lock()
			err = writeConversation(uid, record)
			conversations.Unlock()
			require.ErrorIs(t, err, ErrAccountDeleted)
			_, err = Save(uid, accountSettings())
			require.ErrorIs(t, err, ErrAccountDeleted)
			_, err = CompactConversation(context.Background(), uid, chat.ID, connection)
			require.ErrorIs(t, err, ErrAccountDeleted)
		})
	}
}

func TestTCYAIAccountCleanupStoreScopeAndOwnerCache(t *testing.T) {
	const uid int64 = 91103
	engine := accountCleanupFixture(t, uid)
	_, err := CreateConversation(uid, "Deleted store")
	require.NoError(t, err)
	cacheDriveBytes(driveBytesKey{uid: uid, fileID: 1}, []byte("private cached bytes"))
	cacheDriveBytes(driveBytesKey{uid: uid + 1, fileID: 2}, []byte("another account"))
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	assert.Nil(t, cachedDriveBytes(driveBytesKey{uid: uid, fileID: 1}))
	assert.Equal(t, []byte("another account"), cachedDriveBytes(driveBytesKey{uid: uid + 1, fileID: 2}))
	cacheDriveBytes(driveBytesKey{uid: uid, fileID: 1}, []byte("late cache result"))
	assert.Nil(t, cachedDriveBytes(driveBytesKey{uid: uid, fileID: 1}))

	// A new isolated store can use fixture IDs, but returning to the old store
	// must retain its fence, even if somebody manually recreates the users row.
	_, err = engine.Insert(&user.User{ID: uid, Username: "reused-uid", Email: "reuse@example.com"})
	require.NoError(t, err)
	oldStore := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	_, err = CreateConversation(uid, "Separate fixture store")
	require.NoError(t, err)
	config.FilesBasePath.Set(oldStore)
	_, err = CreateConversation(uid, "Must not revive old identity")
	require.ErrorIs(t, err, ErrAccountDeleted)
}

func TestTCYAIAccountCleanupExternalDeleteRejectsSettingsWrites(t *testing.T) {
	for index, preferences := range []bool{false, true} {
		t.Run(fmt.Sprintf("preferences-%t", preferences), func(t *testing.T) {
			uid := int64(91130 + index)
			engine := accountCleanupFixture(t, uid)
			_, err := CreateConversation(uid, "Private history without an active job")
			require.NoError(t, err)
			_, err = Save(uid, accountSettings())
			require.NoError(t, err)
			assert.False(t, accountDeleted(uid))
			_, err = engine.ID(uid).Delete(&user.User{})
			require.NoError(t, err)

			// No hook, live job, or watcher can supply the fence: the private
			// writer itself must discover the authoritative deletion.
			if preferences {
				_, err = SavePreferences(uid, AssistantPreferences{DefaultProfile: "ask"})
			} else {
				_, err = Save(uid, accountSettings())
			}
			require.ErrorIs(t, err, ErrAccountDeleted)
			assert.True(t, accountDeleted(uid))
			assert.NoFileExists(t, fileFor(uid))
			assert.NoDirExists(t, conversationDir(uid))
		})
	}
}

func TestTCYAIAccountCleanupUploadAlreadyStored(t *testing.T) {
	// The real Drive tables and file handler exercise the second half of an
	// upload, after its blob was committed but before the chat could pin it.
	files.InitTests()
	user.InitTests()
	models.SetupTests()
	require.NoError(t, db.LoadFixtures())
	const uid int64 = 91104
	engine := accountCleanupFixture(t, uid)
	chat, err := CreateConversation(uid, "Upload race")
	require.NoError(t, err)
	data := []byte("blob committed before the account deletion")
	item, err := chatAttachmentFromBytes("late.txt", data)
	require.NoError(t, err)
	item.DriveFileID, err = storeDriveUpload(uid, item.Name, data)
	require.NoError(t, err)
	fileID := item.DriveFileID
	db.AssertExists(t, "drive_files", map[string]interface{}{"file_id": fileID, "owner_id": uid}, false)
	_, err = engine.ID(uid).Delete(&user.User{})
	require.NoError(t, err)
	require.NoError(t, (accountCleanupBridge{}).CleanupDeletedUser(uid))
	_, err = addDriveDraft(uid, chat.ID, item)
	require.ErrorIs(t, err, ErrAccountDeleted)
	discardNewDriveUpload(uid, fileID)
	// If immediate discard stayed conservative, the deleted-owner retry must
	// still recover it, without recreating a conversation or a chat pin.
	require.NoError(t, models.RetryDeletedAccountCleanup())
	db.AssertMissing(t, "drive_chat_refs", map[string]interface{}{"owner_id": uid, "file_id": fileID})
	db.AssertMissing(t, "drive_files", map[string]interface{}{"file_id": fileID})
	db.AssertMissing(t, "files", map[string]interface{}{"id": fileID})
	_, err = files.FileStat(&files.File{ID: fileID})
	require.Error(t, err)
	assert.NoDirExists(t, conversationDir(uid))
}
