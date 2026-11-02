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
package apiv2

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"

	"code.vikunja.io/api/pkg/modules/humabridge"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTCYAIRoutes) }

type aiPreferencesResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.AssistantPreferences
}

type aiSettingsResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.Settings
}
type aiTextResponse struct {
	Body struct {
		ElapsedMS       int64                  `json:"elapsed_ms,omitempty" doc:"Recognition request elapsed time in milliseconds, excluding optional text cleanup."`
		AudioDurationMS int64                  `json:"audio_duration_ms,omitempty" doc:"Verified PCM audio duration; absent when the format cannot be measured locally."`
		FirstTextMS     int64                  `json:"first_text_ms,omitempty" doc:"Time to the first nonempty upstream transcript; absent if unavailable."`
		Search          *tcyai.WebSearchResult `json:"search,omitempty" doc:"Native search evidence and telemetry for a search test."`
		Endpoint        string                 `json:"endpoint" doc:"Actual upstream request URL, without credentials."`
		Text            string                 `json:"text" doc:"Processed text."`
		Original        string                 `json:"original" doc:"Original transcription, before optional cleanup."`
		Warning         string                 `json:"warning" doc:"Non-fatal cleanup failure, if any."`
	}
}

// Only authenticated human sessions can use saved provider credentials.
func aiUser(ctx context.Context) (int64, error) {
	ec := humabridge.EchoContextFrom(ctx)
	if ec == nil || (*ec).Get("api_token") != nil {
		return 0, huma.Error403Forbidden(tcylocale.Render(ctx, tcylocale.Error("e2")))
	}
	a, err := authFromCtx(ctx)
	if err != nil {
		return 0, err
	}
	u, err := user.GetFromAuth(a)
	if err != nil {
		return 0, translateDomainError(err)
	}
	return u.ID, nil
}

func aiError(ctx context.Context, err error) error {
	return huma.Error400BadRequest(tcyai.ExplainError(ctx, err))
}

