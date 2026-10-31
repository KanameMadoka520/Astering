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
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"crypto/tls"
	"crypto/x509"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/png"
	"io"
	"mime/multipart"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/google/uuid"
	"github.com/labstack/echo/v5"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// chatDrive drives the conversation and drive APIs as one signed-in user.
type chatDrive struct {
	t     *testing.T
	e     *echo.Echo
	token string
}

func newChatDriveEnv(t *testing.T) (*echo.Echo, string) {
	t.Helper()
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	base := t.TempDir()
	old := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(base)
	t.Cleanup(func() { config.FilesBasePath.Set(old) })
	return e, base
}

func (c chatDrive) do(method, path, body string) *httptest.ResponseRecorder {
	c.t.Helper()
	return humaRequest(c.t, c.e, method, path, body, c.token, "")
}

func (c chatDrive) multipart(path, name string, data []byte) *httptest.ResponseRecorder {
	c.t.Helper()
	var body bytes.Buffer
	form := multipart.NewWriter(&body)
	part, err := form.CreateFormFile("file", name)
	require.NoError(c.t, err)
	_, err = part.Write(data)
	require.NoError(c.t, err)
	require.NoError(c.t, form.Close())
	req := httptest.NewRequest(http.MethodPost, path, bytes.NewReader(body.Bytes()))
	req.Header.Set("Content-Type", form.FormDataContentType())
	if c.token != "" {
		req.Header.Set("Authorization", "Bearer "+c.token)
	}
	rec := httptest.NewRecorder()
	c.e.ServeHTTP(rec, req)
	return rec
}

func (c chatDrive) conversation(title string) string {
	c.t.Helper()
	rec := c.do(http.MethodPost, "/api/v2/ai/conversations", fmt.Sprintf(`{"title":%q}`, title))
	require.Equal(c.t, http.StatusCreated, rec.Code, rec.Body.String())
	var conversation tcyai.Conversation
	require.NoError(c.t, json.Unmarshal(rec.Body.Bytes(), &conversation))
	return conversation.ID
}

func (c chatDrive) get(id string) tcyai.Conversation {
	c.t.Helper()
	rec := c.do(http.MethodGet, "/api/v2/ai/conversations/"+id, "")
	require.Equal(c.t, http.StatusOK, rec.Code, rec.Body.String())
	var conversation tcyai.Conversation
	require.NoError(c.t, json.Unmarshal(rec.Body.Bytes(), &conversation))
	return conversation
}

func (c chatDrive) chatUpload(id, name string, data []byte) tcyai.ChatAttachment {
	c.t.Helper()
	rec := c.multipart("/api/v2/ai/conversations/"+id+"/attachments", name, data)
	require.Equal(c.t, http.StatusCreated, rec.Code, rec.Body.String())
	var a tcyai.ChatAttachment
	require.NoError(c.t, json.Unmarshal(rec.Body.Bytes(), &a))
	return a
}

func (c chatDrive) driveUpload(name string, data []byte) int64 {
	c.t.Helper()
	rec := c.multipart("/api/v2/drive/files", name, data)
	require.Equal(c.t, http.StatusOK, rec.Code, rec.Body.String())
	var d files.DriveFile
	require.NoError(c.t, json.Unmarshal(rec.Body.Bytes(), &d))
	require.Positive(c.t, d.FileID)
	return d.FileID
}

func (c chatDrive) fromDrive(id string, fileID int64) *httptest.ResponseRecorder {
	c.t.Helper()
	return c.do(http.MethodPost, "/api/v2/ai/conversations/"+id+"/attachments/from-drive", fmt.Sprintf(`{"file_id":%d}`, fileID))
}

func (c chatDrive) usages(fileID int64) []models.DriveUsage {
	c.t.Helper()
	rec := c.do(http.MethodGet, fmt.Sprintf("/api/v2/drive/files/%d/usages", fileID), "")
	require.Equal(c.t, http.StatusOK, rec.Code, rec.Body.String())
	usages := []models.DriveUsage{}
	require.NoError(c.t, json.Unmarshal(rec.Body.Bytes(), &usages))
	return usages
}

