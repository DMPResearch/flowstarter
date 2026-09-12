#!/usr/bin/env bash
# Tear down one platform slot (container + Caddy snippet).
#
# Usage:
#   destroy-slot.sh <slot>
#
# Slots: main, pr-N, prod. The mapping from slot to container and compose
# project must match deploy-slot.sh exactly, or a torn-down slot leaves its
# container running.
#
# Destroying `prod` takes the production site off the internet, and nothing in
# CI ever asks for it, so it needs DESTROY_PROD=1 in the environment as well as
# the argument:
#   sudo DESTROY_PROD=1 /opt/flowstarter/staging/destroy-slot.sh prod

set -euo pipefail

SLOT="${1:?slot required (main|prod|pr-N)}"

STAGING_ROOT="${STAGING_ROOT:-/opt/flowstarter/staging}"
CADDY_PLATFORM_DIR="${CADDY_PLATFORM_DIR:-/etc/caddy/platform}"
COMPOSE_FILE="${STAGING_ROOT}/docker-compose.yml"

if [[ ! "$SLOT" =~ ^(main|prod|pr-[1-9][0-9]*)$ ]]; then
  echo "invalid slot: $SLOT" >&2
  exit 1
fi

case "$SLOT" in
  prod)
    PROJECT="fs-prod"
    CONTAINER="flowstarter-prod"
    if [[ "${DESTROY_PROD:-}" != "1" ]]; then
      echo "refusing to destroy slot prod without DESTROY_PROD=1 in the environment" >&2
      exit 1
    fi
    ;;
  *)
    PROJECT="fs-staging-${SLOT}"
    CONTAINER="flowstarter-staging-${SLOT}"
    ;;
esac

if [[ -f "$COMPOSE_FILE" ]]; then
  FLOWSTARTER_CONTAINER="$CONTAINER" \
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
