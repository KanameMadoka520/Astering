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

package migration

import (
	"time"

	"src.techknowlogick.com/xormigrate"
	"xorm.io/xorm"
)

type ProjectVersion20261107014133 struct {
	ID                    int64     `xorm:"bigint autoincr pk"`
	ProjectID             int64     `xorm:"bigint not null index unique(project_version_sequence)"`
	Sequence              int64     `xorm:"bigint not null unique(project_version_sequence)"`
	Name                  string    `xorm:"varchar(160) not null"`
	Kind                  string    `xorm:"varchar(24) not null"`
	RestoredFromVersionID int64     `xorm:"bigint not null default 0"`
	ContentHash           string    `xorm:"varchar(64) not null"`
	SchemaVersion         int       `xorm:"not null"`
	Created               time.Time `xorm:"created not null"`
	CreatedByID           int64     `xorm:"bigint not null"`
	CreatorUsername       string    `xorm:"varchar(250) not null"`
	CreatorName           string    `xorm:"varchar(250) not null"`
	RequestID             string    `xorm:"varchar(80) not null index"`
	TaskCount             int64     `xorm:"bigint not null"`
	ViewCount             int64     `xorm:"bigint not null"`
	BucketCount           int64     `xorm:"bigint not null"`
	AttachmentCount       int64     `xorm:"bigint not null"`
	FileCount             int64     `xorm:"bigint not null"`
	ReferencedFileBytes   int64     `xorm:"bigint not null"`
	ContentBytes          int64     `xorm:"bigint not null"`
	NewObjectBytes        int64     `xorm:"bigint not null"`
	RestoreReceipt        string    `xorm:"longtext"`
}

func (*ProjectVersion20261107014133) TableName() string { return "project_versions" }

type projectVersionCounter20261107014133 struct {
	ProjectID int64 `xorm:"bigint pk"`
	Sequence  int64 `xorm:"bigint not null"`
}

func (*projectVersionCounter20261107014133) TableName() string { return "project_version_counters" }

type projectVersionObject20261107014133 struct {
	ID           int64  `xorm:"bigint autoincr pk"`
	ProjectID    int64  `xorm:"bigint not null unique(project_version_object)"`
	Hash         string `xorm:"varchar(64) not null unique(project_version_object)"`
	Encoding     string `xorm:"varchar(12) not null"`
	ContentBytes int64  `xorm:"bigint not null"`
	Payload      []byte `xorm:"longblob not null"`
}

func (*projectVersionObject20261107014133) TableName() string { return "project_version_objects" }

type projectVersionEntity20261107014133 struct {
	ID        int64  `xorm:"bigint autoincr pk"`
	VersionID int64  `xorm:"bigint not null index unique(project_version_entity)"`
	Kind      string `xorm:"varchar(24) not null unique(project_version_entity)"`
	EntityID  string `xorm:"varchar(100) not null unique(project_version_entity)"`
	ObjectID  int64  `xorm:"bigint not null index"`
	Hash      string `xorm:"varchar(64) not null"`
	Title     string `xorm:"text"`
}

func (*projectVersionEntity20261107014133) TableName() string { return "project_version_entities" }

type projectVersionTaskRef20261107014133 struct {
	ID        int64 `xorm:"bigint autoincr pk"`
	VersionID int64 `xorm:"bigint not null unique(project_version_task_ref)"`
	ProjectID int64 `xorm:"bigint not null index"`
	TaskID    int64 `xorm:"bigint not null index unique(project_version_task_ref)"`
}

func (*projectVersionTaskRef20261107014133) TableName() string { return "project_version_task_refs" }

type ProjectVersionFileRef20261107014133 struct {
	ID        int64 `xorm:"bigint autoincr pk"`
	ProjectID int64 `xorm:"bigint not null index"`
	VersionID int64 `xorm:"bigint not null unique(project_version_file_ref) index"`
	FileID    int64 `xorm:"bigint not null unique(project_version_file_ref) index"`
}

func (*ProjectVersionFileRef20261107014133) TableName() string { return "project_version_file_refs" }
func init() {
	migrations = append(migrations, &xormigrate.Migration{ID: "20261107014133", Description: "Add immutable project checkpoints, deduplicated objects and authoritative media/task retention edges", Migrate: func(tx *xorm.Engine) error {
		// New tables only; existing project/task rows remain unchanged.
		return tx.Sync(&ProjectVersion20261107014133{}, &projectVersionCounter20261107014133{}, &projectVersionObject20261107014133{}, &projectVersionEntity20261107014133{}, &projectVersionTaskRef20261107014133{}, &ProjectVersionFileRef20261107014133{}) //nolint:forbidigo // Sync is permitted for new tables in migrations.
	}, Rollback: func(tx *xorm.Engine) error { return nil }})
}
