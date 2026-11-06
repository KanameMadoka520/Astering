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

//nolint:gosmopolitan // Chinese persona and transcript fixtures are intentional.
package tcyai

import (
	"archive/zip"
	"bytes"
	"context"
	"crypto/rand"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/gif"
	"image/png"
	"io"
	"io/fs"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/google/uuid"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// legacyChatAttachment stores bytes the way chat uploads were kept before the drive:
// an encrypted per-account file, referenced from the draft. These tests run without a
// database, so they exercise every path that must keep such files readable. New
// uploads go to the drive and are covered by pkg/webtests/tcy_ai_attachments_test.go.
func legacyChatAttachment(t *testing.T, uid int64, cid, name string, data []byte) ChatAttachment {
	t.Helper()
	item, err := chatAttachmentFromBytes(name, data)
	require.NoError(t, err)
	path, err := attachmentPath(uid, item.ID)
	require.NoError(t, err)
	a, err := aead()
	require.NoError(t, err)
	nonce := make([]byte, a.NonceSize())
	_, err = rand.Read(nonce)
	require.NoError(t, err)
	require.NoError(t, os.MkdirAll(filepath.Dir(path), 0700))
	require.NoError(t, os.WriteFile(path, a.Seal(nonce, nonce, data, []byte(fmt.Sprintf("attachment:%d:%s", uid, item.ID))), 0600))
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, cid)
	require.NoError(t, err)
	if !slices.ContainsFunc(record.DraftAttachments, func(d ChatAttachment) bool { return d.ID == item.ID }) {
		record.DraftAttachments = append(record.DraftAttachments, item)
	}
	require.NoError(t, writeConversation(uid, record))
	return item
}
func chatAttachmentFixture(t *testing.T) (Conversation, ChatAttachment, []byte) {
	t.Helper()
	path, secret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("attachment-fixture-secret")
	t.Cleanup(func() { config.FilesBasePath.Set(path); config.ServiceSecret.Set(secret) })
	c, err := CreateConversation(1, "带图片的测试会话")
	require.NoError(t, err)
	img := image.NewRGBA(image.Rect(0, 0, 4, 4))
	img.Set(0, 0, color.RGBA{R: 255, A: 255})
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	a := legacyChatAttachment(t, 1, c.ID, "test image.png", b.Bytes())
	return c, a, b.Bytes()
}
func TestTCYAttachmentsStorageAndFork(t *testing.T) {
	c, a, data := chatAttachmentFixture(t)
	p, err := attachmentPath(1, a.ID)
	require.NoError(t, err)
	encrypted, err := os.ReadFile(p)
	require.NoError(t, err)
	assert.NotContains(t, string(encrypted), string(data))
	assert.Greater(t, len(encrypted), len(data))
	_, _, err = DownloadChatAttachment(2, c.ID, a.ID)
	require.ErrorIs(t, err, ErrConversationMissing)
	unrelated, err := CreateConversation(1, "other")
	require.NoError(t, err)
	_, _, err = DownloadChatAttachment(1, unrelated.ID, a.ID)
	require.ErrorIs(t, err, ErrAttachmentMissing)
	// Identical bytes reuse the readable older file: nothing is stored again, and no
	// database is needed (reaching the drive here would panic in this package).
	twice, err := UploadChatAttachment(1, c.ID, "renamed.png", bytes.NewReader(data))
	require.NoError(t, err)
	assert.Equal(t, a, twice)
	assert.Zero(t, twice.DriveFileID)
	c, err = GetConversation(1, c.ID)
	require.NoError(t, err)
	require.Len(t, c.DraftAttachments, 1)
	require.Equal(t, 1, c.Storage.AttachmentCount)
	assert.Equal(t, int64(len(encrypted)), c.Storage.AttachmentBytes)
	assert.Equal(t, int64(len(encrypted)), c.Storage.TotalBytes-c.Storage.RecordBytes)
	assert.Zero(t, c.Storage.DriveCount)
	assert.Zero(t, c.Storage.DriveBytes)
	_, content, err := DownloadChatAttachment(1, c.ID, a.ID)
	require.NoError(t, err)
	assert.Equal(t, data, content)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	turn := ChatTurn{ID: uuid.NewString(), Prompt: "test", Status: "completed", Started: time.Now(), Attachments: []ChatAttachment{a}}
	record.Turns = []ChatTurn{turn}
	record.Contexts = [][]storedMessage{{{Message: Message{Role: "user", Content: "test", Attachments: []ChatAttachment{a}, AttachmentOwner: 1}}}}
	record.DraftAttachments = nil
	require.NoError(t, writeConversation(1, record))
	fork, err := ForkConversation(1, c.ID, turn.ID)
	require.NoError(t, err)
	require.NoError(t, DeleteConversation(1, c.ID))
	_, content, err = DownloadChatAttachment(1, fork.ID, a.ID)
	require.NoError(t, err)
	assert.Equal(t, data, content)
	require.NoError(t, DeleteConversation(1, fork.ID))
	_, err = os.Stat(p)
	assert.True(t, os.IsNotExist(err))
}
func TestTCYAttachmentsExportAndMissing(t *testing.T) {
	c, a, data := chatAttachmentFixture(t)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	record.Turns = []ChatTurn{{ID: uuid.NewString(), Prompt: "BEFORE", Started: time.Now(), Attachments: []ChatAttachment{a}, Result: RunResult{Reply: "AFTER"}}}
	record.DraftAttachments = nil
	require.NoError(t, writeConversation(1, record))
	blob, kind, err := ExportConversation(1, c.ID, "zip")
	require.NoError(t, err)
	assert.Equal(t, "application/zip", kind)
	z, err := zip.NewReader(bytes.NewReader(blob), int64(len(blob)))
	require.NoError(t, err)
	content := map[string][]byte{}
	for _, f := range z.File {
		r, err := f.Open()
		require.NoError(t, err)
		content[f.Name], err = io.ReadAll(r)
		require.NoError(t, err)
		require.NoError(t, r.Close())
	}
	assert.Equal(t, data, content["attachments/"+a.ID+"/"+a.Name])
	md := string(content["conversation.md"])
	assert.Less(t, strings.Index(md, "BEFORE"), strings.Index(md, "![test image.png]"))
	assert.Less(t, strings.Index(md, "![test image.png]"), strings.Index(md, "AFTER"))
	assert.NotContains(t, string(content["conversation.json"]), "attachment-fixture-secret")
	path, _ := attachmentPath(1, a.ID)
	require.NoError(t, os.Remove(path))
	c, err = GetConversation(1, c.ID)
	require.NoError(t, err)
	assert.Equal(t, 1, c.Storage.MissingCount)
	assert.Zero(t, c.Storage.AttachmentBytes)
	assert.True(t, c.Turns[0].Attachments[0].Missing)
	blob, _, err = ExportConversation(1, c.ID, "md")
	require.NoError(t, err)
	assert.Contains(t, string(blob), "附件已丢失")
}
func TestTCYAttachmentsModelCapabilitiesAndContext(t *testing.T) {
	c, a, _ := chatAttachmentFixture(t)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	_, err = resolveTurnAttachments(1, record, []string{a.ID}, Connection{})
	require.ErrorIs(t, err, ErrImageModel)
	_, err = resolveTurnAttachments(1, record, []string{"../../secret"}, Connection{})
	require.ErrorIs(t, err, ErrAttachmentMissing)
	images, err := resolveTurnAttachments(1, record, []string{a.ID, a.ID}, Connection{InputTypes: []string{"text", "image"}})
	require.NoError(t, err)
	assert.Len(t, images, 1)
	state := NewAgentState(context.Background(), Connection{}, RunInput{Message: "Look", ServerAttachments: images, AttachmentOwner: 1})
	encoded, err := json.Marshal(state)
	require.NoError(t, err)
	var restored AgentState
	require.NoError(t, json.Unmarshal(encoded, &restored))
	require.Len(t, restored.messages()[len(restored.messages())-1].Attachments, 1)
	assert.NotContains(t, string(encoded), "base64")
	assert.Contains(t, SystemPrompt(context.Background(), RunInput{}), "Arona")
	assert.NotContains(t, SystemPrompt(context.Background(), RunInput{Persona: "none"}), "Sensei")
	require.NoError(t, RemoveChatDraftAttachment(1, c.ID, a.ID))
	_, _, err = DownloadChatAttachment(1, c.ID, a.ID)
	require.ErrorIs(t, err, ErrAttachmentMissing)
}
func TestTCYAttachmentsFourWireProtocols(t *testing.T) {
	c, a, data := chatAttachmentFixture(t)
	_ = c
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	protocol := ""
	server := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if !assert.NoError(t, err) {
			return
		}
		text := string(raw)
		assert.Contains(t, text, base64.StdEncoding.EncodeToString(data))
		assert.Contains(t, text, a.ID, "the model must receive the exact callable image attachment ID")
		assert.Contains(t, text, "Image 1 attachment reference")
		assert.NotContains(t, text, "attachment_owner")
		assert.NotContains(t, text, "drive_file_id")
		assert.NotContains(t, text, `"attachments"`)
		w.Header().Set("Content-Type", "application/json")
		switch protocol {
		case "openai-chat":
			assert.Contains(t, text, `"type":"image_url"`)
			_, _ = io.WriteString(w, `{"choices":[{"message":{"role":"assistant","content":"Seen"}}]}`)
		case "openai-responses":
			assert.Contains(t, text, `"type":"input_image"`)
			_, _ = io.WriteString(w, `{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"Seen"}]}]}`)
		case "anthropic":
			assert.Contains(t, text, `"media_type":"image/png"`)
			_, _ = io.WriteString(w, `{"content":[{"type":"text","text":"Seen"}],"stop_reason":"end_turn"}`)
		case "gemini":
			assert.Contains(t, text, `"mimeType":"image/png"`)
			_, _ = io.WriteString(w, `{"candidates":[{"content":{"parts":[{"text":"Seen"}]},"finishReason":"STOP"}]}`)
		}
	}))
	defer server.Close()
	pool := x509.NewCertPool()
	pool.AddCert(server.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	for _, p := range []string{"openai-chat", "openai-responses", "anthropic", "gemini"} {
		t.Run(p, func(t *testing.T) {
			protocol = p
			m, err := Chat(context.Background(), Connection{BaseURL: server.URL, Protocol: p, Model: "vision", InputTypes: []string{"text", "image"}}, []Message{{Role: "user", Content: "See", Attachments: []ChatAttachment{a}, AttachmentOwner: 1}}, nil)
			require.NoError(t, err)
			assert.Equal(t, "Seen", m.Content)
		})
	}
}

