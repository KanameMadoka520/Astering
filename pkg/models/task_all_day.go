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

import "time"

// All-day values are civil labels, not instants. Keeping their canonical ISO
// representation avoids database/session/browser timezone conversion and lets
// every supported SQL engine compare date windows lexicographically.
func validateTaskAllDay(task *Task) error {
	invalid := func(message string) error {
		return InvalidFieldErrorWithMessage([]string{"all_day", "all_day_start", "all_day_end"}, message)
	}
	if !task.AllDay {
		if task.AllDayStart != "" || task.AllDayEnd != "" {
			return invalid("All-day dates require all_day=true; clear both dates when disabling all-day scheduling.")
		}
		return nil
	}
	start, err := calendarCivil(task.AllDayStart)
	if err != nil {
		return invalid("All-day start must be a valid YYYY-MM-DD date between 1970 and 9998.")
	}
	end, err := calendarCivil(task.AllDayEnd)
	if err != nil || !end.After(start) {
		return invalid("All-day end must be a valid YYYY-MM-DD date strictly after start; the end date is exclusive.")
	}
	if !task.StartDate.IsZero() || !task.EndDate.IsZero() {
		return invalid("All-day scheduling cannot contain timed start/end dates; explicitly clear them first or in the same update.")
	}
	if task.RepeatMode != TaskRepeatModeMonth && task.RepeatAfter%86400 != 0 {
		return invalid("All-day repeat intervals must be a whole number of civil days; use 86400 for daily or 604800 for weekly.")
	}
	return nil
}

// Repeat by civil labels in UTC, using the account's local today only for the
// catch-up/current-date anchor. No DST duration is used for the date arithmetic.
func repeatTaskAllDay(oldTask, task *Task, today time.Time) error {
	start, err := calendarCivil(oldTask.AllDayStart)
	if err != nil {
		return err
	}
	end, err := calendarCivil(oldTask.AllDayEnd)
	if err != nil {
		return err
	}
	durationDays := int((end.Unix() - start.Unix()) / 86400)
	day, err := calendarCivil(today.Format(time.DateOnly))
	if err != nil {
		return err
	}
	switch oldTask.RepeatMode {
	case TaskRepeatModeMonth:
		firstNext := time.Date(start.Year(), start.Month()+1, 1, 0, 0, 0, 0, time.UTC)
		lastDay := firstNext.AddDate(0, 1, -1).Day()
		start = firstNext.AddDate(0, 0, min(start.Day(), lastDay)-1)
	case TaskRepeatModeFromCurrentDate:
		start = day.AddDate(0, 0, int(oldTask.RepeatAfter/86400))
	case TaskRepeatModeDefault:
		interval := oldTask.RepeatAfter / 86400
		if interval <= 0 {
			return nil
		}
		steps := max(int64(1), (day.Unix()-start.Unix())/(86400*interval)+1)
		start = start.AddDate(0, 0, int(steps*interval))
	}
	task.AllDayStart = start.Format(time.DateOnly)
	task.AllDayEnd = start.AddDate(0, 0, durationDays).Format(time.DateOnly)
	return validateTaskAllDay(task)
}
