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

	"code.vikunja.io/api/pkg/config"
	"github.com/stretchr/testify/require"
)

func speechSettingsFixture(t *testing.T) {
	t.Helper()
	oldPath := config.FilesBasePath.GetString()
	oldSecret := config.ServiceSecret.GetString()
	config.FilesBasePath.Set(t.TempDir())
	config.ServiceSecret.Set("speech-settings-test-encryption-only")
	t.Cleanup(func() {
		config.FilesBasePath.Set(oldPath)
		config.ServiceSecret.Set(oldSecret)
	})
}

func TestTCYAISpeechSettingsLegacyCompatibility(t *testing.T) {
	speechSettingsFixture(t)
	var legacy Settings
	require.NoError(t, json.Unmarshal([]byte(`{"connections":[{"id":"voice","name":"Legacy voice","kind":"transcription","model":"whisper-1","base_url":"https://provider.example/v1","api_key":"fixture-key"},{"id":"chat","name":"Legacy chat","kind":"chat","model":"fixture-model","base_url":"https://provider.example/v1"}],"transcription":"voice","assistant":"chat"}`), &legacy))
	public, err := Save(94101, legacy)
	require.NoError(t, err)
	require.Equal(t, "openai-transcription", public.Connections[0].Protocol)
	require.Equal(t, "openai-chat", public.Connections[1].Protocol)
	require.Nil(t, public.Connections[0].Speech)
	require.Empty(t, public.Connections[0].APIKey)
	require.True(t, public.Connections[0].HasKey)
	_, err = Save(94101, public)
	require.NoError(t, err, "legacy redacted settings roundtrip must retain the saved key")
	stored, err := Load(94101)
	require.NoError(t, err)
	require.Equal(t, "fixture-key", stored.Connections[0].APIKey)
}

func TestTCYAISpeechSettingsEncryptedRoundTrip(t *testing.T) {
	speechSettingsFixture(t)
	speech := &SpeechOptions{
		Provider:     "aliyun",
		Language:     "zh",
		Prompt:       "Project names",
		Hotwords:     []string{"vikunja-x"},
		VocabularyID: "vocab-fixture",
		WorkspaceID:  "workspace-one",
		AppID:        "app-fixture",
		ResourceID:   "resource-fixture",
	}
	public, err := Save(94101, Settings{
		Connections: []Connection{{
			ID:       "voice",
			Name:     "Ali voice",
			Kind:     "transcription",
			Protocol: "dashscope-asr",
			BaseURL:  "wss://{workspace_id}.cn-beijing.maas.aliyuncs.com",
			Model:    "qwen-audio-3.1-asr-flash-streaming",
			APIKey:   "fixture-key",
			Speech:   speech,
		}},
		Transcription: "voice",
	})
	require.NoError(t, err)
	require.Equal(t, speech, public.Connections[0].Speech)
	require.Empty(t, public.Connections[0].APIKey)
	require.True(t, public.Connections[0].HasKey)
	raw, err := os.ReadFile(fileFor(94101))
	require.NoError(t, err)
	require.NotContains(t, string(raw), "fixture-key")
	require.NotContains(t, string(raw), "workspace-one")
	require.NotContains(t, string(raw), "Project names")
	stored, err := Load(94101)
	require.NoError(t, err)
	require.Equal(t, speech, stored.Connections[0].Speech)
	require.Equal(t, "fixture-key", stored.Connections[0].APIKey)
	other, err := ResolveConnection(94102, public.Connections[0])
	require.NoError(t, err)
	require.Empty(t, other.APIKey, "another account cannot resolve this user's saved secret")
	public.Transcription = ""
	public.Connections[0].Speech.Disabled = true
	disabled, err := Save(94101, public)
	require.NoError(t, err)
	_, err = disabled.Find("voice", "transcription")
	require.Error(t, err)
	stored, err = Load(94101)
	require.NoError(t, err)
	require.True(t, stored.Connections[0].Speech.Disabled)
	require.Equal(t, "fixture-key", stored.Connections[0].APIKey)
}

func TestTCYAISpeechSettingsSecretDestinationFence(t *testing.T) {
	for _, base := range []string{"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com", "wss://speech.example"} {
		for _, change := range []string{"workspace", "protocol", "model", "language"} {
			t.Run(base+"/"+change, func(t *testing.T) {
				speechSettingsFixture(t)
				public, err := Save(94101, Settings{
					Connections: []Connection{{
						ID:       "voice",
						Name:     "Voice",
						Kind:     "transcription",
						Protocol: "qwen-asr-realtime",
						BaseURL:  base,
						Model:    "qwen3-asr-flash-realtime",
						APIKey:   "fixture-key",
						Speech: &SpeechOptions{
							Language:    "zh",
							WorkspaceID: "workspace-one",
						},
					}},
				})
				require.NoError(t, err)
				originalEndpoint := Endpoint(public.Connections[0])
				switch change {
				case "workspace":
					public.Connections[0].Speech.WorkspaceID = "workspace-two"
				case "protocol":
					public.Connections[0].Protocol = "dashscope-asr"
				case "model":
					public.Connections[0].Model = "qwen3-asr-flash-realtime-next"
				case "language":
					public.Connections[0].Speech.Language = "en"
				}
				mustReplaceKey := change == "workspace" || change == "protocol"
				resolved, err := ResolveConnection(94101, public.Connections[0])
				require.NoError(t, err)
				if mustReplaceKey {
					require.Empty(t, resolved.APIKey, "changing the credential destination must not reuse the old key")
				} else {
					require.Equal(t, "fixture-key", resolved.APIKey)
				}
				_, err = Save(94101, public)
				if mustReplaceKey {
					require.Error(t, err)
					stored, loadErr := Load(94101)
					require.NoError(t, loadErr)
					require.Equal(t, "workspace-one", stored.Connections[0].Speech.WorkspaceID)
					require.Equal(t, "qwen-asr-realtime", stored.Connections[0].Protocol)
					public.Connections[0].APIKey = "replacement-key"
					_, err = Save(94101, public)
					require.NoError(t, err)
				} else {
					require.NoError(t, err)
					if change == "model" {
						require.NotEqual(t, originalEndpoint, Endpoint(public.Connections[0]), "model is a non-secret URL query parameter")
					}
					stored, loadErr := Load(94101)
					require.NoError(t, loadErr)
					require.Equal(t, "fixture-key", stored.Connections[0].APIKey)
				}
			})
		}
	}
}