func TestTCYAttachmentsValidateAndConvertGIF(t *testing.T) {
	c, _, pngData := chatAttachmentFixture(t)
	corrupted := append([]byte{}, pngData...)
	corrupted[len(corrupted)-18] ^= 0xff
	_, err := UploadChatAttachment(1, c.ID, "broken.png", bytes.NewReader(corrupted))
	require.ErrorIs(t, err, ErrAttachmentInvalid)
	img := image.NewPaletted(image.Rect(0, 0, 2, 2), color.Palette{color.Black, color.White})
	var data bytes.Buffer
	require.NoError(t, gif.Encode(&data, img, nil))
	attachment := legacyChatAttachment(t, 1, c.ID, "animation.gif", data.Bytes())
	assert.Equal(t, "image/gif", attachment.MIME)
	messages, err := hydrateMessages(Connection{InputTypes: []string{"text", "image"}}, []Message{{Role: "user", Content: "see", Attachments: []ChatAttachment{attachment}, AttachmentOwner: 1}})
	require.NoError(t, err)
	require.Len(t, messages[0].imageData, 1)
	assert.Equal(t, "image/png", messages[0].imageData[0].MIME)
	_, original, err := DownloadChatAttachment(1, c.ID, attachment.ID)
	require.NoError(t, err)
	assert.Equal(t, data.Bytes(), original)
}

