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
	"context"
	"sync/atomic"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/cron"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"xorm.io/xorm"
)

const (
	dailyProjectVersionKind  = "daily"
	dailyProjectVersionHour  = 3
	dailyProjectVersionLimit = 30
)

type projectVersionSchedule struct {
	ProjectID int64     `xorm:"bigint pk"`
	NextRunAt time.Time `xorm:"not null index"`
}

func (*projectVersionSchedule) TableName() string { return "project_version_schedules" }

type ProjectVersionScheduleStatus struct {
	Enabled   bool       `json:"enabled" doc:"Whether daily project history is enabled."`
	NextRunAt *time.Time `json:"next_run_at,omitempty" doc:"Next scheduled check or retry; absent when disabled."`
	TimeZone  string     `json:"time_zone" doc:"Server time zone used by the daily schedule."`
}

func projectVersionScheduleStatus(schedule *projectVersionSchedule) *ProjectVersionScheduleStatus {
	status := &ProjectVersionScheduleStatus{TimeZone: config.GetTimeZone().String()}
	if !schedule.NextRunAt.IsZero() {
		next := schedule.NextRunAt.UTC()
		status.Enabled = true
		status.NextRunAt = &next
	}
	return status
}

func ReadProjectVersionSchedule(s *xorm.Session, a web.Auth, projectID int64) (*ProjectVersionScheduleStatus, error) {
	if err := checkProjectVersionScheduleAccess(s, a, projectID); err != nil {
		return nil, err
	}
	schedule := &projectVersionSchedule{}
	if _, err := s.ID(projectID).Get(schedule); err != nil {
		return nil, err
	}
	return projectVersionScheduleStatus(schedule), nil
}

func checkProjectVersionScheduleAccess(s *xorm.Session, a web.Auth, projectID int64) error {
	level, err := initialVersionAccess(s, a, projectID)
	if err != nil {
		return err
	}
	if level < int(PermissionAdmin) {
		return ErrGenericForbidden{}
	}
	return nil
}

func UpdateProjectVersionSchedule(s *xorm.Session, a web.Auth, projectID int64, enabled bool) (*ProjectVersionScheduleStatus, error) {
	if err := checkProjectVersionScheduleAccess(s, a, projectID); err != nil {
		return nil, err
	}
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		return nil, err
	}
	project, level, err := versionReadAccess(s, a, projectID)
	if err != nil {
		return nil, err
	}
	if level < int(PermissionAdmin) {
		return nil, ErrGenericForbidden{}
	}
	schedule := &projectVersionSchedule{ProjectID: projectID}
	if !enabled {
		_, err = s.ID(projectID).Delete(schedule)
		return projectVersionScheduleStatus(schedule), err
	}
	if project.IsArchived {
		return nil, ErrProjectIsArchived{ProjectID: projectID}
	}
	exists, err := routineCurrentRead(s).ID(projectID).Get(schedule)
	if err != nil {
		return nil, err
	}
	if !exists {
		now := time.Now()
		schedule.NextRunAt = nextProjectVersionRun(now, config.GetTimeZone(), false)
		if _, err = s.Insert(schedule); err != nil {
			return nil, err
		}
	}
	return projectVersionScheduleStatus(schedule), nil
}

// A delayed run checks the current state once and resumes tomorrow, even if it
// caught up before today's scheduled hour. Missed days cannot be reconstructed.
func nextProjectVersionRun(now time.Time, location *time.Location, ranToday bool) time.Time {
	date := now.In(location)
	atHour := func(day time.Time) time.Time {
		return time.Date(day.Year(), day.Month(), day.Day(), dailyProjectVersionHour, 0, 0, 0, location)
	}
	next := atHour(date)
	if ranToday || !next.After(now) {
		next = atHour(date.AddDate(0, 0, 1))
	}
	return next.UTC()
}

func RegisterProjectVersionScheduleCron() {
	var running atomic.Bool
	if err := cron.Schedule("* * * * *", func() {
		if !running.CompareAndSwap(false, true) {
			return
		}
		defer running.Store(false)
		runDueProjectVersions(time.Now())
	}); err != nil {
		log.Errorf("Could not register daily project history: %s", err)
	}
}

