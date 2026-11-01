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

//nolint:gosmopolitan // Bilingual tool contracts are intentional.
package tcyai

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"slices"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/modules/tcylocale"
	"github.com/google/uuid"
)

type Operation struct {
	ID         string  `json:"id" doc:"Server-generated receipt identifier."`
	Tool       string  `json:"tool" doc:"Tool name."`
	Arguments  string  `json:"arguments" doc:"Validated arguments, including any user edits."`
	Status     string  `json:"status" enum:"prepared,running,succeeded,failed,rejected,unknown" doc:"running after a restart means the outcome is unknown, never safe to replay."`
	Before     string  `json:"before,omitempty" doc:"Actual pre-operation snapshot as JSON."`
	After      string  `json:"after,omitempty" doc:"Proposed changes as JSON, not a claim of execution."`
	ProjectIDs []int64 `json:"project_ids" doc:"Projects affected by this operation."`
	Version    string  `json:"version,omitempty" doc:"Fingerprint used to detect changes after review."`
	Units      int     `json:"units" doc:"Operation units; bulk writes count each target."`
	Verified   bool    `json:"verified" doc:"The executor verified the committed task field changes."`
	Approved   bool    `json:"approved" doc:"This exact proposal was reviewed by the user."`
	ErrorCode  string  `json:"error_code,omitempty" doc:"Stable failure code."`
}

type RunBudget struct {
	RoundLimit     int   `json:"round_limit" doc:"Granted model rounds, including explicit continuations."`
	OperationLimit int   `json:"operation_limit" doc:"Granted operation units."`
	Rounds         int   `json:"rounds" doc:"Model requests attempted."`
	Operations     int   `json:"operations" doc:"Operation units attempted."`
	TokenLimit     int64 `json:"token_limit" doc:"Soft reported-token limit; zero disables."`
	TimeoutSeconds int   `json:"timeout_seconds" doc:"Active time allowed per segment, excluding review waits."`
}

type Preparer func(context.Context, string, json.RawMessage) (Operation, error)

type AgentState struct {
	steeringFence     bool
	AppliedSteering   []SteeringInstruction `json:"applied_steering,omitempty"`
	KnownAttachments  []ChatAttachment      `json:"known_attachments,omitempty"`
	QueuedAttachments []ChatAttachment      `json:"queued_attachments,omitempty"`
	Rebased           bool                  `json:"rebased,omitempty"`
	LastInputTokens   int64                 `json:"last_input_tokens,omitempty"`
	LastInputEstimate int64                 `json:"last_input_estimate,omitempty"`
	SegmentStarted    time.Time             `json:"segment_started,omitempty"`
	OwnerID           int64                 `json:"owner_id,omitempty"`
	ConversationID    string                `json:"conversation_id,omitempty"`
	SearchEnabled     bool                  `json:"-"`
	CacheStable       bool                  `json:"cache_stable,omitempty"`

	HistoryStart int             `json:"history_start"`
	Streaming    bool            `json:"-"`
	Input        RunInput        `json:"input"`
	Messages     []storedMessage `json:"messages"`
	Pending      []ToolCall      `json:"pending"`
	Available    []string        `json:"available"`
	Result       RunResult       `json:"result"`
	Approved     *Operation      `json:"approved,omitempty"`
}

var ErrAgentPaused = errors.New("agent paused")
var ErrAgentReview = errors.New("review does not match the current pending operation")

type ToolError struct {
	Code      string
	Message   string
	Uncertain bool
}