func TestTCYAttachmentsRejectBeforeStoring(t *testing.T) {
	c, a, data := chatAttachmentFixture(t)
	// This package has no database: reaching the drive would panic, so every case
	// below proves the request is rejected before anything is stored or read.
	for name, body := range map[string][]byte{"empty.txt": {}, "large.bin": make([]byte, MaxChatAttachmentBytes+1)} {
		_, err := UploadChatAttachment(1, c.ID, name, bytes.NewReader(body))
		require.ErrorIs(t, err, ErrAttachmentInvalid, name)
	}
	_, err := UploadChatAttachment(1, c.ID, "\x00\x01", strings.NewReader("text"))
	require.ErrorIs(t, err, ErrAttachmentInvalid)
	_, err = UploadChatAttachment(2, c.ID, "other.txt", strings.NewReader("text"))
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = AttachDriveFileToConversation(2, c.ID, 42)
	require.ErrorIs(t, err, ErrConversationMissing)
	_, err = AttachDriveFileToConversation(1, c.ID, 0)
	require.ErrorIs(t, err, ErrAttachmentMissing)
	for i := 1; i < maxDraftAttachments; i++ {
		legacyChatAttachment(t, 1, c.ID, fmt.Sprintf("note-%d.txt", i), []byte(fmt.Sprintf("note %d", i)))
	}
	_, err = UploadChatAttachment(1, c.ID, "seventeenth.txt", strings.NewReader("one too many"))
	require.ErrorIs(t, err, ErrAttachmentInvalid)
	_, err = AttachDriveFileToConversation(1, c.ID, 42)
	require.ErrorIs(t, err, ErrAttachmentInvalid)
	// A full draft still accepts bytes it already holds: that reuses the attachment.
	again, err := UploadChatAttachment(1, c.ID, "renamed.png", bytes.NewReader(data))
	require.NoError(t, err)
	assert.Equal(t, a, again)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	installActivityFixture(t, record)
	_, err = UploadChatAttachment(1, c.ID, "busy.txt", strings.NewReader("busy"))
	require.ErrorIs(t, err, ErrConversationBusy)
	_, err = AttachDriveFileToConversation(1, c.ID, 42)
	require.ErrorIs(t, err, ErrConversationBusy)
	require.ErrorIs(t, RemoveChatDraftAttachment(1, c.ID, a.ID), ErrConversationBusy)
}

