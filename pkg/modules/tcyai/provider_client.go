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
	"net/http"

	"github.com/KanameMadoka520/Astering/pkg/utils"
)

type providerClientContextKey struct{}

// A run owns its pool; nested runs share it without closing their parent's connections.
// One-shot calls own a temporary pool, so they cannot leave unreachable idle transports.
func providerClient(ctx context.Context) (*http.Client, func()) {
	if client, ok := ctx.Value(providerClientContextKey{}).(*http.Client); ok {
		return client, func() {}
	}
	client := utils.NewSSRFSafeHTTPClient()
	// Caller contexts own the execution deadline; do not add a hidden output-time cap.
	client.Timeout = 0
	client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	return client, client.CloseIdleConnections
}

func withProviderClient(ctx context.Context) (context.Context, func()) {
	client, release := providerClient(ctx)
	return context.WithValue(ctx, providerClientContextKey{}, client), release
}
