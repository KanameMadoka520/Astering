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

package apiv2

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"code.vikunja.io/api/pkg/modules/humabridge"
	"code.vikunja.io/api/pkg/modules/tcyai"
	"code.vikunja.io/api/pkg/modules/tcylocale"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTCYAIConversationRoutes) }

type conversationPathInput struct {
	ID string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
}
type conversationResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.Conversation
}

func conversationOut(ctx context.Context, value tcyai.Conversation, err error) (*conversationResponse, error) {
	if err != nil {
		return nil, conversationError(ctx, err)
	}
	return &conversationResponse{CacheControl: "no-store", Body: value}, nil
}
func conversationError(ctx context.Context, err error) error {
	if errors.Is(err, tcyai.ErrSteeringUnavailable) {
		return huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("chatSteeringUnavailable")))
	}
	if errors.Is(err, tcyai.ErrSteeringInvalid) {
		return huma.Error400BadRequest(tcylocale.Render(ctx, tcylocale.Error("chatSteeringInvalid")))
	}
	if errors.Is(err, tcyai.ErrConversationMetadata) {
		return huma.Error400BadRequest(tcylocale.Render(ctx, tcylocale.Error("chatMetadata")))
	}
	if errors.Is(err, tcyai.ErrAttachmentMissing) || errors.Is(err, tcyai.ErrAttachmentInvalid) || errors.Is(err, tcyai.ErrImageModel) {
		return chatFileError(ctx, err)
	}
	if errors.Is(err, tcyai.ErrConversationMissing) {
		return huma.Error404NotFound(tcylocale.Render(ctx, tcylocale.Error("chatMissing")))
	}
	if errors.Is(err, tcyai.ErrConversationRequest) {
		return huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("chatRequestChanged")))
	}
	if errors.Is(err, tcyai.ErrAgentReview) {
		return huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("chatReviewChanged")))
	}
	if errors.Is(err, tcyai.ErrConversationBusy) {
		return huma.Error409Conflict(tcylocale.Render(ctx, tcylocale.Error("chatBusy")))
	}
	return aiError(ctx, err)
}
func conversationModel(uid int64, connectionID string) (tcyai.Connection, error) {
	settings, err := tcyai.Load(uid)
	if err != nil {
		return tcyai.Connection{}, err
	}
	if connectionID == "" {
		connectionID = settings.Assistant
	}
	return settings.Find(connectionID, "chat")
}
func RegisterTCYAIConversationRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID: id, Method: method, Path: path, Summary: summary,
			Description: "Private encrypted AI conversation state belonging only to the signed-in human account. API tokens, bots and link shares are rejected. No-store responses; never exposed over MCP.",
			Tags:        []string{"tcymc-ai"}, MaxBodyBytes: 128 * 1024, BodyReadTimeout: 30 * time.Second,
		}
	}
	Register(api, op("tcy-ai-conversations-list", "GET", "/ai/conversations", "List private saved conversations"), func(ctx context.Context, in *struct {
		ListParams
		Scope string `query:"scope" default:"all" enum:"all,active,archived" doc:"Filter regular or archived history. Search matches titles, user messages and final assistant replies."`
	}) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         Paginated[tcyai.ConversationSummary]
	}, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		entries, err := tcyai.SearchConversations(uid, in.Q, in.Scope)
		if err != nil {
			return nil, conversationError(ctx, err)
		}
		filtered := entries
		total := len(filtered)
		start := (in.Page - 1) * in.PerPage
		if start > total {
			start = total
		}
		end := start + in.PerPage
		if end > total {
			end = total
		}
		return &struct {
			CacheControl string `header:"Cache-Control"`
			Body         Paginated[tcyai.ConversationSummary]
		}{CacheControl: "no-store", Body: NewPaginated(filtered[start:end], int64(total), in.Page, in.PerPage)}, nil
	})
	Register(api, op("tcy-ai-conversations-create", "POST", "/ai/conversations", "Create a private conversation without calling a model"), func(ctx context.Context, in *struct {
		Body struct {
			Title string `json:"title" maxLength:"150" doc:"Optional title. The first message supplies a title when blank."`
		}
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.CreateConversation(uid, in.Body.Title)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-read", "GET", "/ai/conversations/{id}", "Read saved turns and live execution progress"), func(ctx context.Context, in *conversationPathInput) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.GetConversation(uid, in.ID)
		return conversationOut(ctx, value, err)
	})
	steer := op("tcy-ai-conversations-steer", "POST", "/ai/conversations/{id}/steer", "Add an instruction to the current running turn")
	steer.MaxBodyBytes = 320 * 1024
	steer.Description += " Durably queues instructions in acceptance order without changing the original goal or run permissions. Applied at safe model/tool boundaries; already executing operations may finish. Returns 409 when this turn no longer accepts instructions or an idempotency key changes payload. Identical retries return the existing receipt, even after completion."
	Register(api, steer, func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body tcyai.SteeringInput
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.SteerConversation(uid, in.ID, in.Body)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-rename", "POST", "/ai/conversations/{id}/title", "Rename a conversation without changing its messages"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body struct {
			Title string `json:"title" minLength:"1" maxLength:"150" doc:"The new title."`
		}
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.RenameConversation(uid, in.ID, in.Body.Title)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-organize", "POST", "/ai/conversations/{id}/organization", "Rename, pin or archive a private conversation without stopping background work"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body tcyai.ConversationMetadata
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.UpdateConversationMetadata(uid, in.ID, in.Body)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-delete", "DELETE", "/ai/conversations/{id}", "Delete a private conversation; does not undo task operations"), func(ctx context.Context, in *conversationPathInput) (*emptyBody, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if err = tcyai.DeleteConversation(uid, in.ID); err != nil {
			return nil, conversationError(ctx, err)
		}
		return &emptyBody{}, nil
	})
	Register(api, op("tcy-ai-conversations-fork", "POST", "/ai/conversations/{id}/fork", "Fork through an existing turn, without replaying or undoing any tool operations"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body struct {
			TurnID string `json:"turn_id" format:"uuid" doc:"Copy context through this turn, inclusive. The source remains unchanged."`
		}
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.ForkConversation(uid, in.ID, in.Body.TurnID)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-send", "POST", "/ai/conversations/{id}/messages", "Start a resumable asynchronous agent run; GET the conversation for live deltas"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body tcyai.RunInput
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if _, err = tcyai.GetConversation(uid, in.ID); err != nil {
			return nil, conversationError(ctx, err)
		}
		connection, err := conversationModel(uid, in.Body.ConnectionID)
		if err != nil {
			return nil, aiError(ctx, err)
		}

		// Copy request headers before Echo returns its context to the pool. Permission checks still run per tool.
		ec := humabridge.EchoContextFrom(ctx)
		caller := (*ec).Request().Clone(context.Background()) //nolint:contextcheck // Only cloned HTTP fields survive Echo pooling.
		execution, err := newAIExecution(ctx, api, caller, in.Body)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.StartConversation(ctx, uid, in.ID, in.Body, connection, execution.execute, execution.prepare)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-review", "POST", "/ai/conversations/{id}/review", "Review or edit a real operation preview, answer a clarification, or grant another bounded execution segment"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body tcyai.ReviewInput
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		policy, err := tcyai.PendingConnection(uid, in.ID)
		if err != nil {
			return nil, conversationError(ctx, err)
		}
		connection, err := conversationModel(uid, policy.ConnectionID)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		ec := humabridge.EchoContextFrom(ctx)
		caller := (*ec).Request().Clone(context.Background()) //nolint:contextcheck // Only copied HTTP fields survive the request.
		execution, err := newAIExecution(ctx, api, caller, policy)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.ReviewConversation(ctx, uid, in.ID, in.Body, connection, execution.execute, execution.prepare)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-conversations-stop", "POST", "/ai/conversations/{id}/stop", "Stop generation; already completed task changes remain in effect"), func(ctx context.Context, in *conversationPathInput) (*emptyBody, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if err = tcyai.StopConversation(uid, in.ID); err != nil {
			return nil, conversationError(ctx, err)
		}
		return &emptyBody{}, nil
	})
	Register(api, op("tcy-ai-conversations-compact", "POST", "/ai/conversations/{id}/compact", "Summarize older turns with the selected model; preserve all original messages and the latest four turns"), func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation owned by the signed-in human user."`
		Body struct {
			ConnectionID string `json:"connection_id" maxLength:"80" doc:"Saved text model connection. Empty uses the assigned assistant."`
		}
	}) (*conversationResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if _, err = tcyai.GetConversation(uid, in.ID); err != nil {
			return nil, conversationError(ctx, err)
		}
		connection, err := conversationModel(uid, in.Body.ConnectionID)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		value, err := tcyai.CompactConversation(ctx, uid, in.ID, connection)
		return conversationOut(ctx, value, err)
	})
	Register(api, op("tcy-ai-prompt", "GET", "/ai/prompt", "Inspect the effective system prompt and available tool definitions"), func(ctx context.Context, in *struct {
		ProjectID    int64  `query:"project_id" minimum:"0" doc:"Optional project context."`
		Mode         string `query:"mode" default:"read" enum:"read,write" doc:"read permits queries; write also allows task creation and updates."`
		AllowDelete  bool   `query:"allow_delete" doc:"Expose the deletion tool only when write mode is selected."`
		ProjectTasks string `query:"project_tasks" default:"write" enum:"off,read,write" doc:"Selected project and task tool capability; global mode remains the write ceiling."`
		Compass      string `query:"compass" default:"off" enum:"off,read,write" doc:"Selected Compass capability; off by default."`
	}) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         struct {
			SystemPrompt string `json:"system_prompt" doc:"Current effective system prompt, including server time and permissions."`
			ToolSchema   string `json:"tool_schema" doc:"Readable JSON tool definitions; no credentials or private task data."`
		}
	}, error) {
		if _, err := aiUser(ctx); err != nil {
			return nil, err
		}
		body := &struct {
			CacheControl string `header:"Cache-Control"`
			Body         struct {
				SystemPrompt string `json:"system_prompt" doc:"Current effective system prompt, including server time and permissions."`
				ToolSchema   string `json:"tool_schema" doc:"Readable JSON tool definitions; no credentials or private task data."`
			}
		}{CacheControl: "no-store"}
		uid, _ := aiUser(ctx)
		settings, err := tcyai.Load(uid)
		if err != nil {
			return nil, aiError(ctx, err)
		}
		input := tcyai.RunInput{Persona: settings.Persona, ProjectID: in.ProjectID, Mode: in.Mode, AllowDelete: in.AllowDelete, ToolModules: tcyai.ToolModules{ProjectTasks: in.ProjectTasks, Compass: in.Compass}}
		body.Body.SystemPrompt = tcyai.SystemPrompt(ctx, input)
		raw, err := json.MarshalIndent(tcyai.ScopedTools(input), "", "  ")
		if err != nil {
			return nil, err
		}
		body.Body.ToolSchema = string(raw)
		return body, nil
	})
}