func RegisterTCYAIRoutes(api huma.API) {
	op := func(id, method, path, description string) huma.Operation {
		return huma.Operation{OperationID: id, Method: method, Path: path, Summary: description, Description: description + "。仅供当前登录用户使用，不向 MCP 暴露。", Tags: []string{"tcymc-ai"}, DefaultStatus: http.StatusOK, MaxBodyBytes: 24 * 1024 * 1024, BodyReadTimeout: 30 * time.Second}
	}
	Register(api, op("tcy-ai-settings", "GET", "/ai/settings", "读取脱敏的个人模型连接与功能分配"), func(ctx context.Context, _ *struct{}) (*aiSettingsResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &aiSettingsResponse{CacheControl: "no-store", Body: tcyai.Redact(s)}, nil
	})
	Register(api, op("tcy-ai-save-settings", "POST", "/ai/settings", "保存个人模型连接，密钥加密存储且不返回"), func(ctx context.Context, in *struct{ Body tcyai.Settings }) (*aiSettingsResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyai.Save(uid, in.Body)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &aiSettingsResponse{CacheControl: "no-store", Body: s}, nil
	})
	registerAIPreferences(api, op)
	Register(api, op("tcy-ai-models", "POST", "/ai/models", "List models for a draft connection without saving its credentials"), func(ctx context.Context, in *struct {
		Body struct {
			ID       string `json:"id" minLength:"1" maxLength:"80"`
			BaseURL  string `json:"base_url"`
			Protocol string `json:"protocol"`
			Kind     string `json:"kind" enum:"chat,transcription"`
			APIKey   string `json:"api_key,omitempty" writeOnly:"true"`
		}
	}) (*singleBody[tcyai.ModelList], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		c, err := tcyai.ResolveConnection(uid, tcyai.Connection{ID: in.Body.ID, Name: "model discovery", Model: "discovery", BaseURL: in.Body.BaseURL, Kind: in.Body.Kind, Protocol: in.Body.Protocol, APIKey: in.Body.APIKey})
		if err != nil {
			return nil, aiError(ctx, err)
		}
		ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
		defer cancel()
		models, err := tcyai.ListModels(ctx, c)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &singleBody[tcyai.ModelList]{Body: &models}, nil
	})

	registerAIConnectionTest(api, op)
	registerSpeechProviders(api, op)

	Register(api, op("tcy-ai-transcribe", "POST", "/ai/transcribe", "识别上传音频，可选使用独立模型整理文字"), func(ctx context.Context, in *struct {
		Body struct {
			ConnectionID string `json:"connection_id,omitempty" maxLength:"80" doc:"Optional saved recognition connection belonging to the current user; empty uses the default."`
			Audio        string `json:"audio"`
			Filename     string `json:"filename"`
			Cleanup      bool   `json:"cleanup"`
		}
	}) (*aiTextResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		connectionID := in.Body.ConnectionID
		if connectionID == "" {
			connectionID = s.Transcription
		}
		c, err := s.Find(connectionID, "transcription")
		if err != nil {
			return nil, aiError(ctx, err)
		}
		data, err := decodeAIAudio(in.Body.Audio)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		result, err := tcyai.RecognizeSpeech(ctx, c, in.Body.Filename, data)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		out := &aiTextResponse{}
		setSpeechResponse(out, result)
		if in.Body.Cleanup && s.Cleanup != "" {
			c, err = s.Find(s.Cleanup, "chat")
			if err == nil {
				out.Body.Text, err = tcyai.Cleanup(ctx, c, result.Text)
			}
			if err != nil {
				out.Body.Text = result.Text
				out.Body.Warning = tcylocale.Text(ctx, "cleanupFailed", tcylocale.Render(ctx, err))
			}
		}
		return out, nil
	})
	Register(api, op("tcy-ai-cleanup", "POST", "/ai/cleanup", "使用文字整理模型保留原意地整理口语记录"), func(ctx context.Context, in *struct {
		Body struct {
			Text string `json:"text" minLength:"1" maxLength:"12000"`
		}
	}) (*aiTextResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		c, err := s.Find(s.Cleanup, "chat")
		if err != nil {
			return nil, aiError(ctx, err)
		}
		text, err := tcyai.Cleanup(ctx, c, in.Body.Text)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		out := &aiTextResponse{}
		out.Body.Text = text
		out.Body.Original = in.Body.Text
		return out, nil
	})
	Register(api, op("tcy-ai-run", "POST", "/ai/run", "运行具有明确读写模式的任务助手，返回实际工具调用记录"), func(ctx context.Context, in *struct{ Body tcyai.RunInput }) (*singleBody[tcyai.RunResult], error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		return runAI(ctx, api, uid, in.Body)
	})
}

func decodeAIAudio(encoded string) ([]byte, error) {
	if len(encoded) > 22*1024*1024 {
		return nil, tcylocale.Error("e50")
	}
	data, err := base64.StdEncoding.DecodeString(encoded)
	if err != nil || len(data) == 0 || len(data) > 16*1024*1024 {
		return nil, tcylocale.Error("e47")
	}
	return data, nil
}

type aiRunCacheEntry struct {
	hash   [32]byte
	result tcyai.RunResult
	ready  bool
	at     time.Time
}

var aiRuns = struct {
	sync.Mutex
	entries map[string]aiRunCacheEntry
	busy    map[int64]bool
}{entries: map[string]aiRunCacheEntry{}, busy: map[int64]bool{}}

