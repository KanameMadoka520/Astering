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

//nolint:gosmopolitan // This fork intentionally provides Chinese prompts and user-facing messages.
package tcyai

import (
	"crypto/aes"
	"crypto/cipher"
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"

	"code.vikunja.io/api/pkg/modules/tcylocale"

	"code.vikunja.io/api/pkg/config"
)

type Connection struct {
	Speech             *SpeechOptions `json:"speech,omitempty" doc:"Optional provider-specific speech recognition configuration."`
	AutoCompactTokens  int64          `json:"auto_compact_tokens,omitempty" minimum:"0" maximum:"9007199254740991" doc:"Soft input threshold for automatic compaction; zero derives from declared capacity or uses a 128000-token policy, never a capacity claim."`
	DisableAutoCompact bool           `json:"disable_auto_compact,omitempty" doc:"Disable automatic context checkpoints for this connection."`
	WebSearchProtocol  string         `json:"web_search_protocol,omitempty" enum:",deepseek,openai-responses,openai-chat,anthropic,gemini" doc:"Explicit search adapter; empty disables search. Independent of chat protocol and model name."`
	WebSearchBaseURL   string         `json:"web_search_base_url,omitempty" doc:"Optional search API base on the same origin as this connection. Empty uses the chat base (official DeepSeek uses /v1)."`
	WebSearchModel     string         `json:"web_search_model,omitempty" maxLength:"150" doc:"Optional search model; empty uses this connection model. DeepSeek search does not use a model."`

	Persona          string             `json:"-"`
	ContextWindow    int64              `json:"context_window,omitempty" minimum:"0" maximum:"9007199254740991" doc:"Declared model context capacity in tokens; zero uses known provider metadata or remains unknown."`
	MaxOutputTokens  int64              `json:"max_output_tokens,omitempty" minimum:"0" maximum:"9007199254740991" doc:"Per-request output allowance; zero uses provider defaults, or a visible protocol fallback when required."`
	InputTypes       []string           `json:"input_types,omitempty" maxItems:"2" uniqueItems:"true" doc:"Model capabilities: text and optionally image. Empty uses known provider metadata or text only."`
	OutputTokenField string             `json:"output_token_field,omitempty" enum:",max_tokens,max_completion_tokens" doc:"OpenAI Chat compatibility override; empty chooses the protocol default."`
	Resolved         *ModelCapabilities `json:"resolved,omitempty" readOnly:"true" doc:"Effective capacities and input types, resolved by the server; never accepted as configuration."`
	NonStreaming     bool               `json:"non_streaming,omitempty" doc:"Explicitly opt out of streaming. Streaming is the default for text models."`
	Protocol         string             `json:"protocol,omitempty" enum:"openai-chat,openai-responses,anthropic,gemini,openai-transcription,openai-audio,dashscope-asr,qwen-asr-realtime,dashscope-file-asr,volcengine-asr,openai-realtime,elevenlabs-transcription,elevenlabs-realtime,soniox-realtime,mimo-asr,sensevoice" doc:"Wire protocol. Omitted legacy values are inferred from kind."`
	ID               string             `json:"id" minLength:"1" maxLength:"80" doc:"Stable connection identifier."`
	Name             string             `json:"name" minLength:"1" maxLength:"100" doc:"Display name."`
	BaseURL          string             `json:"base_url" doc:"OpenAI-compatible API base, including /v1 when required."`
	Model            string             `json:"model" minLength:"1" maxLength:"150" doc:"Provider model identifier."`
	Kind             string             `json:"kind" enum:"chat,transcription" doc:"Text-model or speech-recognition connection; the explicit protocol chooses the upstream API."`
	APIKey           string             `json:"api_key,omitempty" writeOnly:"true" doc:"Write-only key. Empty preserves the saved key when the endpoint is unchanged."`
	HasKey           bool               `json:"has_key" readOnly:"true" doc:"Whether a key is saved; the key itself is never returned."`
}

