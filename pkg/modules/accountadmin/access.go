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

// Package accountadmin defines explicit deployment-level account operations.
// It never grants access to another account's private business resources.
package accountadmin

import (
	"os"
	"strconv"
	"strings"
)

// Configured is deliberately independent of usage, SMTP and the licensed admin
// flag. An explicitly empty configuration grants nobody; every call rereads it.
func Configured(uid int64) bool {
	if uid <= 0 {
		return false
	}
	for _, value := range strings.Split(os.Getenv("ASTERING_SUPERADMIN_IDS"), ",") {
		id, err := strconv.ParseInt(strings.TrimSpace(value), 10, 64)
		if err == nil && id > 0 && id == uid {
			return true
		}
	}
	return false
}
