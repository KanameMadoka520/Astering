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
	"encoding/json"
	"html"
	"net/http"
	"slices"
	"strings"
	"time"
	"unicode/utf8"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/web"
	"github.com/microcosm-cc/bluemonday"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// Compass spaces are private by default. An explicitly selected team grants its current members access.
// Instance-admin access to projects never implicitly grants access to these personal writings.
type CompassSpace struct {
	ID              int64     `xorm:"bigint autoincr pk" json:"id" readOnly:"true" doc:"Space identifier, assigned by the server."`
	OwnerID         int64     `xorm:"bigint not null index" json:"owner_id" readOnly:"true" doc:"Creator; owns a personal space, but cannot retain access after leaving a team space."`
	TeamID          int64     `xorm:"bigint not null default 0 index" json:"team_id" minimum:"0" doc:"0 for private. On creation only, select a team you administer. Immutable thereafter."`
	Title           string    `xorm:"varchar(80) not null" json:"title" minLength:"1" maxLength:"80" doc:"User-defined name, not a fixed product label."`
	Motto           string    `xorm:"text" json:"motto" maxLength:"600" doc:"Plain-text guiding sentence."`
	Introduction    string    `xorm:"longtext" json:"introduction" maxLength:"65536" doc:"Basic rich text without embeds or images, up to 64 KiB."`
	Theme           string    `xorm:"varchar(16) not null" json:"theme" enum:"aurora,solar,nebula,ink" doc:"Built-in visual atmosphere."`
	Revision        int64     `xorm:"bigint not null" json:"revision" minimum:"0" doc:"Expected revision on save; stale edits return 409."`
	Created         time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"Creation time."`
	Updated         time.Time `xorm:"updated not null" json:"updated" readOnly:"true" doc:"Settings or entry update time."`
	MaxPermission   int       `xorm:"-" json:"max_permission" readOnly:"true" doc:"0 read, 1 write entries, 2 manage space and permanently delete entries."`
	EntryCount      int64     `xorm:"-" json:"entry_count" readOnly:"true" doc:"Entries outside trash, including archived writings."`
	PinnedCount     int64     `xorm:"-" json:"pinned_count" readOnly:"true" doc:"Pinned active entries."`
	web.CRUDable    `xorm:"-" json:"-"`
	web.Permissions `xorm:"-" json:"-"`
}

func (*CompassSpace) TableName() string { return "compass_spaces" }

type CompassEntry struct {
	ID              int64     `xorm:"bigint autoincr pk" json:"id" readOnly:"true" doc:"Entry identifier."`
	SpaceID         int64     `xorm:"bigint not null index(compass_space_state)" json:"space_id" readOnly:"true" doc:"Immutable containing space, taken from creation URL."`
	Kind            string    `xorm:"varchar(16) not null" json:"kind" enum:"principle,vision,action,memory,note" doc:"Principle, vision, action guidance, memory, or a free-form note."`
	Title           string    `xorm:"varchar(200) not null" json:"title" minLength:"1" maxLength:"200" doc:"Entry title."`
	Subtitle        string    `xorm:"text" json:"subtitle" maxLength:"600" doc:"Plain-text short introduction."`
	Content         string    `xorm:"longtext" json:"content,omitempty" maxLength:"2097152" doc:"Sanitized rich text, up to 2 MiB. Omitted from lists; load the entry to read or edit."`
	Quote           string    `xorm:"text" json:"quote" maxLength:"1000" doc:"Optional highlighted plain-text passage, explicitly selected by the author."`
	Category        string    `xorm:"varchar(80)" json:"category" maxLength:"80" doc:"User-defined topic; empty means uncategorized."`
	Tags            []string  `xorm:"json" json:"tags" maxItems:"24" doc:"Up to 24 unique single-line tags, each at most 40 Unicode characters."`
	TagsSearch      string    `xorm:"text" json:"-"`
	Theme           string    `xorm:"varchar(16) not null" json:"theme" enum:"inherit,aurora,solar,nebula,ink" doc:"Inherit space atmosphere or select an entry atmosphere."`
	Pinned          bool      `xorm:"not null default false" json:"pinned" doc:"Shown before other entries; trash removes pinning."`
	State           string    `xorm:"varchar(16) not null index(compass_space_state)" json:"state" enum:"active,archived,trashed" doc:"Trash retains content and history until an explicit permanent delete."`
	Revision        int64     `xorm:"bigint not null" json:"revision" minimum:"0" doc:"Expected revision on save; current version in responses."`
	Created         time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"Original creation time."`
	Updated         time.Time `xorm:"updated not null index" json:"updated" readOnly:"true" doc:"Last real change; unchanged saves create no new revision."`
	CreatedByID     int64     `xorm:"bigint not null" json:"created_by_id" readOnly:"true" doc:"Creator's user ID."`
	UpdatedByID     int64     `xorm:"bigint not null" json:"updated_by_id" readOnly:"true" doc:"User who saved this revision."`
	Excerpt         string    `xorm:"text" json:"excerpt" readOnly:"true" doc:"Server-derived plain-text preview, up to 360 Unicode characters."`
	ContentBytes    int64     `xorm:"bigint not null" json:"content_bytes" readOnly:"true" doc:"UTF-8 content size of this version, not total database disk usage."`
	MaxPermission   int       `xorm:"-" json:"max_permission" readOnly:"true" doc:"Permission inherited from the containing space."`
	FilterKind      string    `xorm:"-" json:"-"`
	FilterCategory  string    `xorm:"-" json:"-"`
	FilterTag       string    `xorm:"-" json:"-"`
	FilterState     string    `xorm:"-" json:"-"`
	FilterPinned    *bool     `xorm:"-" json:"-"`
	Sort            string    `xorm:"-" json:"-"`
	web.CRUDable    `xorm:"-" json:"-"`
	web.Permissions `xorm:"-" json:"-"`
}

