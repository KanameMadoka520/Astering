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

package models

import (
	"net/http"
	"time"

	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
)

type ErrRoutineReminderSchedule struct{}

func (ErrRoutineReminderSchedule) Error() string {
	return "A reminder falls outside the routine's shortest period. Use a time at or before the period end that fits every period, or remove the reminder before changing the schedule."
}

func (e ErrRoutineReminderSchedule) HTTPError() web.HTTPError {
	return web.HTTPError{
		HTTPCode: http.StatusUnprocessableEntity,
		Code:     20004,
		Message:  e.Error(),
	}
}

func updateRoutineReminderDates(s *xorm.Session, task *Task, now time.Time) error {
	var routine *TaskRoutine
	var shortestPeriod time.Duration
	for _, reminder := range task.Reminders {
		if reminder.RelativeTo != ReminderRelationRoutinePeriodEnd {
			continue
		}
		if routine == nil {
			routine = &TaskRoutine{}
			exists, err := s.ID(task.ID).Get(routine)
			if err != nil {
				return err
			}
			if !exists {
				return InvalidFieldErrorWithMessage([]string{"reminders"}, "A period-end reminder requires a configured routine")
			}
			if err = routine.setPeriod(now); err != nil {
				return err
			}
			shortestPeriod, err = shortestRoutineReminderPeriod(routine, now)
			if err != nil {
				return err
			}
		}
		if err := validateRoutineReminderOffset(reminder, shortestPeriod); err != nil {
			return err
		}
		var err error
		reminder.Reminder, err = routineReminderDate(routine, reminder)
		if err != nil {
			return err
		}
	}
	return nil
}

func routineReminderDate(routine *TaskRoutine, reminder *TaskReminder) (time.Time, error) {
	if reminder.RelativePeriod > 0 || reminder.RelativePeriod < -MaxTaskRepeatAfterSeconds {
		return time.Time{}, ErrRoutineReminderSchedule{}
	}
	trigger := routine.NextResetAt.Add(time.Duration(reminder.RelativePeriod) * time.Second)
	if trigger.Before(routine.PeriodStartAt) {
		return time.Time{}, ErrRoutineReminderSchedule{}
	}
	return trigger, nil
}

func validateRoutineReminderSchedule(s *xorm.Session, routine *TaskRoutine) error {
	reminders := []*TaskReminder{}
	if err := s.Where("task_id = ? AND relative_to = ?", routine.TaskID, ReminderRelationRoutinePeriodEnd).Find(&reminders); err != nil {
		return err
	}
	if len(reminders) == 0 {
		return nil
	}
	shortestPeriod, err := shortestRoutineReminderPeriod(routine, time.Now())
	if err != nil {
		return err
	}
	for _, reminder := range reminders {
		if err = validateRoutineReminderOffset(reminder, shortestPeriod); err != nil {
			return err
		}
		if _, err := routineReminderDate(routine, reminder); err != nil {
			return err
		}
	}
	return nil
}

func validateRoutineReminderOffset(reminder *TaskReminder, shortestPeriod time.Duration) error {
	if reminder.RelativePeriod > 0 || reminder.RelativePeriod < -int64(shortestPeriod/time.Second) {
		return ErrRoutineReminderSchedule{}
	}
	return nil
}

// Calendar months can be only 28 days. Inspect eight years of actual local
// boundaries to include leap years and the timezone database's upcoming clock
// changes. Fixed future zones need no scan. This runs on writes, never on reads
// or the minute notification scan; future political timezone changes cannot be
// predicted beyond the installed timezone database.
func shortestRoutineReminderPeriod(routine *TaskRoutine, now time.Time) (time.Duration, error) {
	shortest := 24 * time.Hour
	switch routine.Period {
	case "weekly":
		shortest *= 7
	case "monthly":
		shortest *= 28
	}
	loc, err := time.LoadLocation(routine.Timezone)
	if err != nil {
		return 0, err
	}
	if _, end := now.In(loc).ZoneBounds(); end.IsZero() {
		return shortest, nil
	}
	candidate := *routine
	end := now.AddDate(8, 0, 0)
	for cursor := now; cursor.Before(end); cursor = candidate.NextResetAt {
		if err = candidate.setPeriod(cursor); err != nil {
			return 0, err
		}
		shortest = min(shortest, candidate.NextResetAt.Sub(candidate.PeriodStartAt))
	}
	return shortest, nil
}

