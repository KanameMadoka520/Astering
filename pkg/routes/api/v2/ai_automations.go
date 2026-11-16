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
	"errors"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcylocale"
	"github.com/KanameMadoka520/Astering/pkg/user"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterAutomationRoutes) }

// AutomationPathInput is exported so Huma reflects embedded path parameters.
type AutomationPathInput struct {
	ID string `path:"id" format:"uuid" doc:"Automation UUID belonging only to the signed-in human account."`
}
type automationResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.Automation
}
type automationRunResponse struct {
	CacheControl string `header:"Cache-Control"`
	Body         tcyai.AutomationRun
}

// Durable background authorization belongs to active human sessions. A scoped
// internal tool invocation cannot create another autonomous grant, even if a
// future generic dispatcher were to learn this route.
func automationUser(ctx context.Context) (int64, error) {
	uid, err := aiUser(ctx)
	if err != nil {
		return 0, err
	}
	actor, err := authFromCtx(ctx)
	if err != nil {
		return 0, err
	}
	identity, err := user.GetFromAuth(actor)
	if err != nil || identity == nil || identity.HasResourceOnlyPermissions() || identity.CredentialScope().SessionID == "" || identity.CredentialScope().APITokenID != 0 {
		return 0, huma.Error403Forbidden("automation_human_session_required")
	}
	return uid, nil
}
func automationError(ctx context.Context, err error) error {
	switch {
	case errors.Is(err, tcyai.ErrAutomationMissing):
		return huma.Error404NotFound("automation_not_found")
	case errors.Is(err, tcyai.ErrAutomationInvalid):
		return huma.Error400BadRequest("automation_invalid")
	case errors.Is(err, tcyai.ErrAutomationConflict):
		return huma.Error409Conflict("automation_changed")
	case errors.Is(err, tcyai.ErrAutomationBusy):
		return huma.Error409Conflict("automation_running_or_scheduler_busy")
	case errors.Is(err, tcyai.ErrAutomationReceiptExpired):
		return huma.Error409Conflict("automation_run_receipt_expired")
	case errors.Is(err, tcyai.ErrAutomationLimit):
		return huma.Error409Conflict("automation_limit")
	default:
		return aiError(ctx, err)
	}
}
func automationOut(ctx context.Context, value tcyai.Automation, err error) (*automationResponse, error) {
	if err != nil {
		return nil, automationError(ctx, err)
	}
	return &automationResponse{
		CacheControl: "no-store",
		Body:         value,
	}, nil
}
func automationPage[T any](items []T, params ListParams) Paginated[T] {
	total := len(items)
	start := total
	if params.PerPage > 0 && params.Page > 0 && params.Page-1 <= total/params.PerPage {
		start = (params.Page - 1) * params.PerPage
	}
	end := min(total, start+params.PerPage)
	return NewPaginated(items[start:end], int64(total), params.Page, params.PerPage)
}
func RegisterAutomationRoutes(api huma.API) {
	op := func(id, method, path, summary string) huma.Operation {
		return huma.Operation{
			OperationID:     id,
			Method:          method,
			Path:            path,
			Summary:         summary,
			Description:     "Private human-owned background automation. API tokens, bots, shares and tools cannot create or authorize schedules. Parameters are snapshots, never permission grants. Existing account, module, project and MCP permissions are checked again during execution. Configuration uses revision CAS; execution receipts never replay unknown effects.",
			Tags:            []string{"ai-automations"},
			MaxBodyBytes:    128 * 1024,
			BodyReadTimeout: 30 * time.Second,
			Metadata:        map[string]any{"autopatch": false},
			Middlewares:     []func(huma.Context, func(huma.Context)){func(ctx huma.Context, next func(huma.Context)) { ctx.SetHeader("Cache-Control", "no-store"); next(ctx) }},
		}
	}
	Register(api, op("automation-list", http.MethodGet, "/ai/automations", "List personal automations"), func(ctx context.Context, in *ListParams) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         Paginated[tcyai.Automation]
	}, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		items, err := tcyai.ListAutomations(uid, in.Q)
		if err != nil {
			return nil, automationError(ctx, err)
		}
		return &struct {
			CacheControl string `header:"Cache-Control"`
			Body         Paginated[tcyai.Automation]
		}{
			CacheControl: "no-store",
			Body:         automationPage(items, *in),
		}, nil
	})
	Register(api, op("automation-create", http.MethodPost, "/ai/automations", "Create an automation or a pure reminder"), func(ctx context.Context, in *struct{ Body tcyai.AutomationSpec }) (*automationResponse, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.SaveAutomation(uid, "", 0, in.Body)
		return automationOut(ctx, value, err)
	})
	Register(api, op("automation-read", http.MethodGet, "/ai/automations/{id}", "Read a personal automation"), func(ctx context.Context, in *AutomationPathInput) (*automationResponse, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.GetAutomation(uid, in.ID)
		return automationOut(ctx, value, err)
	})
	Register(api, op("automation-update", http.MethodPut, "/ai/automations/{id}", "Replace or pause future automation settings"), func(ctx context.Context, in *struct {
		AutomationPathInput
		Body struct {
			tcyai.AutomationSpec
			ExpectedRevision int64 `json:"expected_revision" minimum:"1" doc:"Revision read by the editor. Stale replacement returns 409; existing execution uses its original snapshot."`
		}
	}) (*automationResponse, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.SaveAutomation(uid, in.ID, in.Body.ExpectedRevision, in.Body.AutomationSpec)
		return automationOut(ctx, value, err)
	})
	Register(api, op("automation-delete", http.MethodDelete, "/ai/automations/{id}", "Delete automation settings and run receipts; retain result conversations"), func(ctx context.Context, in *struct {
		AutomationPathInput
		Body struct {
			ExpectedRevision int64 `json:"expected_revision" minimum:"1" doc:"Revision to delete. Running conversation and all existing resource changes are retained."`
		}
	}) (*emptyBody, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		if err = tcyai.DeleteAutomation(uid, in.ID, in.Body.ExpectedRevision); err != nil {
			return nil, automationError(ctx, err)
		}
		return &emptyBody{}, nil
	})
	Register(api, op("automation-run", http.MethodPost, "/ai/automations/{id}/run", "Run an automation once without changing its schedule"), func(ctx context.Context, in *struct {
		AutomationPathInput
		Body struct {
			RequestID string `json:"request_id" minLength:"8" maxLength:"80" doc:"Idempotency key: preserve this exact ID after a network failure; never replay a trimmed old receipt."`
		}
	}) (*automationRunResponse, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.RunAutomationNow(uid, in.ID, in.Body.RequestID)
		if err != nil {
			return nil, automationError(ctx, err)
		}
		return &automationRunResponse{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
	Register(api, op("automation-runs", http.MethodGet, "/ai/automations/{id}/runs", "List the latest 50 durable execution receipts"), func(ctx context.Context, in *struct {
		AutomationPathInput
		ListParams
	}) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         Paginated[tcyai.AutomationRun]
	}, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		items, err := tcyai.ListAutomationRuns(uid, in.ID)
		if err != nil {
			return nil, automationError(ctx, err)
		}
		return &struct {
			CacheControl string `header:"Cache-Control"`
			Body         Paginated[tcyai.AutomationRun]
		}{
			CacheControl: "no-store",
			Body:         automationPage(items, in.ListParams),
		}, nil
	})
	Register(api, op("automation-run-read", http.MethodGet, "/ai/automations/{id}/runs/{run}", "Read one execution receipt and its private conversation link"), func(ctx context.Context, in *struct {
		AutomationPathInput
		Run string `path:"run" format:"uuid" doc:"Receipt UUID within this account's automation."`
	}) (*automationRunResponse, error) {
		uid, err := automationUser(ctx)
		if err != nil {
			return nil, err
		}
		value, err := tcyai.GetAutomationRun(uid, in.ID, in.Run)
		if err != nil {
			return nil, automationError(ctx, err)
		}
		return &automationRunResponse{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
	tcyai.ConfigureAutomationRunner(func(ctx context.Context, uid int64, record tcyai.Automation, run tcyai.AutomationRun, link func(string) error) tcyai.AutomationOutcome {
		return runAutomationAgent(ctx, api, uid, record, run, link)
	}, cleanupAutomationSessions)
}

const automationSessionPrefix = "Astering automation/"

func automationInput(record tcyai.Automation, run tcyai.AutomationRun) tcyai.RunInput {
	o := *record.Options
	return tcyai.RunInput{
		Message:            record.Prompt,
		RequestID:          run.ID,
		ToolModules:        o.ToolModules,
		MCPServerIDs:       o.MCPServerIDs,
		StopAtSegmentLimit: o.StopAtSegmentLimit,
		EnableSubagents:    o.EnableSubagents,
		SearchMode:         o.SearchMode,
		ConnectionID:       o.ConnectionID,
		ProjectID:          o.ProjectID,
		Mode:               o.Mode,
		AllowDelete:        o.AllowDelete,
		Approval:           o.Approval,
		WriteProjectIDs:    o.WriteProjectIDs,
		MaxRounds:          o.MaxRounds,
		MaxOperations:      o.MaxOperations,
		TimeoutSeconds:     o.TimeoutSeconds,
		TokenBudget:        o.TokenBudget,
	}
}
func automationFailure(code, message string) tcyai.AutomationOutcome {
	return tcyai.AutomationOutcome{
		Status:    "failed",
		ErrorCode: code,
		Error:     message,
	}
}
func revokeAutomationSession(sid string) error {
	s := db.NewSession()
	defer s.Close()
	defer events.CleanupPending(s)
	if _, err := models.DeleteSessionByID(s, sid); err != nil {
		if models.IsErrSessionNotFound(err) {
			return nil
		}
		return err
	}
	if err := s.Commit(); err != nil {
		return err
	}
	events.DispatchPending(context.Background(), s)
	return nil
}
func cleanupAutomationSessions() {
	if cleanupAutomationSessionRecords() != nil {
		log.Warning("Automation session cleanup could not finish; expired sessions will be retried.")
	}
}
func cleanupAutomationSessionRecords() error {
	// Release the read connection before opening any revocation transaction.
	// Holding a read transaction here can block our own SQLite writer.
	s := db.NewReadSession()
	var sessions []models.Session
	err := s.Where("device_info LIKE ?", automationSessionPrefix+"%").Asc("created").Limit(200).Find(&sessions)
	_ = s.Close()
	if err != nil {
		return err
	}
	var result error
	for _, session := range sessions {
		parts := strings.Split(strings.TrimPrefix(session.DeviceInfo, automationSessionPrefix), "/")
		expires, parseErr := strconv.ParseInt(parts[0], 10, 64)
		if parseErr != nil || time.Now().Unix() >= expires {
			result = errors.Join(result, revokeAutomationSession(session.ID))
		}
	}
	return result
}
func automationMCPFailure(uid int64, selectedIDs []string) (tcyai.AutomationOutcome, bool) {
	mcp, err := tcyai.LoadMCP(uid)
	if err != nil {
		return automationFailure("MCP_NOT_CONFIGURED", "The account's MCP settings could not be loaded."), true
	}
	for _, id := range selectedIDs {
		found := false
		for _, item := range mcp.Connections {
			if item.ID == id && item.Enabled {
				found = true
				break
			}
		}
		if !found {
			return automationFailure("MCP_NOT_CONFIGURED", "A selected MCP connection is missing or disabled. Edit the automation or its MCP settings."), true
		}
	}
	return tcyai.AutomationOutcome{}, false
}

func automationConversationFailure(err error) tcyai.AutomationOutcome {
	var localized *tcylocale.LocalizedError
	if errors.As(err, &localized) && localized.Key == "tcymc.errors.chatLimit" {
		return automationFailure("CONVERSATION_LIMIT", "This account has reached its 100-conversation limit, including archived conversations. Delete unneeded conversations in Storage, then retry. Completed records are never deleted automatically.")
	}
	return automationFailure("CONVERSATION_FAILED", "The execution conversation could not be saved.")
}

func runAutomationAgent(ctx context.Context, api huma.API, uid int64, record tcyai.Automation, run tcyai.AutomationRun, link func(string) error) tcyai.AutomationOutcome {
	if record.Options == nil {
		return automationFailure("INVALID_OPTIONS", "The automation has no model execution settings.")
	}
	connection, err := conversationModel(uid, record.Options.ConnectionID)
	if err != nil {
		return automationFailure("MODEL_NOT_CONFIGURED", "The selected model connection is missing or unavailable. Update this account's model settings.")
	}
	if failure, failed := automationMCPFailure(uid, record.Options.MCPServerIDs); failed {
		return failure
	}
	// Capture the revocation fence before credential issuance under the users-row
	// lock. A suspend/delete/password-revoke race cannot register a late worker.
	ctx = tcyai.WithAccountRunAdmission(ctx, uid)
	s := db.NewSession()
	defer s.Close()
	db.SetSessionContext(ctx, s)
	deadline, ok := ctx.Deadline()
	if !ok {
		return automationFailure("INVALID_OPTIONS", "The automation has no total execution deadline.")
	}
	expiry := deadline.Add(time.Minute)
	session, err := models.CreateSession(s, uid, automationSessionPrefix+strconv.FormatInt(expiry.Unix(), 10)+"/"+run.ID, "internal", false, nil)
	if err != nil {
		return automationFailure("ACCOUNT_REVOKED", "The account is inactive or no longer authorized to start background work.")
	}
	session.RefreshToken = ""
	identity, err := user.GetUserByID(s, uid)
	if err != nil {
		return automationFailure("ACCOUNT_REVOKED", "The account could not be verified.")
	}
	token, err := auth.NewBackgroundUserJWTAuthtoken(identity, session.ID, expiry)
	if err != nil {
		return automationFailure("CREDENTIAL_FAILED", "The short-lived background credential could not be created.")
	}
	if err = s.Commit(); err != nil {
		return automationFailure("CREDENTIAL_FAILED", "The background session could not be committed.")
	}
	defer func() {
		if revokeAutomationSession(session.ID) != nil {
			log.Warning("Automation service session could not be revoked; the bounded orphan cleanup will retry.")
		}
	}()
	// Immutable in-memory bearer, never persisted/returned; the ordinary internal
	// API validates its sid, current account, resource ACL and MCP policy per tool.
	caller, _ := http.NewRequestWithContext(ctx, http.MethodPost, "http://automation.internal/", nil)
	caller.Header.Set("Authorization", "Bearer "+token)
	caller.Header.Set("User-Agent", automationSessionPrefix+run.ID)
	caller.Header.Set("Accept-Language", identity.Language)
	input := automationInput(record, run)
	execution := &aiExecution{
		api:    api,
		caller: caller,
		auth:   user.RestrictToResourcePermissions(user.WithSessionCredential(identity, session.ID)),
		input:  input,
	}
	conversation, err := tcyai.CreateConversation(uid, "[Automation] "+record.Title)
	if err != nil {
		return automationConversationFailure(err)
	}
	if err = link(conversation.ID); err != nil {
		return automationFailure("AUTOMATION_REMOVED", "The automation was removed before its conversation could start.")
	}
	ctx = tcylocale.WithLanguage(ctx, identity.Language)
	ctx, stopOriginal := tcyai.WithAutomationConversationOwner(ctx)
	if _, err = tcyai.StartConversation(ctx, uid, conversation.ID, input, connection, execution.execute, execution.prepare); err != nil {
		return automationFailure("START_FAILED", "The conversation could not start. Check the account and execution settings.")
	}
	defer func() { stopOriginal() }()
	ticker := time.NewTicker(500 * time.Millisecond)
	defer ticker.Stop()
	for {
		select {
		case <-ctx.Done():
			stopOriginal()
			return tcyai.AutomationOutcome{
				Status:    "canceled",
				ErrorCode: "TIMEOUT",
				Error:     "The configured total execution time was reached. Completed actions are retained.",
			}
		case <-ticker.C:
			value, readErr := tcyai.GetConversation(uid, conversation.ID)
			if readErr != nil {
				stopOriginal()
				return automationFailure("CONVERSATION_UNAVAILABLE", "The execution conversation is unavailable or account access was revoked.")
			}
			if len(value.Turns) == 0 {
				continue
			}
			var turn *tcyai.ChatTurn
			for index := range value.Turns {
				if value.Turns[index].RequestID == run.ID {
					turn = &value.Turns[index]
					break
				}
			}
			if turn == nil {
				stopOriginal()
				return automationFailure("CONVERSATION_UNAVAILABLE", "The execution turn could not be found in its conversation.")
			}
			switch turn.Status {
			case "running":
				continue
			case "completed":
				return tcyai.AutomationOutcome{Status: "succeeded"}
			case "awaiting_approval", "awaiting_input", "paused":
				return tcyai.AutomationOutcome{
					Status:    "needs_attention",
					ErrorCode: "NEEDS_ATTENTION",
					Error:     "Open the conversation to review an operation, answer a question or continue after the configured segment limit.",
				}
			case "stopped":
				return tcyai.AutomationOutcome{
					Status:    "canceled",
					ErrorCode: "STOPPED",
					Error:     "The execution was stopped. Completed actions are retained.",
				}
			case "interrupted":
				return tcyai.AutomationOutcome{
					Status:    "interrupted",
					ErrorCode: "INTERRUPTED",
					Error:     "The execution result is uncertain. Inspect its conversation before retrying.",
				}
			default:
				return automationFailure("AGENT_FAILED", "The model or a tool could not finish. Open the conversation for safe request details and retry controls.")
			}
		}
	}
}