func chatDriveRow(t *testing.T, fileID int64) (files.DriveFile, bool) {
	t.Helper()
	s := db.NewReadSession()
	defer s.Close()
	d := files.DriveFile{}
	found, err := s.Where("file_id = ?", fileID).Get(&d)
	require.NoError(t, err)
	return d, found
}

// change runs a drive action with the current revision, like the drive page does.
func (c chatDrive) change(fileID int64, action string, confirm bool, confirmName string) *httptest.ResponseRecorder {
	c.t.Helper()
	d, found := chatDriveRow(c.t, fileID)
	require.True(c.t, found)
	return c.do(http.MethodPatch, fmt.Sprintf("/api/v2/drive/files/%d", fileID), fmt.Sprintf(`{"revision":%d,"action":%q,"name":"","category":"","pinned":false,"confirm":%t,"confirm_name":%q}`, d.Revision, action, confirm, confirmName))
}

func chatDriveCount(t *testing.T, bean any, query string, args ...any) int64 {
	t.Helper()
	s := db.NewReadSession()
	defer s.Close()
	n, err := s.Where(query, args...).Count(bean)
	require.NoError(t, err)
	return n
}

func chatDrivePNG(t *testing.T, red uint8) []byte {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, 3, 3))
	img.Set(1, 1, color.RGBA{R: red, G: 40, B: 90, A: 255})
	var b bytes.Buffer
	require.NoError(t, png.Encode(&b, img))
	return b.Bytes()
}

func chatDriveID(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func TestTCYAttachmentsRoutes(t *testing.T) {
	e, base := newChatDriveEnv(t)
	owner := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser1)}
	other := humaTokenFor(t, &testuser2)
	id := owner.conversation("Files")
	path := "/api/v2/ai/conversations/" + id
	filesBefore := chatDriveCount(t, &files.File{}, "created_by_id = ?", testuser1.ID)

	a := owner.chatUpload(id, "notes.txt", []byte("private notes"))
	assert.Equal(t, chatDriveID([]byte("private notes")), a.ID, "IDs stay 64-hex content hashes")
	assert.Equal(t, "notes.txt", a.Name)
	assert.Equal(t, "text/plain; charset=utf-8", a.MIME)
	require.Positive(t, a.DriveFileID, "new uploads are stored in the personal drive")
	// One physical file: the drive blob. Nothing is written to the encrypted chat store.
	assert.Equal(t, filesBefore+1, chatDriveCount(t, &files.File{}, "created_by_id = ?", testuser1.ID))
	_, err := os.Stat(filepath.Join(base, ".tcymc-ai", "conversations", fmt.Sprint(testuser1.ID), "attachments"))
	assert.True(t, os.IsNotExist(err))
	again := owner.chatUpload(id, "renamed.txt", []byte("private notes"))
	assert.Equal(t, a, again, "identical bytes are idempotent")
	assert.Equal(t, filesBefore+1, chatDriveCount(t, &files.File{}, "created_by_id = ?", testuser1.ID), "and store nothing new")
	assert.Len(t, owner.get(id).DraftAttachments, 1)

	filePath := path + "/attachments/" + a.ID
	for _, url := range []string{filePath, path + "/export?format=zip"} {
		assert.Equal(t, 401, humaRequest(t, e, "GET", url, "", "", "").Code)
		assert.Equal(t, 404, humaRequest(t, e, "GET", url, "", other, "").Code)
		assert.Contains(t, []int{401, 403}, humaRequest(t, e, "GET", url, "", "tk_2eef46f40ebab3304919ab2e7e39993f75f29d2e", "").Code)
	}
	got := owner.do("GET", filePath, "")
	require.Equal(t, 200, got.Code)
	assert.Equal(t, "private notes", got.Body.String())
	assert.Equal(t, "no-store", got.Header().Get("Cache-Control"))
	assert.True(t, strings.HasPrefix(got.Header().Get("Content-Disposition"), "attachment"))
	exported := owner.do("GET", path+"/export?format=zip", "")
	require.Equal(t, 200, exported.Code)
	assert.Equal(t, "application/zip", exported.Header().Get("Content-Type"))
	storage := owner.get(id).Storage
	require.NotNil(t, storage)
	assert.Equal(t, 1, storage.DriveCount)
	assert.Equal(t, int64(len("private notes")), storage.DriveBytes)
	assert.Equal(t, storage.DriveBytes, storage.AttachmentBytes)

	assert.Equal(t, []models.DriveUsage{{Kind: "chat_draft", Title: "Files", URL: "/ai?chat=" + id}}, owner.usages(a.DriveFileID))
	assert.Equal(t, 404, humaRequest(t, e, "GET", fmt.Sprintf("/api/v2/drive/files/%d/usages", a.DriveFileID), "", other, "").Code)

	// Removing the draft only removes the reference; the drive keeps the file.
	require.Equal(t, 204, owner.do("DELETE", filePath, "").Code)
	assert.Equal(t, 404, owner.do("GET", filePath, "").Code)
	download := owner.do("GET", fmt.Sprintf("/api/v2/drive/files/%d/download", a.DriveFileID), "")
	require.Equal(t, 200, download.Code)
	assert.Equal(t, "private notes", download.Body.String())
	assert.Empty(t, owner.usages(a.DriveFileID))
	assert.Zero(t, chatDriveCount(t, &files.DriveChatRef{}, "file_id = ?", a.DriveFileID))
	require.Equal(t, 200, owner.change(a.DriveFileID, "trash", false, "").Code, "unused files need no confirmation")
}

