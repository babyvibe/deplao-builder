#!/usr/bin/env bash
set -Eeuo pipefail

APP_DIR="${APP_DIR:-/opt/deplao-builder-t123}"
SERVICE="${DEPLAO_SERVICE:-deplao-web}"
BRANCH="${DEPLOY_BRANCH:-main}"
SHA="${DEPLOY_SHA:-}"
BACKUP_DIR="${APP_DIR}/.deploy-backups"

cd "$APP_DIR"
mkdir -p "$BACKUP_DIR"

git fetch --prune origin "$BRANCH"
TARGET="${SHA:-origin/$BRANCH}"
git cat-file -e "$TARGET^{commit}"

CURRENT="$(git rev-parse HEAD)"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
printf '%s\n' "$CURRENT" > "$BACKUP_DIR/$STAMP.commit"

# Secrets, profile, SQLite and media stay outside Git and are never overwritten.
git reset --hard "$TARGET"
npm ci --legacy-peer-deps
npm run rebuild:native
npm run build:electron
npm run build:web

sudo systemctl restart "$SERVICE"
sleep 3
"$APP_DIR/deploy/healthcheck.sh"

# Keep the last five commit pointers for manual rollback.
ls -1t "$BACKUP_DIR"/*.commit 2>/dev/null | tail -n +6 | xargs -r rm -f
printf 'deployed %s (%s)\n' "$TARGET" "$(date -u +%FT%TZ)"
