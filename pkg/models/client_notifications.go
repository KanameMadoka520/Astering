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
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

const (
	clientTaskLimit         = 200
	clientReminderLimit     = 512
	clientNotificationLimit = 50
)

// These types are read projections, never persistent models or raw task payloads.
type ClientNotificationTask struct {
	ID          int64      `json:"id" doc:"Existing task ID for an authenticated deep link."`
	ProjectID   int64      `json:"project_id"`
	Title       string     `json:"title" doc:"At most 100 Unicode characters of the title; open the existing task for the full text."`
	StartAt     *time.Time `json:"start_at" doc:"Stored start instant, null when unset."`
	EndAt       *time.Time `json:"end_at" doc:"Stored end instant, null when unset; never treated as a deadline."`
	DueAt       *time.Time `json:"due_at" doc:"Independent stored deadline, null when unset."`
	AllDay      bool       `json:"all_day"`
	AllDayStart string     `json:"all_day_start" doc:"Explicit inclusive civil date, unchanged across timezones."`
	AllDayEnd   string     `json:"all_day_end" doc:"Explicit exclusive civil date."`
	UpdatedAt   time.Time  `json:"updated_at"`
}

type ClientNotificationReminder struct {
	Key           string    `json:"key" doc:"Stable reminder identity. Deduplicate by key plus trigger_at, not key alone."`
	Source        string    `json:"source" enum:"explicit,start,due" doc:"Explicit saved reminder or optional default start/deadline notification; trigger_at remains the actual instant."`
	TaskID        int64     `json:"task_id"`
	ProjectID     int64     `json:"project_id"`
	Title         string    `json:"title"`
	TriggerAt     time.Time `json:"trigger_at" doc:"Actual current stored or projected routine-period reminder instant."`
	TaskUpdatedAt time.Time `json:"task_updated_at" doc:"Task version hint for replacing scheduled notifications."`
}

type ClientUnreadNotification struct {
	ID                int64      `json:"id" doc:"Stable persisted notification ID, never a task ID."`
	Name              string     `json:"name" doc:"Event type only; raw event JSON and comment text are never returned."`
	CreatedAt         time.Time  `json:"created_at"`
	ProjectID         int64      `json:"project_id" doc:"0 for account-scoped notifications; otherwise a currently readable project."`
	ReminderKey       string     `json:"reminder_key,omitempty" doc:"Optional verified reminder identity, only for task.reminder events; absent on legacy or oversized payloads."`
	ReminderTriggerAt *time.Time `json:"reminder_trigger_at,omitempty" doc:"Optional matching actual reminder instant. Silence only if this exact event was already delivered locally."`
}

type ClientNotificationCounts struct {
	PersonalOpen        int64 `json:"personal_open"`
	Overdue             int64 `json:"overdue" doc:"Open personal tasks with an actual deadline before generated_at."`
	DueInWindow         int64 `json:"due_in_window" doc:"Open personal deadlines from generated_at inclusive to horizon_end exclusive."`
	Upcoming            int64 `json:"upcoming" doc:"Open personal start/end points or explicit all-day spans in the window. May overlap deadline categories."`
	UnreadNotifications int64 `json:"unread_notifications" doc:"Full currently authorized unread count, independent of the capped metadata list."`
}

type ClientNotificationSnapshot struct {
	SchemaVersion         int                          `json:"schema_version"`
	UserID                int64                        `json:"user_id"`
	GeneratedAt           time.Time                    `json:"generated_at"`
	Timezone              string                       `json:"timezone"`
	HorizonEnd            time.Time                    `json:"horizon_end" doc:"Exclusive seven-day scheduling horizon."`
	ValidUntil            time.Time                    `json:"valid_until" doc:"Snapshot authorization freshness, at most 24 hours and no later than token expiry."`
	Counts                ClientNotificationCounts     `json:"counts"`
	Tasks                 []ClientNotificationTask     `json:"tasks"`
	TasksComplete         bool                         `json:"tasks_complete" doc:"False means omitted tasks must not cancel previously scheduled task alarms."`
	Reminders             []ClientNotificationReminder `json:"reminders"`
	RemindersComplete     bool                         `json:"reminders_complete" doc:"False means omitted reminders must not cancel previously scheduled reminder alarms."`
	Notifications         []ClientUnreadNotification   `json:"notifications"`
	NotificationsComplete bool                         `json:"notifications_complete"`
	NewestNotificationID  int64                        `json:"newest_notification_id" doc:"Latest currently visible persisted notification ID, including already-read rows; baseline only, never mark-read."`
}