func (e *ToolError) Error() string           { return e.Code + ": " + e.Message }
func ToolFailure(code, message string) error { return &ToolError{Code: code, Message: message} }
func failureCode(err error) string {
	var localized *tcylocale.LocalizedError
	if errors.As(err, &localized) && localized.Key == "tcymc.errors.chatUpstream" && len(localized.Args) > 0 {
		return fmt.Sprintf("MODEL_HTTP_%v", localized.Args[0])
	}
	if errors.As(err, &localized) && localized.Key == "tcymc.errors.chatOutputLimit" {
		return "MODEL_OUTPUT_LIMIT"
	}
	var toolErr *ToolError
	if errors.As(err, &toolErr) {
		return toolErr.Code
	}
	if errors.Is(err, context.Canceled) {
		return "CANCELED"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		return "TIMEOUT"
	}
	if s, _, ok := strings.Cut(err.Error(), ":"); ok && len(s) < 35 && strings.ToUpper(s) == s {
		return s
	}
	return "EXECUTION_FAILED"
}

// ExplainError adds a localized explanation while retaining the exact technical detail for debugging and model recovery.
func ExplainError(ctx context.Context, err error) string {
	var streamError *ProviderStreamError
	if errors.As(err, &streamError) {
		return tcylocale.Render(ctx, tcylocale.Error("chatStreamProvider", streamError.Type, streamError.Message, streamError.RequestID))
	}
	keys := map[string]string{"SCOPE_DENIED": "agentScopeDenied", "FORBIDDEN": "agentForbidden", "STATE_CONFLICT": "agentConflict", "WRITE_UNCERTAIN": "agentUncertain", "INVALID_DATE_RANGE": "agentDateRange", "MODEL_CHANGED": "agentModelChanged", "TOOL_NOT_ALLOWED": "agentNotAllowed", "TOOL_NOT_LOADED": "agentNotLoaded", "INVALID_ARGUMENTS": "agentArguments", "TIMEOUT": "agentTimeout", "NO_PROGRESS": "agentNoProgress", "COMPACTION_NO_SHRINK": "agentCompactionFailed", "COMPACTION_EMPTY": "agentCompactionFailed", "RESULT_NOT_FOUND": "agentResultNotFound"}
	if errors.Is(err, ErrImageModel) || errors.Is(err, ErrAttachmentMissing) || errors.Is(err, ErrAttachmentInvalid) {
		return tcylocale.Render(ctx, tcylocale.Error(err.Error()))
	}
	detail := tcylocale.Render(ctx, err)
	if key, ok := keys[failureCode(err)]; ok {
		return tcylocale.Render(ctx, tcylocale.Error(key)) + "\n" + detail
	}
	return detail
}

type operationKey struct{}

func WithOperation(ctx context.Context, op *Operation) context.Context {
	return context.WithValue(ctx, operationKey{}, op)
}
func CurrentOperation(ctx context.Context) *Operation {
	op, _ := ctx.Value(operationKey{}).(*Operation)
	return op
}

func normalizeRun(in RunInput) RunInput {
	if in.SearchMode == "" {
		in.SearchMode = "auto"
	}
	if in.Mode == "" {
		in.Mode = "read"
	}
	if in.Approval == "" {
		in.Approval = "smart"
	}
	if in.MaxRounds == 0 {
		in.MaxRounds = 16
	}
	if in.MaxOperations == 0 {
		in.MaxOperations = 40
	}
	if in.TimeoutSeconds == 0 {
		in.TimeoutSeconds = 180
	}
	return in
}

