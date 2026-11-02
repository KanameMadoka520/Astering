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

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/user"
	"code.vikunja.io/api/pkg/web"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// TaskRoutine stores calendar-period configuration separately from ordinary repeat_after semantics.
type TaskRoutine struct {
	Period          string    `xorm:"varchar(10) not null default 'daily'" json:"period" enum:"daily,weekly,monthly" doc:"Calendar period; omitted legacy configurations use daily."`
	ResetHour       int       `xorm:"not null default 0" json:"reset_hour" minimum:"0" maximum:"23" doc:"Local hour at the beginning of each period."`
	ResetMinute     int       `xorm:"not null default 0" json:"reset_minute" minimum:"0" maximum:"59" doc:"Local minute at the beginning of each period."`
	WeekStart       int       `xorm:"not null default 0" json:"week_start" minimum:"0" maximum:"6" doc:"Weekly anchor weekday: Sunday=0 through Saturday=6."`
	MonthDay        int       `xorm:"not null default 1" json:"month_day" minimum:"0" maximum:"31" doc:"Monthly anchor day; zero means 1. Short months clamp to their final day."`
	Target          int64     `xorm:"bigint not null default 1" json:"target" minimum:"0" maximum:"9007199254740991" doc:"Amount completing one period. Zero from a legacy client means 1."`
	Unit            string    `xorm:"varchar(40) not null default ''" json:"unit" maxLength:"40" doc:"Optional unit for integer amounts, such as ml or sessions."`
	PeriodStartAt   time.Time `xorm:"-" json:"period_start_at" readOnly:"true" doc:"Actual start instant of the current anchored calendar period."`
	ScheduleKey     string    `xorm:"-" json:"schedule_key" readOnly:"true" doc:"Identity of the calendar and quota configuration; histories from different configurations stay separate."`
	CurrentAmount   int64     `xorm:"-" json:"current_amount" readOnly:"true" doc:"Recorded amount in the current period, zero when no progress exists."`
	CompletedPeriod bool      `xorm:"-" json:"completed_period" readOnly:"true" doc:"Whether the current period reached its target; completed_today remains a compatibility alias."`
	TaskID          int64     `xorm:"bigint not null pk" json:"task_id" readOnly:"true"`
	Enabled         bool      `xorm:"not null default false" json:"enabled"`
	Paused          bool      `xorm:"not null default false" json:"paused"`
	Timezone        string    `xorm:"varchar(100) not null" json:"timezone" maxLength:"100" doc:"IANA timezone defining the shared task's calendar periods. Historical dates are not rewritten when this changes."`
	Revision        int64     `xorm:"bigint not null default 0" json:"revision" minimum:"0" doc:"Expected configuration revision; stale updates fail with 409."`
	Created         time.Time `xorm:"created not null" json:"created" readOnly:"true"`
	Updated         time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	Date            string    `xorm:"-" json:"date" readOnly:"true" doc:"Current period starting local YYYY-MM-DD in the routine timezone; use this server value for writes."`
	CompletedToday  bool      `xorm:"-" json:"completed_today" readOnly:"true"`
	CompletedAt     time.Time `xorm:"-" json:"completed_at" readOnly:"true"`
	CompletedByID   int64     `xorm:"-" json:"completed_by_id" readOnly:"true"`
	NextResetAt     time.Time `xorm:"-" json:"next_reset_at" readOnly:"true" doc:"Next anchored local period boundary, including DST transitions."`
	web.CRUDable    `xorm:"-" json:"-"`
	web.Permissions `xorm:"-" json:"-"`
}

