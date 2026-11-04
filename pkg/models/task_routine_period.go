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
	"crypto/sha256"
	"fmt"
	"sort"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/xorm"
)

func (r *TaskRoutine) setPeriod(now time.Time) error {
	if r.Period == "" {
		r.Period = "daily"
	}
	if r.MonthDay == 0 {
		r.MonthDay = 1
	}
	if r.Target == 0 {
		r.Target = 1
	}
	if (r.Period != "daily" && r.Period != "weekly" && r.Period != "monthly") || r.ResetHour < 0 || r.ResetHour > 23 || r.ResetMinute < 0 || r.ResetMinute > 59 || r.WeekStart < 0 || r.WeekStart > 6 || r.MonthDay < 1 || r.MonthDay > 31 || r.Target < 1 || r.Target > 9007199254740991 || utf8.RuneCountInString(r.Unit) > 40 {
		return InvalidFieldErrorWithMessage([]string{"period", "reset_hour", "reset_minute", "week_start", "month_day", "target", "unit"}, "Invalid calendar period or quota")
	}
	loc, err := time.LoadLocation(r.Timezone)
	if err != nil {
		return InvalidFieldErrorWithMessage([]string{"timezone"}, "Use a valid IANA timezone")
	}
	local := now.In(loc)
	start := r.periodAnchor(local.Year(), local.Month(), local.Day(), loc)
	switch r.Period {
	case "daily":
		if start.After(now) {
			start = r.periodAnchor(local.Year(), local.Month(), local.Day()-1, loc)
		}
		day := start.In(loc)
		r.NextResetAt = r.periodAnchor(day.Year(), day.Month(), day.Day()+1, loc)
	case "weekly":
		days := (int(local.Weekday()) - r.WeekStart + 7) % 7
		start = r.periodAnchor(local.Year(), local.Month(), local.Day()-days, loc)
		if start.After(now) {
			start = r.periodAnchor(local.Year(), local.Month(), local.Day()-days-7, loc)
		}
		day := start.In(loc)
		r.NextResetAt = r.periodAnchor(day.Year(), day.Month(), day.Day()+7, loc)
	case "monthly":
		start = r.monthAnchor(local.Year(), local.Month(), loc)
		if start.After(now) {
			start = r.monthAnchor(local.Year(), local.Month()-1, loc)
		}
		r.NextResetAt = r.monthAnchor(start.Year(), start.Month()+1, loc)
	}
	r.PeriodStartAt = start
	r.Date = start.Format(time.DateOnly)
	week, month := 0, 1
	if r.Period == "weekly" {
		week = r.WeekStart
	}
	if r.Period == "monthly" {
		month = r.MonthDay
	}
	key := fmt.Sprintf("%s|%q|%d:%d|%d|%d|%d|%q", r.Period, r.Timezone, r.ResetHour, r.ResetMinute, week, month, r.Target, r.Unit)
	r.ScheduleKey = fmt.Sprintf("%x", sha256.Sum256([]byte(key)))
	return nil
}

func (r *TaskRoutine) periodAnchor(year int, month time.Month, day int, loc *time.Location) time.Time {
	requested := time.Date(year, month, day, r.ResetHour, r.ResetMinute, 0, 0, time.UTC)
	anchor := time.Date(year, month, day, r.ResetHour, r.ResetMinute, 0, 0, loc)
	civil := time.Date(anchor.Year(), anchor.Month(), anchor.Day(), anchor.Hour(), anchor.Minute(), 0, 0, time.UTC)
	// During a spring-forward gap, shift the missing wall time forward by the gap.
	// Repeated wall times use time.Date's consistent occurrence for both reads and writes.
	if civil.Before(requested) {
		anchor = anchor.Add(requested.Sub(civil))
	}
	return anchor
}

func (r *TaskRoutine) monthAnchor(year int, month time.Month, loc *time.Location) time.Time {
	first := time.Date(year, month, 1, 12, 0, 0, 0, loc)
	last := time.Date(first.Year(), first.Month()+1, 0, 12, 0, 0, 0, loc).Day()
	return r.periodAnchor(first.Year(), first.Month(), min(r.MonthDay, last), loc)
}