func runAI(ctx context.Context, api huma.API, uid int64, in tcyai.RunInput) (*singleBody[tcyai.RunResult], error) {
	if len(in.AttachmentIDs) > 0 {
		return nil, chatFileError(ctx, tcyai.ErrAttachmentMissing)
	}
	key := fmt.Sprintf("%d:%s", uid, in.RequestID)
	raw, err := json.Marshal(in)
	if err != nil {
		return nil, aiError(ctx, err)
	}
	hash := sha256.Sum256(raw)
	aiRuns.Lock()
	for k, v := range aiRuns.entries {
		if v.ready && time.Since(v.at) > 10*time.Minute {
			delete(aiRuns.entries, k)
		}
	}
	if v, ok := aiRuns.entries[key]; ok {
		aiRuns.Unlock()
		if v.hash != hash {
			return nil, huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("e20")))
		}
		if !v.ready {
			return nil, huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("e45")))
		}
		return &singleBody[tcyai.RunResult]{Body: &v.result}, nil
	}
	if aiRuns.busy[uid] || len(aiRuns.entries) >= 256 {
		aiRuns.Unlock()
		return nil, huma.Error429TooManyRequests(tcylocale.Render(ctx, tcylocale.Error("e22")))
	}
	aiRuns.busy[uid] = true
	aiRuns.entries[key] = aiRunCacheEntry{hash: hash, at: time.Now()}
	aiRuns.Unlock()
	result := tcyai.RunResult{Actions: []tcyai.Action{}}
	defer func() {
		aiRuns.Lock()
		delete(aiRuns.busy, uid)
		aiRuns.entries[key] = aiRunCacheEntry{hash: hash, result: result, ready: true, at: time.Now()}
		aiRuns.Unlock()
	}()
	s, err := tcyai.Load(uid)
	if err != nil {
		result.Reply = tcylocale.Render(ctx, err)
		return &singleBody[tcyai.RunResult]{Body: &result}, nil
	}
	c, err := s.Find(s.Assistant, "chat")
	if err != nil {
		result.Reply = tcylocale.Render(ctx, err)
		return &singleBody[tcyai.RunResult]{Body: &result}, nil
	}
	ec := humabridge.EchoContextFrom(ctx)
	caller := (*ec).Request().Clone(ctx)
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	execution, executionErr := newAIExecution(ctx, api, caller, in)
	if executionErr != nil {
		return nil, executionErr
	}
	state := tcyai.NewAgentState(ctx, c, in)
	result, err = tcyai.RunAgent(ctx, c, state, execution.execute, execution.prepare, nil)
	if err != nil {
		result.Reply = tcylocale.Text(ctx, "stopped", tcylocale.Render(ctx, err))
	}
	return &singleBody[tcyai.RunResult]{Body: &result}, nil
}

func dispatchAI(ctx context.Context, api huma.API, caller *http.Request, name string, raw json.RawMessage) (string, error) {
	if _, err := tcyai.ValidateTool(name, raw, tcyai.RunInput{Mode: "write", AllowDelete: true}); err != nil {
		return "", err
	}
	var args map[string]json.RawMessage
	if err := json.Unmarshal(raw, &args); err != nil {
		return "", tcylocale.Error("e21")
	}
	id := func(key string) (int64, error) {
		var n int64
		if err := json.Unmarshal(args[key], &n); err != nil || n < 1 {
			return 0, tcylocale.Error("e1", key)
		}
		delete(args, key)
		return n, nil
	}
	path, method := "", "GET"
	query := url.Values{}
	switch name {
	case "list_projects", "list_tasks", "list_labels":
		path = "/projects"
		if name == "list_tasks" {
			path = "/tasks"
		}
		if name == "list_labels" {
			path = "/labels"
		}
		if _, ok := args["project_id"]; ok && name == "list_tasks" {
			n, e := id("project_id")
			if e != nil {
				return "", e
			}
			path = fmt.Sprintf("/projects/%d/tasks", n)
		}
		if e := aiQuery(args, query); e != nil {
			return "", e
		}
		args = nil
	case "get_task", "update_task", "delete_task":
		n, e := id("id")
		if e != nil {
			return "", e
		}
		path = fmt.Sprintf("/tasks/%d", n)
		if name == "update_task" {
			method = "PATCH"
		}
		if name == "delete_task" {
			method = "DELETE"
		}
		if method != "PATCH" && len(args) > 0 {
			return "", tcylocale.Error("e32")
		}
	case "create_task":
		n, e := id("project_id")
		if e != nil {
			return "", e
		}
		path = fmt.Sprintf("/projects/%d/tasks", n)
		method = "POST"
	case "create_project":
		path = "/projects"
		method = "POST"
	default:
		var routeErr error
		path, method, routeErr = aiExtendedRoute(name, args, id, query)
		if routeErr != nil {
			return "", routeErr
		}
	}
	if (method == "PATCH" || method == "POST") && (name == "create_task" || name == "update_task" || name == "create_project") {
		allowed := map[string]bool{"title": true, "description": true, "due_date": true, "start_date": true, "end_date": true, "priority": true, "done": true, "reminders": true, "hex_color": true, "percent_done": true, "is_favorite": true, "repeat_after": true, "repeat_mode": true, "project_id": true, "cover_image_attachment_id": true}
		for k := range args {
			if !allowed[k] {
				return "", tcylocale.Error("e17", k)
			}
		}
	}
	return serveAITool(ctx, api, caller, name, path, method, args, query)
}