func (*CompassEntry) TableName() string { return "compass_entries" }

type CompassRevision struct {
	ID           int64     `xorm:"bigint autoincr pk" json:"id" readOnly:"true" doc:"Revision record ID."`
	EntryID      int64     `xorm:"bigint not null unique(compass_revision)" json:"entry_id" readOnly:"true" doc:"Containing entry."`
	Revision     int64     `xorm:"bigint not null unique(compass_revision)" json:"revision" readOnly:"true" doc:"Monotonically increasing saved version."`
	Title        string    `xorm:"varchar(200) not null" json:"title" readOnly:"true" doc:"Title at save time."`
	Kind         string    `xorm:"varchar(16) not null" json:"kind" readOnly:"true" doc:"Entry kind at save time."`
	State        string    `xorm:"varchar(16) not null" json:"state" readOnly:"true" doc:"Entry state at save time."`
	UpdatedByID  int64     `xorm:"bigint not null" json:"updated_by_id" readOnly:"true" doc:"Author of the saved version."`
	Created      time.Time `xorm:"created not null" json:"created" readOnly:"true" doc:"When this version was recorded."`
	ContentBytes int64     `xorm:"bigint not null" json:"content_bytes" readOnly:"true" doc:"Content bytes of this saved version."`
	Snapshot     string    `xorm:"longtext not null" json:"-"`
}

func (*CompassRevision) TableName() string { return "compass_revisions" }

type ErrCompass struct {
	Code    int
	Message string
}

func (e ErrCompass) Error() string { return e.Message }
func (e ErrCompass) HTTPError() web.HTTPError {
	status := http.StatusBadRequest
	if e.Code == 20101 {
		status = http.StatusConflict
	}
	if e.Code == 20102 {
		status = http.StatusNotFound
	}
	return web.HTTPError{HTTPCode: status, Code: e.Code, Message: e.Message}
}
func compassMissing() error {
	return ErrCompass{20102, "This space, entry or revision no longer exists."}
}
func compassConflict() error {
	return ErrCompass{20101, "This writing changed. Read the latest revision before saving your draft."}
}
func compassInvalid(message string) error { return ErrCompass{20103, message} }
func compassUser(a web.Auth) bool         { _, shared := a.(*LinkSharing); return a.GetID() > 0 && !shared }

