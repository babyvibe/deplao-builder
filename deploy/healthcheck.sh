#!/usr/bin/env bash
set -Eeuo pipefail

BASE_URL="${DEPLAO_HEALTH_URL:-http://127.0.0.1:${DEPLAO_WEB_PORT:-27800}}"
curl --fail --silent --show-error --max-time 15 "$BASE_URL/api/v1/health" >/dev/null || \
  curl --fail --silent --show-error --max-time 15 "$BASE_URL/" >/dev/null
systemctl is-active --quiet "${DEPLAO_SERVICE:-deplao-web}"
printf 'Deplao health check passed: %s\n' "$BASE_URL"
