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
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBarkStorageAndPrivacy(t *testing.T) {
	oldPath, oldSecret := config.FilesBasePath.GetString(), config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("bark-test")
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.ServiceSecret.Set(oldSecret) })
	r, err := read(1)
	require.NoError(t, err)
	r.Settings.DeviceKey = "private-device-key"
	require.NoError(t, write(1, r))
	raw, err := os.ReadFile(path(1))
	require.NoError(t, err)
	assert.NotContains(t, string(raw), r.Settings.DeviceKey)
	out, err := Get(1)
	require.NoError(t, err)
	assert.True(t, out.Settings.HasKey)
	assert.Empty(t, out.Settings.DeviceKey)
	other, err := Get(2)
	require.NoError(t, err)
	assert.False(t, other.Settings.HasKey)
	changed := r.Settings
	changed.DeviceKey = ""
	same, err := validate(changed, r.Settings)
	require.NoError(t, err)
	assert.Equal(t, r.Settings.DeviceKey, same.DeviceKey)
	changed.ServerURL = "https://different.example"
	changed.Enabled = true
	_, err = validate(changed, r.Settings)
	require.Error(t, err)
	for _, bad := range []string{"http://example.com", "https://example.com/push", "https://key@example.com", "https://example.com?key=secret"} {
		changed.ServerURL = bad
		_, err = validate(changed, r.Settings)
		require.Error(t, err)
	}
	n := &notifications.DatabaseNotification{Name: "task.reminder", Notification: map[string]any{"task": map[string]any{"id": 42, "title": "private task title"}}}
	p := pushContent(r.Settings, n)
	assert.NotContains(t, p.Body, "private task title")
	assert.Contains(t, p.URL, "/tasks/42")
	r.Settings.Preview = true
	assert.Contains(t, pushContent(r.Settings, n).Body, "private task title")
}
func TestBarkTransport(t *testing.T) {
	old := config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.OutgoingRequestsAllowNonRoutableIPs.Set(old) })
	for _, tc := range []struct {
		status  int
		body    string
		failure string
		retry   bool
	}{
		{200, `{"code":200}`, "", false}, {200, `{"code":400,"message":"secret"}`, "BARK_400", false}, {503, "secret", "HTTP_503", true}, {429, "secret", "HTTP_429", true}, {400, "secret", "HTTP_400", false}, {200, "bad", "INVALID_RESPONSE", true}, {302, "secret", "HTTP_302", false},
	} {
		server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			assert.Equal(t, "/push", r.URL.Path)
			assert.Empty(t, r.URL.RawQuery)
			assert.Equal(t, "POST", r.Method)
			var p payload
			assert.NoError(t, json.NewDecoder(r.Body).Decode(&p))
			assert.Equal(t, "secret", p.DeviceKey)
			w.Header().Set("Location", "https://must-not-follow.example")
			w.WriteHeader(tc.status)
			_, _ = w.Write([]byte(tc.body))
		}))
		failure, retry := deliver(context.Background(), BarkSettings{ServerURL: server.URL, DeviceKey: "secret"}, payload{Body: "test"})
		assert.Equal(t, tc.failure, failure)
		assert.Equal(t, tc.retry, retry)
		server.Close()
	}
}
