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
	"github.com/KanameMadoka520/Astering/pkg/db"
	"xorm.io/builder"
	"xorm.io/xorm"
	"xorm.io/xorm/schemas"
)

// sharedVersionRows adds only a dialect lock clause to an ORM builder query.
// Xorm has no shared-lock API. These current reads avoid MySQL repeatable-read
// snapshots without exclusively locking every account/grant/ancestor row.
// Table/order names are internal constants, never supplied by a request.
func sharedVersionRows(s *xorm.Session, table string, cond builder.Cond, order string, dest any) error {
	q := builder.Select("*").From(s.Engine().TableName(table, true)).Where(cond)
	if order != "" {
		q.OrderBy(order)
	}
	sql, args, err := q.ToSQL()
	if err != nil {
		return err
	}
	switch db.Type() {
	case schemas.MYSQL:
		sql += " LOCK IN SHARE MODE"
	case schemas.POSTGRES:
		sql += " FOR SHARE"
	case schemas.SQLITE, schemas.MSSQL, schemas.ORACLE, schemas.DAMENG, schemas.GBASE8S:
		// The supported SQLite dialect has no shared row-lock clause.
	}
	return s.SQL(sql, args...).Find(dest)
}