func compassTeamPermission(s *xorm.Session, teamID int64, a web.Auth) (int, error) {
	if !compassUser(a) {
		return -1, nil
	}
	member := &TeamMember{}
	exists, err := s.Table("team_members").Join("INNER", "teams", "teams.id = team_members.team_id").Where("team_members.team_id = ? AND team_members.user_id = ?", teamID, a.GetID()).Get(member)
	if err != nil || !exists {
		return -1, err
	}
	if member.Admin {
		return 2, nil
	}
	return 1, nil
}
func (c *CompassSpace) permission(s *xorm.Session, a web.Auth) (int, error) {
	if !compassUser(a) {
		return -1, nil
	}
	if c.TeamID > 0 {
		return compassTeamPermission(s, c.TeamID, a)
	}
	if c.OwnerID == a.GetID() {
		return 2, nil
	}
	return -1, nil
}
func loadCompassSpace(s *xorm.Session, id int64, lock bool) (*CompassSpace, error) {
	c := &CompassSpace{}
	if lock {
		s = routineCurrentRead(s)
	}
	ok, err := s.ID(id).Get(c)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, compassMissing()
	}
	return c, nil
}
func (c *CompassSpace) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	old, err := loadCompassSpace(s, c.ID, false)
	if err != nil {
		return false, 0, err
	}
	p, err := old.permission(s, a)
	*c = *old
	c.MaxPermission = p
	return p >= 0, p, err
}
func (c *CompassSpace) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	if !compassUser(a) || c.TeamID < 0 {
		return false, nil
	}
	if c.TeamID == 0 {
		return true, nil
	}
	p, err := compassTeamPermission(s, c.TeamID, a)
	return p == 2, err
}
func (c *CompassSpace) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	old, err := loadCompassSpace(s, c.ID, false)
	if err != nil {
		return false, err
	}
	p, err := old.permission(s, a)
	return p == 2, err
}
func compassTheme(theme string, inherit bool) bool {
	return slices.Contains([]string{"aurora", "solar", "nebula", "ink"}, theme) || (inherit && theme == "inherit")
}
func (c *CompassSpace) validate() error {
	c.Title = strings.TrimSpace(c.Title)
	c.Motto = strings.TrimSpace(c.Motto)
	if c.Title == "" || utf8.RuneCountInString(c.Title) > 80 || utf8.RuneCountInString(c.Motto) > 600 || len(c.Introduction) > 65536 || !compassTheme(c.Theme, false) {
		return compassInvalid("Invalid space name, introduction or theme.")
	}
	c.Introduction = announcementHTMLPolicy.Sanitize(c.Introduction)
	return nil
}
func (c *CompassSpace) Create(s *xorm.Session, a web.Auth) error {
	if c.Theme == "" {
		c.Theme = "aurora"
	}
	allowed, err := c.CanCreate(s, a)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrGenericForbidden{}
	}
	if err = c.validate(); err != nil {
		return err
	}
	c.ID = 0
	c.OwnerID = a.GetID()
	c.Revision = 1
	c.Created = time.Now()
	c.Updated = c.Created
	c.MaxPermission = 2
	_, err = s.Insert(c)
	return err
}
func (c *CompassSpace) Update(s *xorm.Session, a web.Auth) error {
	old, err := loadCompassSpace(s, c.ID, true)
	if err != nil {
		return err
	}
	p, err := old.permission(s, a)
	if err != nil {
		return err
	}
	if p != 2 {
		return ErrGenericForbidden{}
	}
	if old.Revision != c.Revision {
		return compassConflict()
	}
	if err = c.validate(); err != nil {
		return err
	}
	c.OwnerID = old.OwnerID
	c.TeamID = old.TeamID
	c.Created = old.Created
	c.MaxPermission = p
	if c.Title == old.Title && c.Motto == old.Motto && c.Introduction == old.Introduction && c.Theme == old.Theme {
		*c = *old
		return c.ReadOne(s, a)
	}
	c.Revision++
	c.Updated = time.Now()
	affected, err := s.ID(c.ID).Where("revision = ?", old.Revision).Cols("title", "motto", "introduction", "theme", "revision", "updated").Update(c)
	if err != nil {
		return err
	}
	if affected != 1 {
		return compassConflict()
	}
	return c.ReadOne(s, a)
}
func (c *CompassSpace) ReadOne(s *xorm.Session, a web.Auth) error {
	old, err := loadCompassSpace(s, c.ID, false)
	if err != nil {
		return err
	}
	p, err := old.permission(s, a)
	if err != nil {
		return err
	}
	if p < 0 {
		return ErrGenericForbidden{}
	}
	*c = *old
	c.MaxPermission = p
	c.EntryCount, err = s.Where("space_id = ? AND state <> ?", c.ID, "trashed").Count(&CompassEntry{})
	if err != nil {
		return err
	}
	c.PinnedCount, err = s.Where("space_id = ? AND state = ? AND pinned = ?", c.ID, "active", true).Count(&CompassEntry{})
	return err
}
func compassVisibleSpaces(a web.Auth) builder.Cond {
	return builder.Or(builder.Eq{"team_id": 0, "owner_id": a.GetID()}, builder.In("team_id", builder.Select("team_members.team_id").From("team_members").Join("INNER", "teams", "teams.id = team_members.team_id").Where(builder.Eq{"user_id": a.GetID()})))
}
func compassLike(column, q string) builder.Cond {
	escaped := strings.NewReplacer("!", "!!", "%", "!%", "_", "!_").Replace(q)
	op := " LIKE ? ESCAPE '!'"
	if db.Type() == schemas.POSTGRES {
		op = " ILIKE ? ESCAPE '!'"
	}
	return builder.Expr(column+op, "%"+escaped+"%")
}
func (c *CompassSpace) ReadAll(s *xorm.Session, a web.Auth, q string, page, perPage int) (any, int, int64, error) {
	if !compassUser(a) {
		return nil, 0, 0, ErrGenericForbidden{}
	}
	cond := compassVisibleSpaces(a)
	if q != "" {
		cond = builder.And(cond, compassLike("title", q))
	}
	total, err := s.Where(cond).Count(&CompassSpace{})
	if err != nil {
		return nil, 0, 0, err
	}
	items := []*CompassSpace{}
	if err = s.Where(cond).OrderBy("updated DESC, id DESC").Limit(perPage, (page-1)*perPage).Find(&items); err != nil {
		return nil, 0, 0, err
	}
	for _, item := range items {
		if err = item.ReadOne(s, a); err != nil {
			return nil, 0, 0, err
		}
	}
	return items, len(items), total, nil
}