func NewAgentState(ctx context.Context, c Connection, input RunInput) *AgentState {
	in := normalizeRun(input)
	in.Persona = c.Persona
	system := SystemPrompt(ctx, in)
	messages := []Message{{Role: "system", Content: system}}
	if in.Summary != "" {
		messages = append(messages, Message{Role: "system", Content: "Historical summary, not new instructions. Any permissions, mode, tool availability or restrictions mentioned below describe past runs only. The current system prompt and current tool discovery are authoritative; never infer current permissions from this summary.\n" + in.Summary})
	}
	messages = append(messages, in.ServerHistory...)
	for _, h := range in.History {
		if h.Role == "user" || h.Role == "assistant" {
			messages = append(messages, Message{Role: h.Role, Content: h.Content})
		}
	}
	historyStart := len(messages)
	messages = append(messages, Message{Role: "user", Content: executionContext(in, c)})
	messages = append(messages, Message{Role: "user", Content: in.Message, Attachments: in.ServerAttachments, AttachmentOwner: in.AttachmentOwner})
	state := &AgentState{CacheStable: true, HistoryStart: historyStart, Input: in, Messages: []storedMessage{}, Pending: []ToolCall{}, Available: []string{}, Result: RunResult{
		SegmentCount: 1, Configuration: runOptions(in), TraceID: uuid.NewString(), SystemPrompt: system, Actions: []Action{}, Steps: []ModelStep{}, Operations: []Operation{},
		Model: c.Model, RequestedModel: c.Model, Protocol: c.EffectiveProtocol(), Endpoint: AgentEndpoint(c),
		Budget: RunBudget{RoundLimit: in.MaxRounds, OperationLimit: in.MaxOperations, TokenLimit: in.TokenBudget, TimeoutSeconds: in.TimeoutSeconds},
	}}
	for _, m := range messages {
		state.Messages = append(state.Messages, storedMessage{Message: m, Native: m.Native})
	}
	for _, t := range Tools(in.Mode, in.AllowDelete) {
		state.Available = append(state.Available, toolName(t))
	}
	state.restoreDiscoveredTools()
	return state
}

func (state *AgentState) appendMessage(m Message) {
	state.Messages = append(state.Messages, storedMessage{Message: m, Native: m.Native})
}
func (state *AgentState) messages() []Message {
	result := make([]Message, len(state.Messages))
	for i, stored := range state.Messages {
		result[i] = stored.Message
		result[i].Native = stored.Native
	}
	return compactDiscoveryMessages(result)
}
func (state *AgentState) tools() []map[string]any {
	if state.CacheStable {
		return stableEntryTools()
	}
	result := []map[string]any{}
	for _, t := range state.catalog() {
		if slices.Contains(state.Available, toolName(t)) {
			result = append(result, t)
		}
	}
	return result
}