func TestTCYAttachmentsFromDrive(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	owner := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser1)}
	stranger := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser2)}
	id := owner.conversation("Reuse")
	pngBytes := chatDrivePNG(t, 200)
	pictureID := owner.driveUpload("picture.png", pngBytes)
	textID := owner.driveUpload("plan.txt", []byte("drive plan"))
	foreignID := stranger.driveUpload("theirs.txt", []byte("not yours"))

	rec := owner.fromDrive(id, pictureID)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	var picture tcyai.ChatAttachment
	require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &picture))
	assert.Equal(t, tcyai.ChatAttachment{ID: chatDriveID(pngBytes), Name: "picture.png", MIME: "image/png", Size: int64(len(pngBytes)), DriveFileID: pictureID}, picture)
	filesBefore := chatDriveCount(t, &files.File{}, "1 = 1")
	for range 2 {
		rec = owner.fromDrive(id, pictureID)
		require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
		var repeated tcyai.ChatAttachment
		require.NoError(t, json.Unmarshal(rec.Body.Bytes(), &repeated))
		assert.Equal(t, picture, repeated, "choosing the same drive file again is idempotent")
	}
	// The same bytes in another drive file are the same attachment, not a second draft.
	duplicateID := owner.driveUpload("copy.png", pngBytes)
	rec = owner.fromDrive(id, duplicateID)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Contains(t, rec.Body.String(), fmt.Sprintf(`"drive_file_id":%d`, pictureID))
	rec = owner.fromDrive(id, textID)
	require.Equal(t, http.StatusCreated, rec.Code, rec.Body.String())
	assert.Equal(t, filesBefore+1, chatDriveCount(t, &files.File{}, "1 = 1"), "references never copy a blob")
	drafts := owner.get(id).DraftAttachments
	require.Len(t, drafts, 2)
	assert.Equal(t, pictureID, drafts[0].DriveFileID)
	assert.Equal(t, textID, drafts[1].DriveFileID)
	got := owner.do("GET", "/api/v2/ai/conversations/"+id+"/attachments/"+picture.ID, "")
	require.Equal(t, 200, got.Code)
	assert.Equal(t, pngBytes, got.Body.Bytes())
	assert.Equal(t, "image/png", got.Header().Get("Content-Type"))

	// Access is limited to the owner's conversation and the owner's drive.
	body := fmt.Sprintf(`{"file_id":%d}`, textID)
	assert.Equal(t, 401, humaRequest(t, e, "POST", "/api/v2/ai/conversations/"+id+"/attachments/from-drive", body, "", "").Code)
	assert.Contains(t, []int{401, 403}, humaRequest(t, e, "POST", "/api/v2/ai/conversations/"+id+"/attachments/from-drive", body, "tk_2eef46f40ebab3304919ab2e7e39993f75f29d2e", "").Code)
	assert.Equal(t, 404, stranger.fromDrive(id, textID).Code)
	strangerChat := stranger.conversation("Theirs")
	assert.Equal(t, 404, stranger.fromDrive(strangerChat, textID).Code, "another account's drive file is not found")
	assert.Equal(t, 404, owner.fromDrive(id, foreignID).Code)
	assert.Equal(t, 404, owner.fromDrive(id, 99999999).Code)
	assert.Equal(t, 422, owner.fromDrive(id, 0).Code)
	assert.Equal(t, 404, owner.fromDrive(uuid.NewString(), textID).Code)
	assert.Empty(t, stranger.usages(foreignID))

	// Bytes are checked like an upload: decoded images, 32 MiB, recycle bin.
	broken := append([]byte{}, chatDrivePNG(t, 10)...)
	broken[len(broken)-18] ^= 0xff
	assert.Equal(t, 422, owner.fromDrive(id, owner.driveUpload("broken.png", broken)).Code)
	hugeID := owner.driveUpload("huge.bin", []byte("pretends to be large"))
	s := db.NewSession()
	_, err := s.ID(hugeID).Cols("size").Update(&files.File{Size: tcyai.MaxChatAttachmentBytes + 1})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	assert.Equal(t, 422, owner.fromDrive(id, hugeID).Code)
	trashedID := owner.driveUpload("old.txt", []byte("in the recycle bin"))
	require.Equal(t, 200, owner.change(trashedID, "trash", false, "").Code)
	rec = owner.fromDrive(id, trashedID)
	assert.Equal(t, http.StatusConflict, rec.Code)
	assert.Contains(t, rec.Body.String(), "recycle bin")
	assert.Len(t, owner.get(id).DraftAttachments, 2, "rejected files never reach the draft")

	// Sixteen drafts at most, from any source.
	for i := 3; i <= 16; i++ {
		require.Equal(t, http.StatusCreated, owner.fromDrive(id, owner.driveUpload(fmt.Sprintf("n%d.txt", i), []byte(fmt.Sprintf("note %d", i)))).Code)
	}
	assert.Equal(t, 422, owner.fromDrive(id, owner.driveUpload("n17.txt", []byte("note 17"))).Code)
	extra := owner.multipart("/api/v2/ai/conversations/"+id+"/attachments", "n18.txt", []byte("note 18"))
	assert.Equal(t, 422, extra.Code)
	assert.Equal(t, http.StatusCreated, owner.fromDrive(id, textID).Code, "a file already in a full draft is still idempotent")
	assert.Len(t, owner.get(id).DraftAttachments, 16)

	usages := owner.usages(pictureID)
	assert.Equal(t, []models.DriveUsage{{Kind: "chat_draft", Title: "Reuse", URL: "/ai?chat=" + id}}, usages)
	assert.Empty(t, owner.usages(duplicateID), "the duplicate was never referenced")
}

