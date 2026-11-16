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
	"encoding/json"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/stretchr/testify/assert"
)

func TestBarkAutomationReminderScopeAndPrivacy(t *testing.T) {
	oldURL := config.ServicePublicURL.GetString()
	config.ServicePublicURL.Set("https://astering.example/")
	t.Cleanup(func() { config.ServicePublicURL.Set(oldURL) })
	reminder := &notifications.DatabaseNotification{
		Name:         "ai.automation",
		Notification: json.RawMessage(`{"automation_id":"private-id","kind":"reminder","title":"private title","message":"private reminder text"}`),
	}
	agent := &notifications.DatabaseNotification{
		Name:         "ai.automation",
		Notification: json.RawMessage(`{"automation_id":"private-id","kind":"agent","title":"private title","message":"sensitive upstream output must never be pushed"}`),
	}
	assert.True(t, isReminderNotification(reminder))
	assert.False(t, isReminderNotification(agent))
	assert.True(t, isReminderNotification(&notifications.DatabaseNotification{Name: "task.reminder"}))
	assert.False(t, isReminderNotification(&notifications.DatabaseNotification{
		Name:         "other",
		Notification: reminder.Notification,
	}))
	for _, language := range []string{
		"en",
		"zh-CN",
	} {
		hidden := pushContent(BarkSettings{
			Language: language,
			Preview:  false,
		}, reminder)
		assert.NotContains(t, hidden.Body, "private")
		assert.Equal(t, "https://astering.example/automations/private-id", hidden.URL)
		preview := pushContent(BarkSettings{
			Language: language,
			Preview:  true,
		}, reminder)
		assert.Contains(t, preview.Body, "private title")
		assert.Contains(t, preview.Body, "private reminder text")
		result := pushContent(BarkSettings{
			Language: language,
			Preview:  true,
		}, agent)
		assert.Contains(t, result.Body, "private title")
		assert.NotContains(t, result.Body, "sensitive upstream")
	}
}