func (*TaskRoutine) TableName() string { return "task_routines" }
func (r *TaskRoutine) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	return (&Task{ID: r.TaskID}).CanRead(s, a)
}
func (r *TaskRoutine) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	task, err := GetTaskByIDSimple(s, r.TaskID)
	if err != nil {
		return false, err
	}
	p, err := GetProjectSimpleByID(s, task.ProjectID)
	if err != nil {
		return false, err
	}
	if err = p.CheckIsArchived(s); err != nil {
		return false, err
	}
	return task.CanUpdate(s, a)
}
func routineTimezone(s *xorm.Session, a web.Auth) string {
	if a.GetID() > 0 {
		u := &user.User{}
		exists, err := s.ID(a.GetID()).Get(u)
		if err == nil && exists && u.Timezone != "" {
			return u.Timezone
		}
	}
	return config.GetTimeZone().String()
}
func (r *TaskRoutine) ReadOne(s *xorm.Session, a web.Auth) error {
	row := TaskRoutine{TaskID: r.TaskID}
	exists, err := s.ID(r.TaskID).Get(&row)
	if err != nil {
		return err
	}
	if !exists {
		row.Timezone = routineTimezone(s, a)
	}
	if err = row.readPeriodState(s, time.Now()); err != nil {
		return err
	}
	*r = row
	return nil
}
func (r *TaskRoutine) setDate(now time.Time) error {
	return r.setPeriod(now)
}
func lockRoutineTask(s *xorm.Session, id int64) (*Task, error) {
	if db.Type() == schemas.SQLITE {
		if _, err := s.Table(new(Task)).Where("id = ?", id).Update(map[string]any{"id": id}); err != nil {
			return nil, err
		}
	}
	locking := s
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		locking = s.ForUpdate()
	}
	task := &Task{}
	exists, err := locking.ID(id).Get(task)
	if err != nil {
		return nil, err
	}
	if !exists {
		return nil, ErrTaskDoesNotExist{ID: id}
	}
	return task, nil
}
func (r *TaskRoutine) Update(s *xorm.Session, a web.Auth) error {
	if r.Revision < 0 || len(r.Timezone) > 100 {
		return InvalidFieldErrorWithMessage([]string{"revision", "timezone"}, "Invalid routine configuration")
	}
	if r.Timezone == "" {
		r.Timezone = routineTimezone(s, a)
	}
	if err := r.setDate(time.Now()); err != nil {
		return err
	}
	task, err := lockRoutineTask(s, r.TaskID)
	if err != nil {
		return err
	}
	allowed, err := r.CanUpdate(s, a)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrGenericForbidden{}
	}
	if r.Enabled && (task.Done || task.RepeatAfter != 0 || task.RepeatMode != TaskRepeatModeDefault) {
		return ErrRoutineState{Message: "Reopen the task and remove ordinary repeat settings before enabling periodic check-ins."}
	}
	old := &TaskRoutine{TaskID: r.TaskID}
	exists, err := routineCurrentRead(s).ID(r.TaskID).Get(old)
	if err != nil {
		return err
	}
	if old.Revision != r.Revision {
		return ErrRoutineConflict{}
	}
	if err = validateRoutineReminderSchedule(s, r); err != nil {
		return err
	}
	r.Revision++
	r.Updated = time.Now()
	if !exists {
		r.Created = time.Now()
		_, err = s.Insert(r)
	} else {
		var changed int64
		changed, err = s.ID(r.TaskID).Where("revision = ?", old.Revision).Cols("enabled", "paused", "timezone", "revision", "updated", "period", "reset_hour", "reset_minute", "week_start", "month_day", "target", "unit").Update(r)
		if err == nil && changed == 0 {
			return ErrRoutineConflict{}
		}
	}
	if err != nil {
		return err
	}
	if _, err = touchRoutineTask(s, a, task); err != nil {
		return err
	}
	return r.ReadOne(s, a)
}

// LocalDate is a calendar key (UTC midnight encoding), not the completion instant.
type TaskRoutineCheckin struct {
	ID            int64     `xorm:"bigint autoincr not null pk" json:"id" readOnly:"true"`
	TaskID        int64     `xorm:"bigint not null unique(routine_day)" json:"task_id" readOnly:"true"`
	LocalDate     time.Time `xorm:"DATE not null unique(routine_day)" json:"-"`
	Timezone      string    `xorm:"varchar(100) not null" json:"timezone" readOnly:"true"`
	CompletedAt   time.Time `xorm:"not null" json:"completed_at" readOnly:"true"`
	CompletedByID int64     `xorm:"bigint not null" json:"completed_by_id" readOnly:"true"`
	Date          string    `xorm:"-" json:"date" readOnly:"true"`
}

func (*TaskRoutineCheckin) TableName() string { return "task_routine_checkins" }