func aiProjectHistoryQuery(args map[string]json.RawMessage, query url.Values) error {
	for key, rawValue := range args {
		var value any
		decoder := json.NewDecoder(bytes.NewReader(rawValue))
		decoder.UseNumber()
		if err := decoder.Decode(&value); err != nil {
			return err
		}
		switch key {
		case "project_id":
			key = "project"
		case "query":
			key = "q"
		}
		query.Set(key, fmt.Sprint(value))
	}
	return nil
}

func serveAITool(ctx context.Context, api huma.API, caller *http.Request, name, path, method string, args map[string]json.RawMessage, query url.Values) (string, error) {
	body, err := json.Marshal(args)
	if err != nil {
		return "", err
	}
	req, err := http.NewRequestWithContext(ctx, method, GroupPrefix+path+"?"+query.Encode(), bytes.NewReader(body))
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", caller.Header.Get("Authorization"))
	req.Header.Set("Accept", "application/json")
	req.Header.Set("Content-Type", "application/json")
	if method == "PATCH" {
		req.Header.Set("Content-Type", "application/merge-patch+json")
	}
	req.Host = caller.Host
	req.RemoteAddr = caller.RemoteAddr
	req.TLS = caller.TLS
	for _, h := range []string{"X-Forwarded-For", "X-Real-IP", "X-Forwarded-Host", "User-Agent", "Accept-Language"} {
		req.Header.Set(h, caller.Header.Get(h))
	}
	rec := httptest.NewRecorder()
	api.Adapter().ServeHTTP(rec, req)
	data := strings.TrimSpace(rec.Body.String())
	// Keep successful results intact for audit and structural projection. Cutting
	// serialized JSON here prevents the runtime from extracting compact list rows.
	if rec.Code >= 300 {
		if rec.Code >= 500 && tcyai.IsWriteTool(name) {
			return "", &tcyai.ToolError{Code: "WRITE_UNCERTAIN", Message: tcylocale.Render(ctx, tcylocale.Error("e25", rec.Code, data)), Uncertain: true}
		}
		return "", &tcyai.ToolError{Code: fmt.Sprintf("API_%d", rec.Code), Message: tcylocale.Render(ctx, tcylocale.Error("e25", rec.Code, data))}
	}
	if data == "" {
		data = `{"success":true}`
	}
	return data, nil
}

func aiQuery(args map[string]json.RawMessage, query url.Values) error {
	for k, v := range args {
		switch k {
		case "query", "filter":
			var text string
			if e := json.Unmarshal(v, &text); e != nil {
				return e
			}
			if k == "query" {
				k = "q"
			}
			query.Set(k, text)
		case "page":
			var n int
			if e := json.Unmarshal(v, &n); e != nil || n < 1 {
				return tcylocale.Error("e51")
			}
			query.Set(k, strconv.Itoa(n))
		default:
			return tcylocale.Error("e33")
		}
	}
	query.Set("per_page", "25")
	return nil
}