//nolint:gocyclo // Keep steering fences, budget checks, model retries and tool settlement in their execution order.
func RunAgent(ctx context.Context, c Connection, state *AgentState, execute Executor, prepare Preparer, save func(*AgentState) error, controls ...AgentControl) (result RunResult, runErr error) {
	ctx, releaseClient := withProviderClient(ctx)
	defer releaseClient()
	startActions := len(state.Result.Actions)
	control := AgentControl{}
	if len(controls) > 0 {
		control = controls[0]
	}
	boundary := func() (bool, error) {
		if control.Boundary != nil {
			changed, err := control.Boundary(state)
			if changed {
				startActions = len(state.Result.Actions)
			}
			return changed, err
		}
		return false, nil
	}
	settle := func() (bool, error) {
		changed, err := control.settle(state)
		if changed {
			startActions = len(state.Result.Actions)
		}
		return changed, err
	}
	started := time.Now()
	state.SegmentStarted = started
	state.SearchEnabled = c.WebSearchProtocol != "" && state.Input.SearchMode != "off"
	state.Available = slices.DeleteFunc(state.Available, func(name string) bool { return name == "web_search" })
	if state.SearchEnabled {
		state.Available = append(state.Available, "web_search")
	}
	if save == nil {
		save = func(*AgentState) error { return nil }
	}
	baseDuration := state.Result.DurationMS
	state.Result.Pause = ""
	state.Result.Error = ""
	state.Result.ErrorCode = ""
	persist := func() error {
		state.Result.DurationMS = baseDuration + time.Since(started).Milliseconds()
		return save(state)
	}
	defer func() {
		state.Result.DurationMS = baseDuration + time.Since(started).Milliseconds()
		state.Result.Context = state.messages()[state.HistoryStart:]
		if runErr != nil && !errors.Is(runErr, ErrAgentPaused) {
			state.Result.Error = ExplainError(ctx, runErr)
			state.Result.ErrorCode = failureCode(runErr)
		}
		result = state.Result
	}()
	if state.Input.SearchMode == "required" && !state.SearchEnabled {
		return state.Result, tcylocale.Error("searchRequiredUnavailable")
	}
	overflowRetried := false
	for {
		if err := ctx.Err(); err != nil {
			return state.Result, err
		}
		if err := requireActiveAccount(state.OwnerID); err != nil {
			return state.Result, err
		}
		if _, err := boundary(); err != nil {
			return state.Result, err
		}
		if len(state.Pending) == 0 {
			if (state.Input.StopAtSegmentLimit && state.Result.Budget.Rounds >= state.Result.Budget.RoundLimit) ||
				(state.Result.Budget.TokenLimit > 0 && state.Result.Usage.Input+state.Result.Usage.Output >= state.Result.Budget.TokenLimit) {
				state.Result.Stage = "budget"
				state.Result.Pause = "budget"
				changed, err := settle()
				if err != nil {
					return state.Result, err
				}
				if changed {
					continue
				}
				return state.Result, ErrAgentPaused
			}
			if repeatedActions(state.Result.Actions[startActions:]) {
				state.Result.Stage = "model"
				return state.Result, ToolFailure("NO_PROGRESS", "Eight identical tool operations returned the same result. Execution stopped; review the trace before retrying.")
			}
			if err := state.autoCompact(ctx, c, persist, false); err != nil {
				return state.Result, err
			}
			if _, err := boundary(); err != nil {
				return state.Result, err
			}
			state.deliverQueuedAttachments()
			done, err := state.modelRound(ctx, c, started, baseDuration, persist)
			if err != nil && contextOverflow(err) && !overflowRetried && !c.DisableAutoCompact {
				overflowRetried = true
				checkpointsBefore := len(state.Result.AutoCompactions)
				if compactErr := state.autoCompact(ctx, c, persist, true); compactErr != nil {
					return state.Result, compactErr
				}
				if len(state.Result.AutoCompactions) == checkpointsBefore {
					return state.Result, err
				}
				continue
			}
			if errors.Is(err, errSteeringReplan) {
				continue
			}
			if errors.Is(err, ErrAgentPaused) {
				changed, settleErr := settle()
				if settleErr != nil {
					return state.Result, settleErr
				}
				if changed {
					continue
				}
			}
			if err != nil {
				return state.Result, err
			}
			if done {
				if control.Complete != nil {
					changed, controlErr := settle()
					if controlErr != nil {
						return state.Result, controlErr
					}
					if changed {
						continue
					}
				}
				return state.Result, nil
			}
			overflowRetried = false
		}
		// The model may have planned a batch before new instructions arrived.
		if changed, err := boundary(); err != nil {
			return state.Result, err
		} else if changed {
			continue
		}
		if err := state.toolStep(ctx, c, execute, prepare, persist, boundary); err != nil {
			if errors.Is(err, errSteeringReplan) {
				continue
			}
			if errors.Is(err, ErrAgentPaused) {
				changed, settleErr := settle()
				if settleErr != nil {
					return state.Result, settleErr
				}
				if changed {
					continue
				}
			}
			return state.Result, err
		}
	}
}

