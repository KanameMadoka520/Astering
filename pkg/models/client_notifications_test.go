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

// Astering additions provide notification-only background capabilities.

package models

import (
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/notifications"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

func TestClientNotificationJSONProjectionCastsSupportedDialects(t *testing.T) {
	assert.Equal(t, "id, SUBSTR(CAST(notification AS TEXT), 1, 65537) AS payload", clientNotificationPayloadProjection(schemas.POSTGRES))
	assert.Equal(t, "id, SUBSTR(CAST(notification AS TEXT), 1, 65537) AS payload", clientNotificationPayloadProjection(schemas.SQLITE))
	assert.Equal(t, "id, SUBSTR(CAST(notification AS CHAR), 1, 65537) AS payload", clientNotificationPayloadProjection(schemas.MYSQL))
}

func TestClientNotificationBoundedPayloadSurvivesEscapedTitles(t *testing.T) {
	s, actor, now := clientNotificationFixture(t)
	for index := 0; index < clientReminderLimit+1; index++ {
		clientNotificationTask(t, s, Task{
			Title:       strings.Repeat("<", 2000),
			CreatedByID: 1,
			StartDate:   now.Add(time.Hour),
			DueDate:     now.Add(2 * time.Hour),
		})
	}
	for index := 0; index < clientNotificationLimit+1; index++ {
		_, err := s.Insert(&notifications.DatabaseNotification{
			NotifiableID: 1,
			Name:         strings.Repeat("<", 250),
			Notification: json.RawMessage(`{"fixture":true}`),
		})
		require.NoError(t, err)
	}
	out, err := GetClientNotificationSnapshot(s, actor, now, time.Time{})
	require.NoError(t, err)
	require.Len(t, out.Tasks, clientTaskLimit)
	require.Len(t, out.Reminders, clientReminderLimit)
	require.Len(t, out.Notifications, clientNotificationLimit)
	assert.False(t, out.TasksComplete)
	assert.False(t, out.RemindersComplete)
	assert.False(t, out.NotificationsComplete)
	data, err := json.Marshal(out)
	require.NoError(t, err)
	assert.Less(t, len(data), 768*1024, "native transport must accept the capped projection even with JSON/HTML escaping")
}

func clientNotificationFixture(t *testing.T) (*xorm.Session, *user.User, time.Time) {
	t.Helper()
	db.LoadAndAssertFixtures(t)
	s := db.NewSession()
	t.Cleanup(func() { _ = s.Close() })
	t.Cleanup(func() { events.CleanupPending(s) })
	_, err := s.Where(builder.Gt{"id": 0}).Cols("done").Update(&Task{Done: true})
	require.NoError(t, err)
	_, err = s.Where(builder.Eq{"user_id": 1}).Delete(&Subscription{})
	require.NoError(t, err)
	return s, &user.User{ID: 1}, time.Date(2026, 11, 16, 12, 0, 0, 0, time.UTC)
}

func clientNotificationJSON(t *testing.T, value any) json.RawMessage {
	t.Helper()
	encoded, err := json.Marshal(value)
	require.NoError(t, err)
	return json.RawMessage(encoded)
}

func TestClientNotificationSkipsCompletedRoutineBeforeReminderCap(t *testing.T) {
	s, actor, now := clientNotificationFixture(t)
	completed := clientNotificationTask(t, s, Task{
		Title:       "Already checked in",
		CreatedByID: 1,
	})
	routine := &TaskRoutine{
		TaskID:   completed.ID,
		Enabled:  true,
		Timezone: "Asia/Shanghai",
		Period:   "daily",
		Target:   1,
	}
	_, err := s.Insert(routine)
	require.NoError(t, err)
	require.NoError(t, routine.setPeriod(now))
	label, err := time.Parse(time.DateOnly, routine.Date)
	require.NoError(t, err)
	_, err = s.Insert(&TaskRoutineCheckin{
		TaskID:      completed.ID,
		LocalDate:   label,
		Timezone:    routine.Timezone,
		CompletedAt: now,
	})
	require.NoError(t, err)
	for index := 0; index < clientReminderLimit+1; index++ {
		_, err = s.Insert(&TaskReminder{
			TaskID:         completed.ID,
			RelativeTo:     ReminderRelationRoutinePeriodEnd,
			RelativePeriod: -60,
		})
		require.NoError(t, err)
	}
	next := clientNotificationTask(t, s, Task{
		Title:       "Later valid ordinary reminder",
		CreatedByID: 1,
	})
	_, err = s.Insert(&TaskReminder{
		TaskID:   next.ID,
		Reminder: now.Add(time.Hour),
	})
	require.NoError(t, err)
	out, err := GetClientNotificationSnapshot(s, actor, now, time.Time{})
	require.NoError(t, err)
	require.Len(t, out.Reminders, 1, "inactive low-ID rows cannot permanently starve later valid reminders")
	assert.Equal(t, next.ID, out.Reminders[0].TaskID)
	assert.True(t, out.RemindersComplete)
}

func TestClientNotificationDerivedDatesBoundedTitlesAndEventMetadata(t *testing.T) {
	s, actor, now := clientNotificationFixture(t)
	item := clientNotificationTask(t, s, Task{
		Title:       strings.Repeat("\u661f", 10000),
		CreatedByID: 1,
		StartDate:   now.Add(time.Hour),
		DueDate:     now.Add(2 * time.Hour),
		EndDate:     now.Add(3 * time.Hour),
	})
	actual := now.Add(-time.Minute)
	event := &ReminderDueNotification{
		Task: &Task{
			ID:        item.ID,
			ProjectID: 1,
			Title:     "Private full task details",
		},
		Project: &Project{ID: 1},
		TaskReminder: &TaskReminder{
			ID:       900001,
			TaskID:   item.ID,
			Reminder: actual,
		},
	}
	metadata := &notifications.DatabaseNotification{
		NotifiableID: 1,
		ProjectID:    1,
		Name:         "task.reminder",
		Notification: clientNotificationJSON(t, event.ToDB()),
	}
	_, err := s.Insert(metadata)
	require.NoError(t, err)
	event.Task.Description = strings.Repeat("PRIVATE-LARGE-BODY", 5000)
	large := &notifications.DatabaseNotification{
		NotifiableID: 1,
		ProjectID:    1,
		Name:         "task.reminder",
		Notification: clientNotificationJSON(t, event.ToDB()),
	}
	_, err = s.Insert(large)
	require.NoError(t, err)
	out, err := GetClientNotificationSnapshot(s, actor, now, time.Time{})
	require.NoError(t, err)
	require.Len(t, out.Tasks, 1)
	assert.Len(t, []rune(out.Tasks[0].Title), 100)
	require.Len(t, out.Reminders, 2)
	assert.Equal(t, "start", out.Reminders[0].Source)
	assert.Equal(t, now.Add(time.Hour), out.Reminders[0].TriggerAt)
	assert.Equal(t, "due", out.Reminders[1].Source)
	assert.Equal(t, now.Add(2*time.Hour), out.Reminders[1].TriggerAt)
	for _, row := range out.Notifications {
		if row.ID == metadata.ID {
			assert.Equal(t, "reminder:900001", row.ReminderKey)
			require.NotNil(t, row.ReminderTriggerAt)
			assert.Equal(t, actual, *row.ReminderTriggerAt)
		}
		if row.ID == large.ID {
			assert.Empty(t, row.ReminderKey)
			assert.Nil(t, row.ReminderTriggerAt, "oversized or legacy events must fall back to generic delivery, never name-based silence")
		}
	}
	data, err := json.Marshal(out)
	require.NoError(t, err)
	assert.NotContains(t, string(data), "PRIVATE-LARGE-BODY")
	assert.NotContains(t, string(data), "Private full task details")
	_, err = s.Insert(&TaskReminder{
		TaskID:   item.ID,
		Reminder: now.Add(30 * time.Minute),
	})
	require.NoError(t, err)
	out, err = GetClientNotificationSnapshot(s, actor, now, time.Time{})
	require.NoError(t, err)
	require.Len(t, out.Reminders, 1, "an explicit reminder replaces default date notifications")
	assert.Equal(t, "explicit", out.Reminders[0].Source)
}

func clientNotificationTask(t *testing.T, s *xorm.Session, item Task) Task {
	t.Helper()
	if item.ProjectID == 0 {
		item.ProjectID = 1
	}
	if item.CreatedByID == 0 {
		item.CreatedByID = 2
	}
	item.Index = time.Now().UnixNano()
	_, err := s.Insert(&item)
	require.NoError(t, err)
	return item
}

func TestClientNotificationPersonalACLSubscriptionsAndPrivacy(t *testing.T) {
	s, actor, now := clientNotificationFixture(t)
	parentID := int64(1)
	child := &Project{
		Title:           "Inherited notification project",
		ParentProjectID: &parentID,
	}
	require.NoError(t, child.Create(s, actor))
	_, err := s.Insert(&Subscription{
		EntityType: SubscriptionEntityProject,
		EntityID:   child.ID,
		UserID:     1,
	})
	require.NoError(t, err)
	created := clientNotificationTask(t, s, Task{
		Title:       "created by me",
		CreatedByID: 1,
		DueDate:     now.Add(time.Hour),
		Description: "PRIVATE-DESCRIPTION-MUST-NOT-BE-IN-SNAPSHOT",
	})
	nullOpen := clientNotificationTask(t, s, Task{
		Title:       "legacy nullable open task",
		CreatedByID: 1,
		DueDate:     now.Add(time.Hour),
	})
	_, err = s.Table("tasks").Where(builder.Eq{"id": nullOpen.ID}).Update(map[string]any{"done": nil})
	require.NoError(t, err)
	nullStored, err := s.ID(nullOpen.ID).Where(builder.IsNull{"done"}).Exist(&Task{})
	require.NoError(t, err)
	require.True(t, nullStored)
	assigned := clientNotificationTask(t, s, Task{
		Title:     "assigned to me",
		StartDate: now.Add(2 * time.Hour),
	})
	_, err = s.Insert(&TaskAssginee{
		TaskID: assigned.ID,
		UserID: 1,
	})
	require.NoError(t, err)
	followed := clientNotificationTask(t, s, Task{
		Title:     "inherited follow",
		ProjectID: child.ID,
		DueDate:   now.Add(3 * time.Hour),
	})
	muted := clientNotificationTask(t, s, Task{
		Title:     "direct mute wins",
		ProjectID: child.ID,
		DueDate:   now.Add(4 * time.Hour),
	})
	_, err = s.Insert(&Subscription{
		EntityType: SubscriptionEntityTask,
		EntityID:   muted.ID,
		UserID:     1,
		Muted:      true,
	})
	require.NoError(t, err)
	ownerOnly := clientNotificationTask(t, s, Task{
		Title:   "project ownership is not personal subscription",
		DueDate: now.Add(time.Hour),
	})
	inaccessible := clientNotificationTask(t, s, Task{
		Title:       "cannot read despite creator",
		ProjectID:   2,
		CreatedByID: 1,
		DueDate:     now.Add(time.Hour),
	})
	_, err = s.Insert(&Subscription{
		EntityType: SubscriptionEntityTask,
		EntityID:   inaccessible.ID,
		UserID:     1,
	})
	require.NoError(t, err)
	n := &notifications.DatabaseNotification{
		NotifiableID: 1,
		ProjectID:    1,
		Name:         "fixture.comment",
		Notification: clientNotificationJSON(t, map[string]string{"secret": "PRIVATE-COMMENT-MUST-NOT-BE-IN-SNAPSHOT"}),
	}
	_, err = s.Insert(n)
	require.NoError(t, err)
	revoked := &notifications.DatabaseNotification{
		NotifiableID: 1,
		ProjectID:    2,
		Name:         "PRIVATE-REVOKED-NOTIFICATION",
		Notification: clientNotificationJSON(t, map[string]string{"text": "PRIVATE-REVOKED-BODY"}),
	}
	_, err = s.Insert(revoked)
	require.NoError(t, err)
	actor.IsAdmin = true
	out, err := GetClientNotificationSnapshot(s, actor, now, now.Add(time.Hour))
	require.NoError(t, err)
	ids := []int64{}
	for _, row := range out.Tasks {
		ids = append(ids, row.ID)
	}
	assert.ElementsMatch(t, []int64{
		created.ID,
		nullOpen.ID,
		assigned.ID,
		followed.ID,
	}, ids)
	assert.NotContains(t, ids, muted.ID)
	assert.NotContains(t, ids, ownerOnly.ID)
	assert.NotContains(t, ids, inaccessible.ID)
	assert.EqualValues(t, 4, out.Counts.PersonalOpen)
	assert.Equal(t, now.Add(time.Hour), out.ValidUntil)
	data, err := json.Marshal(out)
	require.NoError(t, err)
	assert.NotContains(t, string(data), "PRIVATE-")
	assert.NotContains(t, string(data), "description")
	assert.NotContains(t, string(data), "email")
	assert.Less(t, out.NewestNotificationID, revoked.ID)
	stored, err := notifications.GetNotificationByID(s, n.ID)
	require.NoError(t, err)
	assert.True(t, stored.ReadAt.IsZero(), "GET must never mark a notification read")
}

func TestClientNotificationCapsCountsDatesAndReadOnlyRoutine(t *testing.T) {
	s, actor, now := clientNotificationFixture(t)
	for index := 0; index < clientTaskLimit+1; index++ {
		clientNotificationTask(t, s, Task{
			Title:       "Open deadline",
			CreatedByID: 1,
			DueDate:     now.Add(time.Hour),
		})
	}
	endOnly := clientNotificationTask(t, s, Task{
		Title:       "past end is not a deadline",
		CreatedByID: 1,
		EndDate:     now.Add(-time.Hour),
	})
	routineTask := clientNotificationTask(t, s, Task{
		Title:       "current routine",
		CreatedByID: 1,
	})
	routine := &TaskRoutine{
		TaskID:   routineTask.ID,
		Enabled:  true,
		Timezone: "Asia/Shanghai",
		Period:   "daily",
		Target:   1,
	}
	_, err := s.Insert(routine)
	require.NoError(t, err)
	reminder := &TaskReminder{
		TaskID:         routineTask.ID,
		Reminder:       now.AddDate(-1, 0, 0),
		RelativeTo:     ReminderRelationRoutinePeriodEnd,
		RelativePeriod: -60,
	}
	_, err = s.Insert(reminder)
	require.NoError(t, err)
	for index := 0; index < clientNotificationLimit+1; index++ {
		_, err = s.Insert(&notifications.DatabaseNotification{
			NotifiableID: 1,
			ProjectID:    0,
			Name:         "fixture.metadata",
			Notification: clientNotificationJSON(t, map[string]string{"private": "NEVER-SERIALIZE"}),
		})
		require.NoError(t, err)
	}
	out, err := GetClientNotificationSnapshot(s, actor, now, now.Add(72*time.Hour))
	require.NoError(t, err)
	assert.Len(t, out.Tasks, clientTaskLimit)
	assert.False(t, out.TasksComplete)
	assert.False(t, out.NotificationsComplete)
	assert.EqualValues(t, clientTaskLimit+1, out.Counts.DueInWindow)
	assert.Zero(t, out.Counts.Overdue)
	assert.Equal(t, now.Add(24*time.Hour), out.ValidUntil)
	explicit := []ClientNotificationReminder{}
	for _, item := range out.Reminders {
		if item.Source == "explicit" {
			explicit = append(explicit, item)
		}
	}
	require.Len(t, explicit, 1)
	assert.Equal(t, routineTask.ID, explicit[0].TaskID)
	assert.True(t, explicit[0].TriggerAt.After(now))
	for _, item := range out.Tasks {
		assert.NotEqual(t, endOnly.ID, item.ID)
	}
	stored := &TaskReminder{}
	_, err = s.ID(reminder.ID).Get(stored)
	require.NoError(t, err)
	assert.True(t, stored.Reminder.Equal(reminder.Reminder), "routine projection cannot rewrite stored reminder")
	_, err = s.ID(routineTask.ID).Cols("paused").Update(&TaskRoutine{Paused: true})
	require.NoError(t, err)
	out, err = GetClientNotificationSnapshot(s, actor, now, time.Time{})
	require.NoError(t, err)
	for _, item := range out.Reminders {
		assert.NotEqual(t, routineTask.ID, item.TaskID)
	}
}
