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

func (state *AgentState) withChatImages(ctx context.Context) context.Context {
	ids := make([]string, 0, len(state.KnownAttachments)+len(state.Input.ServerAttachments))
	seen := make(map[string]bool, cap(ids))
	add := func(attachments []ChatAttachment) {
		for _, attachment := range attachments {
			if !seen[attachment.ID] && attachment.ID != "" {
				seen[attachment.ID] = true
				ids = append(ids, attachment.ID)
			}
		}
	}
	add(state.KnownAttachments)
	add(state.Input.ServerAttachments)
	return WithChatImageContext(ctx, state.OwnerID, state.ConversationID, ids)
}