// Project subscriptions use the canonical nearest-ancestor/mute resolver once
// per project, not once per task. Direct task rows then override inheritance.
// The final personal condition is applied before counts, limits or projection.
func clientPersonalTasksCondition(s *xorm.Session, actor *user.User) (builder.Cond, error) {
	access, err := getProjectAccessForUser(s, actor.ID)
	if err != nil {
		return nil, err
	}
	subscribedProjects := []int64{}
	for start := 0; start < len(access.sortedIDs); start += 200 {
		rows, err := GetSubscriptionsForEntitiesAndUser(s, SubscriptionEntityProject, access.sortedIDs[start:min(start+200, len(access.sortedIDs))], actor)
		if err != nil {
			return nil, err
		}
		for id, subscriptions := range rows {
			if len(subscriptions) > 0 {
				subscribedProjects = append(subscribedProjects, id)
			}
		}
	}
	assigned := builder.Select("task_id").From("task_assignees").Where(builder.Eq{"user_id": actor.ID})
	direct := func(muted bool) *builder.Builder {
		return builder.Select("entity_id").From("subscriptions").Where(builder.Eq{
			"user_id":     actor.ID,
			"entity_type": SubscriptionEntityTask,
			"muted":       muted,
		})
	}
	return builder.Or(
		builder.Eq{"tasks.created_by_id": actor.ID},
		builder.In("tasks.id", assigned),
		builder.In("tasks.id", direct(false)),
		builder.And(builder.In("tasks.project_id", subscribedProjects), builder.NotIn("tasks.id", direct(true))),
	), nil
}

func clientInstant(value time.Time) *time.Time {
	if value.IsZero() || value.Year() < 1970 {
		return nil
	}
	utc := value.UTC()
	return &utc
}

func clientUpcomingCondition(now, end time.Time, loc *time.Location) builder.Cond {
	from, until := now.UTC().Format(dbTimeFormat), end.UTC().Format(dbTimeFormat)
	return builder.Or(
		builder.And(builder.Gte{"tasks.start_date": from}, builder.Lt{"tasks.start_date": until}),
		builder.And(builder.Gte{"tasks.end_date": from}, builder.Lt{"tasks.end_date": until}),
		builder.And(builder.Eq{"tasks.all_day": true}, builder.Lte{"tasks.all_day_start": end.In(loc).Format(time.DateOnly)}, builder.Gt{"tasks.all_day_end": now.In(loc).Format(time.DateOnly)}),
	)
}