func (state *AgentState) modelRound(ctx context.Context, c Connection, started time.Time, baseDuration int64, persist func() error) (bool, error) {
	var streamErr error
	b := &state.Result.Budget
	if b.TokenLimit > 0 && state.Result.Usage.Input+state.Result.Usage.Output >= b.TokenLimit {
		state.Result.Stage = "budget"
		state.Result.Pause = "budget"
		return false, ErrAgentPaused
	}
	if b.Rounds >= b.RoundLimit || (!state.SegmentStarted.IsZero() && time.Since(state.SegmentStarted) >= time.Duration(state.Input.TimeoutSeconds)*time.Second) {
		if err := state.nextSegment(persist); err != nil {
			return false, err
		}
	}
	if state.SegmentStarted.IsZero() {
		state.SegmentStarted = time.Now()
	}
	// Checkpoint before streaming; a correction queued before intent must win.
	if err := state.persistModelIntent(persist); err != nil {
		return false, err
	}
	observed, o := withObservation(ctx, b.Rounds, c.Model, func(step ModelStep) {
		live := state.Result
		state.Result.DurationMS = baseDuration + time.Since(started).Milliseconds()
		state.Result.Steps = append(append([]ModelStep{}, live.Steps...), step)
		state.Streaming = true
		if err := persist(); err != nil {
			streamErr = err
		}
		state.Streaming = false
		state.Result.Steps = live.Steps
	})
	state.trimTools()
	loaded := state.tools()
	mustSearch := state.Input.SearchMode == "required" && !slices.ContainsFunc(state.Result.Actions, func(action Action) bool { return action.Tool == "web_search" })
	if mustSearch && !state.CacheStable {
		loaded = slices.DeleteFunc(loaded, func(t map[string]any) bool { return toolName(t) != "web_search" })
	}
	catalog := state.catalog()
	loadedJSON, marshalErr := json.Marshal(loaded)
	if marshalErr != nil {
		return false, marshalErr
	}
	catalogJSON, marshalErr := json.Marshal(catalog)
	if marshalErr != nil {
		return false, marshalErr
	}
	o.step.ToolSchemaBytes = len(loadedJSON)
	o.step.CatalogSchemaBytes = len(catalogJSON)
	o.step.CatalogToolCount = len(catalog)
	for _, tool := range loaded {
		o.step.LoadedTools = append(o.step.LoadedTools, toolName(tool))
	}
	messages := state.modelMessages(mustSearch)

	inputEstimate := estimateMessages(messages)
	message, err := Chat(observed, c, messages, loaded)
	o.step.DurationMS = time.Since(o.start).Milliseconds()
	state.Result.Steps = append(state.Result.Steps, o.step)
	state.Result.Usage.Add(o.step.Usage)
	if o.step.Usage.Input > 0 {
		state.LastInputTokens = o.step.Usage.Input
		state.LastInputEstimate = inputEstimate
	}
	state.updateContextStatus(c)
	if o.step.Model != "" {
		state.Result.Model = o.step.Model
	}
	if state.Result.FirstTokenMS == nil && o.step.FirstTokenMS != nil {
		value := baseDuration + o.start.Sub(started).Milliseconds() + *o.step.FirstTokenMS
		state.Result.FirstTokenMS = &value
	}
	if state.Result.FirstTextMS == nil && o.step.FirstTextMS != nil {
		value := baseDuration + o.start.Sub(started).Milliseconds() + *o.step.FirstTextMS
		state.Result.FirstTextMS = &value
	}
	if err != nil {
		if ctx.Err() != nil {
			err = ctx.Err()
		}
		return false, err
	}
	if streamErr != nil {
		return false, streamErr
	}
	state.QueuedAttachments = nil // The provider successfully consumed this evidence; future compaction may omit its pixels.
	message.Role = "assistant"
	state.appendMessage(message)
	state.Pending = message.ToolCalls
	if mustSearch && (len(state.Pending) == 0 || slices.ContainsFunc(state.Pending, func(call ToolCall) bool { return call.Function.Name != "web_search" })) {
		return false, tcylocale.Error("searchUnverified")
	}
	if len(state.Pending) == 0 {
		state.Result.Reply = message.Content
		state.Result.Stage = "completed"
		return true, nil
	}
	state.Result.Stage = "validation"
	if err := persist(); err != nil {
		return false, err
	}
	return false, nil
}

