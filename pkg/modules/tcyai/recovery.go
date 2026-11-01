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

import "context"

// Only a model boundary with fully recorded tool replies is safe to retry.
// Never turn an uncertain side effect into a second execution.
func settledModelResult(r RunResult) bool {
	if (r.Stage != "model" && r.Stage != "compacting") || r.Pending != nil || r.Pause != "" || r.ErrorCode == "SAVE_FAILED" {
		return false
	}
	for _, op := range r.Operations {
		if op.Status != "succeeded" && op.Status != "failed" && op.Status != "rejected" {
			return false
		}
		if op.ErrorCode == "WRITE_UNCERTAIN" {
			return false
		}
	}
	return true
}

func completeToolHistory(messages []storedMessage) bool {
	if len(messages) == 0 {
		return false
	}
	pending := map[string]bool{}
	for _, m := range messages {
		switch m.Role {
		case "assistant":
			if len(pending) != 0 {
				return false
			}
			for _, call := range m.ToolCalls {
				if call.ID == "" || pending[call.ID] {
					return false
				}
				pending[call.ID] = true
			}
		case "tool":
			if !pending[m.ToolCallID] {
				return false
			}
			delete(pending, m.ToolCallID)
		default:
			if len(pending) != 0 {
				return false
			}
		}
	}
	return len(pending) == 0
}

func safeModelState(state *AgentState) bool {
	return state != nil && settledModelResult(state.Result) && len(state.Pending) == 0 && state.Approved == nil && completeToolHistory(state.Messages)
}

func retryableTurn(record *conversationFile, index int) bool {
	if index < 0 || index != len(record.Turns)-1 || record.Compacting {
		return false
	}
	turn := record.Turns[index]
	if turn.Status != "failed" && turn.Status != "interrupted" && (turn.Status != "stopped" || !pendingSteering(turn)) {
		return false
	}
	if !settledModelResult(turn.Result) {
		return false
	}
	if index < len(record.States) && record.States[index] != nil {
		return safeModelState(record.States[index])
	}
	// Compatibility with pre-recovery versions which discarded AgentState on model errors.
	return turn.Status == "failed" && turn.Result.Configuration != nil &&
		validAssistantOptions(*turn.Result.Configuration) && turn.Result.SystemPrompt != "" &&
		index < len(record.Contexts) && len(record.Contexts[index]) > 0 &&
		record.Contexts[index][0].Role == "user" && completeToolHistory(record.Contexts[index])
}

func retryInput(turn ChatTurn) RunInput {
	o := turn.Result.Configuration
	return RunInput{StopAtSegmentLimit: o.StopAtSegmentLimit, EnableSubagents: o.EnableSubagents, Message: turn.Prompt, RequestID: turn.RequestID, ConnectionID: o.ConnectionID,
		ProjectID: o.ProjectID, Mode: o.Mode, AllowDelete: o.AllowDelete, Approval: o.Approval,
		WriteProjectIDs: append([]int64{}, o.WriteProjectIDs...), MaxRounds: o.MaxRounds,
		MaxOperations: o.MaxOperations, TimeoutSeconds: o.TimeoutSeconds, TokenBudget: o.TokenBudget,
		SearchMode: o.SearchMode}
}

func restoreRetryState(ctx context.Context, record *conversationFile, c Connection) error {
	index := len(record.Turns) - 1
	if index < len(record.States) && record.States[index] != nil {
		return nil
	}
	turn := record.Turns[index]
	prefix := *record
	prefix.Turns = record.Turns[:index]
	prefix.Contexts = record.Contexts[:index]
	prefix.Compactions = nil
	for _, compact := range record.Compactions {
		if compact.Through <= index {
			prefix.Compactions = append(prefix.Compactions, compact)
		}
	}
	history, summary, err := conversationHistory(&prefix, c)
	if err != nil {
		return err
	}
	in := retryInput(turn)
	in.ServerHistory, in.Summary = history, summary
	state := NewAgentState(ctx, c, in)
	state.CacheStable = false
	if n := len(turn.Result.Steps); n > 0 {
		for _, name := range turn.Result.Steps[n-1].LoadedTools {
			if name == "invoke_tool" {
				state.CacheStable = true
			}
		}
	}
	// Keep the original date, page context and permission instructions for this same run.
	state.Messages[0].Content = turn.Result.SystemPrompt
	state.Messages = append(state.Messages[:state.HistoryStart], record.Contexts[index]...)
	state.Result = turn.Result
	for _, entry := range turn.Steering {
		if entry.Status == "applied" {
			state.AppliedSteering = append(state.AppliedSteering, entry)
		}
	}
	if n := len(turn.Result.Steps); n > 0 {
		state.Available = append(state.Available, turn.Result.Steps[n-1].LoadedTools...)
	}
	if !safeModelState(state) {
		return ErrAgentReview
	}
	for len(record.States) <= index {
		record.States = append(record.States, nil)
	}
	record.States[index] = state
	return nil
}
