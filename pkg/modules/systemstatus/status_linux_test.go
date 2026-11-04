//go:build linux

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

package systemstatus

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestTCYSystemStatusHost(t *testing.T) {
	proc := t.TempDir()
	for name, value := range map[string]string{"stat": "cpu 100 20 40 800 30 5 5 0 50 10\ncpu0 1\ncpu1 1\n", "meminfo": "MemTotal: 20000 kB\nMemAvailable: 12000 kB\nMemFree: 1000 kB\n", "loadavg": "1.25 0.75 0.50 1/234 123", "uptime": "90061.25 80000.00"} {
		require.NoError(t, os.WriteFile(filepath.Join(proc, name), []byte(value), 0600))
	}
	out, cpu := measureHost(proc)
	assert.True(t, out.HostMetricsAvailable)
	assert.Equal(t, "host", out.Scope)
	assert.Equal(t, uint64(1000), cpu.total)
	assert.InDelta(t, 2, out.CPUCores, 0.001)
	require.NotNil(t, out.MemoryUsed)
	assert.Equal(t, uint64(8000*1024), *out.MemoryUsed)
	assert.Equal(t, uint64(12000*1024), *out.MemoryAvailable)
	assert.Equal(t, int64(90061), *out.HostUptimeSeconds)
	assert.InDeltaSlice(t, []float64{1.25, .75, .5}, out.LoadAverage, .001)
	missing, _ := measureHost(t.TempDir())
	assert.False(t, missing.HostMetricsAvailable)
	assert.Nil(t, missing.MemoryUsed)
	assert.Empty(t, missing.LoadAverage)
	sample, _ := measure(t.TempDir())
	require.NotNil(t, sample.DiskTotal)
	assert.Positive(t, *sample.DiskTotal)
	assert.LessOrEqual(t, *sample.DiskUsed, *sample.DiskTotal)
}
func TestTCYSystemStatusCPUDelta(t *testing.T) {
	before := cpuCounters{total: 1000, idle: 800, ioWait: 30, steal: 0, valid: true}
	after := cpuCounters{total: 1200, idle: 900, ioWait: 50, steal: 10, valid: true}
	busy, wait, steal := cpuUsage(before, after)
	require.NotNil(t, busy)
	assert.InDelta(t, 40, *busy, .001)
	assert.InDelta(t, 10, *wait, .001)
	assert.InDelta(t, 5, *steal, .001)
	b, _, _ := cpuUsage(cpuCounters{}, after)
	assert.Nil(t, b)
	b, _, _ = cpuUsage(after, before)
	assert.Nil(t, b)
	after.ioWait = 20
	b, _, _ = cpuUsage(before, after)
	assert.Nil(t, b, "counter regression resets the sample instead of spiking")
	assert.Nil(t, parseNumbers("NaN 1 2", 3))
	assert.Nil(t, parseNumbers("1 2", 3))
}

func TestAsteringSystemStatusHostPathCompatibility(t *testing.T) {
	fixture := func(path, uptime string) {
		t.Helper()
		for name, value := range map[string]string{
			"stat":    "cpu 100 20 40 800 30 5 5 0\ncpu0 1\n",
			"meminfo": "MemTotal: 20000 kB\nMemAvailable: 12000 kB\n",
			"loadavg": "1.25 0.75 0.50 1/234 123",
			"uptime":  uptime + " 80000.00",
		} {
			require.NoError(t, os.WriteFile(filepath.Join(path, name), []byte(value), 0600))
		}
	}
	primary, legacy := t.TempDir(), t.TempDir()
	fixture(legacy, "111")
	old, _ := measureHostWithFallback(primary, legacy)
	require.True(t, old.HostMetricsAvailable, "existing host mounts continue working")
	require.NotNil(t, old.HostUptimeSeconds)
	assert.EqualValues(t, 111, *old.HostUptimeSeconds)

	fixture(primary, "222")
	current, _ := measureHostWithFallback(primary, legacy)
	require.True(t, current.HostMetricsAvailable)
	require.NotNil(t, current.HostUptimeSeconds)
	assert.EqualValues(t, 222, *current.HostUptimeSeconds, "the new mount has priority when both are present")

	require.NoError(t, os.Remove(filepath.Join(primary, "meminfo")))
	fallback, _ := measureHostWithFallback(primary, legacy)
	require.True(t, fallback.HostMetricsAvailable, "an incomplete new mount does not hide a working old mount")
	assert.EqualValues(t, 111, *fallback.HostUptimeSeconds)

	missing, _ := measureHostWithFallback(t.TempDir(), t.TempDir())
	assert.False(t, missing.HostMetricsAvailable, "container procfs is never substituted for host data")
	assert.Nil(t, missing.HostUptimeSeconds)
}