//nolint:gocyclo // Keep validation, review, durable intent, execution and settlement in one ordered transition.
func (state *AgentState) toolStep(ctx context.Context, c Connection, execute Executor, prepare Preparer, persist func() error, controls ...func() (bool, error)) error {
	call, decodeErr := resolveInvocation(state.Pending[0])
	name := call.Function.Name
	state.Result.Stage = "validation"
	raw, toolErr := ValidateTool(name, json.RawMessage(call.Function.Arguments), state.Input)
	if decodeErr != nil {
		toolErr = decodeErr
	}
	if toolErr == nil && !slices.Contains(state.Available, name) {
		toolErr = ToolFailure("TOOL_NOT_LOADED", "Use find_tools to discover and load this tool first.")
	}
	if toolErr != nil {
		raw = json.RawMessage(call.Function.Arguments)
	}
	op := Operation{ID: uuid.NewString(), Tool: name, Arguments: string(raw), Status: "prepared", Units: 1, ProjectIDs: []int64{}}
	if state.Approved != nil {
		op = *state.Approved
		raw, toolErr = ValidateTool(name, json.RawMessage(op.Arguments), state.Input)
		state.Approved = nil
	}
	if toolErr == nil {
		op, toolErr = state.prepareOperation(ctx, prepare, name, raw, op)
	}
	if len(controls) > 0 {
		changed, err := controls[0]()
		if err != nil {
			return err
		}
		if changed {
			return errSteeringReplan
		}
	}
	if op.Units < 1 {
		op.Units = 1
	}
	if state.Result.Budget.Operations+op.Units > state.Result.Budget.OperationLimit {
		if op.Approved && state.Input.StopAtSegmentLimit {
			state.Approved = &op
		}
		if err := state.nextSegment(persist); err != nil {
			return err
		}
		state.Result.Budget.OperationLimit = max(state.Result.Budget.OperationLimit, state.Result.Budget.Operations+op.Units)
	}
	if toolErr == nil && NeedsReview(name, state.Input) && !op.Approved {
		state.Result.Pending = &op
		state.Result.Pause = "review"
		state.Result.Stage = "review"
		return ErrAgentPaused
	}
	if toolErr == nil && name == "ask_user" {
		var question struct {
			Question string   `json:"question"`
			Choices  []string `json:"choices"`
		}
		_ = json.Unmarshal(raw, &question)
		state.Result.Question = question.Question
		state.Result.Choices = question.Choices
		state.Result.Pause = "question"
		state.Result.Stage = "review"
		return ErrAgentPaused
	}
	state.Result.Pending = nil
	state.Result.Budget.Operations += op.Units
	op.Status = "running"
	state.Result.Operations = append(state.Result.Operations, op)
	operationIndex := len(state.Result.Operations) - 1
	state.Result.Stage = "execute"
	// Persist intent before a side effect. A crash here leaves an uncertain receipt, never an automatic retry.
	if err := state.persistIntent(persist); err != nil {
		if errors.Is(err, errSteeringReplan) {
			state.Result.Operations = state.Result.Operations[:operationIndex]
			state.Result.Budget.Operations -= op.Units
			state.Result.Stage = "validation"
		}
		return err
	}
	toolStarted := time.Now()
	data := ""
	var search *WebSearchResult
	if toolErr == nil {
		data, search, toolErr = state.executeAgentTool(ctx, c, execute, &op, name, raw, persist)
	}

	op.Status = "succeeded"
	if toolErr != nil {
		op.Status = "failed"
		op.ErrorCode = failureCode(toolErr)
		var uncertain *ToolError
		if errors.As(toolErr, &uncertain) && uncertain.Uncertain {
			op.Status = "unknown"
		}
		payload, encodeErr := json.Marshal(map[string]any{"success": false, "code": op.ErrorCode, "message": ExplainError(ctx, toolErr), "retryable": op.Status != "unknown" && op.ErrorCode != "FORBIDDEN" && op.ErrorCode != "SCOPE_DENIED"})
		if encodeErr != nil {
			return encodeErr
		}
		data = string(payload)
	}
	state.Result.Operations[operationIndex] = op
	state.Result.Actions = append(state.Result.Actions, Action{ResultRef: op.ID, Search: search, Round: state.Result.Budget.Rounds, Tool: name, Arguments: string(raw), Result: data, Success: toolErr == nil, DurationMS: time.Since(toolStarted).Milliseconds()})
	toolContent := data
	if state.CacheStable && toolErr == nil {
		toolContent = modelToolResult(name, raw, data, op.ID)
	}
	if op.Approved && op.Arguments != call.Function.Arguments {
		toolContent = "Human-reviewed arguments (use these instead of the original proposal): " + op.Arguments + "\nActual result: " + toolContent
	}
	state.appendMessage(Message{Role: "tool", Content: toolContent, ToolCallID: call.ID})
	state.Pending = state.Pending[1:]
	// A confirmed final receipt is a safe model boundary even if Stop arrived
	// while the atomic operation was running. Unknown outcomes remain unsafe.
	if len(state.Pending) == 0 && state.Approved == nil && completeToolHistory(state.Messages) {
		settled := state.Result
		settled.Stage = "model"
		if settledModelResult(settled) {
			state.Result.Stage = "model"
		}
	}

	if err := persist(); err != nil {
		return err
	}
	if op.Status == "unknown" {
		return ToolFailure("WRITE_UNCERTAIN", "The write outcome is uncertain. Check actual records before starting any new write; this operation will not be replayed.")
	}
	return nil
}