func TestTCYAttachmentsDriveLifecycle(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	oldAllow := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	owner := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser1)}
	pngBytes := chatDrivePNG(t, 120)
	var mu sync.Mutex
	requests := []string{}
	// A local fake provider: no real model is contacted.
	provider := httptest.NewTLSServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		raw, err := io.ReadAll(r.Body)
		if !assert.NoError(t, err) {
			return
		}
		mu.Lock()
		requests = append(requests, string(raw))
		mu.Unlock()
		w.Header().Set("Content-Type", "text/event-stream")
		_, err = io.WriteString(w, `data: {"model":"vision-fixture","choices":[{"index":0,"delta":{"content":"Seen"},"finish_reason":"stop"}],"usage":{"prompt_tokens":10,"completion_tokens":2}}`+"\n\n")
		assert.NoError(t, err)
	}))
	defer provider.Close()
	pool := x509.NewCertPool()
	pool.AddCert(provider.Certificate())
	original := http.DefaultTransport
	transport := original.(*http.Transport).Clone()
	transport.TLSClientConfig = &tls.Config{RootCAs: pool, MinVersion: tls.VersionTLS12}
	http.DefaultTransport = transport
	t.Cleanup(func() { http.DefaultTransport = original; transport.CloseIdleConnections() })
	saved := owner.do("POST", "/api/v2/ai/settings", fmt.Sprintf(`{"connections":[{"id":"vision","name":"Vision","kind":"chat","protocol":"openai-chat","base_url":%q,"model":"vision","api_key":"fixture-key","input_types":["text","image"]}],"assistant":"vision","cleanup":"","transcription":""}`, provider.URL))
	require.Equal(t, 200, saved.Code, saved.Body.String())

	id := owner.conversation("Vision")
	a := owner.chatUpload(id, "photo.png", pngBytes)
	fileID := a.DriveFileID
	require.Positive(t, fileID)
	assert.Equal(t, []models.DriveUsage{{Kind: "chat_draft", Title: "Vision", URL: "/ai?chat=" + id}}, owner.usages(fileID))
	// A chat reference needs the trash confirmation like any other usage.
	trash := owner.change(fileID, "trash", false, "")
	assert.Equal(t, http.StatusConflict, trash.Code)
	assert.Contains(t, trash.Body.String(), "drive_confirm")

	send := owner.do("POST", "/api/v2/ai/conversations/"+id+"/messages", fmt.Sprintf(`{"message":"What is in the picture?","history":[],"project_id":0,"mode":"read","allow_delete":false,"request_id":%q,"attachment_ids":[%q]}`, uuid.NewString(), a.ID))
	require.Equal(t, http.StatusCreated, send.Code, send.Body.String())
	var conversation tcyai.Conversation
	// The condition runs on another goroutine, so it must not use require.
	require.Eventually(t, func() bool {
		rec := humaRequest(t, e, http.MethodGet, "/api/v2/ai/conversations/"+id, "", owner.token, "")
		return rec.Code == http.StatusOK && json.Unmarshal(rec.Body.Bytes(), &conversation) == nil &&
			len(conversation.Turns) == 1 && conversation.Turns[0].Status != "running"
	}, 5*time.Second, 10*time.Millisecond)
	require.Equal(t, "completed", conversation.Turns[0].Status, conversation.Turns[0].Result.Error)
	require.Len(t, conversation.Turns[0].Attachments, 1)
	assert.Equal(t, fileID, conversation.Turns[0].Attachments[0].DriveFileID)
	assert.Empty(t, conversation.DraftAttachments)
	mu.Lock()
	sentImage := false
	for _, body := range requests {
		sentImage = sentImage || strings.Contains(body, base64.StdEncoding.EncodeToString(pngBytes))
		assert.NotContains(t, body, "drive_file_id", "storage references never reach the provider")
	}
	mu.Unlock()
	assert.True(t, sentImage, "the model receives the drive bytes")
	assert.Equal(t, []models.DriveUsage{{Kind: "chat", Title: "Vision", URL: "/ai?chat=" + id}}, owner.usages(fileID))
	// A drive-scoped API token learns that a conversation uses the file, not which one.
	viaToken := chatDrive{t: t, e: e, token: chatDriveUsagesToken(t)}
	assert.Equal(t, []models.DriveUsage{{Kind: "chat", Restricted: true}}, viaToken.usages(fileID))

	exported := owner.do("GET", "/api/v2/ai/conversations/"+id+"/export?format=zip", "")
	require.Equal(t, 200, exported.Code)
	archive, err := zip.NewReader(bytes.NewReader(exported.Body.Bytes()), int64(exported.Body.Len()))
	require.NoError(t, err)
	exportedImage := false
	for _, f := range archive.File {
		if f.Name == "attachments/"+a.ID+"/photo.png" {
			r, err := f.Open()
			require.NoError(t, err)
			content, err := io.ReadAll(r)
			require.NoError(t, err)
			require.NoError(t, r.Close())
			exportedImage = bytes.Equal(pngBytes, content)
		}
	}
	assert.True(t, exportedImage)

	// A branch pins the file for itself; deleting either conversation keeps the other's use.
	fork := owner.do("POST", "/api/v2/ai/conversations/"+id+"/fork", fmt.Sprintf(`{"turn_id":%q}`, conversation.Turns[0].ID))
	require.Equal(t, http.StatusCreated, fork.Code, fork.Body.String())
	var branch tcyai.Conversation
	require.NoError(t, json.Unmarshal(fork.Body.Bytes(), &branch))
	assert.Len(t, owner.usages(fileID), 2)
	require.Equal(t, 200, owner.change(fileID, "trash", true, "").Code)
	got := owner.do("GET", "/api/v2/ai/conversations/"+branch.ID+"/attachments/"+a.ID, "")
	require.Equal(t, 200, got.Code, "the recycle bin is reversible; existing references stay readable")
	assert.Equal(t, pngBytes, got.Body.Bytes())
	assert.Equal(t, http.StatusConflict, owner.change(fileID, "purge", true, "photo.png").Code)
	require.Equal(t, 204, owner.do("DELETE", "/api/v2/ai/conversations/"+id, "").Code)
	assert.Equal(t, []models.DriveUsage{{Kind: "chat", Title: branch.Title, URL: "/ai?chat=" + branch.ID}}, owner.usages(fileID))
	purge := owner.change(fileID, "purge", true, "photo.png")
	assert.Equal(t, http.StatusConflict, purge.Code)
	assert.Contains(t, purge.Body.String(), "drive_in_use")
	require.Equal(t, 204, owner.do("DELETE", "/api/v2/ai/conversations/"+branch.ID, "").Code)
	assert.Empty(t, owner.usages(fileID))
	require.Equal(t, 200, owner.change(fileID, "purge", true, "photo.png").Code)
	_, found := chatDriveRow(t, fileID)
	assert.False(t, found)
	assert.Zero(t, chatDriveCount(t, &files.DriveChatRef{}, "file_id = ?", fileID))
}

