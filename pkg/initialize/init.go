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

package initialize

import (
	"context"
	"time"

	"github.com/KanameMadoka520/Astering/pkg/audit"
	"github.com/KanameMadoka520/Astering/pkg/config"
	"github.com/KanameMadoka520/Astering/pkg/cron"
	"github.com/KanameMadoka520/Astering/pkg/db"
	"github.com/KanameMadoka520/Astering/pkg/events"
	"github.com/KanameMadoka520/Astering/pkg/files"
	"github.com/KanameMadoka520/Astering/pkg/i18n"
	"github.com/KanameMadoka520/Astering/pkg/license"
	"github.com/KanameMadoka520/Astering/pkg/log"
	"github.com/KanameMadoka520/Astering/pkg/mail"
	"github.com/KanameMadoka520/Astering/pkg/migration"
	"github.com/KanameMadoka520/Astering/pkg/models"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth/ldap"
	"github.com/KanameMadoka520/Astering/pkg/modules/auth/openid"
	"github.com/KanameMadoka520/Astering/pkg/modules/bark"
	"github.com/KanameMadoka520/Astering/pkg/modules/keyvalue"
	"github.com/KanameMadoka520/Astering/pkg/modules/mailsettings"
	migrationmodule "github.com/KanameMadoka520/Astering/pkg/modules/migration"
	migrationHandler "github.com/KanameMadoka520/Astering/pkg/modules/migration/handler"
	"github.com/KanameMadoka520/Astering/pkg/plugins"
	_ "github.com/KanameMadoka520/Astering/pkg/plugins/yaegi" // register yaegi plugin loader
	"github.com/KanameMadoka520/Astering/pkg/red"
	"github.com/KanameMadoka520/Astering/pkg/user"
	ws "github.com/KanameMadoka520/Astering/pkg/websocket"
)

// LightInit will only init config, redis, logger but no db connection.
func LightInit() {
	// Set logger
	log.InitLogger()

	// Init the config
	config.InitConfig()

	// Check if the configured time zone is valid
	if _, err := time.LoadLocation(config.ServiceTimeZone.GetString()); err != nil {
		log.Criticalf("Error parsing default time zone: %s", err)
	}

	// Init redis
	red.InitRedis()

	// Init keyvalue store
	keyvalue.InitStorage()
}

// InitEngines intializes all db connections
func InitEngines() {
	err := models.SetEngine()
	if err != nil {
		log.Fatal(err.Error())
	}
	err = files.SetEngine()
	if err != nil {
		log.Fatal(err.Error())
	}

	err = db.CreateParadeDBIndexes()
	if err != nil {
		log.Fatal(err.Error())
	}
}

// FullInitWithoutAsync does a full init without any async handlers (cron or events)
func FullInitWithoutAsync() {
	LightInit()

	// Initialize the files handler
	err := files.InitFileHandler(context.Background())
	if err != nil {
		log.Fatalf("Could not init file handler: %s", err)
	}

	// Run the migrations
	migration.Migrate(nil)

	// Set Engine
	InitEngines()

	// Initialize license validation — funds ongoing development of Vikunja.
	// See the package comment in pkg/license/license.go before removing.
	license.Init()

	if config.AuditEnabled.GetBool() {
		if err := audit.Init(); err != nil {
			log.Fatalf("Could not initialize audit logging: %s", err)
		}
	}

	if err := mailsettings.Initialize(); err != nil {
		log.Fatalf("Could not initialize SMTP settings: %s", err)
	}

	// Start the mail daemon
	mail.StartMailDaemon()
	bark.Start()

	// Connect to ldap if enabled
	ldap.InitializeLDAPConnection()

	// Check all OpenID Connect providers at startup
	_, err = openid.GetAllProviders()
	if err != nil {
		if openid.IsErrDuplicateOIDCIssuer(err) {
			log.Fatalf("OpenID Connect configuration error: %s", err)
		}
		log.Errorf("Error initializing OpenID Connect providers: %s", err)
	}

	// Load translations
	i18n.Init()

	// Initialize plugins
	plugins.Initialize()
}

// FullInit initializes all kinds of things in the right order
func FullInit() {

	FullInitWithoutAsync()

	// Start the cron
	cron.Init()
	models.RegisterReminderCron()
	models.RegisterOverdueReminderCron()
	models.RegisterUserDeletionCron()
	models.RegisterTaskCleanupCron()
	models.RegisterOldExportCleanupCron()
	migrationmodule.RegisterImportUploadCleanupCron()
	models.RegisterAddTaskToFilterViewCron()
	user.RegisterTokenCleanupCron()
	models.RegisterSessionCleanupCron()
	user.RegisterDeletionNotificationCron()
	openid.CleanupSavedOpenIDProviders()
	openid.RegisterEmptyOpenIDTeamCleanupCron()
	openid.RegisterProviderAvailabilityCron()
	models.RegisterAPITokenExpiryCheckCron()

	// Initialize WebSocket hub
	ws.InitHub()

	// Start processing events
	go func() {
		models.RegisterListeners()
		migrationHandler.RegisterListeners()
		ws.RegisterListeners()
		err := events.InitEvents()
		if err != nil {
			log.Fatal(err.Error())
		}

		err = events.Dispatch(&BootedEvent{
			BootedAt: time.Now(),
		})
		if err != nil {
			log.Fatal(err)
		}
	}()
}