func (state *AgentState) prepareOperation(ctx context.Context, prepare Preparer, name string, raw json.RawMessage, op Operation) (Operation, error) {
	if prepare == nil || !IsWriteTool(name) {
		return op, nil
	}
	state.Result.Stage = "prepare"
	preview, err := prepare(ctx, name, raw)
	if err != nil {
		return op, err
	}
	if op.Approved && (preview.Version != op.Version || preview.Before != op.Before) {
		op.Approved = false
		op.ID = uuid.NewString()
	}
	preview.ID = op.ID
	preview.Tool = name
	preview.Arguments = string(raw)
	preview.Status = "prepared"
	preview.Approved = op.Approved
	return preview, nil
}

type ReviewInput struct {
	TurnID      string `json:"turn_id" format:"uuid" doc:"Turn currently paused."`
	OperationID string `json:"operation_id" doc:"Exact pending receipt ID for review/edit/reject."`
	Decision    string `json:"decision" enum:"approve,reject,edit,answer,continue,retry" doc:"Edit regenerates a preview without execution. Continue grants another bounded execution segment."`
	Arguments   string `json:"arguments" maxLength:"64000" doc:"JSON arguments for edit only."`
	Answer      string `json:"answer" maxLength:"12000" doc:"Human clarification or rejection explanation."`
}

