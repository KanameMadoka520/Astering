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
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/modules/auth"
	"github.com/KanameMadoka520/Astering/pkg/modules/tcyai"
	"github.com/coder/websocket"
	"github.com/coder/websocket/wsjson"
	"github.com/stretchr/testify/require"
)

func TestShortSpeechCanceledRunCannotPublishLateProviderDeltas(t *testing.T) {
	for _, cancellation := range []struct {
		name  string
		cause error
	}{
		{
			name:  "revoked_account",
			cause: auth.ErrUserTokenRejected,
		},
		{
			name:  "invalid_audio",
			cause: errShortSpeechAudio,
		},
		{
			name:  "disconnected_client",
			cause: errShortSpeechClosed,
		},
	} {
		t.Run(cancellation.name, func(t *testing.T) {
			for _, final := range []bool{false, true} {
				t.Run(map[bool]string{
					false: "partial",
					true:  "final",
				}[final], func(t *testing.T) {
					ctx, cancel := context.WithCancelCause(context.Background())
					defer cancel(context.Canceled)
					transcript := &shortSpeechTranscript{segments: map[string]tcyai.LiveSpeechDelta{}}
					seed := tcyai.LiveSpeechDelta{
						ID:   "in-flight",
						Text: "Previous partial",
					}
					changed, err := transcript.update(seed)
					require.NoError(t, err)
					require.True(t, changed)
					sends := 0
					sink := &shortSpeechDeltaSink{
						ctx:        ctx,
						transcript: transcript,
						started:    time.Now(),
						send: func(any) error {
							sends++
							return nil
						},
					}
					cancel(cancellation.cause)
					err = sink.consume(tcyai.LiveSpeechDelta{
						ID:    seed.ID,
						Text:  "Private late result",
						Final: final,
					})
					require.ErrorIs(t, err, context.Canceled)
					require.ErrorIs(t, context.Cause(ctx), cancellation.cause)
					require.Zero(t, sends, "canceled callbacks must not publish private transcript data")
					require.Zero(t, sink.firstTextMS)
					require.Equal(t, seed, transcript.segments[seed.ID])
					require.Equal(t, []string{seed.ID}, transcript.ids)
					require.Equal(t, len(seed.Text), transcript.bytes)
					require.Equal(t, 1, transcript.nonempty)
					require.Empty(t, transcript.text(), "a late final must not commit the earlier partial")
				})
			}
		})
	}
}

func TestShortSpeechCanceledWritesKeepTransportForFixedError(t *testing.T) {
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	results := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			results <- err
			return
		}
		defer func() { _ = socket.CloseNow() }()
		writer := &shortSpeechWriter{socket: socket}
		runCtx, cancel := context.WithCancel(ctx)
		cancel()
		for _, kind := range []string{"ready", "transcript", "done"} {
			if err = writer.send(runCtx, ctx, map[string]string{
				"type": kind,
				"text": "Private late result",
			}); !errors.Is(err, context.Canceled) {
				results <- err
				return
			}
		}
		results <- writer.send(ctx, ctx, map[string]string{
			"type": "error",
			"code": "interrupted",
		})
	}))
	defer server.Close()
	socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer func() { _ = socket.CloseNow() }()
	var event map[string]string
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, map[string]string{
		"type": "error",
		"code": "interrupted",
	}, event)
	select {
	case err = <-results:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("the canceled run did not complete its fixed error response")
	}
}

type shortSpeechQueuedEvent struct {
	value     any
	marshaled chan<- struct{}
}

func (e shortSpeechQueuedEvent) MarshalJSON() ([]byte, error) {
	body, err := json.Marshal(e.value)
	e.marshaled <- struct{}{}
	return body, err
}

func TestShortSpeechCanceledQueuedWritesKeepTransportForFixedError(t *testing.T) {
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	results := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(w, r, nil)
		if err != nil {
			results <- err
			return
		}
		defer func() { _ = socket.CloseNow() }()
		writer := &shortSpeechWriter{socket: socket}
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		marshaled := make(chan struct{}, 3)
		writes := make(chan error, 3)
		writer.Lock()
		for _, kind := range []string{"ready", "transcript", "done"} {
			go func(kind string) {
				writes <- writer.send(runCtx, ctx, shortSpeechQueuedEvent{
					value: map[string]string{
						"type": kind,
						"text": "Private queued result",
					},
					marshaled: marshaled,
				})
			}(kind)
		}
		// Every send has entered and encoded its event while the writer stays
		// occupied. Allow the senders to reach Lock, then cancel before release.
		for range 3 {
			select {
			case <-marshaled:
			case <-ctx.Done():
				writer.Unlock()
				results <- ctx.Err()
				return
			}
		}
		select {
		case <-writes:
			writer.Unlock()
			results <- errors.New("speech write escaped the held mutex")
			return
		case <-time.After(20 * time.Millisecond):
		}
		cancel()
		writer.Unlock()
		for range 3 {
			select {
			case err = <-writes:
				if !errors.Is(err, context.Canceled) {
					results <- errors.New("queued speech write ignored cancellation")
					return
				}
			case <-ctx.Done():
				results <- ctx.Err()
				return
			}
		}
		results <- writer.send(ctx, ctx, map[string]string{
			"type": "error",
			"code": "interrupted",
		})
	}))
	defer server.Close()
	socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer func() { _ = socket.CloseNow() }()
	var event map[string]string
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, map[string]string{
		"type": "error",
		"code": "interrupted",
	}, event)
	select {
	case err = <-results:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("the queued speech writes did not finish after cancellation")
	}
}

