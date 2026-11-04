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

package personalstorage

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/models"
)

const previewLifetime = 10 * time.Minute

type confirmation struct {
	StorageSelection
	UID     int64  `json:"uid"`
	Session string `json:"session"`
	Name    string `json:"name"`
	Usages  string `json:"usages"`
	Expires int64  `json:"expires"`
}

func confirmationMAC(payload []byte) []byte {
	mac := hmac.New(sha256.New, []byte(config.ServiceSecret.GetString()))
	_, _ = mac.Write([]byte("astering-personal-storage-v1:"))
	_, _ = mac.Write(payload)
	return mac.Sum(nil)
}

func signConfirmation(value confirmation) (string, error) {
	if config.ServiceSecret.GetString() == "" {
		return "", ErrUnavailable
	}
	data, err := json.Marshal(value)
	if err != nil {
		return "", err
	}
	return base64.RawURLEncoding.EncodeToString(data) + "." + base64.RawURLEncoding.EncodeToString(confirmationMAC(data)), nil
}

func readConfirmation(token string, uid int64, session string, now time.Time) (confirmation, error) {
	var value confirmation
	if len(token) > 8192 || config.ServiceSecret.GetString() == "" {
		return value, ErrInvalid
	}
	parts := strings.Split(token, ".")
	if len(parts) != 2 {
		return value, ErrInvalid
	}
	data, err := base64.RawURLEncoding.DecodeString(parts[0])
	if err != nil {
		return value, ErrInvalid
	}
	signature, err := base64.RawURLEncoding.DecodeString(parts[1])
	if err != nil || !hmac.Equal(signature, confirmationMAC(data)) {
		return value, ErrInvalid
	}
	if err = json.Unmarshal(data, &value); err != nil {
		return value, ErrInvalid
	}
	if value.UID != uid || value.Session != session || value.Expires <= now.Unix() || value.Expires > now.Add(previewLifetime).Unix()+1 {
		return confirmation{}, errors.New("storage_preview_expired")
	}
	return value, nil
}

func referenceFingerprint(usages []models.DriveUsage) string {
	// Quoted fields and fixed delimiters keep the fingerprint unambiguous without a fallible serializer.
	var data []byte
	for _, usage := range usages {
		data = strconv.AppendQuote(data, usage.Kind)
		data = append(data, ':')
		data = strconv.AppendQuote(data, usage.Title)
		data = append(data, ':')
		data = strconv.AppendQuote(data, usage.URL)
		data = append(data, ':')
		data = strconv.AppendBool(data, usage.Restricted)
		data = append(data, ';')
	}
	sum := sha256.Sum256(data)
	return base64.RawURLEncoding.EncodeToString(sum[:])
}