type Settings struct {
	Persona       string               `json:"persona,omitempty" enum:"arona,none" doc:"Arona character tone (default) or neutral. Never changes tool permissions."`
	Preferences   AssistantPreferences `json:"preferences" readOnly:"true" doc:"Personal assistant profiles; updated separately to avoid overwriting connection secrets."`
	Connections   []Connection         `json:"connections" maxItems:"20" doc:"Connections owned by the current user."`
	Assistant     string               `json:"assistant" doc:"Connection used by the task agent."`
	Transcription string               `json:"transcription" doc:"Connection used for speech recognition."`
	Cleanup       string               `json:"cleanup" doc:"Optional chat connection for cleaning up transcripts. Empty disables cleanup."`
}

var settingsLock sync.Mutex

func fileFor(uid int64) string {
	return filepath.Join(config.FilesBasePath.GetString(), ".tcymc-ai", fmt.Sprintf("%d.enc", uid))
}

func aead() (cipher.AEAD, error) {
	key := sha256.Sum256([]byte("tcymc-ai-settings-v1:" + config.ServiceSecret.GetString()))
	block, err := aes.NewCipher(key[:])
	if err != nil {
		return nil, err
	}
	return cipher.NewGCM(block)
}

func read(uid int64) (s Settings, err error) {
	if accountDeleted(uid) {
		return s, ErrAccountDeleted
	}
	s.Connections = []Connection{}
	data, err := os.ReadFile(fileFor(uid))
	if errors.Is(err, os.ErrNotExist) {
		return s, nil
	}
	if err != nil {
		return s, err
	}
	a, err := aead()
	if err != nil {
		return s, err
	}
	if len(data) < a.NonceSize() {
		return s, tcylocale.Error("e14")
	}
	plain, err := a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], []byte(fmt.Sprint(uid)))
	if err != nil {
		return s, tcylocale.Error("e13")
	}
	err = json.Unmarshal(plain, &s)
	return s, err
}

func Load(uid int64) (Settings, error) {
	settingsLock.Lock()
	defer settingsLock.Unlock()
	return read(uid)
}

func Redact(s Settings) Settings {
	s.Connections = append([]Connection{}, s.Connections...)
	for i := range s.Connections {
		s.Connections[i].Protocol = s.Connections[i].EffectiveProtocol()
		s.Connections[i].HasKey = s.Connections[i].APIKey != ""
		s.Connections[i].APIKey = ""
		resolved := s.Connections[i].Capabilities()
		s.Connections[i].Resolved = &resolved
	}
	return s
}

func (s Settings) Find(id, kind string) (Connection, error) {
	for _, c := range s.Connections {
		if c.ID == id && c.Kind == kind {
			if kind == "transcription" && c.Speech != nil && c.Speech.Disabled {
				return Connection{}, tcylocale.Error("speechDisabled")
			}
			c.Persona = s.Persona
			return c, nil
		}
	}
	return Connection{}, tcylocale.Error("e46")
}

func Save(uid int64, s Settings) (Settings, error) {
	settingsLock.Lock()
	defer func() { settingsLock.Unlock(); cleanupRevokedAccount(uid) }()
	old, err := read(uid)
	if err != nil {
		return s, err
	}
	if s.Persona != "" && s.Persona != "arona" && s.Persona != "none" {
		return s, tcylocale.Error("modelCapacityInvalid")
	}
	if len(s.Connections) > 20 {
		return s, tcylocale.Error("e30")
	}
	ids := map[string]bool{}
	for i := range s.Connections {
		c := &s.Connections[i]
		if err := validateConnection(c, ids); err != nil {
			return s, err
		}
		if c.APIKey == "" {
			for _, prev := range old.Connections {
				if prev.ID == c.ID {
					if !sameSpeechSecretDestination(prev, *c) && prev.APIKey != "" {
						return s, tcylocale.Error("e29")
					}
					c.APIKey = prev.APIKey
				}
			}
		}
		c.HasKey = false
	}
	for _, role := range []struct{ id, kind string }{{s.Assistant, "chat"}, {s.Cleanup, "chat"}, {s.Transcription, "transcription"}} {
		if role.id != "" {
			if _, e := s.Find(role.id, role.kind); e != nil {
				return s, e
			}
		}
	}
	s.Preferences = old.Preferences
	return writeSettings(uid, s)
}

func writeSettings(uid int64, s Settings) (Settings, error) {
	var result Settings
	err := withAccountWrite(uid, func() error {
		var writeErr error
		result, writeErr = writeSettingsFile(uid, s)
		return writeErr
	})
	return result, err
}