func TestTCYAttachmentsDriveIntegrityAndRecovery(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	owner := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser1)}
	id := owner.conversation("Integrity")
	path := "/api/v2/ai/conversations/" + id
	original := []byte("the attached version")
	a := owner.chatUpload(id, "version.txt", original)

	// A drive file that is gone (here: a purge interrupted by a crash) shows as missing,
	// and uploading the same bytes again replaces the draft and releases the old pin.
	s := db.NewSession()
	_, err := s.Where("file_id = ?", a.DriveFileID).Cols("purging").Update(&files.DriveFile{Purging: true})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	drafts := owner.get(id).DraftAttachments
	require.Len(t, drafts, 1)
	assert.True(t, drafts[0].Missing)
	assert.Equal(t, 404, owner.do("GET", path+"/attachments/"+a.ID, "").Code)
	replaced := owner.chatUpload(id, "version.txt", original)
	assert.Equal(t, a.ID, replaced.ID)
	assert.NotEqual(t, a.DriveFileID, replaced.DriveFileID)
	drafts = owner.get(id).DraftAttachments
	require.Len(t, drafts, 1)
	assert.False(t, drafts[0].Missing)
	assert.Equal(t, replaced.DriveFileID, drafts[0].DriveFileID)
	assert.Zero(t, chatDriveCount(t, &files.DriveChatRef{}, "file_id = ?", a.DriveFileID))
	fileID := replaced.DriveFileID

	// A reference whose pin was lost is still found before a purge; the file gets its
	// pin back, so the confirmation shown without it is stale and the usage is listed.
	s = db.NewSession()
	_, err = s.Where("file_id = ?", fileID).Delete(&files.DriveChatRef{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	assert.Empty(t, owner.usages(fileID))
	require.Equal(t, 200, owner.change(fileID, "trash", false, "").Code)
	purge := owner.change(fileID, "purge", true, "version.txt")
	assert.Equal(t, http.StatusConflict, purge.Code)
	assert.Contains(t, purge.Body.String(), "drive_changed")
	assert.Equal(t, []models.DriveUsage{{Kind: "chat_draft", Title: "Integrity", URL: "/ai?chat=" + id}}, owner.usages(fileID))
	purge = owner.change(fileID, "purge", true, "version.txt")
	assert.Equal(t, http.StatusConflict, purge.Code)
	assert.Contains(t, purge.Body.String(), "drive_in_use")

	// A blob that no longer matches what was attached is never served or exported.
	tampered := []byte("a different version!")
	require.Len(t, tampered, len(original))
	require.NoError(t, (&files.File{ID: fileID, Size: uint64(len(tampered))}).Save(bytes.NewReader(tampered)))
	assert.Equal(t, 404, owner.do("GET", path+"/attachments/"+a.ID, "").Code)
	exported := owner.do("GET", path+"/export?format=zip", "")
	require.Equal(t, 200, exported.Code)
	archive, err := zip.NewReader(bytes.NewReader(exported.Body.Bytes()), int64(exported.Body.Len()))
	require.NoError(t, err)
	for _, f := range archive.File {
		assert.False(t, strings.HasPrefix(f.Name, "attachments/"), f.Name)
		if f.Name == "conversation.md" {
			r, err := f.Open()
			require.NoError(t, err)
			md, err := io.ReadAll(r)
			require.NoError(t, err)
			require.NoError(t, r.Close())
			assert.Contains(t, string(md), "Attachment missing")
		}
	}

	// Stale pins (left by a crash between pinning and saving) heal when usages are listed.
	stale := owner.driveUpload("stale.txt", []byte("pinned but never saved"))
	s = db.NewSession()
	_, err = s.Insert(&files.DriveChatRef{OwnerID: testuser1.ID, ConversationID: id, FileID: stale}, &files.DriveChatRef{OwnerID: testuser1.ID, ConversationID: uuid.NewString(), FileID: stale})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	assert.Equal(t, http.StatusConflict, owner.change(stale, "trash", false, "").Code, "until verified, a pin counts as a usage")
	assert.Empty(t, owner.usages(stale))
	assert.Zero(t, chatDriveCount(t, &files.DriveChatRef{}, "file_id = ?", stale))
	require.Equal(t, 200, owner.change(stale, "trash", false, "").Code)
}

func TestTCYAttachmentsMissingConversationStoreKeepsFiles(t *testing.T) {
	e, _ := newChatDriveEnv(t)
	owner := chatDrive{t: t, e: e, token: humaTokenFor(t, &testuser1)}
	target := owner.driveUpload("target.txt", []byte("never attached"))
	other := owner.driveUpload("other.txt", []byte("pinned by a chat"))
	require.Equal(t, 200, owner.change(target, "trash", false, "").Code)
	// The owner's chats pinned a drive file, yet the whole conversation store is gone
	// (an unmounted volume, say): nothing proves the target is unreferenced.
	s := db.NewSession()
	_, err := s.Insert(&files.DriveChatRef{OwnerID: testuser1.ID, ConversationID: uuid.NewString(), FileID: other})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	purge := owner.change(target, "purge", true, "target.txt")
	assert.Equal(t, http.StatusConflict, purge.Code)
	assert.Contains(t, purge.Body.String(), "drive_in_use")
	// An owner who never pinned a drive file to a chat simply has no conversations.
	s = db.NewSession()
	_, err = s.Where("owner_id = ?", testuser1.ID).Delete(&files.DriveChatRef{})
	require.NoError(t, err)
	require.NoError(t, s.Commit())
	require.NoError(t, s.Close())
	require.Equal(t, 200, owner.change(target, "purge", true, "target.txt").Code)
	_, found := chatDriveRow(t, target)
	assert.False(t, found)
}

// chatDriveUsagesToken creates an API token of testuser1 that may only list drive usages.
func chatDriveUsagesToken(t *testing.T) string {
	t.Helper()
	for group, perms := range models.GetAPITokenRoutes() {
		for perm, route := range perms {
			if route.Method == http.MethodGet && strings.HasPrefix(route.Path, "/api/v2/drive/") && strings.HasSuffix(route.Path, "/usages") {
				s := db.NewSession()
				defer s.Close()
				token := &models.APIToken{Title: "drive usages", APIPermissions: models.APIPermissions{group: {perm}}, ExpiresAt: time.Now().Add(time.Hour)}
				require.NoError(t, token.Create(s, &testuser1))
				require.NoError(t, s.Commit())
				return token.Token
			}
		}
	}
	require.FailNow(t, "no API token permission for drive usages")
	return ""
}
