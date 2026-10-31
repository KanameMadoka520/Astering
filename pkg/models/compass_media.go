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
	"errors"
	"fmt"
	"image"
	_ "image/gif"  // Register supported raster formats for DecodeConfig.
	_ "image/jpeg" // Register JPEG decoding.
	_ "image/png"  // Register PNG decoding.
	"io"
	"regexp"
	"slices"
	"strconv"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/files"
	"code.vikunja.io/api/pkg/modules/imageutils"
	"code.vikunja.io/api/pkg/web"
	"github.com/c2h5oh/datasize"
	"github.com/microcosm-cc/bluemonday"
	_ "golang.org/x/image/webp" // Register WebP decoding.
	"golang.org/x/net/html"
	"xorm.io/xorm"
)

type compassMedia struct {
	ID        int64     `xorm:"bigint autoincr pk"`
	SpaceID   int64     `xorm:"bigint not null unique(compass_media)"`
	FileID    int64     `xorm:"bigint not null unique(compass_media) index"`
	AddedByID int64     `xorm:"bigint not null"`
	Width     int       `xorm:"int not null default 0"`
	Height    int       `xorm:"int not null default 0"`
	Created   time.Time `xorm:"created not null"`
}

func (*compassMedia) TableName() string { return "compass_media" }

type compassEntryMedia struct {
	ID      int64 `xorm:"bigint autoincr pk"`
	EntryID int64 `xorm:"bigint not null unique(compass_entry_media)"`
	FileID  int64 `xorm:"bigint not null unique(compass_entry_media) index"`
	SpaceID int64 `xorm:"bigint not null index"`
	Current bool  `xorm:"not null default false"`
}

func (*compassEntryMedia) TableName() string { return "compass_entry_media" }

var compassImageID = regexp.MustCompile(`^[1-9][0-9]{0,18}$`)
var compassHTMLPolicy = func() *bluemonday.Policy {
	p := newAnnouncementHTMLPolicy()
	p.AllowAttrs("data-compass-image").Matching(compassImageID).OnElements("img")
	p.AllowAttrs("alt", "title").OnElements("img")
	p.AllowAttrs("width", "height").Matching(regexp.MustCompile(`^[1-9][0-9]{0,4}$`)).OnElements("img")
	return p
}()

// Canonical references contain no remote addresses, credentials, blobs or script attributes.
func sanitizeCompassContent(content string) (string, []int64, error) {
	z := html.NewTokenizer(strings.NewReader(compassHTMLPolicy.Sanitize(content)))
	var out strings.Builder
	ids := []int64{}
	for {
		kind := z.Next()
		if kind == html.ErrorToken {
			if !errors.Is(z.Err(), io.EOF) {
				return "", nil, z.Err()
			}
			break
		}
		if kind != html.StartTagToken && kind != html.SelfClosingTagToken {
			out.Write(z.Raw())
			continue
		}
		t := z.Token()
		if t.Data != "img" {
			out.WriteString(t.String())
			continue
		}
		var id int64
		for i, a := range t.Attr {
			if a.Key == "data-compass-image" {
				parsed, parseErr := strconv.ParseInt(a.Val, 10, 64)
				if parseErr != nil {
					id = 0
				} else {
					id = parsed
				}
			}
			if a.Key == "alt" || a.Key == "title" {
				runes := []rune(a.Val)
				if len(runes) > 500 {
					t.Attr[i].Val = string(runes[:500])
				}
			}
		}
		if id <= 0 {
			continue
		}
		if !slices.Contains(ids, id) {
			ids = append(ids, id)
		}
		if len(ids) > 100 {
			return "", nil, ErrCompass{20105, "A writing can contain at most 100 distinct images."}
		}
		out.WriteString(t.String())
	}
	slices.Sort(ids) // Stable lock order across writers sharing Drive files.
	return out.String(), ids, nil
}
func compassRaster(mime string) bool {
	return slices.Contains([]string{"image/jpeg", "image/png", "image/gif", "image/webp"}, mime)
}
func compassImageUnavailable(id int64) error {
	return ErrCompass{20104, fmt.Sprintf("Image %d is not available in this space. Choose an active image from your own drive.", id)}
}
func compassImageInvalid(id int64) error {
	return ErrCompass{20106, fmt.Sprintf("Image %d is not a supported raster image or exceeds the image limits.", id)}
}