func runDueProjectVersions(now time.Time) {
	s := db.NewAutocommitSession()
	var due []projectVersionSchedule
	err := s.Where("next_run_at <= ?", now.UTC()).OrderBy("next_run_at, project_id").Limit(16).Find(&due)
	s.Close()
	if err != nil {
		log.Errorf("Could not read daily project history schedules: %s", err)
		return
	}
	location := config.GetTimeZone()
	for _, schedule := range due {
		if err = runScheduledProjectVersion(schedule.ProjectID, now, location); err != nil {
			log.Errorf("Daily project history failed for project %d: %s", schedule.ProjectID, err)
			// Move failed projects behind other due work. The conditional update
			// preserves newer settings or a successful run on another instance.
			s := db.NewAutocommitSession()
			_, err = s.ID(schedule.ProjectID).Where("next_run_at = ?", schedule.NextRunAt).
				Cols("next_run_at").Update(&projectVersionSchedule{NextRunAt: time.Now().UTC().Add(15 * time.Minute)})
			s.Close()
			if err != nil {
				log.Errorf("Could not defer daily project history for project %d: %s", schedule.ProjectID, err)
			}
		}
	}
}

func runScheduledProjectVersion(projectID int64, now time.Time, location *time.Location) error {
	ctx, cancel := context.WithTimeout(context.Background(), 45*time.Second)
	defer cancel()
	s := db.NewAutocommitSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	if err := s.Begin(); err != nil {
		return err
	}
	defer s.Rollback()
	if err := saveScheduledProjectVersion(s, projectID, now, location); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	return s.Commit()
}

func saveScheduledProjectVersion(s *xorm.Session, projectID int64, now time.Time, location *time.Location) error {
	if err := LockProjectsForVersionMutation(s, projectID); err != nil {
		if IsErrProjectDoesNotExist(err) {
			return nil // The project may have been deleted since the due query.
		}
		return err
	}
	schedule := &projectVersionSchedule{}
	exists, err := routineCurrentRead(s).ID(projectID).Get(schedule)
	if err != nil || !exists || schedule.NextRunAt.After(now) {
		return err
	}

	project := &Project{}
	if _, err = routineCurrentRead(s).ID(projectID).Get(project); err != nil {
		return err
	}
	if !project.IsArchived {
		if err = saveChangedDailyProjectVersion(s, projectID, now.In(location).Format(time.DateOnly)); err != nil {
			return err
		}
	}
	schedule.NextRunAt = nextProjectVersionRun(now, location, true)
	_, err = s.ID(projectID).Cols("next_run_at").Update(schedule)
	return err
}

func saveChangedDailyProjectVersion(s *xorm.Session, projectID int64, date string) error {
	exists, err := routineCurrentRead(s).Where("project_id = ? AND kind = ? AND request_id = ?", projectID, dailyProjectVersionKind, date).
		Exist(new(ProjectVersion))
	if err != nil || exists {
		return err
	}
	snapshot, err := captureProjectVersion(s, projectID)
	if err != nil {
		return err
	}
	latest := &ProjectVersion{}
	if _, err = routineCurrentRead(s).Where("project_id = ?", projectID).
		Cols("content_hash").OrderBy("sequence DESC").Get(latest); err != nil {
		return err
	}
	if latest.ContentHash == snapshot.Hash {
		return nil
	}
	if _, err = saveProjectVersionSnapshot(s, nil, snapshot, date, dailyProjectVersionKind, date, 0); err != nil {
		return err
	}
	var expired []ProjectVersion
	if err = routineCurrentRead(s).Where("project_id = ? AND kind = ?", projectID, dailyProjectVersionKind).
		Cols("id").OrderBy("sequence DESC").Limit(1, dailyProjectVersionLimit).Find(&expired); err != nil {
		return err
	}
	for _, version := range expired {
		if err = deleteProjectVersionRows(s, projectID, version.ID); err != nil {
			return err
		}
	}
	return nil
}