func TestTCYAttachmentsDriveReferenceScan(t *testing.T) {
	c, a, _ := chatAttachmentFixture(t)
	drive := func(fill string, id int64, mime string) ChatAttachment {
		return ChatAttachment{ID: strings.Repeat(fill, 64), Name: fill + ".bin", MIME: mime, Size: 1, DriveFileID: id}
	}
	draft, sent, saved := drive("b", 12, "text/plain"), drive("c", 123, "image/png"), drive("d", 7, "text/plain")
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	record.DraftAttachments = append(record.DraftAttachments, draft)
	record.Turns = []ChatTurn{{ID: uuid.NewString(), Status: "completed", Started: time.Now(), Attachments: []ChatAttachment{a, sent}, Result: RunResult{Reply: `a reply quoting "drive_file_id":99`}}}
	record.Contexts = [][]storedMessage{{{Message: Message{Role: "user", Content: "look", Attachments: []ChatAttachment{saved}, AttachmentOwner: 1}}}}
	record.Compactions = []Compaction{{Through: 1, Summary: `[{"id":"x","drive_file_id":98}]`}}
	// Serialized text that merely mentions the field never counts as a reference,
	// and digits are matched whole (12 is not 123).
	ids, err := recordDriveIDs(record)
	require.NoError(t, err)
	assert.Equal(t, []int64{7, 12, 123}, ids)
	// Only attachments as encoding/json writes them count, wherever they are kept; a
	// provider payload or tool argument that merely names the field does not.
	shaped := fmt.Sprintf(`{"id":"%s","name":"a \"b\".txt","mime":"text/plain","size":3,"drive_file_id":5}`, strings.Repeat("f", 64))
	quoted, err := json.Marshal(shaped)
	require.NoError(t, err)
	assert.Equal(t, []int64{5}, jsonDriveIDs([]byte(`{"later":[`+shaped+`],"native":{"input":{"drive_file_id":6}},"note":`+string(quoted)+`}`)))
	require.NoError(t, writeConversation(1, record))

	conversations.Lock()
	uses, title, err := conversationDriveUsesLocked(1, c.ID)
	conversations.Unlock()
	require.NoError(t, err)
	assert.Equal(t, record.Title, title)
	assert.Equal(t, map[int64]driveUse{12: {draft: true}, 123: {sent: true}, 7: {sent: true}}, uses)

	// A live record adds references its run holds in memory; the saved file still counts.
	live, err := readConversation(1, c.ID)
	require.NoError(t, err)
	live.DraftAttachments = []ChatAttachment{drive("e", 55, "text/plain")}
	installActivityFixture(t, live)
	conversations.Lock()
	uses, _, err = conversationDriveUsesLocked(1, c.ID)
	conversations.Unlock()
	require.NoError(t, err)
	assert.Equal(t, driveUse{draft: true}, uses[55])
	assert.Equal(t, driveUse{draft: true}, uses[12], "saved drafts stay referenced while the live record moved on")
	conversations.Lock()
	_, _, err = conversationDriveUsesLocked(1, uuid.NewString())
	conversations.Unlock()
	require.ErrorIs(t, err, ErrConversationMissing)
	// Without the account's conversation directory (an unmounted volume, say) nothing is
	// proven missing, so no pin would be released.
	conversations.Lock()
	_, _, err = conversationDriveUsesLocked(987654, uuid.NewString())
	conversations.Unlock()
	require.Error(t, err)
	require.NotErrorIs(t, err, ErrConversationMissing)

	// The purge safety net: no match needs no database. A conversation that no longer
	// decrypts has unknown references, so it must block irreversible deletion.
	used, err := chatDriveBridge{}.Referenced(1, 42)
	require.NoError(t, err)
	assert.False(t, used)
	foreign := filepath.Join(conversationDir(1), uuid.NewString()+".enc")
	require.NoError(t, os.WriteFile(foreign, []byte("not a conversation of this server"), 0600))
	used, err = chatDriveBridge{}.Referenced(1, 42)
	require.Error(t, err)
	assert.False(t, used)
	require.NoError(t, os.Remove(foreign))
	used, err = chatDriveBridge{}.Referenced(1, 42)
	require.NoError(t, err)
	assert.False(t, used)
	used, err = chatDriveBridge{}.Referenced(987654, 42)
	require.NoError(t, err)
	assert.False(t, used, "an account without conversations references nothing")
	// Read errors keep the file too (checked on its own: the directory is clean again).
	if os.Getuid() > 0 {
		unreadable := filepath.Join(conversationDir(1), uuid.NewString()+".enc")
		require.NoError(t, os.WriteFile(unreadable, []byte("x"), 0))
		_, err = chatDriveBridge{}.Referenced(1, 42)
		var pathErr *fs.PathError
		require.ErrorAs(t, err, &pathErr)
		require.NoError(t, os.Remove(unreadable))
	}
}

