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

//nolint:gosmopolitan // Pushes have explicit Chinese and English user-selected text.
package bark

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/notifications"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/utils"
)

type payload struct {
	DeviceKey string `json:"device_key"`
	Title     string `json:"title"`
	Body      string `json:"body"`
	URL       string `json:"url"`
	Group     string `json:"group"`
	Level     string `json:"level"`
}

// Never put the key in the URL, follow redirects, or return an upstream body (which may echo secrets).
func deliver(ctx context.Context, s BarkSettings, p payload) (string, bool) {
	p.DeviceKey = s.DeviceKey
	p.Group = "vikunja-x"
	p.Level = s.Level
	b, err := json.Marshal(p)
	if err != nil {
		return "ENCODING_FAILED", false
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, s.ServerURL+"/push", bytes.NewReader(b))
	if err != nil {
		return "INVALID_URL", false
	}
	req.Header.Set("Content-Type", "application/json")
	client := utils.NewSSRFSafeHTTPClient()
	client.Timeout = 10 * time.Second
	client.CheckRedirect = func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }
	res, err := client.Do(req)
	if err != nil {
		return "NETWORK_ERROR", true
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return fmt.Sprintf("HTTP_%d", res.StatusCode), res.StatusCode == 429 || res.StatusCode >= 500
	}
	var response struct {
		Code int `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 65536)).Decode(&response) != nil {
		return "INVALID_RESPONSE", true
	}
	if response.Code != 200 {
		return fmt.Sprintf("BARK_%d", response.Code), response.Code == 429 || response.Code >= 500
	}
	return "", false
}
func pushContent(s BarkSettings, n *notifications.DatabaseNotification) payload {
	p := payload{Title: "vikunja-x", Body: "You have a new notification. Open vikunja-x to view it.", URL: strings.TrimRight(config.ServicePublicURL.GetString(), "/") + "/"}
	if s.Language == "zh-CN" {
		p.Body = "你有一条新通知，请打开 vikunja-x 查看。"
	}
	if n == nil {
		p.Body = "Bark test notification. Your personal push connection is working."
		if s.Language == "zh-CN" {
			p.Body = "Bark 测试通知：你的个人推送连接已接通。"
		}
		return p
	}
	var data struct {
		Task *struct {
			ID    int64  `json:"id"`
			Title string `json:"title"`
		} `json:"task"`
	}
	raw, err := json.Marshal(n.Notification)
	if err == nil {
		_ = json.Unmarshal(raw, &data)
	}
	if n.Name == "task.reminder" {
		p.Body = "A task reminder is due. Open vikunja-x to view it."
		if s.Language == "zh-CN" {
			p.Body = "任务提醒时间到了，请打开 vikunja-x 查看。"
		}
	}
	if data.Task != nil {
		if data.Task.ID > 0 {
			p.URL = strings.TrimRight(config.ServicePublicURL.GetString(), "/") + "/tasks/" + strconv.FormatInt(data.Task.ID, 10)
		}
		if s.Preview && data.Task.Title != "" {
			title := []rune(data.Task.Title)
			if len(title) > 240 {
				title = title[:240]
			}
			p.Body += "\n" + string(title)
		}
	}
	return p
}
func Test(ctx context.Context, uid int64) (BarkStatus, error) {
	defer cleanupRevokedAccount(uid)
	lock.Lock()
	r, e := read(uid)
	if e != nil {
		lock.Unlock()
		return BarkStatus{}, e
	}
	if r.Settings.DeviceKey == "" {
		lock.Unlock()
		return BarkStatus{}, ErrInvalid
	}
	// Avoid accidental double clicks and test spam; delivery metadata survives browser refreshes.
	for _, d := range r.Deliveries {
		if d.NotificationID == 0 && time.Since(d.Updated) < 10*time.Second {
			lock.Unlock()
			return BarkStatus{}, ErrConflict
		}
	}
	requestCtx, job, e := beginDeliveryLocked(ctx, uid)
	lock.Unlock()
	if e != nil {
		return BarkStatus{}, e
	}
	defer finishDelivery(job)
	failure, _ := deliver(requestCtx, r.Settings, pushContent(r.Settings, nil))
	lock.Lock()
	defer lock.Unlock()
	if !currentDeliveryLocked(job) {
		return BarkStatus{}, ErrAccountDeleted
	}
	current, e := read(uid)
	if e != nil {
		return BarkStatus{}, e
	}
	if current.Settings.Revision != r.Settings.Revision {
		return public(current), ErrConflict
	}
	d := BarkDelivery{Status: "accepted", Attempts: 1, Updated: time.Now().UTC(), Error: failure}
	if failure != "" {
		d.Status = "failed"
	}
	appendDelivery(&current, d)
	e = write(uid, current)
	return public(current), e
}
func appendDelivery(r *record, d BarkDelivery) {
	r.Deliveries = append(r.Deliveries, d)
	// Keep pending entries; only discard oldest terminal records.
	for len(r.Deliveries) > 30 {
		index := -1
		for i, v := range r.Deliveries {
			if v.Status != "pending" {
				index = i
				break
			}
		}
		if index < 0 {
			break
		}
		r.Deliveries = append(r.Deliveries[:index], r.Deliveries[index+1:]...)
	}
}
func latestNotification(uid int64) (int64, error) {
	s := db.NewSession()
	defer s.Close()
	n := notifications.DatabaseNotification{}
	_, e := s.Where("notifiable_id = ?", uid).Desc("id").Get(&n)
	return n.ID, e
}
func enqueue(uid int64, r *record) error {
	s := db.NewSession()
	defer s.Close()
	var ns []notifications.DatabaseNotification
	if e := s.Where("notifiable_id = ? AND id > ?", uid, r.Cursor).Asc("id").Limit(30).Find(&ns); e != nil {
		return e
	}
	for _, n := range ns {
		if len(r.Deliveries) >= 30 {
			pending := 0
			for _, d := range r.Deliveries {
				if d.Status == "pending" {
					pending++
				}
			}
			if pending >= 30 {
				break
			}
		}
		r.Cursor = n.ID
		if r.Settings.Scope == "reminders" && n.Name != "task.reminder" {
			continue
		}
		appendDelivery(r, BarkDelivery{NotificationID: n.ID, Status: "pending", Updated: time.Now().UTC()})
	}
	return nil
}
func readableNotification(uid, id int64) (*notifications.DatabaseNotification, error) {
	s := db.NewSession()
	defer s.Close()
	u := &user.User{ID: uid}
	exists, e := s.Get(u)
	if e != nil || !exists {
		return nil, e
	}
	filter, e := models.NotificationProjectFilter(s, u)
	if e != nil {
		return nil, e
	}
	n := &notifications.DatabaseNotification{}
	exists, e = s.Where("id = ? AND notifiable_id = ?", id, uid).And(filter).Get(n)
	if e != nil || !exists {
		return nil, e
	}
	return n, nil
}
func processUser(ctx context.Context, uid int64) error {
	defer cleanupRevokedAccount(uid)
	lock.Lock()
	r, e := read(uid)
	if e != nil || !r.Settings.Enabled {
		lock.Unlock()
		return e
	}
	previousCursor := r.Cursor
	if e = enqueue(uid, &r); e != nil {
		lock.Unlock()
		return e
	}
	if r.Cursor != previousCursor {
		if e = write(uid, r); e != nil {
			lock.Unlock()
			return e
		}
	}
	requestCtx, job, e := beginDeliveryLocked(ctx, uid)
	lock.Unlock()
	if e != nil {
		return e
	}
	defer finishDelivery(job)
	for _, d := range r.Deliveries {
		if d.Status != "pending" || time.Now().Before(d.Next) {
			continue
		}
		n, e := readableNotification(uid, d.NotificationID)
		if e != nil {
			return e
		}
		d.Updated = time.Now().UTC()
		if n == nil {
			d.Status = "skipped"
		} else {
			d.Attempts++
			failure, retry := deliver(requestCtx, r.Settings, pushContent(r.Settings, n))
			d.Error = failure
			d.Status = "accepted"
			if failure != "" {
				d.Status = "failed"
				if retry && d.Attempts < 8 {
					d.Status = "pending"
					d.Next = d.Updated.Add(time.Duration(min(3600, 15*(1<<d.Attempts))) * time.Second)
				}
			}
		}
		lock.Lock()
		if !currentDeliveryLocked(job) {
			lock.Unlock()
			return ErrAccountDeleted
		}
		current, e := read(uid)
		if e == nil && current.Settings.Revision == r.Settings.Revision && current.Settings.Enabled {
			for i, old := range current.Deliveries {
				if old.NotificationID == d.NotificationID {
					current.Deliveries[i] = d
					break
				}
			}
			e = write(uid, current)
		}
		changed := current.Settings.Revision != r.Settings.Revision || !current.Settings.Enabled
		lock.Unlock()
		if e != nil {
			return e
		}
		if changed {
			return nil
		}
	}
	return nil
}

var started sync.Once

// Start runs once per application process. Only configured users are scanned; notifications remain the durable source.
func Start() {
	started.Do(func() {
		go func() {
			ticker := time.NewTicker(5 * time.Second)
			defer ticker.Stop()
			for range ticker.C {
				entries, e := os.ReadDir(directory())
				if os.IsNotExist(e) {
					continue
				}
				if e != nil {
					log.Error("Bark queue cannot read settings directory")
					continue
				}
				for _, entry := range entries {
					if entry.IsDir() || !strings.HasSuffix(entry.Name(), ".enc") {
						continue
					}
					uid, e := strconv.ParseInt(strings.TrimSuffix(entry.Name(), ".enc"), 10, 64)
					if e != nil || uid < 1 {
						continue
					}
					if e = processUser(context.Background(), uid); e != nil {
						log.Errorf("Bark queue failed for user %d; check storage and database health", uid)
					}
				}
			}
		}()
	})
}