func (r *TaskRoutine) legacyCalendar() bool {
	return (r.Period == "daily" || r.Period == "") && r.ResetHour == 0 && r.ResetMinute == 0 && r.Target <= 1 && r.Unit == ""
}

// TaskRoutineProgress snapshots a real recorded period, never an inferred missed cycle.
type TaskRoutineProgress struct {
	ID            int64      `xorm:"bigint autoincr not null pk" json:"id" readOnly:"true" doc:"Progress record identifier."`
	TaskID        int64      `xorm:"bigint not null unique(routine_period)" json:"task_id" readOnly:"true" doc:"Shared task this record belongs to."`
	ScheduleKey   string     `xorm:"varchar(64) not null unique(routine_period)" json:"schedule_key" readOnly:"true" doc:"Original calendar and quota configuration identity."`
	LocalDate     time.Time  `xorm:"DATE not null unique(routine_period)" json:"-"`
	Date          string     `xorm:"-" json:"date" readOnly:"true" doc:"Period starting local calendar date."`
	Period        string     `xorm:"varchar(10) not null" json:"period" readOnly:"true" doc:"Original daily, weekly or monthly period."`
	Timezone      string     `xorm:"varchar(100) not null" json:"timezone" readOnly:"true" doc:"Original IANA timezone."`
	PeriodStartAt time.Time  `xorm:"not null" json:"period_start_at" readOnly:"true" doc:"Original period start instant."`
	PeriodEndAt   time.Time  `xorm:"not null" json:"period_end_at" readOnly:"true" doc:"Original next reset instant."`
	Amount        int64      `xorm:"bigint not null" json:"amount" readOnly:"true" doc:"Absolute recorded quantity, including incomplete periods."`
	Target        int64      `xorm:"bigint not null" json:"target" readOnly:"true" doc:"Target applying when this period was recorded."`
	Unit          string     `xorm:"varchar(40) not null default ''" json:"unit" readOnly:"true" doc:"Original quantity unit."`
	CompletedAt   *time.Time `xorm:"null" json:"completed_at" readOnly:"true" doc:"First attainment of target; null when the recorded amount is below target."`
	CompletedByID int64      `xorm:"bigint not null default 0" json:"completed_by_id" readOnly:"true" doc:"Actor who first reached the target; zero while incomplete."`
	UpdatedByID   int64      `xorm:"bigint not null" json:"updated_by_id" readOnly:"true" doc:"Last progress editor."`
	Created       time.Time  `xorm:"created not null" json:"created" readOnly:"true" doc:"First recording time."`
	Updated       time.Time  `xorm:"updated not null" json:"updated" readOnly:"true" doc:"Last quantity update time."`
}

func (*TaskRoutineProgress) TableName() string { return "task_routine_progress" }

func (r *TaskRoutine) readPeriodState(s *xorm.Session, now time.Time) error {
	if err := r.setPeriod(now); err != nil {
		return err
	}
	r.CurrentAmount, r.CompletedByID = 0, 0
	r.CompletedToday, r.CompletedPeriod = false, false
	r.CompletedAt = time.Time{}
	if r.legacyCalendar() {
		check := &TaskRoutineCheckin{}
		exists, err := s.Where("task_id = ? AND local_date = ?", r.TaskID, r.Date).Get(check)
		if err != nil {
			return err
		}
		if exists && check.Timezone == r.Timezone {
			r.CurrentAmount, r.CompletedByID = 1, check.CompletedByID
			r.CompletedToday, r.CompletedPeriod = true, true
			r.CompletedAt = check.CompletedAt
		}
	}
	return r.readProgress(s)
}

func (r *TaskRoutine) readProgress(s *xorm.Session) error {
	p := &TaskRoutineProgress{}
	exists, err := s.Where("task_id = ? AND schedule_key = ? AND local_date = ?", r.TaskID, r.ScheduleKey, r.Date).Get(p)
	if err == nil && exists {
		r.applyProgress(p)
	}
	return err
}

func (r *TaskRoutine) applyProgress(p *TaskRoutineProgress) {
	r.CurrentAmount = p.Amount
	r.CompletedToday = p.Amount >= p.Target
	r.CompletedPeriod = r.CompletedToday
	r.CompletedAt, r.CompletedByID = time.Time{}, 0
	if p.CompletedAt != nil {
		r.CompletedAt, r.CompletedByID = *p.CompletedAt, p.CompletedByID
	}
}