func aiExtendedRoute(name string, args map[string]json.RawMessage, id func(string) (int64, error), query url.Values) (string, string, error) {
	method := "GET"
	switch name {
	case "get_project_announcement", "update_project_announcement":
		n, err := id("id")
		if name == "update_project_announcement" {
			method = "PUT"
		}
		return fmt.Sprintf("/projects/%d/announcement", n), method, err
	case "get_task_routine", "configure_task_routine", "check_in_task_routine", "set_task_routine_progress", "get_task_routine_history":
		n, err := id("id")
		if err != nil {
			return "", "", err
		}
		path := fmt.Sprintf("/tasks/%d/routine", n)
		switch name {
		case "configure_task_routine":
			method = "PUT"
		case "check_in_task_routine":
			method = "POST"
			path += "/check-in"
		case "set_task_routine_progress":
			method = "POST"
			path += "/progress"
		case "get_task_routine_history":
			path += "/history"
			for _, key := range []string{"year", "month"} {
				query.Set(key, string(args[key]))
			}
			clear(args)
		}
		return path, method, nil
	case "list_project_history", "list_project_timeline":
		err := aiProjectHistoryQuery(args, query)
		clear(args)
		if name == "list_project_timeline" {
			return "/projects/timeline", method, err
		}
		return "/projects/history", method, err
	case "get_project":
		n, err := id("id")
		return fmt.Sprintf("/projects/%d", n), method, err
	case "list_comments", "list_project_users":
		key := "id"
		if name == "list_project_users" {
			key = "project_id"
		}
		n, err := id(key)
		if err != nil {
			return "", "", err
		}
		path := fmt.Sprintf("/tasks/%d/comments", n)
		if name == "list_project_users" {
			path = fmt.Sprintf("/projects/%d/users", n)
		}
		if err = aiQuery(args, query); err != nil {
			return "", "", err
		}
		clear(args)
		return path, method, nil
	case "create_label":
		return "/labels", "POST", nil
	}
	n, err := id("id")
	if err != nil {
		return "", "", err
	}
	suffixes := map[string]string{"add_comment": "comments", "assign_task": "assignees", "add_task_label": "labels", "relate_tasks": "relations"}
	if suffix, ok := suffixes[name]; ok {
		return fmt.Sprintf("/tasks/%d/%s", n, suffix), "POST", nil
	}
	key, suffix := "", ""
	switch name {
	case "unassign_task":
		key = "user_id"
		suffix = "assignees"
	case "remove_task_label":
		key = "label_id"
		suffix = "labels"
	case "unrelate_tasks":
		key = "other_task_id"
		var kind string
		if err = json.Unmarshal(args["relation_kind"], &kind); err != nil {
			return "", "", err
		}
		delete(args, "relation_kind")
		suffix = "relations/" + url.PathEscape(kind)
	default:
		return "", "", tcylocale.Error("e18")
	}
	other, err := id(key)
	return fmt.Sprintf("/tasks/%d/%s/%d", n, suffix, other), "DELETE", err
}

func registerAIPreferences(api huma.API, op func(string, string, string, string) huma.Operation) {
	Register(api, op("tcy-ai-preferences", "GET", "/ai/preferences", "Read account-owned assistant profiles and default scenario"), func(ctx context.Context, _ *struct{}) (*aiPreferencesResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		s, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &aiPreferencesResponse{CacheControl: "no-store", Body: s.Preferences}, nil
	})
	Register(api, op("tcy-ai-save-preferences", "POST", "/ai/preferences", "Replace personal assistant profiles using an optimistic revision; stale writes return 409, connection secrets are preserved"), func(ctx context.Context, in *struct{ Body tcyai.AssistantPreferences }) (*aiPreferencesResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		p, err := tcyai.SavePreferences(uid, in.Body)
		if errors.Is(err, tcyai.ErrPreferencesConflict) {
			return nil, huma.Error409Conflict(err.Error())
		}
		if err != nil {
			return nil, aiError(ctx, err)
		}
		return &aiPreferencesResponse{CacheControl: "no-store", Body: p}, nil
	})
}

