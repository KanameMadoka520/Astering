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
	"errors"
	"fmt"
	"strings"
	"time"
	"unicode/utf8"

	"github.com/google/uuid"
)

// SteeringInstruction records acceptance separately from durable context delivery.
type SteeringInstruction struct {
	ID        string     `json:"id" readOnly:"true" doc:"Server-generated steering receipt ID."`
	RequestID string     `json:"request_id" readOnly:"true" doc:"Client idempotency key, unique in this conversation."`
	Message   string     `json:"message" readOnly:"true" doc:"Original additional user instruction; never replaces the original turn prompt."`
	Created   time.Time  `json:"created" readOnly:"true" doc:"UTC time the server durably accepted this instruction."`
	AppliedAt *time.Time `json:"applied_at,omitempty" readOnly:"true" doc:"UTC time this instruction was checkpointed into the run context; does not claim provider or task completion."`
	Status    string     `json:"status" enum:"pending,applied" readOnly:"true" doc:"Pending survives stop, failures and restart; applied means incorporated into durable model context."`
}

type SteeringInput struct {
	TurnID    string `json:"turn_id" format:"uuid" doc:"Exact currently running turn to receive the instruction."`
	RequestID string `json:"request_id" format:"uuid" doc:"Reuse for retries of exactly the same turn and message; changing the payload conflicts."`
	Message   string `json:"message" minLength:"1" maxLength:"64000" doc:"Additional instruction for this run, preserving its original goal and current permissions."`
}

var ErrSteeringUnavailable = errors.New("turn no longer accepts steering")
var ErrSteeringInvalid = errors.New("invalid steering instruction")
var errSteeringReplan = errors.New("steering arrived before the next intent was committed")

// AgentControl operates only at safe engine boundaries. The engine state remains
// private to its goroutine; HTTP handlers only append to the locked record queue.
type AgentControl struct {
	Boundary func(*AgentState) (bool, error)
	Complete func(*AgentState) (bool, error)
}

func cloneSteering(entries []SteeringInstruction) []SteeringInstruction {
	out := append([]SteeringInstruction{}, entries...)
	for i := range out {
		if out[i].AppliedAt != nil {
			stamp := *out[i].AppliedAt
			out[i].AppliedAt = &stamp
		}
	}
	return out
}

func pendingSteering(turn ChatTurn) bool {
	for _, entry := range turn.Steering {
		if entry.Status == "pending" {
			return true
		}
	}
	return false
}

func steeringMessage(entry SteeringInstruction) Message {
	return Message{Role: "user", Content: "Additional instruction for the task already in progress (receipt " + entry.ID + "). Continue the original goal and incorporate this instruction in order. Replace or cancel the goal only if the user explicitly asks. Current system permissions, model and run budgets remain unchanged. Replan any not-yet-executed operations as needed.\n\n" + entry.Message}
}

// SteerConversation acknowledges only after the encrypted queue is written.
func SteerConversation(uid int64, id string, in SteeringInput) (Conversation, error) {
	if _, err := uuid.Parse(in.TurnID); err != nil {
		return Conversation{}, ErrSteeringInvalid
	}
	if _, err := uuid.Parse(in.RequestID); err != nil {
		return Conversation{}, ErrSteeringInvalid
	}
	if strings.TrimSpace(in.Message) == "" || !utf8.ValidString(in.Message) || utf8.RuneCountInString(in.Message) > 64000 {
		return Conversation{}, ErrSteeringInvalid
	}
	conversations.Lock()
	defer conversations.Unlock()
	record, err := getConversationLocked(uid, id)
	if err != nil {
		return Conversation{}, err
	}
	for _, turn := range record.Turns {
		for _, entry := range turn.Steering {
			if entry.RequestID != in.RequestID {
				continue
			}
			if turn.ID != in.TurnID || entry.Message != in.Message {
				return Conversation{}, ErrConversationRequest
			}
			return cloneConversation(record), nil
		}
	}
	index := len(record.Turns) - 1
	live := conversations.live[liveKey(uid, id)]
	if index < 0 || record.Turns[index].ID != in.TurnID || record.Turns[index].Status != "running" || live == nil || live.id != id || live.compacting || !live.acceptingSteering || live.cancel == nil {
		return Conversation{}, ErrSteeringUnavailable
	}
	now := time.Now().UTC()
	old := record.Turns[index].Steering
	updated := record.Updated
	record.Turns[index].Steering = append(cloneSteering(old), SteeringInstruction{ID: uuid.NewString(), RequestID: in.RequestID, Message: in.Message, Created: now, Status: "pending"})
	record.Updated = now
	if err := writeConversation(uid, record); err != nil {
		record.Turns[index].Steering = old
		record.Updated = updated
		return Conversation{}, err
	}
	return cloneConversation(record), nil
}

