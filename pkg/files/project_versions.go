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
	"errors"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// ProjectVersionFileRef is an authoritative retention edge, including legacy files outside Drive.
type ProjectVersionFileRef struct {
	ID        int64 `xorm:"bigint autoincr pk"`
	ProjectID int64 `xorm:"bigint not null index"`
	VersionID int64 `xorm:"bigint not null unique(project_version_file_ref) index"`
	FileID    int64 `xorm:"bigint not null unique(project_version_file_ref) index"`
}

func (*ProjectVersionFileRef) TableName() string { return "project_version_file_refs" }
func ReferencedByProjectVersion(s *xorm.Session, id int64) (bool, error) {
	query, args, err := builder.Dialect(db.GetDialect()).Select("id").From(s.Engine().TableName(new(ProjectVersionFileRef), true)).Where(builder.Eq{"file_id": id}).Limit(1).ToSQL()
	if err != nil {
		return false, err
	}
	// Retention edges are immutable. A shared current read sees newly committed
	// checkpoints on MySQL without reversing Drive -> reference lock order into
	// an exclusive lock against the snapshot reader's existing shared locks.
	switch {
	case db.Type() == schemas.MYSQL:
		query += " LOCK IN SHARE MODE"
	case db.Type() == schemas.POSTGRES:
		query += " FOR SHARE"
	}
	var refs []struct{ ID int64 }
	err = s.SQL(query, args...).Find(&refs)
	return len(refs) > 0, err
}

func currentFileRead(s *xorm.Session) *xorm.Session {
	if db.Type() == schemas.MYSQL || db.Type() == schemas.POSTGRES {
		return s.ForUpdate()
	}
	return s
}

// LockOriginalForReference serializes legacy file removal and checkpoint retention without a models dependency.
// Always acquire the Drive row, then original metadata, after project/view/task guards.
func LockOriginalForReference(s *xorm.Session, id int64) error {
	drive := &DriveFile{}
	exists, err := currentFileRead(s).Where("file_id = ?", id).Get(drive)
	if err != nil {
		return err
	}
	if exists && drive.Purging {
		return errors.New("original file is being permanently deleted")
	}
	original := &File{}
	exists, err = currentFileRead(s).ID(id).Get(original)
	if err != nil {
		return err
	}
	if !exists {
		return ErrFileDoesNotExist{FileID: id}
	}
	return nil
}
