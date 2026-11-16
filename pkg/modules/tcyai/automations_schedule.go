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

package tcyai

import (
	"fmt"
	"slices"
	"strconv"
	"strings"
	"time"
)

type AutomationSchedule struct {
	Kind            string `json:"kind" enum:"once,daily,weekdays,weekly,monthly,yearly,interval" doc:"Civil-time recurrence; missing monthly/yearly dates and DST gaps are skipped, never shifted."`
	At              string `json:"at,omitempty" doc:"RFC3339 absolute instant for once only."`
	Time            string `json:"time,omitempty" pattern:"^[0-2][0-9]:[0-5][0-9]$" doc:"Local HH:mm in the automation timezone for civil-time recurrence."`
	Weekdays        []int  `json:"weekdays,omitempty" maxItems:"7" uniqueItems:"true" doc:"Weekly recurrence only: Sunday=0 through Saturday=6."`
	Day             int    `json:"day,omitempty" minimum:"0" maximum:"31" doc:"Monthly/yearly day, 1..31. Months without the date are skipped."`
	Month           int    `json:"month,omitempty" minimum:"0" maximum:"12" doc:"Yearly month, 1..12."`
	IntervalMinutes int    `json:"interval_minutes,omitempty" minimum:"0" maximum:"525600" doc:"Interval recurrence, 1..525600 minutes. Missed slots coalesce into one execution."`
}

func validateAutomationSchedule(s AutomationSchedule, timezone string) error {
	if strings.TrimSpace(timezone) == "" || timezone == "Local" {
		return ErrAutomationInvalid
	}
	if _, err := time.LoadLocation(timezone); err != nil {
		return ErrAutomationInvalid
	}
	if s.Kind == "once" {
		return validateAutomationOnce(s)
	}
	if s.Kind == "interval" {
		if s.IntervalMinutes < 1 || s.IntervalMinutes > 525600 || s.At != "" || s.Time != "" || len(s.Weekdays) > 0 || s.Day != 0 || s.Month != 0 {
			return ErrAutomationInvalid
		}
		return nil
	}
	clock, err := time.Parse("15:04", s.Time)
	if err != nil || clock.Format("15:04") != s.Time || s.At != "" || s.IntervalMinutes != 0 {
		return ErrAutomationInvalid
	}
	switch s.Kind {
	case "daily", "weekdays":
		if s.Day != 0 || s.Month != 0 || len(s.Weekdays) > 0 {
			return ErrAutomationInvalid
		}
	case "weekly":
		return validateAutomationWeekly(s)
	case "monthly":
		if s.Day < 1 || s.Day > 31 || s.Month != 0 || len(s.Weekdays) > 0 {
			return ErrAutomationInvalid
		}
	case "yearly":
		return validateAutomationYearly(s)
	default:
		return ErrAutomationInvalid
	}
	return nil
}

func validateAutomationOnce(s AutomationSchedule) error {
	at, err := time.Parse(time.RFC3339, s.At)
	if err != nil || at.IsZero() || s.Time != "" || len(s.Weekdays) > 0 || s.Day != 0 || s.Month != 0 || s.IntervalMinutes != 0 {
		return ErrAutomationInvalid
	}
	return nil
}
func validateAutomationWeekly(s AutomationSchedule) error {
	if s.Day != 0 || s.Month != 0 || len(s.Weekdays) == 0 {
		return ErrAutomationInvalid
	}
	seen := map[int]bool{}
	for _, day := range s.Weekdays {
		if day < 0 || day > 6 || seen[day] {
			return ErrAutomationInvalid
		}
		seen[day] = true
	}
	return nil
}
func validateAutomationYearly(s AutomationSchedule) error {
	if s.Day < 1 || s.Day > 31 || s.Month < 1 || s.Month > 12 || len(s.Weekdays) > 0 {
		return ErrAutomationInvalid
	}
	candidate := time.Date(2024, time.Month(s.Month), s.Day, 0, 0, 0, 0, time.UTC)
	if int(candidate.Month()) != s.Month {
		return ErrAutomationInvalid
	}
	return nil
}

// NextAutomationRun is strictly after the cursor. Repeated DST wall times run once;
// nonexistent wall times and nonexistent civil dates do not acquire a surprise slot.
func NextAutomationRun(s AutomationSchedule, timezone string, after time.Time) (*time.Time, error) {
	if err := validateAutomationSchedule(s, timezone); err != nil {
		return nil, err
	}
	if s.Kind == "once" {
		at, _ := time.Parse(time.RFC3339, s.At)
		if at.After(after) {
			at = at.UTC()
			return &at, nil
		}
		return nil, nil
	}
	if s.Kind == "interval" {
		next := after.UTC().Add(time.Duration(s.IntervalMinutes) * time.Minute)
		return &next, nil
	}
	location, _ := time.LoadLocation(timezone)
	parts := strings.Split(s.Time, ":")
	hour, _ := strconv.Atoi(parts[0])
	minute, _ := strconv.Atoi(parts[1])
	local := after.In(location)
	// Eight years covers February 29 around the non-leap century boundary.
	for offset := 0; offset < 366*8; offset++ {
		day := time.Date(local.Year(), local.Month(), local.Day()+offset, 12, 0, 0, 0, location)
		if s.Kind == "weekdays" && (day.Weekday() == time.Saturday || day.Weekday() == time.Sunday) {
			continue
		}
		if s.Kind == "weekly" && !slices.Contains(s.Weekdays, int(day.Weekday())) {
			continue
		}
		if (s.Kind == "monthly" || s.Kind == "yearly") && day.Day() != s.Day {
			continue
		}
		if s.Kind == "yearly" && int(day.Month()) != s.Month {
			continue
		}
		at := time.Date(day.Year(), day.Month(), day.Day(), hour, minute, 0, 0, location)
		if at.Day() != day.Day() || at.Month() != day.Month() || at.Hour() != hour || at.Minute() != minute {
			continue
		}
		if at.After(after) {
			at = at.UTC()
			return &at, nil
		}
	}
	return nil, fmt.Errorf("%w: no schedule occurrence within eight years", ErrAutomationInvalid)
}