func ensureCompassImage(s *xorm.Session, a web.Auth, spaceID, fileID int64) error {
	if fileID == 0 {
		return nil
	}
	exists, err := routineCurrentRead(s).Where("space_id = ? AND file_id = ?", spaceID, fileID).Exist(&compassMedia{})
	if err != nil || exists {
		return err
	}
	d, err := GetDriveItem(s, a, fileID)
	if err != nil {
		return compassImageUnavailable(fileID)
	}
	if d.Purging || !d.TrashedAt.IsZero() {
		return compassImageUnavailable(fileID)
	}
	// Check using division to avoid overflow in a configured MiB limit.
	maxMB := config.GetMaxFileSizeInMBytes()
	if !compassRaster(d.File.Mime) || (d.File.Size > 0 && (d.File.Size-1)/uint64(datasize.MB) >= maxMB) {
		return compassImageInvalid(fileID)
	}
	if err = d.File.LoadFileByID(); err != nil {
		return compassImageUnavailable(fileID)
	}
	cfg, format, decodeErr := image.DecodeConfig(io.LimitReader(d.File.File, 4<<20))
	closeErr := d.File.File.Close()
	if decodeErr != nil || closeErr != nil || imageutils.ValidateConfig(cfg) != nil || !slices.Contains([]string{"jpeg", "png", "gif", "webp"}, format) {
		return compassImageInvalid(fileID)
	}
	// Serializes against Drive trash/purge. Metadata is immutable for the file ID.
	locked, err := LockDriveItem(s, a, fileID, d.Revision)
	if err != nil || locked.Purging || !locked.TrashedAt.IsZero() {
		return compassImageUnavailable(fileID)
	}
	_, err = s.Insert(&compassMedia{SpaceID: spaceID, FileID: fileID, AddedByID: a.GetID(), Width: cfg.Width, Height: cfg.Height})
	return err
}
func (e *CompassEntry) syncImages(s *xorm.Session, a web.Auth) error {
	_, ids, err := sanitizeCompassContent(e.Content)
	if err != nil {
		return err
	}
	for _, id := range ids {
		if err = ensureCompassImage(s, a, e.SpaceID, id); err != nil {
			return err
		}
	}
	if _, err = s.Where("entry_id = ?", e.ID).Cols("current").Update(&compassEntryMedia{Current: false}); err != nil {
		return err
	}
	for _, id := range ids {
		exists, err := routineCurrentRead(s).Where("entry_id = ? AND file_id = ?", e.ID, id).Exist(&compassEntryMedia{})
		if err != nil {
			return err
		}
		if exists {
			_, err = s.Where("entry_id = ? AND file_id = ?", e.ID, id).Cols("current").Update(&compassEntryMedia{Current: true})
		} else {
			_, err = s.Insert(&compassEntryMedia{EntryID: e.ID, FileID: id, SpaceID: e.SpaceID, Current: true})
		}
		if err != nil {
			return err
		}
	}
	return nil
}
func gcCompassImages(s *xorm.Session, spaceID int64) error {
	space, err := loadCompassSpace(s, spaceID, true)
	if err != nil {
		return err
	}
	images := []*compassMedia{}
	if err = routineCurrentRead(s).Where("space_id = ?", spaceID).Find(&images); err != nil {
		return err
	}
	for _, m := range images {
		if m.FileID == space.BackgroundFileID {
			continue
		}
		used, err := routineCurrentRead(s).Where("space_id = ? AND file_id = ?", spaceID, m.FileID).Exist(&compassEntryMedia{})
		if err != nil {
			return err
		}
		if !used {
			if _, err = s.ID(m.ID).Delete(&compassMedia{}); err != nil {
				return err
			}
		}
	}
	return nil
}

// GetCompassImage checks current membership before allowing any mounted image or own draft preview.
func GetCompassImage(s *xorm.Session, a web.Auth, spaceID, fileID int64) (*files.File, error) {
	space, err := loadCompassSpace(s, spaceID, false)
	if err != nil {
		return nil, compassMissing()
	}
	permission, err := space.permission(s, a)
	if err != nil {
		return nil, err
	}
	if permission < 0 {
		return nil, compassMissing()
	}
	mounted, err := s.Where("space_id = ? AND file_id = ?", spaceID, fileID).Exist(&compassMedia{})
	if err != nil {
		return nil, err
	}
	f := &files.File{ID: fileID}
	if mounted {
		if err = f.LoadFileMetaByID(s); err != nil {
			return nil, compassMissing()
		}
	} else {
		if permission < 1 {
			return nil, compassMissing()
		}
		d, err := GetDriveItem(s, a, fileID)
		if err != nil || d.Purging || !d.TrashedAt.IsZero() {
			return nil, compassMissing()
		}
		f = d.File
	}
	if !compassRaster(f.Mime) {
		return nil, compassMissing()
	}
	return f, nil
}

// Usage protection includes snapshots and trashed entries. Never disclose inaccessible writing titles.
func compassDriveUsages(s *xorm.Session, a web.Auth, fileID int64) ([]DriveUsage, error) {
	out := []DriveUsage{}
	refs := []*compassEntryMedia{}
	if err := s.Where("file_id = ?", fileID).Find(&refs); err != nil {
		return nil, err
	}
	for _, ref := range refs {
		e, err := loadCompassEntry(s, ref.EntryID, false)
		if err != nil {
			return nil, err
		}
		p, err := e.permission(s, a)
		if err != nil {
			return nil, err
		}
		u := DriveUsage{Kind: "compass_entry", Restricted: p < 0}
		if !ref.Current {
			u.Kind = "compass_history"
		} else if e.State == "trashed" {
			u.Kind = "compass_trash"
		}
		if !u.Restricted {
			u.Title = e.Title
			u.URL = fmt.Sprintf("/compass/entries/%d", e.ID)
			if !ref.Current {
				u.URL += "/history"
			}
		}
		out = append(out, u)
	}
	spaces := []*CompassSpace{}
	if err := s.Where("background_file_id = ?", fileID).Find(&spaces); err != nil {
		return nil, err
	}
	for _, c := range spaces {
		p, err := c.permission(s, a)
		if err != nil {
			return nil, err
		}
		u := DriveUsage{Kind: "compass_background", Restricted: p < 0}
		if !u.Restricted {
			u.Title = c.Title
			u.URL = fmt.Sprintf("/compass/spaces/%d/settings", c.ID)
		}
		out = append(out, u)
	}
	return out, nil
}
