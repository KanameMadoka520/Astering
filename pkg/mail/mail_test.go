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

package mail

import (
	"bufio"
	"fmt"
	"net"
	"os"
	"strings"
	"testing"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/log"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// startSMTPSink runs a minimal SMTP server which accepts everything and
// pushes each received DATA payload into the returned channel.
func startSMTPSink(t *testing.T) (port int, received chan string) {
	t.Helper()

	l, err := new(net.ListenConfig).Listen(t.Context(), "tcp", "127.0.0.1:0")
	require.NoError(t, err)
	t.Cleanup(func() {
		_ = l.Close()
	})

	received = make(chan string, 100)

	go func() {
		for {
			conn, err := l.Accept()
			if err != nil {
				return
			}
			go func(conn net.Conn) {
				defer conn.Close()
				r := bufio.NewReader(conn)
				fmt.Fprintf(conn, "220 sink ESMTP\r\n")
				for {
					line, err := r.ReadString('\n')
					if err != nil {
						return
					}
					cmd := strings.ToUpper(strings.TrimSpace(line))
					switch {
					case strings.HasPrefix(cmd, "EHLO"), strings.HasPrefix(cmd, "HELO"):
						fmt.Fprintf(conn, "250-sink\r\n250 8BITMIME\r\n")
					case strings.HasPrefix(cmd, "DATA"):
						fmt.Fprintf(conn, "354 go ahead\r\n")
						var body strings.Builder
						for {
							dl, err := r.ReadString('\n')
							if err != nil {
								return
							}
							if strings.TrimRight(dl, "\r\n") == "." {
								break
							}
							body.WriteString(dl)
						}
						received <- body.String()
						fmt.Fprintf(conn, "250 ok\r\n")
					case strings.HasPrefix(cmd, "QUIT"):
						fmt.Fprintf(conn, "221 bye\r\n")
						return
					default:
						fmt.Fprintf(conn, "250 ok\r\n")
					}
				}
			}(conn)
		}
	}()

	return l.Addr().(*net.TCPAddr).Port, received
}

func setupMailerConfig(t *testing.T, host string, port int) {
	t.Helper()

	config.InitDefaultConfig()
	log.InitLogger()
	config.MailerEnabled.Set(true)
	config.MailerHost.Set(host)
	config.MailerPort.Set(port)
	config.MailerFromEmail.Set("mail@vikunja")
	config.MailerQueueTimeout.Set(2)

	wasUnderTest := isUnderTest
	isUnderTest = false
	t.Cleanup(func() {
		isUnderTest = wasUnderTest
		StopMailDaemon()
	})
}

func TestStopMailDaemonDrainsQueue(t *testing.T) {
	port, received := startSMTPSink(t)
	setupMailerConfig(t, "127.0.0.1", port)

	StartMailDaemon()

	for i := range 3 {
		SendMail(&Opts{
			To:          fmt.Sprintf("test%d@example.com", i),
			Subject:     fmt.Sprintf("Test %d", i),
			Message:     "Hello",
			ContentType: ContentTypePlain,
		})
	}

	StopMailDaemon()

	assert.Len(t, received, 3, "expected all queued mails to be delivered before StopMailDaemon returns")
	assert.Nil(t, Queue)
}

func TestStopMailDaemonMailerDisabled(t *testing.T) {
	config.InitDefaultConfig()
	config.MailerEnabled.Set(false)

	StartMailDaemon()
	assert.Nil(t, Queue)

	assert.NotPanics(t, StopMailDaemon)
}

func TestStopMailDaemonNeverStarted(t *testing.T) {
	setupMailerConfig(t, "", 587)

	// Empty host: StartMailDaemon creates the queue but never starts the daemon goroutine.
	StartMailDaemon()
	assert.NotNil(t, Queue)

	assert.NotPanics(t, StopMailDaemon)
	assert.Nil(t, Queue)
}

func TestStopMailDaemonCalledTwice(t *testing.T) {
	port, _ := startSMTPSink(t)
	setupMailerConfig(t, "127.0.0.1", port)

	StartMailDaemon()

	assert.NotPanics(t, StopMailDaemon)
	assert.NotPanics(t, StopMailDaemon)
}

func TestTCYMailRuntimeReload(t *testing.T) {
	port1, received1 := startSMTPSink(t)
	port2, received2 := startSMTPSink(t)
	setupMailerConfig(t, "127.0.0.1", port1)
	t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
	require.NoError(t, os.Unsetenv("ASTERING_SETTINGS_ADMIN_IDS"))
	t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "1")
	config.SetMailerRuntime(nil)
	t.Cleanup(func() { StopMailDaemon(); config.SetMailerRuntime(nil) })
	config.MailerEnabled.Set(false)
	StartMailDaemon()
	c := config.CurrentMailerRuntime()
	c.Enabled = true
	c.AuthType = "none"
	c.Revision = 1
	config.SetMailerRuntime(&c)
	send := func() {
		SendMail(&Opts{To: "test@example.com", Subject: "Runtime reload", Message: "Isolated SMTP sink", ContentType: ContentTypePlain})
	}
	send()
	select {
	case <-received1:
	case <-time.After(5 * time.Second):
		t.Fatal("first relay did not receive mail")
	}
	c.Port = port2
	c.FromEmail = "changed@example.com"
	c.Revision = 2
	config.SetMailerRuntime(&c)
	send()
	select {
	case msg := <-received2:
		assert.Contains(t, msg, "changed@example.com")
	case <-time.After(5 * time.Second):
		t.Fatal("new relay did not receive mail")
	}
	StopMailDaemon()
	assert.Empty(t, received1)
}

func TestAsteringMailDaemonAdminCompatibility(t *testing.T) {
	config.InitDefaultConfig()
	config.SetMailerRuntime(nil)
	config.MailerEnabled.Set(false)
	t.Cleanup(func() {
		StopMailDaemon()
		config.SetMailerRuntime(nil)
	})

	t.Run("new allowlist enables dynamic mail configuration", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "7")
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "")
		StartMailDaemon()
		assert.NotNil(t, Queue)
		StopMailDaemon()
	})
	t.Run("explicitly empty new allowlist disables legacy access", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2")
		StartMailDaemon()
		assert.Nil(t, Queue)
		StopMailDaemon()
	})
	t.Run("absent new allowlist preserves legacy configuration", func(t *testing.T) {
		t.Setenv("ASTERING_SETTINGS_ADMIN_IDS", "")
		require.NoError(t, os.Unsetenv("ASTERING_SETTINGS_ADMIN_IDS"))
		t.Setenv("TCYMC_SETTINGS_ADMIN_IDS", "2")
		StartMailDaemon()
		assert.NotNil(t, Queue)
		StopMailDaemon()
	})
}