// GetClientNotificationSnapshot is a private read-only projection. The account
// and every resource ACL are checked again; instance administration adds no access.
func GetClientNotificationSnapshot(s *xorm.Session, actor *user.User, now, validUntil time.Time) (*ClientNotificationSnapshot, error) {
	if actor == nil || actor.ID <= 0 || actor.IsBot() || actor.HasResourceOnlyPermissions() {
		return nil, ErrGenericForbidden{}
	}
	current, err := user.GetUserByIDForAuth(s, actor.ID)
	if err != nil {
		return nil, err
	}
	if current.IsBot() {
		return nil, ErrGenericForbidden{}
	}
	loc, err := calendarTimezone(s, actor, "")
	if err != nil {
		return nil, err
	}
	access, err := accessibleProjectIDsCond(s, actor, "projects.id")
	if err != nil {
		return nil, err
	}
	personal, err := clientPersonalTasksCondition(s, actor)
	if err != nil {
		return nil, err
	}
	base := builder.And(access, personal, taskNotDeletedCond("tasks"), builder.Eq{"projects.is_archived": false},
		builder.Or(builder.Eq{"tasks.done": false}, builder.IsNull{"tasks.done"}))
	query := func(extra builder.Cond) *xorm.Session {
		return s.Table("tasks").Join("INNER", "projects", "projects.id = tasks.project_id").Where(builder.And(base, extra))
	}
	now = now.UTC()
	end := now.Add(7 * 24 * time.Hour)
	validUntil = minTime(validUntil, now.Add(24*time.Hour))
	out := &ClientNotificationSnapshot{
		SchemaVersion:         1,
		UserID:                actor.ID,
		GeneratedAt:           now,
		Timezone:              loc.String(),
		HorizonEnd:            end,
		ValidUntil:            validUntil.UTC(),
		Tasks:                 []ClientNotificationTask{},
		Reminders:             []ClientNotificationReminder{},
		Notifications:         []ClientUnreadNotification{},
		TasksComplete:         true,
		RemindersComplete:     true,
		NotificationsComplete: true,
	}
	zero := time.Time{}.UTC().Format(dbTimeFormat)
	overdue := builder.And(builder.Gt{"tasks.due_date": zero}, builder.Lt{"tasks.due_date": now.Format(dbTimeFormat)})
	due := builder.And(builder.Gte{"tasks.due_date": now.Format(dbTimeFormat)}, builder.Lt{"tasks.due_date": end.Format(dbTimeFormat)})
	upcoming := clientUpcomingCondition(now, end, loc)
	for _, entry := range []struct {
		target *int64
		cond   builder.Cond
	}{
		{
			target: &out.Counts.PersonalOpen,
			cond:   builder.NewCond(),
		},
		{
			target: &out.Counts.Overdue,
			cond:   overdue,
		},
		{
			target: &out.Counts.DueInWindow,
			cond:   due,
		},
		{
			target: &out.Counts.Upcoming,
			cond:   upcoming,
		},
	} {
		*entry.target, err = query(entry.cond).Count()
		if err != nil {
			return nil, err
		}
	}
	rows := []CalendarTask{}
	err = query(builder.Or(overdue, due, upcoming)).Select("tasks.id, tasks.project_id, SUBSTR(tasks.title, 1, 100) AS title, tasks.start_date, tasks.end_date, tasks.due_date, tasks.all_day, tasks.all_day_start, tasks.all_day_end, tasks.updated").OrderBy("tasks.id ASC").Limit(clientTaskLimit + 1).Find(&rows)
	if err != nil {
		return nil, err
	}
	out.TasksComplete = len(rows) <= clientTaskLimit
	for _, row := range rows[:min(len(rows), clientTaskLimit)] {
		out.Tasks = append(out.Tasks, ClientNotificationTask{
			ID:          row.ID,
			ProjectID:   row.ProjectID,
			Title:       row.Title,
			StartAt:     clientInstant(row.StartDate),
			EndAt:       clientInstant(row.EndDate),
			DueAt:       clientInstant(row.DueDate),
			AllDay:      row.AllDay,
			AllDayStart: row.AllDayStart,
			AllDayEnd:   row.AllDayEnd,
			UpdatedAt:   row.Updated.UTC(),
		})
	}
	if err := clientSnapshotReminders(s, base, now, end, out); err != nil {
		return nil, err
	}
	if err := clientSnapshotDateReminders(s, base, now, end, out); err != nil {
		return nil, err
	}
	if err := clientSnapshotUnread(s, actor, out); err != nil {
		return nil, err
	}
	return out, nil
}

func minTime(left, right time.Time) time.Time {
	if left.IsZero() || right.Before(left) {
		return right
	}
	return left
}

