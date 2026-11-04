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

package health

import (
	"context"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
	"xorm.io/xorm"
)

func healthTestEngine(t *testing.T) *xorm.Engine {
	t.Helper()
	config.InitDefaultConfig()
	oldRedis := config.RedisEnabled.GetBool()
	config.RedisEnabled.Set(false)
	t.Cleanup(func() { config.RedisEnabled.Set(oldRedis) })
	engine, err := db.CreateTestEngine()
	require.NoError(t, err)
	oldLimit := engine.DB().Stats().MaxOpenConnections
	engine.SetMaxOpenConns(1)
	t.Cleanup(func() { engine.SetMaxOpenConns(oldLimit) })
	return engine
}

// Bound the fixture itself, including an accidental regression to Begin with a
// background context. Opening extra slots lets that regression drain safely, even with a held fixture connection.
func boundedHealthResult(t *testing.T, engine *xorm.Engine, run func() error, limit time.Duration) error {
	t.Helper()
	done := make(chan error, 1)
	go func() { done <- run() }()
	select {
	case err := <-done:
		return err
	case <-time.After(limit):
		t.Error("health probe exceeded its deadline")
		engine.SetMaxOpenConns(3)
		select {
		case err := <-done:
			return err
		case <-time.After(time.Second):
			t.Fatal("health probe did not drain after releasing the pool constraint")
			return nil
		}
	}
}

func TestHealthCheckSingleConnection(t *testing.T) {
	engine := healthTestEngine(t)
	ctx, cancel := context.WithTimeout(context.Background(), 200*time.Millisecond)
	defer cancel()
	require.NoError(t, boundedHealthResult(t, engine, func() error { return CheckContext(ctx) }, time.Second))
	assert.Zero(t, engine.DB().Stats().InUse, "a health probe must not retain a transaction")
}

func TestHealthCheckPoolExhaustionRespectsDeadline(t *testing.T) {
	engine := healthTestEngine(t)
	held, err := engine.DB().Conn(context.Background())
	require.NoError(t, err)
	defer held.Close()
	ctx, cancel := context.WithTimeout(context.Background(), 40*time.Millisecond)
	defer cancel()
	err = boundedHealthResult(t, engine, func() error { return CheckContext(ctx) }, time.Second)
	require.ErrorIs(t, err, context.DeadlineExceeded)
	assert.Equal(t, 1, engine.DB().Stats().InUse, "only the fixture owns a connection")
}

func TestHealthCheckBackgroundIsBounded(t *testing.T) {
	engine := healthTestEngine(t)
	held, err := engine.DB().Conn(context.Background())
	require.NoError(t, err)
	defer held.Close()
	require.ErrorIs(t, boundedHealthResult(t, engine, Check, 3*time.Second), context.DeadlineExceeded)
}

func TestHealthCheckCancelledCaller(t *testing.T) {
	engine := healthTestEngine(t)
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	require.ErrorIs(t, boundedHealthResult(t, engine, func() error { return CheckContext(ctx) }, time.Second), context.Canceled)
	assert.Zero(t, engine.DB().Stats().InUse)
}