func testAISearch(ctx context.Context, c tcyai.Connection) (*aiTextResponse, error) {
	ctx, cancel := context.WithTimeout(ctx, 120*time.Second)
	defer cancel()
	result, err := tcyai.SearchWeb(ctx, c, "Vikunja official documentation")
	if err != nil {
		return nil, aiError(ctx, err)
	}
	out := &aiTextResponse{}
	out.Body.Endpoint = result.Endpoint
	out.Body.Search = &result
	if !result.Verified {
		out.Body.Warning = tcylocale.Render(ctx, tcylocale.Error("searchUnverified"))
	}
	return out, nil
}

func registerAIConnectionTest(api huma.API, op func(string, string, string, string) huma.Operation) {
	Register(api, op("tcy-ai-test", "POST", "/ai/test", "测试已保存模型的文字响应或语音转写能力"), func(ctx context.Context, in *struct {
		Body struct {
			ConnectionID string            `json:"connection_id"`
			WebSearch    bool              `json:"web_search,omitempty" doc:"Test actual web search, not chat or write tools."`
			Connection   *tcyai.Connection `json:"connection,omitempty" doc:"Optional unsaved connection for search tests; saved secrets only reused on the same origin."`
			Audio        string            `json:"audio"`
			Filename     string            `json:"filename"`
		}
	}) (*aiTextResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if in.Body.WebSearch && in.Body.Connection != nil {
			c, resolveErr := tcyai.ResolveConnection(uid, *in.Body.Connection)
			if resolveErr != nil {
				return nil, aiError(ctx, resolveErr)
			}
			return testAISearch(ctx, c)
		}
		s, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		for _, c := range s.Connections {
			if c.ID == in.Body.ConnectionID {
				if in.Body.WebSearch {
					return testAISearch(ctx, c)
				}
				out := &aiTextResponse{}
				out.Body.Endpoint = tcyai.Endpoint(c)
				if c.Kind == "chat" {
					out.Body.Endpoint = tcyai.AgentEndpoint(c)
					out.Body.Text, out.Body.Warning, err = tcyai.TestConnection(ctx, c)
				} else {
					data, e := decodeAIAudio(in.Body.Audio)
					if e != nil {
						return nil, aiError(ctx, e)
					}
					var speech tcyai.SpeechResult
					speech, err = tcyai.RecognizeSpeech(ctx, c, in.Body.Filename, data)
					setSpeechResponse(out, speech)
				}
				if err != nil {
					return nil, aiError(ctx, err)
				}
				return out, nil
			}
		}
		return nil, huma.Error404NotFound(tcylocale.Render(ctx, tcylocale.Error("e43")))
	})
}

func setSpeechResponse(out *aiTextResponse, result tcyai.SpeechResult) {
	out.Body.Text = result.Text
	out.Body.Original = result.Text
	out.Body.Endpoint = result.Endpoint
	out.Body.ElapsedMS = result.ElapsedMS
	out.Body.AudioDurationMS = result.AudioDurationMS
	out.Body.FirstTextMS = result.FirstTextMS
}

func registerSpeechProviders(api huma.API, op func(string, string, string, string) huma.Operation) {
	type response struct {
		CacheControl string `header:"Cache-Control"`
		Body         []tcyai.SpeechProvider
	}
	Register(api, op("tcy-ai-speech-providers", "GET", "/ai/speech/providers", "列出已实现的语音服务商协议、模型预设与真实参数能力；不返回凭据"), func(ctx context.Context, _ *struct{}) (*response, error) {
		if _, err := aiUser(ctx); err != nil {
			return nil, err
		}
		return &response{
			CacheControl: "no-store",
			Body:         tcyai.SpeechProviders(),
		}, nil
	})
}
