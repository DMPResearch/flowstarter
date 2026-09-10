#!/usr/bin/env bash
# Tear down one platform staging slot (container + Caddy snippet).
#
# Usage:
#   destroy-slot.sh <slot>

set -euo pipefail

SLOT="${1:?slot required (main|pr-N)}"

STAGING_ROOT="${STAGING_ROOT:-/opt/flowstarter/staging}"
CADDY_PLATFORM_DIR="${CADDY_PLATFORM_DIR:-/etc/caddy/platform}"
COMPOSE_FILE="${STAGING_ROOT}/docker-compose.yml"
PROJECT="fs-staging-${SLOT}"
CONTAINER="flowstarter-staging-${SLOT}"

if [[ ! "$SLOT" =~ ^(main|pr-[1-9][0-9]*)$ ]]; then
  echo "invalid slot: $SLOT" >&2
  exit 1
fi

if [[ -f "$COMPOSE_FILE" ]]; then
  docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down --remove-orphans || true
fi
docker rm -f "$CONTAINER" 2>/dev/null || true

SNIPPET="${CADDY_PLATFORM_DIR}/${SLOT}.caddy"
rm -f "$SNIPPET"

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload caddy || true
else
  caddy reload --config /etc/caddy/Caddyfile --force || true
fi

echo "Destroyed slot ${SLOT}"
