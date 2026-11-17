#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/deplao-builder-t123}"
SERVICE="${DEPLAO_SERVICE:-deplao-web}"
COMMIT_FILE="${1:?Usage: rollback-vps.sh /opt/deplao-builder-t123/.deploy-backups/<timestamp>.commit}"

cd "$APP_DIR"
TARGET="$(cat "$COMMIT_FILE")"
git cat-file -e "$TARGET^{commit}"
git reset --hard "$TARGET"
npm ci --legacy-peer-deps
npm run rebuild:native
npm run build:electron
npm run build:web
sudo systemctl restart "$SERVICE"
sleep 3
"$APP_DIR/deploy/healthcheck.sh"