func clientSnapshotReminders(s *xorm.Session, base builder.Cond, now, end time.Time, out *ClientNotificationSnapshot) error {
	type row struct {
		TaskReminder `xorm:"extends"`
		Title        string
		ProjectID    int64
		TaskUpdated  time.Time
	}
	// Scan past inactive/completed periods, rather than letting low-ID stale
	// rows permanently starve later valid reminders on every poll.
	var cursor int64
	routines := map[int64]*TaskRoutine{}
	for {
		rows := []row{}
		err := s.Table("task_reminders").Join("INNER", "tasks", "tasks.id = task_reminders.task_id").Join("INNER", "projects", "projects.id = tasks.project_id").
			Where(builder.And(base, builder.Gt{"task_reminders.id": cursor}, builder.Or(
				builder.And(builder.Eq{"task_reminders.relative_to": ReminderRelationRoutinePeriodEnd}, builder.In("tasks.id", builder.Select("task_id").From("task_routines").Where(builder.Eq{
					"enabled": true,
					"paused":  false,
				}))),
				builder.And(builder.Or(builder.Neq{"task_reminders.relative_to": ReminderRelationRoutinePeriodEnd}, builder.IsNull{"task_reminders.relative_to"}), builder.Gte{"task_reminders.reminder": now.Format(dbTimeFormat)}, builder.Lt{"task_reminders.reminder": end.Format(dbTimeFormat)}),
			))).Select("task_reminders.*, SUBSTR(tasks.title, 1, 100) AS title, tasks.project_id, tasks.updated AS task_updated").OrderBy("task_reminders.id ASC").Limit(200).Find(&rows)
		if err != nil {
			return err
		}
		for _, item := range rows {
			cursor = item.ID
			trigger := item.Reminder
			if item.RelativeTo == ReminderRelationRoutinePeriodEnd {
				routine, cached := routines[item.TaskID]
				if !cached {
					routine = &TaskRoutine{}
					found, err := s.ID(item.TaskID).Get(routine)
					if err != nil {
						return err
					}
					if !found {
						continue
					}
					if err := routine.readPeriodState(s, now); err != nil {
						return err
					}
					routines[item.TaskID] = routine
				}
				if !routine.Enabled || routine.Paused || routine.CompletedPeriod {
					continue
				}
				trigger, err = routineReminderDate(routine, &item.TaskReminder)
				if err != nil {
					continue
				}
			}
			if trigger.Before(now) || !trigger.Before(end) {
				continue
			}
			out.Reminders = append(out.Reminders, ClientNotificationReminder{
				Key:           "reminder:" + strconv.FormatInt(item.ID, 10),
				Source:        "explicit",
				TaskID:        item.TaskID,
				ProjectID:     item.ProjectID,
				Title:         item.Title,
				TriggerAt:     trigger.UTC(),
				TaskUpdatedAt: item.TaskUpdated.UTC(),
			})
			if len(out.Reminders) > clientReminderLimit {
				out.RemindersComplete = false
				out.Reminders = out.Reminders[:clientReminderLimit]
				return nil
			}
		}
		if len(rows) < 200 {
			return nil
		}
	}
}

func clientSnapshotDateReminders(s *xorm.Session, base builder.Cond, now, end time.Time, out *ClientNotificationSnapshot) error {
	from, until := now.Format(dbTimeFormat), end.Format(dbTimeFormat)
	rows := []CalendarTask{}
	err := s.Table("tasks").Join("INNER", "projects", "projects.id = tasks.project_id").Where(builder.And(base,
		builder.NotIn("tasks.id", builder.Select("task_id").From("task_reminders")),
		builder.Or(
			builder.And(builder.Eq{"tasks.all_day": false}, builder.Gte{"tasks.start_date": from}, builder.Lt{"tasks.start_date": until}),
			builder.And(builder.Gte{"tasks.due_date": from}, builder.Lt{"tasks.due_date": until}),
		),
	)).Select("tasks.id, tasks.project_id, SUBSTR(tasks.title, 1, 100) AS title, tasks.start_date, tasks.due_date, tasks.all_day, tasks.updated").OrderBy("tasks.id ASC").Limit(clientReminderLimit + 1).Find(&rows)
	if err != nil {
		return err
	}
	if len(rows) > clientReminderLimit {
		out.RemindersComplete = false
	}
	for _, row := range rows[:min(len(rows), clientReminderLimit)] {
		for _, point := range []struct {
			source  string
			trigger time.Time
		}{
			{
				source:  "start",
				trigger: row.StartDate,
			},
			{
				source:  "due",
				trigger: row.DueDate,
			},
		} {
			if point.source == "start" && row.AllDay || point.trigger.Before(now) || !point.trigger.Before(end) {
				continue
			}
			out.Reminders = append(out.Reminders, ClientNotificationReminder{
				Key:           "task:" + strconv.FormatInt(row.ID, 10) + ":" + point.source,
				Source:        point.source,
				TaskID:        row.ID,
				ProjectID:     row.ProjectID,
				Title:         row.Title,
				TriggerAt:     point.trigger.UTC(),
				TaskUpdatedAt: row.Updated.UTC(),
			})
		}
	}
	sort.Slice(out.Reminders, func(i, j int) bool {
		if out.Reminders[i].TriggerAt.Equal(out.Reminders[j].TriggerAt) {
			return out.Reminders[i].Key < out.Reminders[j].Key
		}
		return out.Reminders[i].TriggerAt.Before(out.Reminders[j].TriggerAt)
	})
	if len(out.Reminders) > clientReminderLimit {
		out.RemindersComplete = false
		out.Reminders = out.Reminders[:clientReminderLimit]
	}
	return nil
}

