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
	"sync/atomic"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestBarkDurableQueue(t *testing.T) {
	config.InitDefaultConfig()
	log.InitLogger()
	events.Fake()
	x, err := db.CreateTestEngine()
	require.NoError(t, err)
	require.NoError(t, x.Sync2(models.GetTables()...))
	require.NoError(t, x.Sync2(&user.User{}, &notifications.DatabaseNotification{}))
	_, err = x.Insert(&user.User{ID: 987, Username: "bark-queue", Email: "bark@example.test"})
	require.NoError(t, err)
	oldPath, oldAllow := config.FilesBasePath.GetString(), config.OutgoingRequestsAllowNonRoutableIPs.GetBool()
	config.FilesBasePath.Set(t.TempDir())
	config.OutgoingRequestsAllowNonRoutableIPs.Set(true)
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath); config.OutgoingRequestsAllowNonRoutableIPs.Set(oldAllow) })
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		if calls.Add(1) == 1 {
			w.WriteHeader(503)
			return
		}
		_, _ = w.Write([]byte(`{"code":200}`))
	}))
	defer server.Close()
	r, err := read(987)
	require.NoError(t, err)
	r.Settings.Enabled = true
	r.Settings.ServerURL = server.URL
	r.Settings.DeviceKey = "queue-secret"
	require.NoError(t, write(987, r))
	n := &notifications.DatabaseNotification{NotifiableID: 987, Name: "task.reminder", ProjectID: 0, Notification: json.RawMessage(`{"task":{"id":123}}`)}
	_, err = x.Insert(n)
	require.NoError(t, err)
	require.NoError(t, processUser(context.Background(), 987))
	r, err = read(987)
	require.NoError(t, err)
	require.Len(t, r.Deliveries, 1)
	assert.Equal(t, "pending", r.Deliveries[0].Status)
	assert.Equal(t, 1, r.Deliveries[0].Attempts)
	assert.Equal(t, n.ID, r.Cursor)
	// A second scan before the durable retry deadline does not send again.
	require.NoError(t, processUser(context.Background(), 987))
	assert.EqualValues(t, 1, calls.Load())
	r.Deliveries[0].Next = time.Time{}
	require.NoError(t, write(987, r))
	require.NoError(t, processUser(context.Background(), 987))
	r, err = read(987)
	require.NoError(t, err)
	assert.Equal(t, "accepted", r.Deliveries[0].Status)
	assert.Equal(t, 2, r.Deliveries[0].Attempts)
	require.NoError(t, processUser(context.Background(), 987))
	assert.EqualValues(t, 2, calls.Load())
	// Inaccessible or unresolved projects and another user's notifications cannot be pushed.
	for _, v := range []*notifications.DatabaseNotification{
		{NotifiableID: 987, Name: "task.reminder", ProjectID: 999999, Notification: json.RawMessage(`{}`)},
		{NotifiableID: 987, Name: "task.reminder", ProjectID: -1, Notification: json.RawMessage(`{}`)},
		{NotifiableID: 988, Name: "task.reminder", ProjectID: 0, Notification: json.RawMessage(`{}`)},
	} {
		_, err = x.Insert(v)
		require.NoError(t, err)
	}
	require.NoError(t, processUser(context.Background(), 987))
	assert.EqualValues(t, 2, calls.Load())
	r, err = read(987)
	require.NoError(t, err)
	assert.Len(t, r.Deliveries, 3)
	assert.Equal(t, "skipped", r.Deliveries[1].Status)
	assert.Equal(t, "skipped", r.Deliveries[2].Status)
}