func loadCompassEntry(s *xorm.Session, id int64, lock bool) (*CompassEntry, error) {
	entry := &CompassEntry{}
	if lock {
		existing, err := loadCompassEntry(s, id, false)
		if err != nil {
			return nil, err
		}
		if _, err = loadCompassSpace(s, existing.SpaceID, true); err != nil {
			return nil, err
		}
		s = routineCurrentRead(s)
	}
	ok, err := s.ID(id).Get(entry)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, compassMissing()
	}
	if entry.Tags == nil {
		entry.Tags = []string{}
	}
	return entry, nil
}
func (e *CompassEntry) permission(s *xorm.Session, a web.Auth) (int, error) {
	space, err := loadCompassSpace(s, e.SpaceID, false)
	if err != nil {
		return -1, err
	}
	return space.permission(s, a)
}
func (e *CompassEntry) CanRead(s *xorm.Session, a web.Auth) (bool, int, error) {
	old, err := loadCompassEntry(s, e.ID, false)
	if err != nil {
		return false, 0, err
	}
	p, err := old.permission(s, a)
	*e = *old
	e.MaxPermission = p
	return p >= 0, p, err
}
func (e *CompassEntry) CanCreate(s *xorm.Session, a web.Auth) (bool, error) {
	p, err := e.permission(s, a)
	return p >= 1, err
}
func (e *CompassEntry) CanUpdate(s *xorm.Session, a web.Auth) (bool, error) {
	old, err := loadCompassEntry(s, e.ID, false)
	if err != nil {
		return false, err
	}
	p, err := old.permission(s, a)
	return p >= 1, err
}
func (e *CompassEntry) CanDelete(s *xorm.Session, a web.Auth) (bool, error) {
	old, err := loadCompassEntry(s, e.ID, false)
	if err != nil {
		return false, err
	}
	p, err := old.permission(s, a)
	return p >= 2, err
}
func compassKind(k string) bool {
	return slices.Contains([]string{"principle", "vision", "action", "memory", "note"}, k)
}
func (e *CompassEntry) validate() error {
	e.Title = strings.TrimSpace(e.Title)
	e.Category = strings.TrimSpace(e.Category)
	if e.Title == "" || utf8.RuneCountInString(e.Title) > 200 || utf8.RuneCountInString(e.Subtitle) > 600 || utf8.RuneCountInString(e.Quote) > 1000 || utf8.RuneCountInString(e.Category) > 80 || len(e.Content) > 2097152 || len(e.Tags) > 24 {
		return compassInvalid("Entry text or tags exceed their supported size.")
	}
	if !compassKind(e.Kind) || !compassTheme(e.Theme, true) || !slices.Contains([]string{"active", "archived", "trashed"}, e.State) {
		return compassInvalid("Unknown entry kind, theme or state.")
	}
	tags := []string{}
	for _, tag := range e.Tags {
		tag = strings.TrimSpace(tag)
		if tag == "" {
			continue
		}
		if utf8.RuneCountInString(tag) > 40 || strings.ContainsAny(tag, "\r\n\x00") {
			return compassInvalid("Tags must be single-line text of at most 40 characters.")
		}
		if !slices.Contains(tags, tag) {
			tags = append(tags, tag)
		}
	}
	e.Tags = tags
	e.TagsSearch = "\n" + strings.Join(tags, "\n") + "\n"
	e.Content = announcementHTMLPolicy.Sanitize(e.Content)
	e.ContentBytes = int64(len(e.Content))
	plain := strings.Join(strings.Fields(html.UnescapeString(bluemonday.StrictPolicy().Sanitize(e.Content))), " ")
	runes := []rune(plain)
	if len(runes) > 360 {
		runes = runes[:360]
	}
	e.Excerpt = string(runes)
	if e.State == "trashed" {
		e.Pinned = false
	}
	return nil
}
func (e *CompassEntry) ReadOne(s *xorm.Session, a web.Auth) error {
	old, err := loadCompassEntry(s, e.ID, false)
	if err != nil {
		return err
	}
	p, err := old.permission(s, a)
	if err != nil {
		return err
	}
	if p < 0 {
		return ErrGenericForbidden{}
	}
	*e = *old
	e.MaxPermission = p
	return nil
}
func (e *CompassEntry) Create(s *xorm.Session, a web.Auth) error {
	if e.Kind == "" {
		e.Kind = "note"
	}
	if e.Theme == "" {
		e.Theme = "inherit"
	}
	if e.State == "" {
		e.State = "active"
	}
	if _, err := loadCompassSpace(s, e.SpaceID, true); err != nil {
		return err
	}
	allowed, err := e.CanCreate(s, a)
	if err != nil {
		return err
	}
	if !allowed {
		return ErrGenericForbidden{}
	}
	if err = e.validate(); err != nil {
		return err
	}
	e.ID = 0
	e.Revision = 1
	e.Created = time.Now()
	e.Updated = e.Created
	e.CreatedByID = a.GetID()
	e.UpdatedByID = a.GetID()
	if _, err = s.Insert(e); err != nil {
		return err
	}
	if err = e.saveRevision(s); err != nil {
		return err
	}
	return e.ReadOne(s, a)
}
func compassEntryFieldsEqual(e, old *CompassEntry) bool {
	// Only editable fields define a meaningful save, without copying long bodies into JSON.
	return e.Kind == old.Kind && e.Title == old.Title && e.Subtitle == old.Subtitle &&
		e.Content == old.Content && e.Quote == old.Quote && e.Category == old.Category &&
		slices.Equal(e.Tags, old.Tags) && e.Theme == old.Theme && e.Pinned == old.Pinned && e.State == old.State
}
func (e *CompassEntry) Update(s *xorm.Session, a web.Auth) error {
	old, err := loadCompassEntry(s, e.ID, true)
	if err != nil {
		return err
	}
	p, err := old.permission(s, a)
	if err != nil {
		return err
	}
	if p < 1 {
		return ErrGenericForbidden{}
	}
	if old.Revision != e.Revision {
		return compassConflict()
	}
	e.SpaceID = old.SpaceID
	e.Created = old.Created
	e.CreatedByID = old.CreatedByID
	if err = e.validate(); err != nil {
		return err
	}
	if compassEntryFieldsEqual(e, old) {
		*e = *old
		e.MaxPermission = p
		return nil
	}
	e.Revision++
	e.Updated = time.Now()
	e.UpdatedByID = a.GetID()
	e.MaxPermission = p
	affected, err := s.ID(e.ID).Where("revision = ?", old.Revision).Cols("kind", "title", "subtitle", "content", "quote", "category", "tags", "tags_search", "theme", "pinned", "state", "revision", "updated", "updated_by_id", "excerpt", "content_bytes").Update(e)
	if err != nil {
		return err
	}
	if affected != 1 {
		return compassConflict()
	}
	return e.saveRevision(s)
}
func (e *CompassEntry) saveRevision(s *xorm.Session) error {
	snapshot, err := json.Marshal(e)
	if err != nil {
		return err
	}
	r := &CompassRevision{EntryID: e.ID, Revision: e.Revision, Title: e.Title, Kind: e.Kind, State: e.State, UpdatedByID: e.UpdatedByID, Created: e.Updated, ContentBytes: e.ContentBytes, Snapshot: string(snapshot)}
	if _, err = s.Insert(r); err != nil {
		return err
	}
	_, err = s.ID(e.SpaceID).Cols("updated").Update(&CompassSpace{Updated: time.Now()})
	return err
}
func (e *CompassEntry) Delete(s *xorm.Session, a web.Auth) error {
	old, err := loadCompassEntry(s, e.ID, true)
	if err != nil {
		return err
	}
	p, err := old.permission(s, a)
	if err != nil {
		return err
	}
	if p < 2 {
		return ErrGenericForbidden{}
	}
	if old.Revision != e.Revision {
		return compassConflict()
	}
	if old.State != "trashed" {
		return compassInvalid("Move this entry to trash before permanently deleting it.")
	}
	if _, err = s.Where("entry_id = ?", e.ID).Delete(&CompassRevision{}); err != nil {
		return err
	}
	if _, err = s.ID(e.ID).Delete(&CompassEntry{}); err != nil {
		return err
	}
	_, err = s.ID(old.SpaceID).Cols("updated").Update(&CompassSpace{Updated: time.Now()})
	return err
}
func (e *CompassEntry) ReadAll(s *xorm.Session, a web.Auth, q string, page, perPage int) (any, int, int64, error) {
	p, err := e.permission(s, a)
	if err != nil {
		return nil, 0, 0, err
	}
	if p < 0 {
		return nil, 0, 0, ErrGenericForbidden{}
	}
	cond := builder.Eq{"space_id": e.SpaceID}.And(e.filters(q))
	total, err := s.Where(cond).Count(&CompassEntry{})
	if err != nil {
		return nil, 0, 0, err
	}
	sort := "updated DESC, id DESC"
	if e.Sort == "created" {
		sort = "created DESC, id DESC"
	}
	if e.Sort == "title" {
		sort = "title ASC, id ASC"
	}
	if e.FilterState != "trashed" {
		sort = "pinned DESC, " + sort
	}
	items := []*CompassEntry{}
	err = s.Where(cond).Omit("content", "tags_search").OrderBy(sort).Limit(perPage, (page-1)*perPage).Find(&items)
	if err != nil {
		return nil, 0, 0, err
	}
	for _, item := range items {
		item.MaxPermission = p
		if item.Tags == nil {
			item.Tags = []string{}
		}
	}
	return items, len(items), total, nil
}
func (e *CompassEntry) filters(q string) builder.Cond {
	var cond builder.Cond = builder.Eq{"state": "active"}
	switch e.FilterState {
	case "all":
		cond = builder.Neq{"state": "trashed"}
	case "archived", "trashed":
		cond = builder.Eq{"state": e.FilterState}
	}
	if e.FilterKind != "" {
		cond = cond.And(builder.Eq{"kind": e.FilterKind})
	}
	if e.FilterCategory != "" {
		cond = cond.And(builder.Eq{"category": e.FilterCategory})
	}
	if e.FilterTag != "" {
		cond = cond.And(compassLike("tags_search", "\n"+e.FilterTag+"\n"))
	}
	if e.FilterPinned != nil {
		cond = cond.And(builder.Eq{"pinned": *e.FilterPinned})
	}
	if q != "" {
		cond = cond.And(builder.Or(compassLike("title", q), compassLike("subtitle", q), compassLike("content", q), compassLike("quote", q), compassLike("category", q)))
	}
	return cond
}
func ListCompassRevisions(s *xorm.Session, a web.Auth, id int64, page, perPage int) ([]*CompassRevision, int64, error) {
	e := &CompassEntry{ID: id}
	if err := e.ReadOne(s, a); err != nil {
		return nil, 0, err
	}
	total, err := s.Where("entry_id = ?", id).Count(&CompassRevision{})
	if err != nil {
		return nil, 0, err
	}
	items := []*CompassRevision{}
	err = s.Where("entry_id = ?", id).Omit("snapshot").OrderBy("revision DESC").Limit(perPage, (page-1)*perPage).Find(&items)
	return items, total, err
}
func ReadCompassRevision(s *xorm.Session, a web.Auth, id, revision int64) (*CompassEntry, error) {
	e := &CompassEntry{ID: id}
	if err := e.ReadOne(s, a); err != nil {
		return nil, err
	}
	r := &CompassRevision{}
	ok, err := s.Where("entry_id = ? AND revision = ?", id, revision).Get(r)
	if err != nil {
		return nil, err
	}
	if !ok {
		return nil, compassMissing()
	}
	snapshot := &CompassEntry{}
	if err = json.Unmarshal([]byte(r.Snapshot), snapshot); err != nil {
		return nil, err
	}
	snapshot.MaxPermission = e.MaxPermission
	return snapshot, nil
}
func RestoreCompassRevision(s *xorm.Session, a web.Auth, id, revision, expected int64) (*CompassEntry, error) {
	current, err := loadCompassEntry(s, id, true)
	if err != nil {
		return nil, err
	}
	p, err := current.permission(s, a)
	if err != nil {
		return nil, err
	}
	if p < 1 {
		return nil, ErrGenericForbidden{}
	}
	if current.Revision != expected {
		return nil, compassConflict()
	}
	snapshot, err := ReadCompassRevision(s, a, id, revision)
	if err != nil {
		return nil, err
	}
	snapshot.ID = id
	snapshot.Revision = expected
	snapshot.State = current.State
	snapshot.Pinned = current.Pinned
	if err = snapshot.Update(s, a); err != nil {
		return nil, err
	}
	return snapshot, nil
}