func TestTCYAttachmentsBranchWithoutDriveFilesNeedsNoDatabase(t *testing.T) {
	c, a, _ := chatAttachmentFixture(t)
	record, err := readConversation(1, c.ID)
	require.NoError(t, err)
	record.ID = uuid.NewString()
	record.DraftAttachments = nil
	record.Turns = []ChatTurn{{ID: uuid.NewString(), Status: "completed", Started: time.Now(), Attachments: []ChatAttachment{a}}}
	conversations.Lock()
	err = writeForkWithDrivePins(1, record)
	conversations.Unlock()
	require.NoError(t, err)
	_, content, err := DownloadChatAttachment(1, record.ID, a.ID)
	require.NoError(t, err)
	assert.NotEmpty(t, content)
}

func TestTCYAttachmentsFilenames(t *testing.T) {
	for in, want := range map[string]string{`C:\Users\sensei\report.pdf`: "report.pdf", "../../etc/passwd": "passwd", "a\x00b\x7f.txt": "ab.txt", "图片 1.png": "图片 1.png"} {
		got, ok := cleanChatFilename(in)
		assert.True(t, ok, in)
		assert.Equal(t, want, got)
	}
	for _, bad := range []string{"", ".", "/", "\x01\x02", strings.Repeat("名", 256)} {
		_, ok := cleanChatFilename(bad)
		assert.False(t, ok, bad)
	}
}