// Read projections never rewrite stored reminders or their scheduling identities.
// An invalid historical offset has no projected date, so the UI can request repair
// instead of presenting a stale instant as an active reminder.
func projectRoutineReminderDates(s *xorm.Session, reminders []*TaskReminder, now time.Time) error {
	ids := []int64{}
	seen := make(map[int64]bool)
	for _, reminder := range reminders {
		if reminder.RelativeTo == ReminderRelationRoutinePeriodEnd && !seen[reminder.TaskID] {
			ids = append(ids, reminder.TaskID)
			seen[reminder.TaskID] = true
		}
	}
	if len(ids) == 0 {
		return nil
	}
	routines := make(map[int64]*TaskRoutine, len(ids))
	for start := 0; start < len(ids); start += 500 {
		rows := []*TaskRoutine{}
		if err := s.In("task_id", ids[start:min(start+500, len(ids))]).Find(&rows); err != nil {
			return err
		}
		for _, routine := range rows {
			if err := routine.setPeriod(now); err != nil {
				return err
			}
			routines[routine.TaskID] = routine
		}
	}
	for _, reminder := range reminders {
		if reminder.RelativeTo != ReminderRelationRoutinePeriodEnd {
			continue
		}
		reminder.Reminder = time.Time{}
		if routine := routines[reminder.TaskID]; routine != nil {
			// Invalid offsets stay visible by identity with an absent projected date.
			reminder.Reminder, _ = routineReminderDate(routine, reminder)
		}
	}
	return nil
}

// Period reminders are evaluated from the calendar, never from a once-persisted absolute date.
func routineRemindersDue(s *xorm.Session, now, until time.Time) ([]*TaskReminder, error) {
	rows := []*TaskReminder{}
	err := s.Join("INNER", "tasks", "tasks.id = task_reminders.task_id").
		Where("task_reminders.relative_to = ?", ReminderRelationRoutinePeriodEnd).
		And("tasks.done = false").
		And("tasks.deleted_at IS NULL").Find(&rows)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return nil, nil
	}
	ids := make([]int64, 0, len(rows))
	for _, row := range rows {
		ids = append(ids, row.TaskID)
	}
	routines := map[int64]*TaskRoutine{}
	for start := 0; start < len(ids); start += 500 {
		chunk := []*TaskRoutine{}
		if err = s.In("task_id", ids[start:min(start+500, len(ids))]).Find(&chunk); err != nil {
			return nil, err
		}
		for _, routine := range chunk {
			routines[routine.TaskID] = routine
		}
	}
	due := []*TaskReminder{}
	for _, row := range rows {
		routine := routines[row.TaskID]
		if routine == nil || !routine.Enabled || routine.Paused || row.RelativePeriod > 0 || row.RelativePeriod < -MaxTaskRepeatAfterSeconds {
			continue
		}
		candidate := *routine
		offset := time.Duration(row.RelativePeriod) * time.Second
		// The end instant belongs to the following period; read immediately before it.
		if err = candidate.setPeriod(now.Add(-offset).Add(-time.Nanosecond)); err != nil {
			return nil, err
		}
		trigger := candidate.NextResetAt.Add(offset)
		if trigger.Before(candidate.PeriodStartAt) || trigger.Before(now) || !trigger.Before(until) {
			continue
		}
		if err = candidate.readPeriodState(s, candidate.NextResetAt.Add(-time.Nanosecond)); err != nil {
			return nil, err
		}
		if candidate.CompletedPeriod {
			continue
		}
		reminder := *row
		reminder.Reminder = trigger
		due = append(due, &reminder)
	}
	return due, nil
}
