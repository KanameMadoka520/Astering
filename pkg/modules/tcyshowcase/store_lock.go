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
	"os"
	"path/filepath"
)

// The CLI and web process share one pages.json. Keep this inode permanently:
// unlinking a lock file would let another process lock a different inode and
// overwrite a newer whole-store snapshot. Closing the handle (also on process
// exit) releases the OS lock without leaving a stale application-level lock.
// Call only under lock, before reading a read-modify-write snapshot or removing
// abandoned snapshots, and before taking an account's database write gate.
func acquireStoreLock() (*os.File, error) {
	directory := filepath.Dir(path())
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	file, err := os.OpenFile(filepath.Join(directory, ".pages.lock"), os.O_CREATE|os.O_RDWR, 0600)
	if err != nil {
		return nil, err
	}
	if err = lockStoreFile(file); err != nil {
		_ = file.Close()
		return nil, err
	}
	return file, nil
}