func routineNeedsProgress(s *xorm.Session, r *TaskRoutine) (bool, error) {
	if !r.legacyCalendar() {
		return true, nil
	}
	exists, err := routineCurrentRead(s).Where("task_id = ? AND schedule_key = ? AND local_date = ?", r.TaskID, r.ScheduleKey, r.Date).Exist(&TaskRoutineProgress{})
	if err != nil || exists {
		return exists, err
	}
	old := &TaskRoutineCheckin{}
	exists, err = routineCurrentRead(s).Where("task_id = ? AND local_date = ?", r.TaskID, r.Date).Get(old)
	return exists && old.Timezone != r.Timezone, err
}

// SetTaskRoutineProgress sets an absolute amount: retries never add it twice.
func SetTaskRoutineProgress(s *xorm.Session, a web.Auth, id int64, date string, revision, amount int64) (*Task, error) {
	return setTaskRoutineProgressAt(s, a, id, date, revision, amount, time.Now())
}

func setTaskRoutineProgressAt(s *xorm.Session, a web.Auth, id int64, date string, revision, amount int64, now time.Time) (*Task, error) {
	task, err := lockRoutineTask(s, id)
	if err != nil {
		return nil, err
	}
	r := &TaskRoutine{TaskID: id}
	allowed, err := r.CanUpdate(s, a)
	if err != nil {
		return nil, err
	}
	if !allowed {
		return nil, ErrGenericForbidden{}
	}
	exists, err := routineCurrentRead(s).ID(id).Get(r)
	if err != nil {
		return nil, err
	}
	if !exists || !r.Enabled || r.Paused {
		return nil, ErrRoutineState{Message: "This routine is disabled or paused."}
	}
	if err = r.setPeriod(now); err != nil {
		return nil, err
	}
	if revision != r.Revision || date != r.Date {
		return nil, ErrRoutineConflict{}
	}
	return writeRoutineProgress(s, a, task, r, amount, now)
}

func writeRoutineProgress(s *xorm.Session, a web.Auth, task *Task, r *TaskRoutine, amount int64, now time.Time) (*Task, error) {
	if amount < 0 || amount > 9007199254740991 {
		return nil, InvalidFieldErrorWithMessage([]string{"amount"}, "Use a nonnegative safe integer amount")
	}
	p := &TaskRoutineProgress{}
	exists, err := routineCurrentRead(s).Where("task_id = ? AND schedule_key = ? AND local_date = ?", r.TaskID, r.ScheduleKey, r.Date).Get(p)
	if err != nil {
		return nil, err
	}
	if exists && p.Amount == amount {
		return taskWithRoutineAt(s, a, task, now)
	}
	if !exists {
		localDate, parseErr := time.Parse(time.DateOnly, r.Date)
		if parseErr != nil {
			return nil, parseErr
		}
		*p = TaskRoutineProgress{
			TaskID:        r.TaskID,
			ScheduleKey:   r.ScheduleKey,
			LocalDate:     localDate,
			Period:        r.Period,
			Timezone:      r.Timezone,
			PeriodStartAt: r.PeriodStartAt.UTC(),
			PeriodEndAt:   r.NextResetAt.UTC(),
			Target:        r.Target,
			Unit:          r.Unit,
		}
	}
	p.Amount, p.UpdatedByID = amount, a.GetID()
	if amount >= p.Target && p.CompletedAt == nil {
		instant := now.UTC()
		p.CompletedAt, p.CompletedByID = &instant, a.GetID()
		if !exists && r.legacyCalendar() {
			legacy := &TaskRoutineCheckin{}
			found, readErr := routineCurrentRead(s).Where("task_id = ? AND local_date = ? AND timezone = ?", r.TaskID, r.Date, r.Timezone).Get(legacy)
			if readErr != nil {
				return nil, readErr
			}
			if found {
				p.CompletedAt, p.CompletedByID = &legacy.CompletedAt, legacy.CompletedByID
			}
		}
	}
	if amount < p.Target {
		p.CompletedAt, p.CompletedByID = nil, 0
	}
	if exists {
		_, err = s.ID(p.ID).Cols("amount", "completed_at", "completed_by_id", "updated_by_id", "updated").Update(p)
	} else {
		_, err = s.Insert(p)
	}
	if err != nil {
		return nil, err
	}
	// When a legacy daily record becomes quantitative, replace only this exact
	// calendar's current row; other calendars and historical periods stay untouched.
	if r.legacyCalendar() {
		if _, err = s.Where("task_id = ? AND local_date = ? AND timezone = ?", r.TaskID, r.Date, r.Timezone).Delete(&TaskRoutineCheckin{}); err != nil {
			return nil, err
		}
	}
	if _, err = touchRoutineTask(s, a, task); err != nil {
		return nil, err
	}
	return taskWithRoutineAt(s, a, task, now)
}

