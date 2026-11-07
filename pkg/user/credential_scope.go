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

package user

// CredentialScope is trusted in-process authentication metadata. It is never
// persisted or decoded from request JSON. SessionID is the existing verified
// JWT sid, not a new client-supplied permission or JWT claim.
type CredentialScope struct {
	SessionID  string
	APITokenID int64
}

func WithSessionCredential(u *User, sid string) *User {
	if u == nil {
		return nil
	}
	principal := *u
	principal.credential = CredentialScope{SessionID: sid}
	return &principal
}
func WithAPITokenCredential(u *User, tokenID int64) *User {
	if u == nil {
		return nil
	}
	principal := *u
	principal.credential = CredentialScope{APITokenID: tokenID}
	return &principal
}
func (u *User) CredentialScope() CredentialScope {
	if u == nil {
		return CredentialScope{}
	}
	return u.credential
}
