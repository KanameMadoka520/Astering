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
	"context"
	"fmt"
	"net/http"
	"strings"
	"testing"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/google/uuid"
	"github.com/stretchr/testify/require"
)

func TestTCYAISpeechProviderFailureClassifiesOnlyKnownCodesAndOpaqueIDs(t *testing.T) {
	const secret = "private-key-and-transcript"
	requestID, taskID := uuid.NewString(), uuid.NewString()
	for _, scenario := range []struct {
		code string
		want string
		key  string
	}{
		{"InvalidApiKey", "AUTHENTICATION", "speechProviderAuthentication"},
		{"ACCESS_DENIED", "PERMISSION_DENIED", "speechProviderPermission"},
		{"Arrearage", "QUOTA_EXCEEDED", "speechProviderQuota"},
		{"rate_limit_exceeded", "RATE_LIMITED", "speechProviderRateLimit"},
		{"InvalidParameter", "INVALID_REQUEST", "speechProviderParameters"},
		{"INVALID_AUDIO", "INVALID_AUDIO", "speechProviderAudio"},
		{"NO_VALID_AUDIO", "NO_VALID_SPEECH", "speechProviderNoSpeech"},
		{"REQUEST_TIMEOUT", "TIMEOUT", "speechProviderTimeout"},
		{"SERVER_ERROR", "SERVER_ERROR", "speechProviderUnavailable"},
		{"CLIENT_ERROR", "CLIENT_ERROR", "speechProviderClient"},
		{secret, "UNCLASSIFIED", "speechProviderRejected"},
		{"CLIENT_ERROR\n" + secret, "UNCLASSIFIED", "speechProviderRejected"},
	} {
		t.Run(scenario.code, func(t *testing.T) {
			err := fmt.Errorf("wrapped: %w", speechProviderFailure(scenario.code, requestID, taskID, secret))
			var localized *tcylocale.LocalizedError
			require.ErrorAs(t, err, &localized)
			require.Equal(t, "tcymc.errors."+scenario.key, localized.Key)
			require.NotContains(t, err.Error(), secret)
			require.Equal(t, SpeechProviderDiagnostic{
				Code:      scenario.want,
				RequestID: requestID,
				TaskID:    taskID,
			}, SpeechProviderErrorDiagnostic(err))
		})
	}
	for _, id := range []string{secret, "request=" + requestID, requestID + "\n", "sk-" + strings.Repeat("a", 32)} {
		err := speechProviderFailure("CLIENT_ERROR", id, id, secret)
		diagnostic := SpeechProviderErrorDiagnostic(err)
		require.Empty(t, diagnostic.RequestID)
		require.Empty(t, diagnostic.TaskID)
	}
	const hexKey = "0123456789abcdef0123456789abcdef"
	diagnostic := SpeechProviderErrorDiagnostic(speechProviderFailure("CLIENT_ERROR", strings.ToUpper(hexKey), requestID, hexKey))
	require.Empty(t, diagnostic.RequestID, "a key must not escape by masquerading as a request ID")
	require.Equal(t, requestID, diagnostic.TaskID)
	require.Equal(t, SpeechProviderDiagnostic{}, SpeechProviderErrorDiagnostic(tcylocale.Error("speechProviderRejected")))
}

func TestTCYAILiveSpeechProviderFailureKeepsSafeCodeInsteadOfRawMessage(t *testing.T) {
	for _, operation := range []string{"live", "file", "probe"} {
		t.Run(operation, func(t *testing.T) {
			requestID := uuid.NewString()
			tasks := make(chan string, 1)
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				taskID := speechTestDashStart(ctx, t, socket)
				tasks <- taskID
				require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
					"header": map[string]string{
						"event":         "task-failed",
						"task_id":       taskID,
						"error_code":    "CLIENT_ERROR",
						"request_id":    requestID,
						"error_message": "fixture-live-key and private transcript must stay private",
					},
				}))
				_, _, _ = socket.Read(ctx)
			})
			connection := liveSpeechTestConnection(endpoint, "dashscope-asr")
			var err error
			switch operation {
			case "live":
				err = RecognizeLiveSpeech(ctx, connection, 16000, make(chan []byte), nil, nil)
			case "file":
				_, err = transcribeDashScope(ctx, connection, "voice.wav", speechTestWAV(make([]byte, 3200), 16000), nil)
			case "probe":
				err = probeDashScopeSpeech(ctx, connection)
			}
			require.Error(t, err)
			require.NotContains(t, err.Error(), "fixture-live-key")
			require.NotContains(t, err.Error(), "private transcript")
			require.NotContains(t, ExplainError(ctx, err), "private transcript")
			taskID := liveSpeechTestReceive(ctx, t, tasks)
			require.Equal(t, SpeechProviderDiagnostic{
				Code:      "CLIENT_ERROR",
				RequestID: requestID,
				TaskID:    taskID,
			}, SpeechProviderErrorDiagnostic(err))
			liveSpeechTestErrorKey(t, err, "speechProviderClient")
		})
	}
}

func TestTCYAILiveSpeechQwenProviderFailureHasNoRawMessageOrEventID(t *testing.T) {
	for _, operation := range []string{"live", "file", "probe"} {
		t.Run(operation, func(t *testing.T) {
			ctx, endpoint := speechTestSocket(t, func(ctx context.Context, socket *websocket.Conn, _ *http.Request) {
				var start map[string]any
				require.NoError(t, wsjson.Read(ctx, socket, &start))
				require.NoError(t, wsjson.Write(ctx, socket, map[string]any{
					"type": "error",
					"error": map[string]string{
						"code":       "rate_limit_exceeded",
						"message":    "fixture-live-key and private transcript",
						"request_id": "secret-not-a-valid-request-id",
					},
				}))
				_, _, _ = socket.Read(ctx)
			})
			connection := liveSpeechTestConnection(endpoint, "qwen-asr-realtime")
			var err error
			switch operation {
			case "live":
				err = RecognizeLiveSpeech(ctx, connection, 16000, make(chan []byte), nil, nil)
			case "file":
				_, err = transcribeQwenRealtime(ctx, connection, "voice.wav", speechTestWAV(make([]byte, 3200), 16000), nil)
			case "probe":
				err = probeQwenSpeech(ctx, connection)
			}
			liveSpeechTestErrorKey(t, err, "speechProviderRateLimit")
			diagnostic := SpeechProviderErrorDiagnostic(err)
			require.Equal(t, "RATE_LIMITED", diagnostic.Code)
			require.Empty(t, diagnostic.RequestID)
			require.Empty(t, diagnostic.TaskID)
			require.NotContains(t, err.Error(), "fixture-live-key")
			require.NotContains(t, ExplainError(ctx, err), "private transcript")
		})
	}
}
