#!/bin/sh

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

rc-update add astering default

# Only restart when already running, so fresh installs stay stopped and
# upgrades pick up the new binary.
if rc-service astering status >/dev/null 2>&1; then
	rc-service astering restart || true
fi
