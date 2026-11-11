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
	"encoding/hex"
	"errors"
	"strings"

	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/google/uuid"
)

// SpeechProviderError retains only allow-listed error codes and opaque request
// identifiers. Upstream messages may contain transcripts or credentials and are
// deliberately neither retained nor rendered.
type SpeechProviderError struct {
	Code      string
	RequestID string
	TaskID    string
	detail    error
}

func (e *SpeechProviderError) Error() string { return e.Unwrap().Error() }
func (e *SpeechProviderError) Unwrap() error {
	if e.detail != nil {
		return e.detail
	}
	_, reason := speechProviderErrorCode(e.Code)
	return tcylocale.Error(reason)
}

type SpeechProviderDiagnostic struct {
	Code      string `json:"provider_code,omitempty"`
	RequestID string `json:"provider_request_id,omitempty"`
	TaskID    string `json:"provider_task_id,omitempty"`
}

// SpeechProviderErrorDiagnostic returns only fixed codes and UUID/hex IDs, even
// if another internal caller constructed an error without the normal adapter.
func SpeechProviderErrorDiagnostic(err error) SpeechProviderDiagnostic {
	var failure *SpeechProviderError
	if !errors.As(err, &failure) {
		return SpeechProviderDiagnostic{}
	}
	code, _ := speechProviderErrorCode(failure.Code)
	return SpeechProviderDiagnostic{
		Code:      code,
		RequestID: safeSpeechProviderID(failure.RequestID),
		TaskID:    safeSpeechProviderID(failure.TaskID),
	}
}

func speechProviderFailure(code, requestID, taskID, key string) error {
	code, reason := speechProviderErrorCode(code)
	requestID = safeSpeechProviderID(requestID)
	taskID = safeSpeechProviderID(taskID)
	if key != "" {
		if strings.Contains(requestID, strings.ToLower(key)) {
			requestID = ""
		}
		if strings.Contains(taskID, strings.ToLower(key)) {
			taskID = ""
		}
	}
	return &SpeechProviderError{
		Code:      code,
		RequestID: requestID,
		TaskID:    taskID,
		detail:    tcylocale.Error(reason),
	}
}

func safeSpeechProviderID(id string) string {
	if len(id) == 36 && uuid.Validate(id) == nil {
		return strings.ToLower(id)
	}
	if len(id) == 32 {
		if _, err := hex.DecodeString(id); err == nil {
			return strings.ToLower(id)
		}
	}
	return ""
}

func speechProviderErrorCode(code string) (safeCode, reason string) {
	switch strings.ToUpper(code) {
	case "INVALIDAPIKEY", "INVALID_API_KEY", "UNAUTHORIZED", "AUTHENTICATION_ERROR":
		return "AUTHENTICATION", "speechProviderAuthentication"
	case "ACCESSDENIED", "ACCESS_DENIED", "FORBIDDEN", "PERMISSION_DENIED":
		return "PERMISSION_DENIED", "speechProviderPermission"
	case "ARREARAGE", "INSUFFICIENTBALANCE", "INSUFFICIENT_BALANCE", "QUOTA_EXCEEDED", "INSUFFICIENT_QUOTA":
		return "QUOTA_EXCEEDED", "speechProviderQuota"
	case "THROTTLING", "THROTTLING.RATEQUOTA", "THROTTLING.ALLOCATIONQUOTA", "TOO_MANY_REQUESTS", "RATE_LIMIT_EXCEEDED":
		return "RATE_LIMITED", "speechProviderRateLimit"
	case "INVALIDPARAMETER", "INVALID_PARAMETER", "INVALID_REQUEST", "INVALID_MESSAGE", "INVALID_REQUEST_ERROR":
		return "INVALID_REQUEST", "speechProviderParameters"
	case "INVALID_AUDIO", "AUDIO_FORMAT_ERROR", "UNSUPPORTED_AUDIO_FORMAT":
		return "INVALID_AUDIO", "speechProviderAudio"
	case "NO_VALID_AUDIO", "NO_VALID_SPEECH", "NO_SPEECH":
		return "NO_VALID_SPEECH", "speechProviderNoSpeech"
	case "TIMEOUT", "REQUEST_TIMEOUT", "RESPONSE_TIMEOUT":
		return "TIMEOUT", "speechProviderTimeout"
	case "SERVER_ERROR", "INTERNAL_ERROR", "INTERNALERROR", "SERVICE_UNAVAILABLE":
		return "SERVER_ERROR", "speechProviderUnavailable"
	case "CLIENT_ERROR":
		return "CLIENT_ERROR", "speechProviderClient"
	// These canonical values also make revalidation idempotent.
	case "AUTHENTICATION":
		return "AUTHENTICATION", "speechProviderAuthentication"
	case "RATE_LIMITED":
		return "RATE_LIMITED", "speechProviderRateLimit"
	default:
		return "UNCLASSIFIED", "speechProviderRejected"
	}
}

type speechEventHeader struct {
	Event     string `json:"event"`
	TaskID    string `json:"task_id"`
	ErrorCode string `json:"error_code"`
	RequestID string `json:"request_id"`
}

type speechEventError struct {
	Code      string `json:"code"`
	Type      string `json:"type"`
	RequestID string `json:"request_id"`
}

func (e *speechEventError) failure(requestID, key string) error {
	code := ""
	if e != nil {
		code = e.Code
		if code == "" {
			code = e.Type
		}
		if e.RequestID != "" {
			requestID = e.RequestID
		}
	}
	return speechProviderFailure(code, requestID, "", key)
}
