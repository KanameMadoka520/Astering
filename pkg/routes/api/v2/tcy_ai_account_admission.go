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
	"context"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func aiRunAdmission(ctx context.Context, uid int64) (context.Context, error) {
	// Capture before locking/validating credentials. Revoke either invalidates
	// the original proof, invalidates this generation before registration, or
	// cancels a worker that registered first under conversations.Mutex.
	guarded := tcyai.WithAccountRunAdmission(ctx, uid)
	a, err := authFromCtx(ctx)
	if err != nil {
		return nil, err
	}
	u, err := user.GetFromAuth(a)
	if err != nil || u == nil || u.ID != uid || u.HasResourceOnlyPermissions() || u.CredentialScope().APITokenID > 0 {
		return nil, huma.Error403Forbidden("account_human_session_required")
	}
	s := db.NewSession()
	// Close deliberately rolls back this read-only authorization transaction.
	// The generation fence bridges releasing the user lock and registering live
	// work; holding it through private-store writes would nest a conflicting lock.
	defer s.Close()
	db.SetSessionContext(ctx, s)
	if err = models.LockCredentialIssue(s, u); err != nil {
		if models.IsErrGenericForbidden(err) || user.IsErrUserCannotAuthenticate(err) {
			return nil, huma.Error403Forbidden(tcylocale.Render(ctx, tcylocale.Error("accountRunRevoked")))
		}
		return nil, translateDomainError(err)
	}
	return guarded, nil
}
