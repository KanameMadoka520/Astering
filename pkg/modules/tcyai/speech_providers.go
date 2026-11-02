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

type SpeechModel struct {
	ID          string `json:"id" doc:"Actual upstream model ID; display labels are never used as API identifiers."`
	Name        string `json:"name" doc:"Display name."`
	Protocol    string `json:"protocol" doc:"Implemented wire adapter for this model."`
	BaseURL     string `json:"base_url" doc:"Default API base or full endpoint; workspace placeholders require configuration."`
	Recommended bool   `json:"recommended" doc:"Suggested starting model within this provider."`
	SampleRate  int    `json:"sample_rate" doc:"Required browser-converted mono PCM sample rate, or zero for file input."`
	Language    bool   `json:"language" doc:"Adapter supports an explicit language hint."`
	Prompt      bool   `json:"prompt" doc:"Adapter supports recognition context."`
	Hotwords    bool   `json:"hotwords" doc:"Adapter supports inline vocabulary hints."`
	Vocabulary  bool   `json:"vocabulary" doc:"Adapter supports a compiled vocabulary ID."`
	Workspace   bool   `json:"workspace" doc:"Adapter supports an optional Alibaba workspace ID; required only when the endpoint contains {workspace_id}."`
	AppID       bool   `json:"app_id" doc:"Adapter accepts the optional Volcengine application ID for legacy credentials."`
	ResourceID  bool   `json:"resource_id" doc:"Adapter needs a Volcengine service resource ID."`
}

type SpeechProvider struct {
	ID      string        `json:"id" doc:"Stable provider preset identifier."`
	Name    string        `json:"name" doc:"Provider display name."`
	DocsURL string        `json:"docs_url" doc:"Official API or self-hosting documentation."`
	KeyURL  string        `json:"key_url" doc:"Provider console, not an API credential."`
	Local   bool          `json:"local" doc:"Requires a separately hosted local recognition service; not browser-local inference."`
	Models  []SpeechModel `json:"models" doc:"Verified presets; users can still enter their own supported model ID."`
}