// SetTaskRoutineCheckin is idempotent per task/local date and never changes task.done or task dates.
func SetTaskRoutineCheckin(s *xorm.Session, a web.Auth, id int64, date string, completed bool, expectedRevision ...int64) (*Task, error) {
	return setTaskRoutineCheckinAt(s, a, id, date, completed, time.Now(), expectedRevision...)
}
func setTaskRoutineCheckinAt(s *xorm.Session, a web.Auth, id int64, date string, completed bool, now time.Time, expectedRevision ...int64) (*Task, error) {
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
	if err = r.setDate(now); err != nil {
		return nil, err
	}
	if (len(expectedRevision) > 0 && expectedRevision[0] != r.Revision) || (!r.legacyCalendar() && len(expectedRevision) == 0) {
		return nil, ErrRoutineConflict{}
	}
	if date != r.Date {
		return nil, ErrRoutineConflict{Message: "The routine's current period changed. Reload before checking in."}
	}
	useProgress, err := routineNeedsProgress(s, r)
	if err != nil {
		return nil, err
	}
	if useProgress {
		amount := int64(0)
		if completed {
			if err = r.readPeriodState(s, now); err != nil {
				return nil, err
			}
			amount = max(r.Target, r.CurrentAmount)
		}
		return writeRoutineProgress(s, a, task, r, amount, now)
	}
	// A row lock plus an explicit existence check makes no-op retries event-free on every DB,
	// including MySQL connections configured to report found rather than changed rows.
	already, err := routineCurrentRead(s).Where("task_id = ? AND local_date = ?", id, date).Get(&TaskRoutineCheckin{})
	if err != nil {
		return nil, err
	}
	if already == completed {
		err = task.ReadOne(s, a)
		return task, err
	}
	var changed int64
	if completed {
		localDate, parseErr := time.Parse(time.DateOnly, date)
		if parseErr != nil {
			return nil, parseErr
		}
		changed, err = s.Insert(&TaskRoutineCheckin{
			TaskID:        id,
			LocalDate:     localDate,
			Timezone:      r.Timezone,
			CompletedAt:   now.UTC(),
			CompletedByID: a.GetID(),
		})
	} else {
		changed, err = s.Where("task_id = ? AND local_date = ?", id, date).Delete(&TaskRoutineCheckin{})
	}
	if err != nil {
		return nil, err
	}
	if changed > 0 {
		return touchRoutineTask(s, a, task)
	}
	err = task.ReadOne(s, a)
	return task, err
}
func touchRoutineTask(s *xorm.Session, a web.Auth, task *Task) (*Task, error) {
	task.Updated = time.Now()
	if err := updateTaskLastUpdated(s, task); err != nil {
		return nil, err
	}
	if err := updateProjectLastUpdated(s, &Project{ID: task.ProjectID}); err != nil {
		return nil, err
	}
	if err := task.ReadOne(s, a); err != nil {
		return nil, err
	}
	events.DispatchOnCommit(s, &TaskUpdatedEvent{Task: task, Doer: doerFromAuth(s, a)})
	return task, nil
}

// addRoutineInfoToTasks batches configuration, legacy completions and period progress.
func addRoutineInfoToTasks(s *xorm.Session, taskMap map[int64]*Task, now time.Time) error {
	if len(taskMap) == 0 {
		return nil
	}
	ids := make([]int64, 0, len(taskMap))
	for id := range taskMap {
		ids = append(ids, id)
		taskMap[id].Routine = nil
	}
	rows := []*TaskRoutine{}
	if err := s.In("task_id", ids).Find(&rows); err != nil {
		return err
	}
	if len(rows) == 0 {
		return nil
	}
	minDate, maxDate := "9999-12-31", "0000-01-01"
	for _, r := range rows {
		if err := r.setDate(now); err != nil {
			return err
		}
		if r.Date < minDate {
			minDate = r.Date
		}
		if r.Date > maxDate {
			maxDate = r.Date
		}
		taskMap[r.TaskID].Routine = r
	}
	checks := []*TaskRoutineCheckin{}
	if err := s.In("task_id", ids).Where("local_date >= ? AND local_date <= ?", minDate, maxDate).Find(&checks); err != nil {
		return err
	}
	for _, c := range checks {
		r := taskMap[c.TaskID].Routine
		if r != nil && r.legacyCalendar() && c.Timezone == r.Timezone && c.LocalDate.Format(time.DateOnly) == r.Date {
			r.CurrentAmount = 1
			r.CompletedPeriod = true
			r.CompletedToday = true
			r.CompletedAt = c.CompletedAt
			r.CompletedByID = c.CompletedByID
		}
	}
	return addRoutineProgressToTasks(s, taskMap, ids, minDate, maxDate)
}

