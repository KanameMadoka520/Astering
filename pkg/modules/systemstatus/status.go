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
	"sync"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/health"
	"github.com/KanameMadoka520/Astering/pkg/version"
)

type Snapshot struct {
	Application          ApplicationSnapshot `json:"application" doc:"Astering application container and persistent data metrics, separate from host totals."`
	Scope                string              `json:"scope" enum:"host" doc:"CPU and memory describe the entire host, never the application cgroup."`
	HostMetricsAvailable bool                `json:"host_metrics_available" doc:"True when explicit read-only host proc files are readable and valid. No silent fallback to container counters."`
	Version              string              `json:"version" doc:"Running API build version."`
	Started              time.Time           `json:"started" doc:"Application process start, UTC; resets on restart."`
	UptimeSeconds        int64               `json:"uptime_seconds" doc:"Continuous application process runtime in seconds."`
	HostUptimeSeconds    *int64              `json:"host_uptime_seconds" doc:"Host time since boot in seconds, independent of application restarts."`
	Sampled              time.Time           `json:"sampled" doc:"UTC sample time. Samples are shared and cached for 5 seconds."`
	Healthy              bool                `json:"healthy" doc:"Application database and configured Redis are reachable; not a host resource pressure assessment."`
	CPUPercent           *float64            `json:"cpu_percent" doc:"Host non-idle CPU time excluding I/O wait, across all cores, percent. Null until two valid samples exist."`
	CPUIOWaitPercent     *float64            `json:"cpu_io_wait_percent" doc:"Host CPU I/O wait delta as a percentage of total CPU time."`
	CPUStealPercent      *float64            `json:"cpu_steal_percent" doc:"Host CPU steal time delta as a percentage of total CPU time."`
	CPUCores             float64             `json:"cpu_cores" doc:"Host logical CPU count from host proc/stat, unaffected by container quotas."`
	LoadAverage          []float64           `json:"load_average" doc:"Host 1, 5 and 15 minute load averages, in that order; empty when unavailable. Not percentages."`
	MemoryUsed           *uint64             `json:"memory_used" doc:"Host MemTotal minus MemAvailable in bytes; includes all host applications."`
	MemoryAvailable      *uint64             `json:"memory_available" doc:"Host kernel estimate of available RAM in bytes, including reclaimable caches."`
	MemoryTotal          *uint64             `json:"memory_total" doc:"Total host RAM in bytes, independent of container limits."`
	DiskUsed             *uint64             `json:"disk_used" doc:"Used bytes on the host filesystem containing uploaded data, including other applications."`
	DiskTotal            *uint64             `json:"disk_total" doc:"Data-filesystem capacity: used plus available bytes, matching df usage accounting; not a sum of all mounted filesystems."`
}

type cpuCounters struct {
	total, idle, ioWait, steal uint64
	valid                      bool
}

func cpuUsage(before, after cpuCounters) (busy, wait, steal *float64) {
	if !before.valid || !after.valid || after.total <= before.total || after.idle < before.idle || after.ioWait < before.ioWait || after.steal < before.steal {
		return nil, nil, nil
	}
	total := after.total - before.total
	idle := after.idle - before.idle
	io := after.ioWait - before.ioWait
	stolen := after.steal - before.steal
	if idle > total || io > total-idle || stolen > total {
		return nil, nil, nil
	}
	b := 100 * float64(total-idle-io) / float64(total)
	w := 100 * float64(io) / float64(total)
	s := 100 * float64(stolen) / float64(total)
	return &b, &w, &s
}

var started = time.Now().UTC()
var cache struct {
	sync.Mutex
	snapshot    Snapshot
	previous    cpuCounters
	application applicationCounters
}

// Read shares lightweight counters. Persistent-data scans run asynchronously at most once per minute.
//
//nolint:contextcheck // Existing health.Check owns its database/Redis contexts.
func Read() Snapshot {
	cache.Lock()
	defer cache.Unlock()
	now := time.Now().UTC()
	if !cache.snapshot.Sampled.IsZero() && now.Sub(cache.snapshot.Sampled) < 5*time.Second {
		return cache.snapshot
	}
	sample, cpu := measure(config.FilesBasePath.GetString())
	sample.Application, cache.application = measureApplication(cache.application, now)
	sample.Application.Storage = readStorage(config.FilesBasePath.GetString())
	sample.Scope = "host"
	sample.Version = version.Version
	sample.Started = started
	sample.UptimeSeconds = int64(now.Sub(started).Seconds())
	sample.Sampled = now
	sample.Healthy = health.Check() == nil
	sample.CPUPercent, sample.CPUIOWaitPercent, sample.CPUStealPercent = cpuUsage(cache.previous, cpu)
	cache.previous = cpu
	cache.snapshot = sample
	return sample
}
