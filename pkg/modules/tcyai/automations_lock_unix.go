//go:build linux || darwin || freebsd || netbsd || openbsd || dragonfly

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
	"errors"
	"os"
	"time"

	"golang.org/x/sys/unix"
)

func lockAutomationFile(path string, nonblocking bool) (func(), error) {
	fd, err := unix.Open(path, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	return holdAutomationLock(os.NewFile(uintptr(fd), path), nonblocking)
}
func lockAutomationRoot(root *os.Root, name string, nonblocking bool) (func(), error) {
	directory, err := root.Open(".")
	if err != nil {
		return nil, err
	}
	defer directory.Close()
	fd, err := unix.Openat(int(directory.Fd()), name, unix.O_CREAT|unix.O_RDWR|unix.O_CLOEXEC|unix.O_NOFOLLOW, 0600)
	if err != nil {
		return nil, err
	}
	return holdAutomationLock(os.NewFile(uintptr(fd), name), nonblocking)
}
func holdAutomationLock(file *os.File, nonblocking bool) (func(), error) {
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		_ = file.Close()
		return nil, errStoragePathUnsafe
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		err = unix.Flock(int(file.Fd()), unix.LOCK_EX|unix.LOCK_NB)
		if err == nil {
			break
		}
		if !errors.Is(err, unix.EWOULDBLOCK) && !errors.Is(err, unix.EAGAIN) {
			_ = file.Close()
			return nil, err
		}
		if nonblocking || !time.Now().Before(deadline) {
			_ = file.Close()
			return nil, ErrAutomationBusy
		}
		time.Sleep(20 * time.Millisecond)
	}
	return func() { _ = unix.Flock(int(file.Fd()), unix.LOCK_UN); _ = file.Close() }, nil
}
