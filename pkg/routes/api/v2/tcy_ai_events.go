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
	"fmt"
	"net/http"
	"time"

	"code.vikunja.io/api/pkg/modules/tcyai"
	"github.com/danielgtaylor/huma/v2"
	"github.com/danielgtaylor/huma/v2/adapters/humaecho"
)

func init() { AddRouteRegistrar(RegisterTCYAIEvents) }
func RegisterTCYAIEvents(api huma.API) {
	Register(api, huma.Operation{OperationID: "tcy-ai-conversations-events", Method: "GET", Path: "/ai/conversations/{id}/events", Summary: "Observe live conversation events", Description: "Account-owned SSE snapshots of model deltas, tool receipts and background compaction. Disconnecting only stops observation, never execution. Reconnect to receive the latest saved state; only the stop endpoint cancels the job.", Tags: []string{"tcymc-ai"}}, func(ctx context.Context, in *conversationPathInput) (*huma.StreamResponse, error) {
		uid, err := aiUser(ctx)
		if err != nil {
			return nil, err
		}
		if _, err = tcyai.GetConversationActivity(uid, in.ID); err != nil {
			return nil, conversationError(ctx, err)
		}
		return &huma.StreamResponse{Body: func(hctx huma.Context) {
			ec := humaecho.Unwrap(hctx)
			response := (*ec).Response()
			response.Header().Set("Content-Type", "text/event-stream")
			response.Header().Set("Cache-Control", "no-store, no-transform")
			response.Header().Set("X-Accel-Buffering", "no")
			encoder := conversationEventEncoder{
				delta: acceptsConversationDeltas((*ec).Request().Header.Get("Accept")),
			}
			timer := time.NewTicker(120 * time.Millisecond)
			defer timer.Stop()
			deadline := time.NewTimer(25 * time.Second)
			defer deadline.Stop()
			lastRead := time.Time{}
			for {
				select {
				case <-ctx.Done():
					return
				case <-deadline.C:
					return
				case <-timer.C:
				}
				if !tcyai.ConversationJobRunning(uid, in.ID) && time.Since(lastRead) < 2*time.Second {
					continue
				}
				lastRead = time.Now()
				state, err := tcyai.GetConversationActivity(uid, in.ID)
				if err != nil {
					return
				}
				event, err := encoder.encode(state)
				if err != nil {
					return
				}
				if event != nil {
					if _, err = fmt.Fprintf(response, "event: %s\ndata: %s\n\n", event.name, event.data); err != nil {
						return
					}
					if err = http.NewResponseController(response).Flush(); err != nil {
						return
					}
				}
			}
		}}, nil
	})
}
