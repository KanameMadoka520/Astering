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

package red

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"net"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/log"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func readTestCommand(reader *bufio.Reader) ([]string, error) {
	line, err := reader.ReadString('\n')
	if err != nil {
		return nil, err
	}
	count, err := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "*")))
	if err != nil {
		return nil, err
	}
	args := make([]string, count)
	for i := range args {
		line, err = reader.ReadString('\n')
		if err != nil {
			return nil, err
		}
		size, parseErr := strconv.Atoi(strings.TrimSpace(strings.TrimPrefix(line, "$")))
		if parseErr != nil || size < 0 {
			return nil, fmt.Errorf("invalid test RESP length")
		}
		value := make([]byte, size+2)
		if _, err = io.ReadFull(reader, value); err != nil {
			return nil, err
		}
		args[i] = string(value[:size])
	}
	return args, nil
}

func TestRedisClientHonorsProbeDeadline(t *testing.T) {
	config.InitDefaultConfig()
	log.InitLogger()
	var listenConfig net.ListenConfig
	listener, err := listenConfig.Listen(context.Background(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	var stalled atomic.Bool
	stop := make(chan struct{})
	var workers sync.WaitGroup
	workers.Add(1)
	go func() {
		defer workers.Done()
		for {
			conn, acceptErr := listener.Accept()
			if acceptErr != nil {
				return
			}
			workers.Add(1)
			go func() {
				defer workers.Done()
				defer conn.Close()
				reader := bufio.NewReader(conn)
				for {
					args, readErr := readTestCommand(reader)
					if readErr != nil || len(args) == 0 {
						return
					}
					response := "+OK\r\n"
					switch strings.ToLower(args[0]) {
					case "hello":
						response = "-ERR unknown command\r\n"
					case "ping":
						if stalled.Load() {
							<-stop
							return
						}
						response = "+PONG\r\n"
					}
					if _, writeErr := io.WriteString(conn, response); writeErr != nil {
						return
					}
				}
			}()
		}
	}()
	oldClient := r
	oldEnabled, oldHost := config.RedisEnabled.GetBool(), config.RedisHost.GetString()
	config.RedisEnabled.Set(true)
	config.RedisHost.Set(listener.Addr().String())
	r = nil
	t.Cleanup(func() {
		close(stop)
		_ = listener.Close()
		if r != nil {
			_ = r.Close()
		}
		workers.Wait()
		r = oldClient
		config.RedisEnabled.Set(oldEnabled)
		config.RedisHost.Set(oldHost)
	})
	InitRedis()
	require.True(t, r.Options().ContextTimeoutEnabled)
	stalled.Store(true)
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	started := time.Now()
	err = r.Ping(ctx).Err()
	require.Error(t, err)
	assert.Less(t, time.Since(started), time.Second, "a stalled Redis socket must respect the shorter caller deadline")
}
