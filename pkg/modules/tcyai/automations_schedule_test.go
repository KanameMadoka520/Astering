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
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestAutomationCalendarSchedulesAndDST(t *testing.T) {
	for _, test := range []struct {
		name               string
		schedule           AutomationSchedule
		zone, cursor, want string
	}{

		{
			"daily-shanghai",
			AutomationSchedule{
				Kind: "daily",
				Time: "09:00",
			},
			"Asia/Shanghai",
			"2026-11-16T00:00:00Z",
			"2026-11-16T01:00:00Z",
		},

		{
			"weekdays-skip-weekend",
			AutomationSchedule{
				Kind: "weekdays",
				Time: "09:00",
			},
			"Asia/Shanghai",
			"2026-11-20T02:00:00Z",
			"2026-11-23T01:00:00Z",
		},

		{
			"weekly-sunday",
			AutomationSchedule{
				Kind:     "weekly",
				Time:     "09:00",
				Weekdays: []int{0},
			},
			"UTC",
			"2026-11-16T10:00:00Z",
			"2026-11-22T09:00:00Z",
		},

		{
			"monthly-skip-february",
			AutomationSchedule{
				Kind: "monthly",
				Time: "09:00",
				Day:  31,
			},
			"UTC",
			"2027-01-31T09:00:00Z",
			"2027-03-31T09:00:00Z",
		},

		{
			"yearly-leap",
			AutomationSchedule{
				Kind:  "yearly",
				Time:  "09:00",
				Day:   29,
				Month: 2,
			},
			"UTC",
			"2028-02-29T09:00:00Z",
			"2032-02-29T09:00:00Z",
		},

		{
			"spring-gap-skipped",
			AutomationSchedule{
				Kind: "daily",
				Time: "02:30",
			},
			"America/New_York",
			"2026-03-08T05:00:00Z",
			"2026-03-09T06:30:00Z",
		},

		{
			"fall-repeat-not-twice",
			AutomationSchedule{
				Kind: "daily",
				Time: "01:30",
			},
			"America/New_York",
			"2026-11-01T06:00:00Z",
			"2026-11-02T06:30:00Z",
		},
	} {
		t.Run(test.name, func(t *testing.T) {
			cursor, err := time.Parse(time.RFC3339, test.cursor)
			require.NoError(t, err)
			next, err := NextAutomationRun(test.schedule, test.zone, cursor)
			require.NoError(t, err)
			require.NotNil(t, next)
			assert.Equal(t, test.want, next.Format(time.RFC3339))
		})
	}
}
func TestAutomationScheduleRejectsInapplicableFields(t *testing.T) {
	for _, schedule := range []AutomationSchedule{

		{
			Kind: "daily",
			Time: "24:00",
		},
		{
			Kind: "weekly",
			Time: "09:00",
			Weekdays: []int{
				1,
				1,
			},
		},
		{
			Kind: "daily",
			Time: "09:00",
			Day:  1,
		},
		{
			Kind:            "interval",
			IntervalMinutes: 1,
			Time:            "09:00",
		},
		{
			Kind:  "yearly",
			Time:  "09:00",
			Month: 2,
			Day:   30,
		},
		{
			Kind: "once",
			At:   "2026-11-16T09:00:00Z",
			Time: "09:00",
		},
		{
			Kind: "cron",
			Time: "09:00",
		},
	} {
		_, err := NextAutomationRun(schedule, "UTC", time.Now())
		require.ErrorIs(t, err, ErrAutomationInvalid)
	}
}