func clientSnapshotUnread(s *xorm.Session, actor *user.User, out *ClientNotificationSnapshot) error {
	access, err := NotificationProjectFilter(s, actor)
	if err != nil {
		return err
	}
	base := builder.And(builder.Eq{"notifiable_id": actor.ID}, access)
	unread := builder.And(base, builder.Or(builder.IsNull{"read_at"}, builder.Eq{"read_at": time.Time{}.UTC().Format(dbTimeFormat)}))
	out.Counts.UnreadNotifications, err = s.Table("notifications").Where(unread).Count()
	if err != nil {
		return err
	}
	err = s.Table("notifications").Where(unread).Select("id, name, created AS created_at, project_id").OrderBy("id DESC").Limit(clientNotificationLimit + 1).Find(&out.Notifications)
	if err != nil {
		return err
	}
	out.NotificationsComplete = len(out.Notifications) <= clientNotificationLimit
	out.Notifications = out.Notifications[:min(len(out.Notifications), clientNotificationLimit)]
	if err := clientReminderNotificationMetadata(s, out.Notifications); err != nil {
		return err
	}
	var newest struct{ ID int64 }
	_, err = s.Table("notifications").Where(base).Select("id").OrderBy("id DESC").Limit(1).Get(&newest)
	out.NewestNotificationID = newest.ID
	return err
}

func clientNotificationPayloadProjection(database schemas.DBType) string {
	// PostgreSQL stores this as json/jsonb, SQLite as text; MySQL requires
	// CHAR rather than TEXT as a CAST target. All expressions are fixed.
	if database == schemas.MYSQL {
		return "id, SUBSTR(CAST(notification AS CHAR), 1, 65537) AS payload"
	}
	return "id, SUBSTR(CAST(notification AS TEXT), 1, 65537) AS payload"
}

func clientReminderNotificationMetadata(s *xorm.Session, rows []ClientUnreadNotification) error {
	ids := []int64{}
	index := map[int64]int{}
	for i, item := range rows {
		if item.Name == "task.reminder" {
			ids = append(ids, item.ID)
			index[item.ID] = i
		}
	}
	if len(ids) == 0 {
		return nil
	}
	var payloads []struct {
		ID      int64
		Payload string
	}
	// Portable text projection limits even a huge task description in an older
	// event to 65,537 characters. Invalid/truncated/large JSON has no metadata,
	// so native delivery falls back to a generic new-notification alert.
	if err := s.Table("notifications").In("id", ids).Select(clientNotificationPayloadProjection(db.Type())).Find(&payloads); err != nil {
		return err
	}
	for _, item := range payloads {
		if len(item.Payload) > 65536 {
			continue
		}
		var metadata struct {
			Key     string     `json:"reminder_key"`
			Trigger *time.Time `json:"reminder_trigger_at"`
		}
		if json.Unmarshal([]byte(item.Payload), &metadata) != nil || metadata.Trigger == nil || metadata.Trigger.IsZero() {
			continue
		}
		id, err := strconv.ParseInt(strings.TrimPrefix(metadata.Key, "reminder:"), 10, 64)
		if err != nil || id <= 0 || metadata.Key != "reminder:"+strconv.FormatInt(id, 10) {
			continue
		}
		rows[index[item.ID]].ReminderKey = metadata.Key
		rows[index[item.ID]].ReminderTriggerAt = clientInstant(*metadata.Trigger)
	}
	return nil
}
