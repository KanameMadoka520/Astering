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
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/instanceusage"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/danielgtaylor/huma/v2"
)

func init() { AddRouteRegistrar(RegisterTCYAIReadRoutes) }

func RegisterTCYAIReadRoutes(api huma.API) {
	Register(api, huma.Operation{
		OperationID:     "tcy-ai-conversations-mark-read",
		Method:          http.MethodPost,
		Path:            "/ai/conversations/{id}/read",
		Summary:         "Acknowledge an exact visible final assistant result",
		Description:     "Only the signed-in human owner can acknowledge a terminal result. GET and SSE observation never mark a result read. The opaque result version must still exist: old retry versions return 409, and older valid acknowledgements never move the read cursor backwards. Does not stop model execution, compaction, or change activity timestamps; never exposed over MCP.",
		Tags:            []string{"tcymc-ai"},
		DefaultStatus:   http.StatusOK,
		MaxBodyBytes:    1024,
		BodyReadTimeout: 10 * time.Second,
	}, func(ctx context.Context, in *struct {
		ID   string `path:"id" format:"uuid" doc:"Conversation UUID owned by the signed-in human account."`
		Body struct {
			ThroughReplyID string `json:"through_reply_id" minLength:"1" maxLength:"128" doc:"Exact latest_reply_id observed in the visible assistant response; not a turn UUID or client timestamp."`
		}
	}) (*struct {
		CacheControl string `header:"Cache-Control"`
		Body         tcyai.ConversationReadReceipt
	}, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		active, err := instanceusage.ActiveHuman(ctx, uid)
		if err != nil {
			return nil, huma.Error503ServiceUnavailable("account_verification_unavailable")
		}
		if !active {
			return nil, huma.Error403Forbidden("forbidden")
		}
		value, err := tcyai.MarkConversationRead(uid, in.ID, in.Body.ThroughReplyID)
		if errors.Is(err, tcyai.ErrConversationReplyChanged) {
			return nil, huma.Error409Conflict("conversation_reply_changed")
		}
		if err != nil {
			return nil, conversationError(ctx, err)
		}
		return &struct {
			CacheControl string `header:"Cache-Control"`
			Body         tcyai.ConversationReadReceipt
		}{
			CacheControl: "no-store",
			Body:         value,
		}, nil
	})
}