type CompassTopic struct {
	Name  string `json:"name"`
	Count int64  `json:"count"`
}
type CompassTopics struct {
	Items []CompassTopic `json:"items"`
	Tags  []CompassTopic `json:"tags"`
}

func ReadCompassTopics(s *xorm.Session, a web.Auth, spaceID int64) (*CompassTopics, error) {
	c := &CompassSpace{ID: spaceID}
	can, _, err := c.CanRead(s, a)
	if err != nil {
		return nil, err
	}
	if !can {
		return nil, ErrGenericForbidden{}
	}
	// Only short categorization fields are loaded; never hydrate long-form bodies for navigation.
	entries := []*CompassEntry{}
	if err = s.Where("space_id = ? AND state <> ?", spaceID, "trashed").Cols("category", "tags").Find(&entries); err != nil {
		return nil, err
	}
	topics, tags := map[string]int64{}, map[string]int64{}
	for _, e := range entries {
		if e.Category != "" {
			topics[e.Category]++
		}
		for _, t := range e.Tags {
			tags[t]++
		}
	}
	list := func(m map[string]int64) []CompassTopic {
		out := []CompassTopic{}
		for name, count := range m {
			out = append(out, CompassTopic{Name: name, Count: count})
		}
		slices.SortFunc(out, func(a, b CompassTopic) int { return strings.Compare(a.Name, b.Name) })
		return out
	}
	return &CompassTopics{Items: list(topics), Tags: list(tags)}, nil
}

// Account/team removal must not leave private writing behind or turn team writing into personal property.
func deleteCompassSpaces(s *xorm.Session, cond builder.Cond) error {
	spaces := []*CompassSpace{}
	if err := s.Where(cond).Cols("id").Find(&spaces); err != nil {
		return err
	}
	for _, c := range spaces {
		if _, err := loadCompassSpace(s, c.ID, true); err != nil {
			return err
		}
		ids := []int64{}
		if err := s.Table(&CompassEntry{}).Where("space_id = ?", c.ID).Cols("id").Find(&ids); err != nil {
			return err
		}
		for _, id := range ids {
			if _, err := s.Where("entry_id = ?", id).Delete(&CompassRevision{}); err != nil {
				return err
			}
		}
		if _, err := s.Where("space_id = ?", c.ID).Delete(&CompassEntry{}); err != nil {
			return err
		}
		if _, err := s.ID(c.ID).Delete(&CompassSpace{}); err != nil {
			return err
		}
	}
	return nil
}