func writeSettingsFile(uid int64, s Settings) (Settings, error) {
	if accountDeleted(uid) {
		return s, ErrAccountDeleted
	}
	plain, err := json.Marshal(s)
	if err != nil {
		return s, err
	}
	a, err := aead()
	if err != nil {
		return s, err
	}
	nonce := make([]byte, a.NonceSize())
	if _, err = rand.Read(nonce); err != nil {
		return s, err
	}
	data := a.Seal(nonce, nonce, plain, []byte(fmt.Sprint(uid)))
	path := fileFor(uid)
	if err = os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return s, err
	}
	f, err := os.CreateTemp(filepath.Dir(path), fmt.Sprintf(".settings-%d-*", uid))
	if err != nil {
		return s, err
	}
	defer os.Remove(f.Name())
	if _, err = f.Write(data); err != nil {
		_ = f.Close()
		return s, err
	}
	if err = f.Close(); err != nil {
		return s, err
	}
	if err = os.Rename(f.Name(), path); err != nil {
		return s, err
	}
	return Redact(s), nil
}

func validateConnection(c *Connection, ids map[string]bool) error {
	c.Resolved = nil
	if err := c.validateCapabilities(); err != nil {
		return err
	}
	c.BaseURL = strings.TrimRight(strings.TrimSpace(c.BaseURL), "/")
	if err := validateSpeech(*c); err != nil {
		return err
	}
	u, e := url.Parse(speechBase(*c))
	schemeAllowed := e == nil && (u.Scheme == "https" || (u.Scheme == "wss" && isSpeechSocketProtocol(c.EffectiveProtocol())))
	if !schemeAllowed || u.Hostname() == "" || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return tcylocale.Error("e35")
	}
	if c.ID == "" || ids[c.ID] || c.Name == "" || c.Model == "" || (c.Kind != "chat" && c.Kind != "transcription") {
		return tcylocale.Error("e49")
	}
	if err := c.ValidateProtocol(); err != nil {
		return err
	}
	if err := validateSearch(c); err != nil {
		return err
	}
	c.Protocol = c.EffectiveProtocol()
	ids[c.ID] = true
	return nil
}

func (c Connection) EffectiveProtocol() string {
	if c.Protocol != "" {
		return c.Protocol
	}
	if c.Kind == "transcription" {
		return "openai-transcription"
	}
	return "openai-chat"
}
func (c Connection) ValidateProtocol() error {
	p := c.EffectiveProtocol()
	if c.Kind == "chat" && (p == "openai-chat" || p == "openai-responses" || p == "anthropic" || p == "gemini") {
		return nil
	}
	if c.Kind == "transcription" && (p == "openai-transcription" || p == "openai-audio" || p == "gemini" || isNativeSpeechProtocol(p)) {
		return nil
	}
	return tcylocale.Error("e11")
}

// ResolveConnection accepts draft metadata but only reuses this user's saved key at the same endpoint.
func ResolveConnection(uid int64, c Connection) (Connection, error) {
	if err := validateConnection(&c, map[string]bool{}); err != nil {
		return c, err
	}
	if c.APIKey != "" {
		return c, nil
	}
	s, err := Load(uid)
	if err != nil {
		return c, err
	}
	for _, saved := range s.Connections {
		if saved.ID == c.ID && sameSpeechSecretDestination(saved, c) {
			c.APIKey = saved.APIKey
			break
		}
	}
	return c, nil
}

func sameSpeechSecretDestination(a, b Connection) bool {
	if a.BaseURL != b.BaseURL {
		return false
	}
	if isNativeSpeechProtocol(a.EffectiveProtocol()) || isNativeSpeechProtocol(b.EffectiveProtocol()) {
		workspaceA, workspaceB, appA, appB := "", "", "", ""
		if a.Speech != nil {
			workspaceA, appA = a.Speech.WorkspaceID, a.Speech.AppID
		}
		if b.Speech != nil {
			workspaceB, appB = b.Speech.WorkspaceID, b.Speech.AppID
		}
		return a.EffectiveProtocol() == b.EffectiveProtocol() && speechBase(a) == speechBase(b) &&
			workspaceA == workspaceB && appA == appB
	}
	return true
}
