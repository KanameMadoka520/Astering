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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/KanameMadoka520/Astering/pkg/utils"

	"xorm.io/xorm"
)

// OAuthCode represents a short-lived OAuth 2.0 authorization code.
type OAuthCode struct {
	// Trusted issuance fence used only during a consumed-code exchange.
	AuthorizationGeneration string    `xorm:"-" json:"-"`
	ID                      int64     `xorm:"autoincr not null unique pk" json:"id"`
	UserID                  int64     `xorm:"bigint not null" json:"-"`
	Code                    string    `xorm:"varchar(128) not null unique index" json:"-"`
	ExpiresAt               time.Time `xorm:"not null" json:"-"`
	ClientID                string    `xorm:"varchar(255) not null" json:"-"`
	RedirectURI             string    `xorm:"text not null" json:"-"`
	CodeChallenge           string    `xorm:"varchar(128) not null" json:"-"`
	CodeChallengeMethod     string    `xorm:"varchar(10) not null" json:"-"`
	Created                 time.Time `xorm:"created not null" json:"created"`
}

func (*OAuthCode) TableName() string {
	return "oauth_codes"
}

// CreateOAuthCode generates a cryptographically random authorization code,
// stores it, and returns the code string.
func CreateOAuthCode(s *xorm.Session, userID int64, clientID, redirectURI, codeChallenge, codeChallengeMethod string) (code string, err error) {
	return CreateOAuthCodeForAuth(s, &user.User{ID: userID}, clientID, redirectURI, codeChallenge, codeChallengeMethod)
}

// CreateOAuthCodeForAuth preserves the real browser credential across the user
// lock so an already-revoked request cannot create a new authorization code.
func CreateOAuthCodeForAuth(s *xorm.Session, actor *user.User, clientID, redirectURI, codeChallenge, codeChallengeMethod string) (code string, err error) {
	if err := LockCredentialIssue(s, actor); err != nil {
		return "", err
	}
	userID := actor.ID
	rawCode, err := utils.CryptoRandomString(64)
	if err != nil {
		return "", err
	}

	oauthCode := &OAuthCode{
		UserID:              userID,
		Code:                HashSessionToken(rawCode),
		ExpiresAt:           time.Now().Add(10 * time.Minute),
		ClientID:            clientID,
		RedirectURI:         redirectURI,
		CodeChallenge:       codeChallenge,
		CodeChallengeMethod: codeChallengeMethod,
	}

	_, err = s.Insert(oauthCode)
	if err != nil {
		return "", err
	}

	return rawCode, nil
}

// GetAndDeleteOAuthCode looks up an authorization code and deletes it (single-use).
// Returns the code record or an error if not found or expired.
func GetAndDeleteOAuthCode(s *xorm.Session, code string) (*OAuthCode, error) {
	oauthCode := &OAuthCode{}
	has, err := s.Where("code = ?", HashSessionToken(code)).Get(oauthCode)
	if err != nil {
		return nil, err
	}
	if !has {
		return nil, &ErrOAuthCodeInvalid{}
	}

	oauthCode.AuthorizationGeneration, err = user.SessionAuthCacheKey(oauthCode.UserID, "oauth-code-exchange")
	if err != nil {
		return nil, err
	}

	// Delete immediately (single-use).
	// Check affected rows to prevent a race where two concurrent requests
	// both read the same code before either deletes it.
	affected, err := s.Where("id = ?", oauthCode.ID).Delete(&OAuthCode{})
	if err != nil {
		return nil, err
	}
	if affected == 0 {
		return nil, &ErrOAuthCodeInvalid{}
	}

	// Check expiry after deletion to prevent reuse of expired codes
	if time.Now().After(oauthCode.ExpiresAt) {
		return nil, &ErrOAuthCodeExpired{}
	}

	return oauthCode, nil
}

// ValidateOAuthCodeExchange runs with the user lock held by the caller. A code
// consumed before a later credential revocation must not mint a new session.
func ValidateOAuthCodeExchange(code *OAuthCode) error {
	generation, err := user.SessionAuthCacheKey(code.UserID, "oauth-code-exchange")
	if err != nil {
		return err
	}
	if code.AuthorizationGeneration == "" || generation != code.AuthorizationGeneration {
		return &ErrOAuthCodeInvalid{}
	}
	return nil
}
