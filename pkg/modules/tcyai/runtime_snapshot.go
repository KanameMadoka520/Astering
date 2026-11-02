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

// The engine mutates its private state outside the conversation lock. Published
// records must own a snapshot so rename/pin/export and SSE reads never marshal
// the running engine concurrently. Snapshots are replaced at safe boundaries.
func snapshotAgentState(state *AgentState) *AgentState {
	if state == nil {
		return nil
	}
	out := *state
	out.mcp = nil
	out.MCPTickets = append([]MCPToolTicket{}, state.MCPTickets...)
	out.steeringFence = false
	out.AppliedSteering = cloneSteering(state.AppliedSteering)
	out.Input.History = append([]Turn{}, state.Input.History...)
	out.Input.AttachmentIDs = append([]string{}, state.Input.AttachmentIDs...)
	out.Input.WriteProjectIDs = append([]int64{}, state.Input.WriteProjectIDs...)
	out.Input.MCPServerIDs = append([]string{}, state.Input.MCPServerIDs...)
	out.Input.ServerHistory = nil
	out.Input.ServerAttachments = append([]ChatAttachment{}, state.Input.ServerAttachments...)
	out.Messages = append([]storedMessage{}, state.Messages...)
	for i := range out.Messages {
		out.Messages[i].ToolCalls = append([]ToolCall{}, out.Messages[i].ToolCalls...)
		out.Messages[i].Attachments = append([]ChatAttachment{}, out.Messages[i].Attachments...)
	}
	out.Pending = append([]ToolCall{}, state.Pending...)
	out.Available = append([]string{}, state.Available...)
	out.KnownAttachments = append([]ChatAttachment{}, state.KnownAttachments...)
	out.QueuedAttachments = append([]ChatAttachment{}, state.QueuedAttachments...)
	out.Result = publicResult(state.Result)
	if state.Approved != nil {
		approved := *state.Approved
		approved.ProjectIDs = append([]int64{}, approved.ProjectIDs...)
		approved.External = cloneMCPOperation(approved.External)
		out.Approved = &approved
	}
	return &out
}
func cloneAutoCompactions(events []AutoCompaction) []AutoCompaction {
	result := append([]AutoCompaction{}, events...)
	for i := range result {
		result[i].Progress = cloneCompactProgress(result[i].Progress)
	}
	return result
}
func cloneModelSteps(steps []ModelStep) []ModelStep {
	result := append([]ModelStep{}, steps...)
	for i := range result {
		result[i].ToolCalls = append([]ToolCall{}, result[i].ToolCalls...)
	}
	return result
}