// applySteeringLocked commits context, status and delivery cursor in one file.
// On any write failure the caller's private state and published record stay intact.
func applySteeringLocked(uid int64, record *conversationFile, index int, state *AgentState) (bool, error) {
	if !pendingSteering(record.Turns[index]) {
		return false, nil
	}
	candidate := snapshotAgentState(state)
	for _, call := range candidate.Pending {
		resolved, _ := resolveInvocation(call)
		op := Operation{ID: uuid.NewString(), Tool: resolved.Function.Name, Arguments: resolved.Function.Arguments, Status: "rejected", ErrorCode: "STEERING_REPLAN", ProjectIDs: []int64{}}
		candidate.Result.Operations = append(candidate.Result.Operations, op)
		candidate.Result.Actions = append(candidate.Result.Actions, Action{ResultRef: op.ID, Tool: op.Tool, Arguments: op.Arguments, Round: candidate.Result.Budget.Rounds, Result: `{"success":false,"code":"STEERING_REPLAN","executed":false}`, Success: false})
		candidate.appendMessage(Message{Role: "tool", ToolCallID: call.ID, Content: `{"success":false,"code":"STEERING_REPLAN","executed":false,"message":"Not executed: a new user instruction superseded this pending plan. Re-evaluate the remaining work."}`})
	}
	candidate.Pending = nil
	candidate.Approved = nil
	candidate.Result.Pending = nil
	candidate.Result.Pause = ""
	candidate.Result.Question = ""
	candidate.Result.Choices = nil
	candidate.Result.Reply = ""
	candidate.Result.Stage = "model"
	entries := cloneSteering(record.Turns[index].Steering)
	now := time.Now().UTC()
	for i := range entries {
		if entries[i].Status != "pending" {
			continue
		}
		entries[i].Status = "applied"
		entries[i].AppliedAt = &now
		candidate.appendMessage(steeringMessage(entries[i]))
		candidate.AppliedSteering = append(candidate.AppliedSteering, entries[i])
	}
	oldTurn, oldState, oldUpdated := record.Turns[index], record.States[index], record.Updated
	record.Turns[index].Steering = entries
	record.Turns[index].Result = publicResult(candidate.Result)
	record.States[index] = snapshotAgentState(candidate)
	record.Updated = now
	if err := writeConversation(uid, record); err != nil {
		record.Turns[index], record.States[index], record.Updated = oldTurn, oldState, oldUpdated
		return false, err
	}
	*state = *candidate
	return true, nil
}

func conversationControl(uid int64, live *liveConversation, index int) AgentControl {
	boundary := func(state *AgentState, finish bool) (bool, error) {
		conversations.Lock()
		defer conversations.Unlock()
		if !currentLiveAccountLocked(uid, live) {
			return false, ErrAccountDeleted
		}
		if !live.acceptingSteering {
			// Stop wins even when an already completed HTTP response reaches its
			// terminal callback late. Keep accepted instructions pending for retry.
			preserveStoppedSteering(state, live.record.Turns[index])
			return false, context.Canceled
		}
		changed, err := applySteeringLocked(uid, live.record, index, state)
		if err == nil && !changed && finish {
			// Acceptance and completion share this lock: no accepted instruction can
			// slip between the last model answer and the asynchronous finalizer.
			live.acceptingSteering = false
		}
		return changed, err
	}
	return AgentControl{
		Boundary: func(state *AgentState) (bool, error) { return boundary(state, false) },
		Complete: func(state *AgentState) (bool, error) { return boundary(state, true) },
	}
}

func pendingSteeringSummary(turn ChatTurn) string {
	var b strings.Builder
	for _, entry := range turn.Steering {
		if entry.Status == "pending" {
			fmt.Fprintf(&b, "\nAccepted additional user instruction, still pending when this run ended (%s):\n%s\n", entry.ID, entry.Message)
		}
	}
	return b.String()
}

func steeringIntentBoundary(state *AgentState) bool { return state.steeringFence }

func (state *AgentState) persistIntent(persist func() error) error {
	state.steeringFence = true
	defer func() { state.steeringFence = false }()
	return persist()
}

func steeringSearchText(entries []SteeringInstruction) string {
	var b strings.Builder
	for _, entry := range entries {
		b.WriteByte('\n')
		b.WriteString(entry.Message)
	}
	return b.String()
}

func (control AgentControl) settle(state *AgentState) (bool, error) {
	if control.Complete == nil {
		return false, nil
	}
	return control.Complete(state)
}

// Check the queue under the same lock as durable intent publication. Once this
// succeeds, the current operation is in flight; later instructions govern the
// next boundary, never silently cancel a side effect with an uncertain outcome.
func checkpointConversation(uid int64, live *liveConversation, index int, state *AgentState) error {
	snapshot := publicResult(state.Result)
	var checkpoint *AgentState
	if !state.Streaming {
		checkpoint = snapshotAgentState(state)
	}
	conversations.Lock()
	defer conversations.Unlock()
	if !currentLiveAccountLocked(uid, live) {
		return ErrAccountDeleted
	}
	record := live.record
	if !state.Streaming && pendingSteering(record.Turns[index]) && steeringIntentBoundary(state) {
		return errSteeringReplan
	}
	record.Turns[index].Result = snapshot
	if state.Streaming {
		return nil
	}
	record.States[index] = checkpoint
	return writeConversation(uid, record)
}

func (state *AgentState) persistModelIntent(persist func() error) error {
	state.Result.Stage = "model"
	state.Result.Budget.Rounds++
	err := state.persistIntent(persist)
	if errors.Is(err, errSteeringReplan) {
		// No HTTP request was issued, so this attempt consumes no model round.
		state.Result.Budget.Rounds--
	}
	return err
}

func preserveStoppedSteering(state *AgentState, turn ChatTurn) {
	if !pendingSteering(turn) || len(state.Pending) != 0 || state.Approved != nil || !completeToolHistory(state.Messages) {
		return
	}
	settled := state.Result
	settled.Stage = "model"
	if !settledModelResult(settled) {
		return
	}
	// Only confirmed receipts can become a retryable model boundary. Retain the
	// old answer in messages/steps, but do not present it as the redirected result.
	state.Result.Stage = "model"
	state.Result.Reply = ""
}
