#!/bin/bash

# This package installs /etc/astering and /opt/astering only. Existing Vikunja
# configuration, databases and services are never migrated or stopped here.
# The shipped config is fully commented out, so the secret must be live yaml.
# Skipping an existing service section avoids a duplicate key on upgrades.
if ! grep -q '^service:' /etc/astering/config.yml; then
	NEW_SECRET=$(head -c 512 /dev/urandom | tr -dc 'a-zA-Z0-9' | head -c 32)
	printf '\nservice:\n  secret: "%s"\n' "$NEW_SECRET" >> /etc/astering/config.yml
fi

sed -i "s/<rootpath>/\/opt\/astering\//g" /etc/astering/config.yml
sed -i "s/path: \"\.\/astering.db\"/path: \"\\/opt\/astering\/astering.db\"/g" /etc/astering/config.yml

systemctl enable astering.service

# Nothing to reload or restart in chroots and containers without systemd.
if [ -d /run/systemd/system ]; then
	# Pick up changes to astering.service itself.
	systemctl daemon-reload || true
	# try-restart is a no-op while the unit is stopped, so fresh installs stay
	# stopped and upgrades pick up the new binary.
	systemctl try-restart astering.service || true
fi
