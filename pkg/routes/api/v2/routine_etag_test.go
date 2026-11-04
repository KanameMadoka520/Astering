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
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/danielgtaylor/huma/v2/conditional"
	"github.com/stretchr/testify/require"
)

func TestTaskRoutineETag(t *testing.T) {
	body := &taskReadOneBody{Task: models.Task{ID: 1, Updated: time.Now(), Routine: &models.TaskRoutine{Date: "2026-10-31", CompletedToday: true}}, MaxPermission: models.PermissionWrite}
	first, err := conditionalRepresentationResponse(&conditional.Params{}, body)
	require.NoError(t, err)
	_, err = conditionalRepresentationResponse(&conditional.Params{IfNoneMatch: []string{first.ETag}}, body)
	require.Error(t, err)
	body.Routine.Date = "2026-11-01"
	body.Routine.CompletedToday = false
	next, err := conditionalRepresentationResponse(&conditional.Params{IfNoneMatch: []string{first.ETag}, IfModifiedSince: time.Now().Add(time.Hour)}, body)
	require.NoError(t, err)
	require.NotEqual(t, first.ETag, next.ETag)
	body.MaxPermission = models.PermissionRead
	changed, err := conditionalRepresentationResponse(&conditional.Params{IfNoneMatch: []string{next.ETag}}, body)
	require.NoError(t, err)
	require.NotEqual(t, next.ETag, changed.ETag)
}
