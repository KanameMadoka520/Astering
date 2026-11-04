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

package files

import (
	"os"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/xorm"
)

// DriveFile owns a blob independently of any task, cover or avatar reference.
type DriveFile struct {
	FileID    int64     `xorm:"bigint pk" json:"file_id"`
	OwnerID   int64     `xorm:"bigint not null index" json:"-"`
	Category  string    `xorm:"varchar(120)" json:"category"`
	Pinned    bool      `xorm:"not null default false" json:"pinned"`
	TrashedAt time.Time `xorm:"null" json:"trashed_at"`
	Purging   bool      `xorm:"not null default false" json:"purging"`
	Revision  int64     `xorm:"bigint not null default 1" json:"revision"`
	File      *File     `xorm:"-" json:"file"`
}

func (*DriveFile) TableName() string { return "drive_files" }

// Matches the drive list, which treats pre-1971 values as "not trashed".
var driveTrashEpoch = time.Date(1971, 1, 1, 0, 0, 0, 0, time.UTC)

// InTrash reports whether the file is in the recycle bin.
func (d *DriveFile) InTrash() bool { return d.TrashedAt.After(driveTrashEpoch) }

// DriveChatRef pins a drive file while a private AI conversation may reference it.
// The conversation itself lives in an encrypted file the database cannot read, so
// rows are a conservative superset: written before the conversation references the
// file and removed only after the saved conversation is verified not to.
type DriveChatRef struct {
	ID             int64     `xorm:"bigint autoincr not null unique pk" json:"-"`
	OwnerID        int64     `xorm:"bigint not null unique(drive_chat_ref)" json:"-"`
	ConversationID string    `xorm:"varchar(36) not null unique(drive_chat_ref)" json:"-"`
	FileID         int64     `xorm:"bigint not null unique(drive_chat_ref) index" json:"-"`
	Created        time.Time `xorm:"created not null" json:"-"`
}

func (*DriveChatRef) TableName() string { return "drive_chat_refs" }

// AddToDrive is called only for user uploads, never exports or temporary files.
// Negative IDs identify link shares, which do not own a personal drive.
func AddToDrive(s *xorm.Session, f *File) error {
	if f.CreatedByID <= 0 {
		return nil
	}
	_, err := s.Insert(&DriveFile{FileID: f.ID, OwnerID: f.CreatedByID, Revision: 1})
	return err
}
func (f *File) keptInDrive(s *xorm.Session) (bool, error) {
	return s.Where("file_id = ?", f.ID).Exist(&DriveFile{})
}

// PurgeFromDrive is reserved for the usage-checked recycle-bin operation.
func (f *File) PurgeFromDrive(s *xorm.Session) error {
	_, err := s.Where("file_id = ?", f.ID).Cols("purging").Update(&DriveFile{Purging: true})
	return err
}

// FinishDrivePurge leaves a durable tombstone on any storage/DB failure. A retry
// can safely complete it; restore and new references are blocked after marking.
func FinishDrivePurge(id int64) error {
	s := db.NewSession()
	defer s.Close()
	d := &DriveFile{}
	ok, err := s.Where("file_id = ? AND purging = ?", id, true).Get(d)
	if err != nil {
		return err
	}
	if !ok {
		return nil
	}
	f := &File{ID: id}
	if err = storage.Remove(f.fileID()); err != nil && !os.IsNotExist(err) {
		return err
	}
	f.removePreviews()
	if _, err = s.ID(id).Delete(&File{}); err != nil {
		return err
	}
	if _, err = s.Where("file_id = ? AND purging = ?", id, true).Delete(&DriveFile{}); err != nil {
		return err
	}
	return s.Commit()
}