func ReviewAgent(ctx context.Context, state *AgentState, in ReviewInput, prepare Preparer) error {
	r := &state.Result
	switch in.Decision {
	case "retry":
		if !safeModelState(state) {
			return ErrAgentReview
		}
		// A failed attempt consumed its round; allow one replacement, not a fresh operation budget.
		if r.Budget.Rounds >= r.Budget.RoundLimit {
			r.Budget.RoundLimit = r.Budget.Rounds + 1
		}
	case "continue":
		if r.Pause != "budget" {
			return ErrAgentReview
		}
		r.Budget.RoundLimit += state.Input.MaxRounds
		r.SegmentCount = max(1, r.SegmentCount) + 1
		r.Budget.OperationLimit += state.Input.MaxOperations
		if r.Budget.TokenLimit > 0 {
			r.Budget.TokenLimit += state.Input.TokenBudget
		}
	case "answer":
		if r.Pause != "question" || strings.TrimSpace(in.Answer) == "" || len(state.Pending) == 0 {
			return ErrAgentReview
		}
		state.appendMessage(Message{Role: "tool", ToolCallID: state.Pending[0].ID, Content: in.Answer})
		state.Pending = state.Pending[1:]
		r.Question = ""
		r.Choices = nil
	case "approve", "reject", "edit":
		if r.Pause != "review" || r.Pending == nil || in.OperationID != r.Pending.ID || len(state.Pending) == 0 {
			return ErrAgentReview
		}
		proposal := *r.Pending
		switch in.Decision {
		case "reject":
			proposal.Status = "rejected"
			r.Operations = append(r.Operations, proposal)
			state.appendMessage(Message{Role: "tool", ToolCallID: state.Pending[0].ID, Content: "USER_REJECTED: The human declined this exact operation. Do not retry or bypass the rejection. " + in.Answer})
			state.Pending = state.Pending[1:]
		case "edit":
			raw, err := ValidateTool(proposal.Tool, json.RawMessage(in.Arguments), state.Input)
			if err != nil {
				return err
			}
			if prepare == nil {
				return ErrAgentReview
			}
			updated, err := prepare(ctx, proposal.Tool, raw)
			if err != nil {
				return err
			}
			updated.ID = uuid.NewString()
			updated.Tool = proposal.Tool
			updated.Arguments = string(raw)
			updated.Status = "prepared"
			if state.Pending[0].Function.Name == "invoke_tool" {
				envelope, err := json.Marshal(map[string]any{"name": proposal.Tool, "arguments": raw})
				if err != nil {
					return err
				}
				state.Pending[0].Function.Arguments = string(envelope)
			} else {
				state.Pending[0].Function.Arguments = string(raw)
			}
			r.Pending = &updated
			return nil
		default:
			proposal.Approved = true
			state.Approved = &proposal
		}
		r.Pending = nil
	default:
		return ErrAgentReview
	}
	r.Pause = ""
	r.Error = ""
	r.ErrorCode = ""
	return nil
}

func (state *AgentState) catalog() []map[string]any {
	all := AllTools(state.Input.Mode, state.Input.AllowDelete)
	if !state.Input.EnableSubagents {
		all = slices.DeleteFunc(all, func(t map[string]any) bool { return toolName(t) == "delegate_tasks" })
	}
	if !state.SearchEnabled {
		all = slices.DeleteFunc(all, func(t map[string]any) bool { return toolName(t) == "web_search" })
	}
	return all
}

func (state *AgentState) executeAgentTool(ctx context.Context, c Connection, execute Executor, op *Operation, name string, raw json.RawMessage, persist func() error) (string, *WebSearchResult, error) {
	switch name {
	case "delegate_tasks":
		data, err := state.delegateTasks(ctx, c, raw, execute, persist)
		return data, nil, err
	case "web_search":
		if !state.SearchEnabled {
			return "", nil, tcylocale.Error("searchDisabled")
		}
		var args struct {
			Query string `json:"query"`
		}
		_ = json.Unmarshal(raw, &args)
		search, err := SearchWeb(ctx, c, args.Query)
		if search.Step != nil {
			state.Result.Usage.Add(search.Step.Usage)
		}
		if err == nil && !search.Verified {
			err = tcylocale.Error("searchUnverified")
		}
		if err != nil {
			return "", &search, err
		}
		encoded, err := json.Marshal(map[string]any{"verified": search.Verified, "query": search.Query, "summary": search.Summary, "sources": search.Sources})
		return string(encoded), &search, err
	case "view_attachment":
		data, err := state.viewAttachment(c, raw)
		return data, nil, err
	case "read_tool_result":
		data, err := state.readToolResult(raw)
		return data, nil, err
	case "find_tools":
		data, err := state.discover(raw)
		return data, nil, err
	default:
		data, err := execute(WithOperation(ctx, op), name, raw)
		return data, nil, err
	}
}
