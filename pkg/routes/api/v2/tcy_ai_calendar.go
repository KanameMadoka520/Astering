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

package apiv2

import (
	"encoding/json"
	"fmt"
	"net/url"
)

// The normal calendar route applies the caller's resource ACL before count and
// paging. Do not reinterpret project_id as a write scope or the current project.
func aiCalendarQuery(args map[string]json.RawMessage, query url.Values) error {
	for key, raw := range args {
		var value any
		if err := json.Unmarshal(raw, &value); err != nil {
			return err
		}
		query.Set(key, fmt.Sprint(value))
	}
	if query.Get("per_page") == "" {
		query.Set("per_page", "25")
	}
	return nil
}