func taskWithRoutineAt(s *xorm.Session, a web.Auth, task *Task, now time.Time) (*Task, error) {
	if err := task.ReadOne(s, a); err != nil {
		return nil, err
	}
	if task.Routine != nil {
		if err := task.Routine.readPeriodState(s, now); err != nil {
			return nil, err
		}
	}
	return task, nil
}

func addRoutineProgressToTasks(s *xorm.Session, tasks map[int64]*Task, ids []int64, minDate, maxDate string) error {
	rows := []*TaskRoutineProgress{}
	if err := s.In("task_id", ids).Where("local_date >= ? AND local_date <= ?", minDate, maxDate).Find(&rows); err != nil {
		return err
	}
	for _, p := range rows {
		r := tasks[p.TaskID].Routine
		if r != nil && r.ScheduleKey == p.ScheduleKey && r.Date == p.LocalDate.Format(time.DateOnly) {
			r.applyProgress(p)
		}
	}
	return nil
}

func addRoutineProgressHistory(s *xorm.Session, id int64, year, month int, current *TaskRoutine, history *TaskRoutineHistory, legacy []*TaskRoutineCheckin) error {
	rows := []*TaskRoutineProgress{}
	if err := s.Where("task_id = ?", id).OrderBy("period_start_at ASC, id ASC").Find(&rows); err != nil {
		return err
	}
	compatible := make([]*TaskRoutineProgress, 0, len(rows)+len(legacy))
	if current.legacyCalendar() {
		loc, err := time.LoadLocation(current.Timezone)
		if err != nil {
			return err
		}
		for _, check := range legacy {
			if check.Timezone != current.Timezone {
				continue
			}
			day := check.LocalDate
			compatible = append(compatible, &TaskRoutineProgress{
				PeriodStartAt: current.periodAnchor(day.Year(), day.Month(), day.Day(), loc),
				PeriodEndAt:   current.periodAnchor(day.Year(), day.Month(), day.Day()+1, loc),
				CompletedAt:   &check.CompletedAt,
			})
		}
	}
	streak, longest := 0, 0
	var previousEnd time.Time
	for _, p := range rows {
		p.Date = p.LocalDate.Format(time.DateOnly)
		if p.CompletedAt != nil {
			history.TotalCheckins++
		}
		if p.LocalDate.Year() == year && int(p.LocalDate.Month()) == month {
			history.Periods = append(history.Periods, p)
		}
		if p.ScheduleKey == current.ScheduleKey {
			compatible = append(compatible, p)
		}
	}
	sort.SliceStable(compatible, func(i, j int) bool { return compatible[i].PeriodStartAt.Before(compatible[j].PeriodStartAt) })
	for _, p := range compatible {
		if p.CompletedAt == nil {
			streak = 0
			previousEnd = time.Time{}
			continue
		}
		if previousEnd.Equal(p.PeriodStartAt) {
			streak++
		} else {
			streak = 1
		}
		longest = max(longest, streak)
		previousEnd = p.PeriodEndAt
	}
	history.LongestStreak = longest
	history.CurrentStreak = 0
	if previousEnd.Equal(current.PeriodStartAt) || previousEnd.Equal(current.NextResetAt) {
		history.CurrentStreak = streak
	}
	sort.SliceStable(history.Periods, func(i, j int) bool { return history.Periods[i].PeriodStartAt.Before(history.Periods[j].PeriodStartAt) })
	return nil
}
