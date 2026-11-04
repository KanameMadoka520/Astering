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

package mailsettings

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"net"
	"net/mail"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
)

type MailSettings struct {
	Enabled       bool   `json:"enabled"`
	Host          string `json:"host" maxLength:"253"`
	Port          int    `json:"port" minimum:"1" maximum:"65535"`
	Username      string `json:"username" maxLength:"320"`
	Password      string `json:"password,omitempty" writeOnly:"true" maxLength:"4096" doc:"Blank preserves the saved password only when host and username are unchanged."`
	ClearPassword bool   `json:"clear_password" doc:"Explicitly remove the saved password."`
	FromEmail     string `json:"from_email" maxLength:"320"`
	AuthType      string `json:"auth_type" enum:"plain,login,cram-md5,none"`
	TLSMode       string `json:"tls_mode" enum:"auto,starttls,tls" doc:"auto: opportunistic STARTTLS; starttls: required STARTTLS; tls: implicit TLS."`
	SkipTLSVerify bool   `json:"skip_tls_verify"`
	Revision      int64  `json:"revision" doc:"Revision from the last read. Stale saves return 409."`
	HasPassword   bool   `json:"has_password" readOnly:"true"`
	Source        string `json:"source" readOnly:"true" enum:"environment,saved"`
}

var mu sync.Mutex
var ErrConflict = errors.New("mail settings revision conflict")

// This allowlist grants only custom site-settings access, not licensed admin-panel roles.
func CanManage(uid int64) bool {
	if uid <= 0 {
		return false
	}
	for _, id := range strings.Split(config.SettingsAdminIDsEnv(), ",") {
		parsed, err := strconv.ParseInt(strings.TrimSpace(id), 10, 64)
		if err == nil && uid == parsed {
			return true
		}
	}
	return false
}
func Read() MailSettings {
	c := config.CurrentMailerRuntime()
	source := "environment"
	if c.Revision > 0 {
		source = "saved"
	}
	authType := c.AuthType
	if authType == "" {
		authType = "none"
	}
	return MailSettings{Enabled: c.Enabled, Host: c.Host, Port: c.Port, Username: c.Username, FromEmail: c.FromEmail, AuthType: authType, TLSMode: c.TLSMode, SkipTLSVerify: c.SkipTLSVerify, HasPassword: c.Password != "", Source: source, Revision: c.Revision}
}
func Validate(s *MailSettings) error {
	s.Host = strings.TrimSpace(s.Host)
	s.Username = strings.TrimSpace(s.Username)
	s.FromEmail = strings.TrimSpace(s.FromEmail)
	if s.Port < 1 || s.Port > 65535 {
		return tcylocale.Error("smtpPort")
	}
	if s.AuthType != "plain" && s.AuthType != "login" && s.AuthType != "cram-md5" && s.AuthType != "none" {
		return tcylocale.Error("smtpAuth")
	}
	if s.TLSMode != "auto" && s.TLSMode != "starttls" && s.TLSMode != "tls" {
		return tcylocale.Error("smtpTLS")
	}
	if strings.ContainsAny(s.Host, "/@?#\\ \t\r\n") || (strings.Contains(s.Host, ":") && net.ParseIP(s.Host) == nil) || (s.Enabled && s.Host == "") {
		return tcylocale.Error("smtpHost")
	}
	if strings.ContainsAny(s.Username, "\r\n") || strings.ContainsAny(s.FromEmail, "\r\n") {
		return tcylocale.Error("smtpAddress")
	}
	if s.FromEmail != "" {
		if _, err := mail.ParseAddress(s.FromEmail); err != nil {
			return tcylocale.Error("smtpAddress")
		}
	} else if s.Enabled {
		return tcylocale.Error("smtpAddress")
	}
	return nil
}
func settingsPath() string { return filepath.Join(config.FilesBasePath.GetString(), ".tcymc-smtp.enc") }
func encryption() (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("tcymc-smtp-v1:" + config.ServiceSecret.GetString()))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}
func Initialize() error {
	mu.Lock()
	defer mu.Unlock()
	data, err := os.ReadFile(settingsPath())
	if os.IsNotExist(err) {
		config.SetMailerRuntime(nil)
		return nil
	}
	if err != nil {
		return err
	}
	aead, err := encryption()
	if err != nil {
		return err
	}
	if len(data) < aead.NonceSize() {
		return errors.New("invalid encrypted SMTP settings")
	}
	plain, err := aead.Open(nil, data[:aead.NonceSize()], data[aead.NonceSize():], nil)
	if err != nil {
		return errors.New("could not decrypt SMTP settings with service secret")
	}
	var c config.MailerRuntime
	if err = json.Unmarshal(plain, &c); err != nil {
		return errors.New("invalid SMTP settings document")
	}
	if c.Revision < 1 {
		return errors.New("invalid SMTP settings revision")
	}
	config.SetMailerRuntime(&c)
	return nil
}
func Save(s MailSettings) (MailSettings, error) {
	mu.Lock()
	defer mu.Unlock()
	current := config.CurrentMailerRuntime()
	if s.Revision != current.Revision {
		return MailSettings{}, ErrConflict
	}
	if err := Validate(&s); err != nil {
		return MailSettings{}, err
	}
	password := s.Password
	if s.ClearPassword {
		password = ""
	} else if password == "" {
		if current.Password != "" && (!strings.EqualFold(current.Host, s.Host) || current.Username != s.Username) {
			return MailSettings{}, tcylocale.Error("smtpNewKey")
		}
		password = current.Password
	}
	if s.Enabled && s.AuthType != "none" && (s.Username == "" || password == "") {
		return MailSettings{}, tcylocale.Error("smtpCredentials")
	}
	c := config.MailerRuntime{Enabled: s.Enabled, Host: s.Host, Port: s.Port, Username: s.Username, Password: password, FromEmail: s.FromEmail, AuthType: s.AuthType, TLSMode: s.TLSMode, SkipTLSVerify: s.SkipTLSVerify, Revision: current.Revision + 1}
	plain, err := json.Marshal(c)
	if err != nil {
		return MailSettings{}, err
	}
	aead, err := encryption()
	if err != nil {
		return MailSettings{}, err
	}
	nonce := make([]byte, aead.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return MailSettings{}, err
	}
	encrypted := aead.Seal(nonce, nonce, plain, nil)
	// Same directory makes the rename atomic. Files are private from their creation.
	f, err := os.CreateTemp(filepath.Dir(settingsPath()), ".smtp-*.tmp")
	if err != nil {
		return MailSettings{}, err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(encrypted); err == nil {
		err = f.Sync()
	}
	closeErr := f.Close()
	if err != nil {
		return MailSettings{}, err
	}
	if closeErr != nil {
		return MailSettings{}, closeErr
	}
	if err = os.Rename(f.Name(), settingsPath()); err != nil {
		return MailSettings{}, err
	}
	config.SetMailerRuntime(&c)
	return Read(), nil
}
