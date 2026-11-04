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

package bark

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
)

//nolint:revive // Distinct public names prevent collisions in the shared Huma schema registry.
type BarkSettings struct {
	Revision  int64  `json:"revision" minimum:"0" doc:"Optimistic revision; stale saves return 409."`
	Enabled   bool   `json:"enabled" doc:"Deliver new personal notifications in the background."`
	ServerURL string `json:"server_url" maxLength:"500" doc:"HTTPS Bark base URL, without the device key or /push."`
	DeviceKey string `json:"device_key,omitempty" writeOnly:"true" maxLength:"300" doc:"Write-only device key. Empty preserves it only for the same server."`
	HasKey    bool   `json:"has_key" readOnly:"true" doc:"A device key is saved; it is never returned."`
	Scope     string `json:"scope" enum:"reminders,all" doc:"Task reminders only, or all persisted in-app notifications."`
	Level     string `json:"level" enum:"active,timeSensitive,passive" doc:"Bark interruption level; critical alerts are deliberately not used."`
	Preview   bool   `json:"preview" doc:"Include task titles on the phone lock screen; false sends generic text."`
	Language  string `json:"language" enum:"zh-CN,en" doc:"Language of push content."`
}

//nolint:revive // Distinct public names prevent collisions in the shared Huma schema registry.
type BarkDelivery struct {
	NotificationID int64     `json:"notification_id" doc:"Original in-app notification ID; zero is a test."`
	Status         string    `json:"status" enum:"pending,accepted,failed,skipped" doc:"Accepted means the Bark server accepted it, not proof the phone displayed it."`
	Attempts       int       `json:"attempts" doc:"Delivery attempts including uncertain network outcomes."`
	Updated        time.Time `json:"updated" doc:"Last attempt or queue update."`
	Next           time.Time `json:"next" doc:"Next automatic retry time, when pending."`
	Error          string    `json:"error,omitempty" doc:"Sanitized failure category; never includes device keys or provider response text."`
}

//nolint:revive // Distinct public names prevent collisions in the shared Huma schema registry.
type BarkStatus struct {
	Settings   BarkSettings   `json:"settings" doc:"Current account's redacted configuration."`
	Deliveries []BarkDelivery `json:"deliveries" doc:"Up to 30 recent deliveries, newest first."`
	Endpoint   string         `json:"endpoint" doc:"Actual POST endpoint without credentials."`
}
type record struct {
	Settings   BarkSettings   `json:"settings"`
	Cursor     int64          `json:"cursor"`
	Deliveries []BarkDelivery `json:"deliveries"`
}

var lock sync.Mutex
var ErrConflict = errors.New("push settings changed; reload before saving")
var ErrInvalid = errors.New("invalid push settings")

func directory() string     { return filepath.Join(config.FilesBasePath.GetString(), ".tcymc-bark") }
func path(uid int64) string { return filepath.Join(directory(), fmt.Sprintf("%d.enc", uid)) }
func aead() (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("tcymc-bark-v1:" + config.ServiceSecret.GetString()))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func read(uid int64) (r record, err error) {
	if accountDeleted(uid) {
		return r, ErrAccountDeleted
	}
	r.Settings = BarkSettings{ServerURL: "https://api.day.app", Scope: "reminders", Level: "timeSensitive", Language: "zh-CN"}
	r.Deliveries = []BarkDelivery{}
	b, err := os.ReadFile(path(uid))
	if errors.Is(err, os.ErrNotExist) {
		return r, nil
	}
	if err != nil {
		return r, err
	}
	a, err := aead()
	if err != nil {
		return r, err
	}
	if len(b) < a.NonceSize() {
		return r, ErrInvalid
	}
	plain, err := a.Open(nil, b[:a.NonceSize()], b[a.NonceSize():], []byte(fmt.Sprint(uid)))
	if err != nil {
		return r, err
	}
	err = json.Unmarshal(plain, &r)
	return r, err
}
func write(uid int64, r record) error {
	return withAccountWrite(uid, func() error { return writeRecord(uid, r) })
}

func writeRecord(uid int64, r record) error {
	if accountDeleted(uid) {
		return ErrAccountDeleted
	}
	b, err := json.Marshal(r)
	if err != nil {
		return err
	}
	a, err := aead()
	if err != nil {
		return err
	}
	nonce := make([]byte, a.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return err
	}
	b = a.Seal(nonce, nonce, b, []byte(fmt.Sprint(uid)))
	if err = os.MkdirAll(directory(), 0700); err != nil {
		return err
	}
	f, err := os.CreateTemp(directory(), fmt.Sprintf(".push-%d-*", uid))
	if err != nil {
		return err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(b); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Sync(); err != nil {
		_ = f.Close()
		return err
	}
	if err = f.Close(); err != nil {
		return err
	}
	return os.Rename(f.Name(), path(uid))
}
func public(r record) BarkStatus {
	s := r.Settings
	s.HasKey = s.DeviceKey != ""
	s.DeviceKey = ""
	items := append([]BarkDelivery{}, r.Deliveries...)
	for i, j := 0, len(items)-1; i < j; i, j = i+1, j-1 {
		items[i], items[j] = items[j], items[i]
	}
	return BarkStatus{Settings: s, Endpoint: s.ServerURL + "/push", Deliveries: items}
}
func Get(uid int64) (BarkStatus, error) {
	lock.Lock()
	defer lock.Unlock()
	r, e := read(uid)
	return public(r), e
}
func validate(s BarkSettings, old BarkSettings) (BarkSettings, error) {
	s.ServerURL = strings.TrimRight(strings.TrimSpace(s.ServerURL), "/")
	u, e := url.Parse(s.ServerURL)
	if e != nil || u.Scheme != "https" || u.Host == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" || strings.Contains(u.Path, "..") || strings.HasSuffix(u.Path, "/push") {
		return s, ErrInvalid
	}
	if s.DeviceKey == "" && s.ServerURL == old.ServerURL {
		s.DeviceKey = old.DeviceKey
	}
	if strings.ContainsAny(s.DeviceKey, " /?#\n\r\t") || len(s.DeviceKey) > 300 || (s.Enabled && s.DeviceKey == "") {
		return s, ErrInvalid
	}
	if s.Scope != "reminders" && s.Scope != "all" {
		return s, ErrInvalid
	}
	if s.Level != "active" && s.Level != "timeSensitive" && s.Level != "passive" {
		return s, ErrInvalid
	}
	if s.Language != "zh-CN" && s.Language != "en" {
		return s, ErrInvalid
	}
	return s, nil
}
func Save(uid int64, s BarkSettings) (BarkStatus, error) {
	lock.Lock()
	defer func() { lock.Unlock(); cleanupRevokedAccount(uid) }()
	r, e := read(uid)
	if e != nil {
		return BarkStatus{}, e
	}
	if s.Revision != r.Settings.Revision {
		return BarkStatus{}, ErrConflict
	}
	s, e = validate(s, r.Settings)
	if e != nil {
		return BarkStatus{}, e
	}
	// Enabling starts from now, not a flood of old notifications. Destination changes discard the old queue.
	if !r.Settings.Enabled || !s.Enabled || s.ServerURL != r.Settings.ServerURL || s.DeviceKey != r.Settings.DeviceKey {
		r.Cursor, e = latestNotification(uid)
		if e != nil {
			return BarkStatus{}, e
		}
		for i := range r.Deliveries {
			if r.Deliveries[i].Status == "pending" {
				r.Deliveries[i].Status = "skipped"
			}
		}
	}
	s.Revision++
	r.Settings = s
	e = write(uid, r)
	return public(r), e
}
