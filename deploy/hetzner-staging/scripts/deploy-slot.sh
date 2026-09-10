#!/usr/bin/env bash
# Deploy (or replace) one platform staging slot on the Hetzner host.
#
# Usage:
#   deploy-slot.sh <slot> <image> [host_port]
#
# Examples:
#   deploy-slot.sh main ghcr.io/dmpresearch/flowstarter-main:abc123 3000
#   deploy-slot.sh pr-73 ghcr.io/dmpresearch/flowstarter-main:pr-73 3073
#
# Slots:
#   main  → https://staging.flowstarter.dev
#   pr-N  → https://pr-N.staging.flowstarter.dev
#
# Requires: docker compose, caddy (or systemctl reload caddy), write access to
# /etc/caddy/platform and /opt/flowstarter/staging.

set -euo pipefail

SLOT="${1:?slot required (main|pr-N)}"
IMAGE="${2:?image required}"
HOST_PORT="${3:-}"

STAGING_ROOT="${STAGING_ROOT:-/opt/flowstarter/staging}"
CADDY_PLATFORM_DIR="${CADDY_PLATFORM_DIR:-/etc/caddy/platform}"
ENV_FILE="${FLOWSTARTER_ENV_FILE:-/etc/flowstarter/staging.env}"
COMPOSE_FILE="${STAGING_ROOT}/docker-compose.yml"
DOMAIN_BASE="${STAGING_DOMAIN_BASE:-staging.flowstarter.dev}"

if [[ ! "$SLOT" =~ ^(main|pr-[1-9][0-9]*)$ ]]; then
  echo "invalid slot: $SLOT (expected main or pr-<number>)" >&2
  exit 1
fi

if [[ -z "$HOST_PORT" ]]; then
  if [[ "$SLOT" == "main" ]]; then
    HOST_PORT=3000
  else
    # pr-73 → 3073 (keeps ports in 3000–3999 for PR numbers under 1000)
    PR_NUM="${SLOT#pr-}"
    HOST_PORT=$((3000 + PR_NUM))
  fi
fi

if [[ "$SLOT" == "main" ]]; then
  HOSTNAME="$DOMAIN_BASE"
else
  HOSTNAME="${SLOT}.${DOMAIN_BASE}"
fi

CONTAINER="flowstarter-staging-${SLOT}"
PROJECT="fs-staging-${SLOT}"

mkdir -p "$CADDY_PLATFORM_DIR" "$STAGING_ROOT"

export FLOWSTARTER_IMAGE="$IMAGE"
export FLOWSTARTER_CONTAINER="$CONTAINER"
export FLOWSTARTER_HOST_PORT="$HOST_PORT"
export FLOWSTARTER_ENV_FILE="$ENV_FILE"

echo "Pulling $IMAGE ..."
docker pull "$IMAGE"

echo "Starting $CONTAINER on 127.0.0.1:${HOST_PORT} ..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans

SNIPPET="${CADDY_PLATFORM_DIR}/${SLOT}.caddy"
cat >"$SNIPPET" <<EOF
# Managed by flowstarter staging deploy-slot.sh — slot ${SLOT}
${HOSTNAME} {
	encode gzip
	reverse_proxy 127.0.0.1:${HOST_PORT}
}
EOF

echo "Wrote $SNIPPET"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload caddy
else
  caddy reload --config /etc/caddy/Caddyfile --force
fi

echo "Waiting for health on :${HOST_PORT} ..."
ok=0
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" >/dev/null 2>&1; then
    ok=1
    break
  fi
  sleep 2
done
if [[ "$ok" -ne 1 ]]; then
  echo "health check failed for $CONTAINER" >&2
  docker logs "$CONTAINER" 2>&1 | tail -n 80 >&2 || true
  exit 1
fi

echo "Deployed https://${HOSTNAME} (slot=${SLOT}, port=${HOST_PORT})"
