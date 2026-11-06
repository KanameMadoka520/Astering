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
	"regexp"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/web"
	"github.com/microcosm-cc/bluemonday"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// Notices accept basic rich text and links, not embeds, forms, images or scripts.
var announcementHTMLPolicy = newAnnouncementHTMLPolicy()

func newAnnouncementHTMLPolicy() *bluemonday.Policy {
	p := bluemonday.NewPolicy()
	p.AllowElements("p", "br", "strong", "em", "b", "i", "u", "s", "del", "blockquote", "ul", "ol", "li", "h1", "h2", "h3", "h4", "h5", "h6", "pre", "code", "a", "hr", "sub", "sup", "mark", "table", "thead", "tbody", "tr", "th", "td")
	p.AllowAttrs("href").OnElements("a")
	p.AllowAttrs("colspan", "rowspan").Matching(regexp.MustCompile(`^[1-9][0-9]{0,2}$`)).OnElements("td", "th")
	p.AllowStandardURLs()
	p.RequireNoFollowOnLinks(true)
	return p
}

// ProjectAnnouncement is a separate shared notice, never part of a project's description.
type ProjectAnnouncement struct {
	ProjectID       int64     `xorm:"bigint not null pk" json:"project_id" readOnly:"true"`
	Title           string    `xorm:"varchar(160) not null" json:"title" maxLength:"160"`
	Content         string    `xorm:"longtext null" json:"content" maxLength:"65536" doc:"Rich text; an empty title and content remove the visible announcement."`
	Revision        int64     `xorm:"bigint not null default 0" json:"revision" minimum:"0" doc:"Read the current revision before writing. Stale writes fail with 409; successful writes increment it."`
	Updated         time.Time `xorm:"updated not null" json:"updated" readOnly:"true"`
	UpdatedByID     int64     `xorm:"bigint not null" json:"updated_by_id" readOnly:"true"`
	web.CRUDable    `xorm:"-" json:"-"`
	web.Permissions `xorm:"-" json:"-"`
}

func (*ProjectAnnouncement) TableName() string { return "project_announcements" }
func (n *ProjectAnnouncement) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	return (&Project{ID: n.ProjectID}).CanRead(s, a)
}
func (n *ProjectAnnouncement) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	p, err := GetProjectSimpleByID(s, n.ProjectID)
	if err != nil {
		return false, err
	}
	if err = p.CheckIsArchived(s); err != nil {
		return false, err
	}
	return p.CanWrite(s, a)
}
func (n *ProjectAnnouncement) ReadOne(s *xorm.Session, _ web.Auth) error {
	id := n.ProjectID
	row := ProjectAnnouncement{ProjectID: id}
	_, err := s.ID(id).Get(&row)
	*n = row
	return err
}
func (n *ProjectAnnouncement) Update(s *xorm.Session, a web.Auth) error {
	if err := LockProjectsForVersionMutation(s, n.ProjectID); err != nil {
		return err
	}
	if err := requireCurrentProjectWrite(s, a, n.ProjectID); err != nil {
		return err
	}

	if n.Revision < 0 || utf8.RuneCountInString(n.Title) > 160 || len(n.Content) > 65536 {
		return InvalidFieldErrorWithMessage([]string{"title", "content", "revision"}, "Invalid announcement length or revision")
	}
	n.Title = strings.TrimSpace(n.Title)
	n.Content = announcementHTMLPolicy.Sanitize(n.Content)
	// Lock the parent before the singleton row so first writes and project removal serialize.
	p := &Project{ID: n.ProjectID}
	locking := s
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		locking = s.ForUpdate()
	}
	exists, err := locking.ID(n.ProjectID).Get(p)
	if err != nil {
		return err
	}
	if !exists {
		return ErrProjectDoesNotExist{ID: n.ProjectID}
	}
	allowed, err := n.CanUpdate(s, a)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrGenericForbidden{}
	}
	old := &ProjectAnnouncement{ProjectID: n.ProjectID}
	if kind := db.Type(); kind == schemas.MYSQL || kind == schemas.POSTGRES {
		s.ForUpdate()
	}
	exists, err = s.ID(n.ProjectID).Get(old)
	if err != nil {
		return err
	}
	if old.Revision != n.Revision {
		return ErrProjectAnnouncementConflict{}
	}
	n.Revision++
	n.Updated = time.Now()
	n.UpdatedByID = a.GetID()
	if !exists {
		_, err = s.Insert(n)
	} else {
		var changed int64
		changed, err = s.ID(n.ProjectID).Where("revision = ?", old.Revision).Cols("title", "content", "revision", "updated", "updated_by_id").Update(n)
		if err == nil && changed == 0 {
			return ErrProjectAnnouncementConflict{}
		}
	}
	if err != nil {
		return err
	}
	if err = n.ReadOne(s, a); err != nil {
		return err
	}
	if err = updateProjectLastUpdated(s, p); err != nil {
		return err
	}
	if err = p.ReadOne(s, a); err != nil {
		return err
	}
	events.DispatchOnCommit(s, &ProjectUpdatedEvent{Project: p, Doer: doerFromAuth(s, a)})
	return nil
}

type ErrProjectAnnouncementConflict struct{}

func (ErrProjectAnnouncementConflict) Error() string {
	return "The project announcement changed. Reload it before saving your draft."
}
func (e ErrProjectAnnouncementConflict) HTTPError() web.HTTPError {
	return web.HTTPError{HTTPCode: http.StatusConflict, Code: 20001, Message: e.Error()}
}