type shortSpeechHeldWriteConn struct {
	net.Conn
	ctx     context.Context
	written chan<- struct{}
	release <-chan struct{}
	once    sync.Once
}

func (c *shortSpeechHeldWriteConn) Write(body []byte) (int, error) {
	n, err := c.Conn.Write(body)
	if err == nil {
		c.once.Do(func() {
			close(c.written)
			select {
			case <-c.release:
			case <-c.ctx.Done():
			}
		})
	}
	return n, err
}

type shortSpeechHeldWriteResponse struct {
	http.ResponseWriter
	ctx     context.Context
	written chan<- struct{}
	release <-chan struct{}
}

func (w shortSpeechHeldWriteResponse) Hijack() (net.Conn, *bufio.ReadWriter, error) {
	conn, buffers, err := w.ResponseWriter.(http.Hijacker).Hijack()
	if err != nil {
		return nil, nil, err
	}
	// Flush the HTTP upgrade before holding the first actual WebSocket frame.
	if err = buffers.Flush(); err != nil {
		_ = conn.Close()
		return nil, nil, err
	}
	held := &shortSpeechHeldWriteConn{
		Conn:    conn,
		ctx:     w.ctx,
		written: w.written,
		release: w.release,
	}
	buffers.Writer.Reset(held)
	return held, buffers, nil
}

func TestShortSpeechCancellationDuringReadyWriteKeepsFixedErrorReadable(t *testing.T) {
	ctx, done := context.WithTimeout(context.Background(), 5*time.Second)
	defer done()
	written, release, canceled := make(chan struct{}), make(chan struct{}), make(chan struct{})
	unblock := sync.OnceFunc(func() { close(release) })
	results := make(chan error, 1)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		socket, err := websocket.Accept(shortSpeechHeldWriteResponse{
			ResponseWriter: w,
			ctx:            ctx,
			written:        written,
			release:        release,
		}, r, nil)
		if err != nil {
			results <- err
			return
		}
		defer func() { _ = socket.CloseNow() }()
		writer := &shortSpeechWriter{socket: socket}
		runCtx, cancel := context.WithCancel(ctx)
		defer cancel()
		reader := make(chan error, 1)
		go func() {
			var command map[string]string
			readErr := wsjson.Read(ctx, socket, &command)
			if readErr == nil && command["action"] != "invalid" {
				readErr = errors.New("expected an invalid speech command")
			}
			cancel()
			close(canceled)
			reader <- readErr
		}()
		// The client sees ready and cancels the run while the underlying Write
		// has sent the bytes but has not yet returned to clear its cancel hook.
		err = writer.send(runCtx, ctx, map[string]string{"type": "ready"})
		if !errors.Is(err, context.Canceled) {
			results <- errors.New("the admitted ready write did not report run cancellation")
			return
		}
		if err = <-reader; err != nil {
			results <- err
			return
		}
		if err = writer.send(runCtx, ctx, map[string]string{
			"type": "transcript",
			"text": "Private late result",
		}); !errors.Is(err, context.Canceled) {
			results <- errors.New("a transcript was admitted after cancellation")
			return
		}
		results <- writer.send(ctx, ctx, map[string]string{
			"type": "error",
			"code": "invalid_audio",
		})
	}))
	defer server.Close()
	defer unblock()
	socket, response, err := websocket.Dial(ctx, "ws"+strings.TrimPrefix(server.URL, "http"), nil)
	if response != nil && response.Body != nil {
		_ = response.Body.Close()
	}
	require.NoError(t, err)
	defer func() { _ = socket.CloseNow() }()
	var event map[string]string
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, map[string]string{"type": "ready"}, event)
	select {
	case <-written:
	case <-ctx.Done():
		t.Fatal("the ready frame was not written")
	}
	require.NoError(t, wsjson.Write(ctx, socket, map[string]string{"action": "invalid"}))
	select {
	case <-canceled:
	case <-ctx.Done():
		t.Fatal("the invalid client command did not cancel the run")
	}
	unblock()
	require.NoError(t, wsjson.Read(ctx, socket, &event))
	require.Equal(t, map[string]string{
		"type": "error",
		"code": "invalid_audio",
	}, event)
	select {
	case err = <-results:
		require.NoError(t, err)
	case <-ctx.Done():
		t.Fatal("the canceled ready write did not finish its fixed error response")
	}
}