// Keep the catalog and the adapters together: a branded card must be runnable.
func SpeechProviders() []SpeechProvider {
	aliyun := []SpeechModel{}
	for _, id := range []string{"qwen-audio-3.1-asr-flash-streaming", "fun-asr-realtime"} {
		aliyun = append(aliyun, SpeechModel{
			ID:          id,
			Name:        id,
			Protocol:    "dashscope-asr",
			BaseURL:     "wss://dashscope.aliyuncs.com/api-ws/v1/inference",
			Recommended: id == "qwen-audio-3.1-asr-flash-streaming",
			SampleRate:  16000,
			Language:    true,
			Prompt:      true,
			Hotwords:    id == "qwen-audio-3.1-asr-flash-streaming",
			Vocabulary:  true,
			Workspace:   true,
		})
	}
	aliyun = append(aliyun, SpeechModel{
		ID:         "qwen3-asr-flash-realtime",
		Name:       "qwen3-asr-flash-realtime",
		Protocol:   "qwen-asr-realtime",
		BaseURL:    "wss://dashscope.aliyuncs.com/api-ws/v1/realtime",
		SampleRate: 16000,
		Language:   true,
		Workspace:  true,
	}, SpeechModel{
		ID:         "fun-asr-flash-2026-06-15",
		Name:       "fun-asr-flash-2026-06-15",
		Protocol:   "dashscope-file-asr",
		BaseURL:    "https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation",
		Language:   true,
		Prompt:     true,
		Hotwords:   true,
		Vocabulary: true,
		Workspace:  true,
	})
	return []SpeechProvider{
		{
			ID:      "aliyun",
			Name:    "Alibaba Cloud",
			DocsURL: "https://help.aliyun.com/zh/model-studio/real-time-speech-recognition-user-guide",
			KeyURL:  "https://bailian.console.aliyun.com/",
			Models:  aliyun,
		},
		{
			ID:      "sensevoice",
			Name:    "SenseVoice Small",
			DocsURL: "https://github.com/FunAudioLLM/SenseVoice/blob/main/api.py",
			Local:   true,
			Models: []SpeechModel{{
				ID:          "iic/SenseVoiceSmall",
				Name:        "SenseVoice Small",
				Protocol:    "sensevoice",
				BaseURL:     "https://your-sensevoice.example",
				Recommended: true,
				Language:    true,
			}},
		},
		{
			ID:      "volcengine",
			Name:    "Volcengine",
			DocsURL: "https://www.volcengine.com/docs/6561/1354869",
			KeyURL:  "https://console.volcengine.com/speech/",
			Models: []SpeechModel{{
				ID:          "bigmodel",
				Name:        "Doubao Streaming ASR",
				Protocol:    "volcengine-asr",
				BaseURL:     "wss://openspeech.bytedance.com/api/v3/sauc/bigmodel",
				Recommended: true,
				SampleRate:  16000,
				AppID:       true,
				ResourceID:  true,
			}},
		},
		{
			ID:      "mimo",
			Name:    "Xiaomi MiMo",
			DocsURL: "https://mimo.mi.com/docs/zh-CN/api/audio/Speech-Recognition",
			KeyURL:  "https://platform.xiaomimimo.com/",
			Models: []SpeechModel{{
				ID:          "mimo-v2.5-asr",
				Name:        "MiMo-V2.5-ASR",
				Protocol:    "mimo-asr",
				BaseURL:     "https://api.xiaomimimo.com/v1",
				Recommended: true,
				Language:    true,
			}},
		},
		{
			ID:      "openai",
			Name:    "OpenAI",
			DocsURL: "https://developers.openai.com/api/docs/guides/transcription",
			KeyURL:  "https://platform.openai.com/api-keys",
			Models: []SpeechModel{
				{
					ID:          "gpt-live-transcribe",
					Name:        "GPT-Live-Transcribe",
					Protocol:    "openai-realtime",
					BaseURL:     "wss://api.openai.com/v1",
					Recommended: true,
					SampleRate:  24000,
					Language:    true,
					Prompt:      true,
					Hotwords:    true,
				},
				{
					ID:         "gpt-realtime-whisper",
					Name:       "GPT-Realtime-Whisper",
					Protocol:   "openai-realtime",
					BaseURL:    "wss://api.openai.com/v1",
					SampleRate: 24000,
					Language:   true,
					Prompt:     true,
				},
				{
					ID:       "gpt-transcribe",
					Name:     "GPT-Transcribe (file)",
					Protocol: "openai-transcription",
					BaseURL:  "https://api.openai.com/v1",
					Language: true,
					Prompt:   true,
				},
			},
		},
		{
			ID:      "elevenlabs",
			Name:    "ElevenLabs",
			DocsURL: "https://elevenlabs.io/docs/api-reference/speech-to-text/v-1-speech-to-text-realtime",
			KeyURL:  "https://elevenlabs.io/app/settings/api-keys",
			Models: []SpeechModel{
				{
					ID:          "scribe_v2_realtime",
					Name:        "Scribe v2 Realtime",
					Protocol:    "elevenlabs-realtime",
					BaseURL:     "wss://api.elevenlabs.io/v1",
					Recommended: true,
					SampleRate:  16000,
					Language:    true,
				},
				{
					ID:       "scribe_v2",
					Name:     "Scribe v2",
					Protocol: "elevenlabs-transcription",
					BaseURL:  "https://api.elevenlabs.io/v1",
					Language: true,
				},
			},
		},
		{
			ID:      "soniox",
			Name:    "Soniox",
			DocsURL: "https://docs.soniox.com/api-reference/stt/websocket-api",
			KeyURL:  "https://console.soniox.com/",
			Models: []SpeechModel{{
				ID:          "stt-rt-v5",
				Name:        "Soniox Real-time",
				Protocol:    "soniox-realtime",
				BaseURL:     "wss://stt-rt.soniox.com/transcribe-websocket",
				Recommended: true,
				SampleRate:  16000,
				Language:    true,
				Prompt:      true,
				Hotwords:    true,
			}},
		},
	}
}
