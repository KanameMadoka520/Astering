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

package instanceusage

import (
	"context"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"strconv"
	"strings"

	"github.com/google/uuid"
)

// A shared ceiling bounds work even if an account has unexpected disk debris.
const maxMetadataEntries = 250000

type metadataScanner struct {
	ctx           context.Context
	ai            *os.Root
	conversations *os.Root
	complete      bool
	remaining     int
}

// childRoot pins the checked directory identity before any enumeration. It rejects
// symlinks (including ones pointing into another account) rather than following them.
func childRoot(parent *os.Root, name string) (*os.Root, error) {
	info, err := parent.Lstat(name)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("invalid usage metadata directory")
	}
	root, err := parent.OpenRoot(name)
	if err != nil {
		return nil, err
	}
	current, err := root.Stat(".")
	if err != nil || !os.SameFile(info, current) {
		_ = root.Close()
		return nil, errors.New("usage metadata directory changed")
	}
	return root, nil
}

func newMetadataScanner(ctx context.Context, basePath string) *metadataScanner {
	s := &metadataScanner{
		ctx:       ctx,
		complete:  true,
		remaining: maxMetadataEntries,
	}
	base, err := os.OpenRoot(basePath)
	if err != nil {
		s.complete = false
		return s
	}
	defer base.Close()
	s.ai, err = childRoot(base, ".tcymc-ai")
	if errors.Is(err, os.ErrNotExist) {
		return s
	}
	if err != nil {
		s.complete = false
		return s
	}
	s.conversations, err = childRoot(s.ai, "conversations")
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		s.complete = false
	}
	return s
}

func (s *metadataScanner) close() {
	if s.conversations != nil {
		_ = s.conversations.Close()
	}
	if s.ai != nil {
		_ = s.ai.Close()
	}
}

func (s *metadataScanner) scan(row *InstanceUserUsage) {
	row.AIScanComplete = s.complete && s.ctx.Err() == nil && s.remaining > 0
	if !row.AIScanComplete || s.ai == nil {
		return
	}
	uid := strconv.FormatInt(row.ID, 10)
	size, ok := regularSize(s.ai, uid+".enc")
	row.AISettingsBytes = size
	row.AIScanComplete = ok
	if s.conversations != nil {
		root, err := childRoot(s.conversations, uid)
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			row.AIScanComplete = false
		}
		if root != nil {
			mcpBytes, valid := regularSize(root, ".mcp-settings")
			row.AISettingsBytes += mcpBytes
			row.AIScanComplete = row.AIScanComplete && valid
			row.AIConversations, row.AIConversationBytes, ok = s.enumerate(root, canonicalConversation)
			row.AIScanComplete = row.AIScanComplete && ok
			attachments, err := childRoot(root, "attachments")
			if err != nil && !errors.Is(err, os.ErrNotExist) {
				row.AIScanComplete = false
			}
			if attachments != nil {
				_, row.AIAttachmentBytes, ok = s.enumerate(attachments, canonicalAttachment)
				row.AIScanComplete = row.AIScanComplete && ok
				_ = attachments.Close()
			}
			_ = root.Close()
		}
	}
	row.AIBytes = row.AIConversationBytes + row.AIAttachmentBytes + row.AISettingsBytes
}

func regularSize(root *os.Root, name string) (int64, bool) {
	info, err := root.Lstat(name)
	if errors.Is(err, os.ErrNotExist) {
		return 0, true
	}
	if err != nil || !info.Mode().IsRegular() {
		return 0, false
	}
	return info.Size(), true
}

func canonicalConversation(name string) bool {
	if !strings.HasSuffix(name, ".enc") {
		return false
	}
	id := strings.TrimSuffix(name, ".enc")
	parsed, err := uuid.Parse(id)
	return err == nil && id == parsed.String()
}

func canonicalAttachment(name string) bool {
	if len(name) != 68 || !strings.HasSuffix(name, ".enc") {
		return false
	}
	id := strings.TrimSuffix(name, ".enc")
	bytes, err := hex.DecodeString(id)
	return err == nil && len(bytes) == 32 && strings.ToLower(id) == id
}

func (s *metadataScanner) enumerate(root *os.Root, canonical func(string) bool) (count, bytes int64, complete bool) {
	dir, err := root.Open(".")
	if err != nil {
		return 0, 0, false
	}
	defer dir.Close()
	complete = true
	for {
		if s.ctx.Err() != nil || s.remaining <= 0 {
			return count, bytes, false
		}
		entries, readErr := dir.ReadDir(128)
		for _, entry := range entries {
			if s.ctx.Err() != nil || s.remaining <= 0 {
				return count, bytes, false
			}
			s.remaining--
			if !canonical(entry.Name()) {
				continue
			}
			// A vanished file is normal during concurrent deletion; don't count it.
			info, statErr := root.Lstat(entry.Name())
			if statErr != nil {
				if !errors.Is(statErr, os.ErrNotExist) {
					complete = false
				}
				continue
			}
			if !info.Mode().IsRegular() {
				complete = false
				continue
			}
			count++
			bytes += info.Size()
		}
		if errors.Is(readErr, io.EOF) {
			return count, bytes, complete
		}
		if readErr != nil {
			return count, bytes, false
		}
	}
}
