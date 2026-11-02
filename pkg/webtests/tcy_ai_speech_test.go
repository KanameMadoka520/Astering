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

package webtests

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"testing"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/i18n"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/stretchr/testify/require"
)

func TestTCYAISpeechCatalogAndConnectionIsolation(t *testing.T) {
	i18n.Init()
	e, err := setupTestEnv()
	require.NoError(t, err)
	token := humaTokenFor(t, &testuser1)
	other := humaTokenFor(t, &testuser2)
	oldPath := config.FilesBasePath.GetString()
	config.FilesBasePath.Set(t.TempDir())
	t.Cleanup(func() { config.FilesBasePath.Set(oldPath) })
	catalog := "/api/v2/ai/speech/providers"
	require.Equal(t, 401, humaRequest(t, e, "GET", catalog, "", "", "").Code)
	got := humaRequest(t, e, "GET", catalog, "", token, "")
	require.Equal(t, 200, got.Code, got.Body.String())
	require.Equal(t, "no-store", got.Header().Get("Cache-Control"))
	var providers []tcyai.SpeechProvider
	require.NoError(t, json.Unmarshal(got.Body.Bytes(), &providers))
	require.Len(t, providers, 7)
	require.Equal(t, "qwen-audio-3.1-asr-flash-streaming", providers[0].Models[0].ID)
	require.Equal(t, "dashscope-asr", providers[0].Models[0].Protocol)
	require.NotContains(t, got.Body.String(), "api_key")
	// A disabled connection is stored, but cannot be invoked or assigned as default.
	settings := `{"connections":[{"id":"private-speech","name":"Speech","kind":"transcription","protocol":"openai-realtime","base_url":"https://api.openai.com/v1","model":"gpt-live-transcribe","api_key":"fixture-private-secret","speech":{"disabled":true,"provider":"openai"}}],"assistant":"","cleanup":"","transcription":""}`
	saved := humaRequest(t, e, "POST", "/api/v2/ai/settings", settings, token, "")
	require.Equal(t, 200, saved.Code, saved.Body.String())
	require.NotContains(t, saved.Body.String(), "fixture-private-secret")
	request := fmt.Sprintf(`{"connection_id":"private-speech","audio":%q,"filename":"voice.wav"}`, base64.StdEncoding.EncodeToString([]byte("not-PCM")))
	for _, route := range []string{"/api/v2/ai/transcribe", "/api/v2/ai/test"} {
		for _, identity := range []string{token, other} {
			response := humaRequest(t, e, "POST", route, request, identity, "")
			require.Contains(t, []int{400, 404}, response.Code, response.Body.String())
			require.NotContains(t, response.Body.String(), "fixture-private-secret")
		}
	}
	// A workspace placeholder cannot be saved without the workspace ID.
	bad := `{"connections":[{"id":"workspace","name":"Ali","kind":"transcription","protocol":"dashscope-asr","base_url":"wss://{workspace_id}.cn-beijing.maas.aliyuncs.com/api-ws/v1/inference","model":"qwen-audio-3.1-asr-flash-streaming","api_key":"fixture-secret"}],"assistant":"","cleanup":"","transcription":"workspace"}`
	require.Equal(t, 400, humaRequest(t, e, "POST", "/api/v2/ai/settings", bad, token, "").Code)
}
