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

package caldav

import (
	"errors"
	"strconv"
	"strings"
	"time"

	ics "github.com/arran4/golang-ical"
)

func isCivilICalProperty(prop ics.IANAProperty) bool {
	for _, value := range prop.ICalParameters["VALUE"] {
		if strings.EqualFold(value, "DATE") {
			return true
		}
	}
	return false
}

// RFC 5545 sections 3.6.2 and 3.8.2.3: VTODO uses DUE or DURATION,
// never DTEND, and DATE DTSTART requires DATE DUE. DTEND is read-only legacy compatibility.
func parseAllDayVTODO(properties map[string]ics.IANAProperty) (bool, string, string, error) {
	startProperty, hasStart := properties["DTSTART"]
	endProperty, hasEnd := properties["DUE"]
	legacyEnd, hasLegacyEnd := properties["DTEND"]
	if !hasEnd {
		endProperty, hasEnd = legacyEnd, hasLegacyEnd
	}
	if !isCivilICalProperty(startProperty) && !isCivilICalProperty(endProperty) {
		return false, "", "", nil
	}
	invalid := errors.New("all-day VTODO requires DATE DTSTART and a later DATE DUE or whole-day DURATION; DATE-TIME DUE cannot be mixed")
	if !hasStart || !isCivilICalProperty(startProperty) {
		return false, "", "", invalid
	}
	start, err := time.Parse("20060102", startProperty.Value)
	if err != nil || start.Format("20060102") != startProperty.Value || start.Year() < 1970 || start.Year() > 9998 {
		return false, "", "", invalid
	}
	end := start.AddDate(0, 0, 1)
	if hasEnd {
		if _, hasDuration := properties["DURATION"]; hasDuration {
			return false, "", "", invalid
		}
		if !isCivilICalProperty(endProperty) {
			return false, "", "", invalid
		}
		end, err = time.Parse("20060102", endProperty.Value)
		if err != nil || end.Format("20060102") != endProperty.Value {
			return false, "", "", invalid
		}
	} else if duration, ok := properties["DURATION"]; ok {
		days, valid := civilDurationDays(duration.Value)
		if !valid {
			return false, "", "", invalid
		}
		end = start.AddDate(0, 0, days)
	}
	if !end.After(start) || end.Year() > 9998 {
		return false, "", "", invalid
	}
	return true, start.Format(time.DateOnly), end.Format(time.DateOnly), nil
}

// DATE durations are calendar days/weeks, not nanoseconds; time.Duration
// cannot represent valid civil schedules longer than approximately 292 years.
func civilDurationDays(value string) (int, bool) {
	value = strings.TrimPrefix(value, "+")
	if len(value) < 3 || value[0] != 'P' {
		return 0, false
	}
	unit := value[len(value)-1]
	if unit != 'D' && unit != 'W' {
		return 0, false
	}
	digits := value[1 : len(value)-1]
	for _, digit := range digits {
		if digit < '0' || digit > '9' {
			return 0, false
		}
	}
	days, err := strconv.ParseInt(digits, 10, 32)
	if err != nil || days <= 0 {
		return 0, false
	}
	if unit == 'W' {
		days *= 7
	}
	if days > 3000000 {
		return 0, false
	}
	return int(days), true
}
