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

package tcyshowcase

import (
	"bufio"
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"code.vikunja.io/api/pkg/config"
	"code.vikunja.io/api/pkg/user"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

const concurrentContent = "A newer snapshot from the other process"

// This is a second OS process, with a separate module mutex. Its lease deliberately
// spans a whole-store read and later write, like a slow web request racing the CLI.
func TestShowcaseAccountCleanupStoreProcess(t *testing.T) {
	root := os.Getenv("VIKUNJA_SHOWCASE_LOCK_FIXTURE")
	if root == "" {
		t.Skip("subprocess fixture")
	}
	config.InitDefaultConfig()
	config.FilesBasePath.Set(root)
	lock.Lock()
	defer lock.Unlock()
	lease, err := acquireStoreLock()
	require.NoError(t, err)
	defer lease.Close()
	states, err := read()
	require.NoError(t, err)
	owner := os.Getenv("VIKUNJA_SHOWCASE_LOCK_OWNER")
	if owner != "" {
		state := states[owner]
		state.Draft.Content = concurrentContent
		if state.Published != nil {
			draft := *state.Published
			draft.Content = concurrentContent
			state.Published = &draft
		}
		states[owner] = state
	}
	temporary := filepath.Join(filepath.Dir(path()), ".pages-held")
	require.NoError(t, os.WriteFile(temporary, []byte("in-progress snapshot"), 0600))
	_, err = fmt.Fprintln(os.Stdout, "store-locked")
	require.NoError(t, err)
	_, err = bufio.NewReader(os.Stdin).ReadString('\n')
	require.NoError(t, err)
	if owner != "" {
		require.NoError(t, write(states))
	}
	require.NoError(t, os.Remove(temporary))
}

type storeProcess struct {
	cmd      *exec.Cmd
	input    io.WriteCloser
	done     chan error
	released sync.Once
	waited   sync.Once
	err      error
	killed   bool
}

func startStoreProcess(t *testing.T, owner string) *storeProcess {
	t.Helper()
	executable, err := os.Executable()
	require.NoError(t, err)
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
	t.Cleanup(cancel)
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestShowcaseAccountCleanupStoreProcess$", "-test.count=1") // #nosec G204 -- re-executes only the current test binary.
	cmd.Env = append(os.Environ(), "VIKUNJA_SHOWCASE_LOCK_FIXTURE="+config.FilesBasePath.GetString(), "VIKUNJA_SHOWCASE_LOCK_OWNER="+owner)
	input, err := cmd.StdinPipe()
	require.NoError(t, err)
	output, err := cmd.StdoutPipe()
	require.NoError(t, err)
	require.NoError(t, cmd.Start())
	process := &storeProcess{cmd: cmd, input: input, done: make(chan error, 1)}
	go func() { process.done <- cmd.Wait() }()
	ready := make(chan bool, 1)
	go func() {
		scanner := bufio.NewScanner(output)
		for scanner.Scan() {
			if scanner.Text() == "store-locked" {
				ready <- true
				return
			}
		}
		ready <- false
	}()
	t.Cleanup(func() { process.finish(t, false) })
	select {
	case locked := <-ready:
		require.True(t, locked, "child process failed before acquiring its store lease")
	case <-time.After(10 * time.Second):
		_ = cmd.Process.Kill()
		t.Fatal("child process did not acquire the store lease")
	}
	return process
}

func (process *storeProcess) finish(t *testing.T, kill bool) {
	t.Helper()
	process.released.Do(func() {
		if kill {
			process.killed = true
			_ = process.cmd.Process.Kill()
		} else {
			_, _ = io.WriteString(process.input, "release\n")
		}
		_ = process.input.Close()
	})
	process.waited.Do(func() {
		select {
		case process.err = <-process.done:
		case <-time.After(10 * time.Second):
			_ = process.cmd.Process.Kill()
			process.err = <-process.done
			t.Error("child process did not release its store lease")
		}
	})
	if !process.killed {
		require.NoError(t, process.err, "child process failed")
	}
}

func awaitStoreOperation(t *testing.T, result <-chan error) {
	t.Helper()
	select {
	case err := <-result:
		require.NoError(t, err)
	case <-time.After(10 * time.Second):
		t.Fatal("store operation did not finish after the other process released its lease")
	}
}

func TestShowcaseAccountCleanupSerializesWholeStoreAcrossProcesses(t *testing.T) {
	for _, action := range []string{"save", "unpublish", "cleanup", "retry"} {
		t.Run(action, func(t *testing.T) {
			engine := cleanupFixture(t)
			_, err := Save(91201, cleanupDraft("owner-a"), true)
			require.NoError(t, err)
			_, err = Save(91202, cleanupDraft("owner-b"), true)
			require.NoError(t, err)
			deleted := action == "cleanup" || action == "retry"
			concurrentOwner := "91201"
			if deleted {
				_, err = engine.ID(91201).Delete(&user.User{})
				require.NoError(t, err)
				concurrentOwner = "91202"
			}
			process := startStoreProcess(t, concurrentOwner)
			result := make(chan error, 1)
			go func() {
				var operationErr error
				switch action {
				case "save":
					draft := cleanupDraft("owner-b")
					draft.Content = "Latest owner B content"
					_, operationErr = Save(91202, draft, true)
				case "unpublish":
					_, operationErr = Unpublish(91202)
				case "cleanup":
					operationErr = (accountCleanupBridge{}).CleanupDeletedUser(91201)
				case "retry":
					operationErr = (accountCleanupBridge{}).RetryDeletedUsers()
				}
				result <- operationErr
			}()
			early := false
			select {
			case err = <-result:
				early = true
				t.Errorf("%s bypassed the other process's whole-store lease: %v", action, err)
			case <-time.After(100 * time.Millisecond):
			}
			assert.FileExists(t, filepath.Join(filepath.Dir(path()), ".pages-held"), "a live snapshot in another process must not be treated as abandoned")
			process.finish(t, false)
			if !early {
				awaitStoreOperation(t, result)
			}
			states, err := read()
			require.NoError(t, err)
			if deleted {
				assert.NotContains(t, states, "91201", "a stale whole-store write must never revive a deleted owner's page")
				assert.Equal(t, concurrentContent, states["91202"].Draft.Content, "cleanup must preserve another owner's latest snapshot")
			} else {
				assert.Equal(t, concurrentContent, states["91201"].Draft.Content)
				if action == "save" {
					assert.Equal(t, "Latest owner B content", states["91202"].Draft.Content)
				} else {
					assert.Nil(t, states["91202"].Published)
				}
			}
			assert.FileExists(t, filepath.Join(filepath.Dir(path()), ".pages.lock"), "the shared lock inode must remain permanent")
		})
	}
}

func TestShowcaseAccountCleanupStoreLeaseReleasedOnProcessExit(t *testing.T) {
	cleanupFixture(t)
	_, err := Save(91202, cleanupDraft("surviving-owner"), true)
	require.NoError(t, err)
	process := startStoreProcess(t, "")
	result := make(chan error, 1)
	go func() { _, saveErr := Unpublish(91202); result <- saveErr }()
	select {
	case err = <-result:
		t.Fatalf("writer bypassed the child lease: %v", err)
	case <-time.After(100 * time.Millisecond):
	}
	process.finish(t, true)
	awaitStoreOperation(t, result)
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	assert.NoFileExists(t, filepath.Join(filepath.Dir(path()), ".pages-held"))
	assert.FileExists(t, filepath.Join(filepath.Dir(path()), ".pages.lock"))
}

func TestShowcaseAccountCleanupStoreLockErrorsRemainFailures(t *testing.T) {
	engine := cleanupFixture(t)
	_, err := Save(91201, cleanupDraft("deleted-owner"), true)
	require.NoError(t, err)
	_, err = Save(91202, cleanupDraft("preserved-owner"), true)
	require.NoError(t, err)
	before, err := os.ReadFile(path())
	require.NoError(t, err)
	_, err = engine.ID(91201).Delete(&user.User{})
	require.NoError(t, err)
	lockPath := filepath.Join(filepath.Dir(path()), ".pages.lock")
	require.NoError(t, os.Remove(lockPath)) // Test-only failure injection with no active lease.
	require.NoError(t, os.Mkdir(lockPath, 0700))
	_, err = Save(91202, cleanupDraft("preserved-owner"), true)
	require.Error(t, err)
	_, err = Unpublish(91202)
	require.Error(t, err)
	require.Error(t, (accountCleanupBridge{}).CleanupDeletedUser(91201))
	require.Error(t, (accountCleanupBridge{}).RetryDeletedUsers())
	after, err := os.ReadFile(path())
	require.NoError(t, err)
	assert.Equal(t, before, after, "lock errors must not write an unprotected whole-store snapshot")
	require.NoError(t, os.Remove(lockPath))
	require.NoError(t, (accountCleanupBridge{}).RetryDeletedUsers())
	states, err := read()
	require.NoError(t, err)
	assert.NotContains(t, states, "91201")
	assert.Contains(t, states, "91202")
}