// Called after the task row write: locking/current reads also see concurrent configuration commits on MySQL.
func validateTaskRoutineState(s *xorm.Session, t *Task) error {
	if !t.Done && t.RepeatAfter == 0 && t.RepeatMode == TaskRepeatModeDefault {
		return nil
	}
	locking := s
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		locking = s.ForUpdate()
	}
	r := &TaskRoutine{}
	exists, err := locking.ID(t.ID).Get(r)
	if err != nil {
		return err
	}
	if exists && r.Enabled {
		return ErrRoutineState{Message: "Use period check-in for this task, or disable its routine before setting done or ordinary repeats."}
	}
	return nil
}

type TaskRoutineHistory struct {
	Periods       []*TaskRoutineProgress `json:"periods" doc:"Recorded quota periods with their original calendar, target and unit; includes incomplete progress."`
	Timezone      string                 `json:"timezone"`
	Year          int                    `json:"year"`
	Month         int                    `json:"month"`
	Items         []*TaskRoutineCheckin  `json:"items"`
	TotalCheckins int                    `json:"total_checkins"`
	CurrentStreak int                    `json:"current_streak"`
	LongestStreak int                    `json:"longest_streak"`
}

func GetTaskRoutineHistory(s *xorm.Session, a web.Auth, id int64, year, month int) (*TaskRoutineHistory, error) {
	if year < 1970 || year > 9998 || month < 1 || month > 12 {
		return nil, InvalidFieldErrorWithMessage([]string{"year", "month"}, "Choose a valid calendar month")
	}
	r := &TaskRoutine{TaskID: id}
	can, _, err := r.CanRead(s, a)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, ErrGenericForbidden{}
	}
	if err = r.ReadOne(s, a); err != nil {
		return nil, err
	}
	result := &TaskRoutineHistory{Periods: []*TaskRoutineProgress{}, Timezone: r.Timezone, Year: year, Month: month, Items: []*TaskRoutineCheckin{}}
	records := []*TaskRoutineCheckin{}
	if err = s.Where("task_id = ?", id).OrderBy("local_date ASC").Find(&records); err != nil {
		return nil, err
	}
	result.TotalCheckins = len(records)
	for _, c := range records {
		c.Date = c.LocalDate.Format(time.DateOnly)
		if c.LocalDate.Year() == year && int(c.LocalDate.Month()) == month {
			result.Items = append(result.Items, c)
		}
	}
	if err = addRoutineProgressHistory(s, id, year, month, r, result, records); err != nil {
		return nil, err
	}
	return result, nil
}

type ErrRoutineConflict struct{ Message string }

func (e ErrRoutineConflict) Error() string {
	if e.Message != "" {
		return e.Message
	}
	return "Routine settings changed. Reload before saving."
}
func (e ErrRoutineConflict) HTTPError() web.HTTPError {
	return web.HTTPError{HTTPCode: http.StatusConflict, Code: 20002, Message: e.Error()}
}

type ErrRoutineState struct{ Message string }

func (e ErrRoutineState) Error() string { return e.Message }
func (e ErrRoutineState) HTTPError() web.HTTPError {
	return web.HTTPError{HTTPCode: http.StatusBadRequest, Code: 20003, Message: e.Error()}
}

// A duplicate gets the schedule but starts its own history.
func duplicateTaskRoutine(s *xorm.Session, oldID, newID int64) error {
	r := &TaskRoutine{}
	exists, err := s.ID(oldID).Get(r)
	if err != nil || !exists {
		return err
	}
	r.TaskID = newID
	r.Revision = 1
	r.Created = time.Now()
	r.Updated = r.Created
	_, err = s.Insert(r)
	return err
}

// Current reads after the parent lock avoid an older MySQL repeatable-read snapshot.
func routineCurrentRead(s *xorm.Session) *xorm.Session {
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		return s.ForUpdate()
	}
	return s
}
