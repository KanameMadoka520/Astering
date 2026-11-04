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
	"math"
	"os"
	"path/filepath"
	"strconv"
	"strings"

	"golang.org/x/sys/unix"
)

const (
	hostProcPath       = "/run/aster-host-proc"
	legacyHostProcPath = "/run/tcymc-host-proc"
)

func read(path string) string {
	b, err := os.ReadFile(path)
	if err != nil {
		return ""
	}
	return strings.TrimSpace(string(b))
}
func fields(text string) map[string]uint64 {
	result := map[string]uint64{}
	for line := range strings.SplitSeq(text, "\n") {
		f := strings.Fields(line)
		if len(f) < 2 {
			continue
		}
		if v, err := strconv.ParseUint(f[1], 10, 64); err == nil {
			result[strings.TrimSuffix(f[0], ":")] = v
		}
	}
	return result
}
func parseCPU(text string) (cpuCounters, float64) {
	counters := cpuCounters{}
	cores := 0.
	for line := range strings.SplitSeq(text, "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if len(f[0]) > 3 && strings.HasPrefix(f[0], "cpu") {
			if _, err := strconv.ParseUint(f[0][3:], 10, 64); err == nil {
				cores++
			}
			continue
		}
		if f[0] != "cpu" || len(f) < 9 {
			continue
		}
		// guest and guest_nice are already included in user and nice. Only sum
		// the first eight counters, avoiding double counting virtual guest time.
		values := [8]uint64{}
		for i := range values {
			v, err := strconv.ParseUint(f[i+1], 10, 64)
			if err != nil {
				return cpuCounters{}, cores
			}
			values[i] = v
			counters.total += v
		}
		counters.idle = values[3]
		counters.ioWait = values[4]
		counters.steal = values[7]
		counters.valid = true
	}
	return counters, cores
}
func parseNumbers(text string, count int) []float64 {
	parts := strings.Fields(text)
	if len(parts) < count {
		return nil
	}
	out := make([]float64, count)
	for i := range count {
		v, err := strconv.ParseFloat(parts[i], 64)
		if err != nil || math.IsNaN(v) || math.IsInf(v, 0) || v < 0 {
			return nil
		}
		out[i] = v
	}
	return out
}
func measureHost(proc string) (Snapshot, cpuCounters) {
	out := Snapshot{Scope: "host", LoadAverage: []float64{}}
	cpu, cores := parseCPU(read(filepath.Join(proc, "stat")))
	if cpu.valid {
		out.CPUCores = cores
	}
	mem := fields(read(filepath.Join(proc, "meminfo")))
	total, hasTotal := mem["MemTotal"]
	available, hasAvailable := mem["MemAvailable"]
	if hasTotal && hasAvailable && total > 0 && available <= total {
		total *= 1024
		available *= 1024
		used := total - available
		out.MemoryTotal = &total
		out.MemoryAvailable = &available
		out.MemoryUsed = &used
	}
	if load := parseNumbers(read(filepath.Join(proc, "loadavg")), 3); len(load) == 3 {
		out.LoadAverage = load
	}
	if uptime := parseNumbers(read(filepath.Join(proc, "uptime")), 1); len(uptime) == 1 && uptime[0] < math.MaxInt64 {
		seconds := int64(uptime[0])
		out.HostUptimeSeconds = &seconds
	}
	out.HostMetricsAvailable = cpu.valid && cores > 0 && out.MemoryTotal != nil && len(out.LoadAverage) == 3 && out.HostUptimeSeconds != nil
	return out, cpu
}
func measureHostWithFallback(primary, legacy string) (Snapshot, cpuCounters) {
	out, cpu := measureHost(primary)
	if out.HostMetricsAvailable {
		return out, cpu
	}
	if previous, previousCPU := measureHost(legacy); previous.HostMetricsAvailable {
		return previous, previousCPU
	}
	return out, cpu
}

func measure(dataPath string) (Snapshot, cpuCounters) {
	// Narrow explicit host file mounts prevent container metrics or a virtualized
	// procfs from being silently labelled as host measurements.
	out, cpu := measureHostWithFallback(hostProcPath, legacyHostProcPath)
	var disk unix.Statfs_t
	if err := unix.Statfs(dataPath, &disk); err == nil && disk.Bsize > 0 {
		used := (disk.Blocks - disk.Bfree) * uint64(disk.Bsize)
		total := used + disk.Bavail*uint64(disk.Bsize)
		out.DiskUsed = &used
		out.DiskTotal = &total
	}
	return out, cpu
}
