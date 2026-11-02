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

package tcyai

import (
	"encoding/json"
	"os"
	"testing"

	"code.vikunja.io/api/pkg/i18n"
	"github.com/stretchr/testify/require"
)

func connectionCopyFixture(t *testing.T) Settings {
	t.Helper()
	i18n.Init()
	speechSettingsFixture(t)
	settings, err := Save(94101, Settings{
		Connections: []Connection{{
			ID:       "source",
			Name:     "Saved text connection",
			Kind:     "chat",
			Protocol: "openai-responses",
			BaseURL:  "https://api.example/v1",
			Model:    "original-model",
			APIKey:   "copy-fixture-secret",
		}},
		Assistant: "source",
	})
	require.NoError(t, err)
	return settings
}

func connectionCopyDraft() Connection {
	return Connection{
		ID:          "copy",
		Name:        "Copied connection",
		Kind:        "chat",
		Protocol:    "openai-responses",
		BaseURL:     "https://api.example/v1",
		Model:       "different-model",
		InputTypes:  []string{"text", "image"},
		CopyKeyFrom: "source",
	}
}

func TestTCYAIConnectionCopySavedKey(t *testing.T) {
	settings := connectionCopyFixture(t)
	settings.Connections = append(settings.Connections, connectionCopyDraft())
	public, err := Save(94101, settings)
	require.NoError(t, err)
	require.Len(t, public.Connections, 2)
	require.Equal(t, "source", public.Assistant, "copy must not change the selected default")
	for _, c := range public.Connections {
		require.Empty(t, c.APIKey)
		require.Empty(t, c.CopyKeyFrom)
		require.True(t, c.HasKey)
	}
	require.Empty(t, settings.Connections[1].APIKey, "caller draft must never receive the copied secret")
	stored, err := Load(94101)
	require.NoError(t, err)
	require.Equal(t, "copy-fixture-secret", stored.Connections[0].APIKey)
	require.Equal(t, stored.Connections[0].APIKey, stored.Connections[1].APIKey)
	require.Equal(t, []string{"text", "image"}, stored.Connections[1].InputTypes)
	data, err := os.ReadFile(fileFor(94101))
	require.NoError(t, err)
	a, err := aead()
	require.NoError(t, err)
	plain, err := a.Open(nil, data[:a.NonceSize()], data[a.NonceSize():], []byte("94101"))
	require.NoError(t, err)
	require.NotContains(t, string(plain), "copy_key_from", "copy intent is never persisted")
	_, err = Save(94101, public)
	require.NoError(t, err, "redacted normal saves retain both independent keys")
}

func TestTCYAIConnectionCopyRejectsUnsafeSources(t *testing.T) {
	for _, scenario := range []string{
		"existing-target",
		"explicit-key",
		"missing-source",
		"cross-account",
		"cross-endpoint",
		"cross-path",
		"cross-protocol",
		"target-speech",
		"source-speech",
		"source-without-key",
		"draft-chain",
		"late-invalid-role",
	} {
		t.Run(scenario, func(t *testing.T) {
			settings := connectionCopyFixture(t)
			draft := connectionCopyDraft()
			uid := int64(94101)
			switch scenario {
			case "existing-target":
				draft.ID = "source"
				settings.Connections = nil
			case "explicit-key":
				draft.APIKey = "explicit-secret"
			case "missing-source":
				draft.CopyKeyFrom = "not-saved"
			case "cross-account":
				uid = 94102
				settings = Settings{}
			case "cross-endpoint":
				draft.BaseURL = "https://other.example/v1"
			case "cross-path":
				draft.BaseURL = "https://api.example/another-tenant/v1"
			case "cross-protocol":
				draft.Protocol = "anthropic"
			case "target-speech":
				draft.Kind = "transcription"
				draft.Protocol = "openai-transcription"
			case "source-speech", "source-without-key":
				stored, err := Load(94101)
				require.NoError(t, err)
				stored.Assistant = ""
				if scenario == "source-speech" {
					stored.Connections[0].Kind = "transcription"
					stored.Connections[0].Protocol = "openai-transcription"
				} else {
					stored.Connections[0].APIKey = ""
				}
				settings, err = writeSettings(94101, stored)
				require.NoError(t, err)
			case "draft-chain":
				settings.Connections = append(settings.Connections, draft)
				draft.ID = "second-copy"
				draft.CopyKeyFrom = "copy"
			case "late-invalid-role":
				settings.Assistant = "nonexistent"
			}
			before, err := os.ReadFile(fileFor(94101))
			require.NoError(t, err)
			settings.Connections = append(settings.Connections, draft)
			result, err := Save(uid, settings)
			require.Error(t, err)
			require.NotContains(t, err.Error(), "copy-fixture-secret")
			redacted, marshalErr := json.Marshal(result)
			require.NoError(t, marshalErr)
			require.NotContains(t, string(redacted), "copy-fixture-secret")
			require.NotContains(t, string(redacted), "explicit-secret")
			require.NotContains(t, string(redacted), "copy_key_from")
			after, readErr := os.ReadFile(fileFor(94101))
			require.NoError(t, readErr)
			require.Equal(t, before, after, "failed copy must leave saved configuration untouched")
			if uid != 94101 {
				_, statErr := os.Stat(fileFor(uid))
				require.True(t, os.IsNotExist(statErr))
			}
		})
	}
}

func TestTCYAIConnectionCopyNotAvailableToDraftRequests(t *testing.T) {
	connectionCopyFixture(t)
	for _, id := range []string{"copy", "source"} {
		draft := connectionCopyDraft()
		draft.ID = id
		resolved, err := ResolveConnection(94101, draft)
		require.Error(t, err)
		require.Empty(t, resolved.APIKey)
		require.Empty(t, resolved.CopyKeyFrom)
	}
}
