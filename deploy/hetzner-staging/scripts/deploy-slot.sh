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
# Every slot shares ONE Supabase CLI stack running on the host, bound to
# 127.0.0.1:54321/:54322 (see supabase-stack.sh, README.md "Database"). This
# script makes sure that stack is up before starting the container; only slot
# `main` applies migrations and refreshes the keys in staging.env, since PR
# slots share the schema main last applied. The Caddy snippet, the only
# thing that makes a slot reachable from the internet, is written only after
# the container is healthy and its own /api/health confirms it is talking to
# the local stack, not a remote one.
#
# Requires: docker compose, caddy (or systemctl reload caddy), write access to
# /etc/caddy/platform and /opt/flowstarter/staging, supabase-stack.sh
# alongside this script.

set -euo pipefail

SLOT="${1:?slot required (main|pr-N)}"
IMAGE="${2:?image required}"
HOST_PORT="${3:-}"

STAGING_ROOT="${STAGING_ROOT:-/opt/flowstarter/staging}"
CADDY_PLATFORM_DIR="${CADDY_PLATFORM_DIR:-/etc/caddy/platform}"
ENV_FILE="${FLOWSTARTER_ENV_FILE:-/etc/flowstarter/staging.env}"
COMPOSE_FILE="${STAGING_ROOT}/docker-compose.yml"
DOMAIN_BASE="${STAGING_DOMAIN_BASE:-staging.flowstarter.dev}"
SUPABASE_STACK_SCRIPT="${SUPABASE_STACK_SCRIPT:-${STAGING_ROOT}/supabase-stack.sh}"
SUPABASE_REPO_DIR="${SUPABASE_REPO_DIR:-${STAGING_ROOT}/repo}"

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

echo "Ensuring the Supabase CLI stack is running on the host ..."
REPO_DIR="$SUPABASE_REPO_DIR" FLOWSTARTER_ENV_FILE="$ENV_FILE" \
  "$SUPABASE_STACK_SCRIPT" ensure

# A stack published on 0.0.0.0 would expose a database signed with the public
# demo JWT secret to the internet. Refuse to deploy any slot on such a host.
echo "Checking that the stack is bound to loopback only ..."
REPO_DIR="$SUPABASE_REPO_DIR" "$SUPABASE_STACK_SCRIPT" check

if [[ "$SLOT" == "main" ]]; then
  echo "Applying migrations (slot main owns the schema every slot shares) ..."
  REPO_DIR="$SUPABASE_REPO_DIR" "$SUPABASE_STACK_SCRIPT" migrate

  echo "Refreshing Supabase keys in $ENV_FILE ..."
  REPO_DIR="$SUPABASE_REPO_DIR" FLOWSTARTER_ENV_FILE="$ENV_FILE" \
    "$SUPABASE_STACK_SCRIPT" write-env
fi

echo "Pulling $IMAGE ..."
docker pull "$IMAGE"

echo "Starting $CONTAINER on 127.0.0.1:${HOST_PORT} ..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans

# The Caddy snippet is what makes a slot reachable from the internet, so it
# is written only once the container answers healthy AND reports it is
# talking to the local Supabase stack, never to a remote (production)
# project. No jq: a substring grep on the compact JSON is enough and keeps
# this script dependency-free.
echo "Waiting for health on :${HOST_PORT} ..."
ok=0
health_body=""
for _ in $(seq 1 60); do
  if health_body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null)"; then
    if printf '%s' "$health_body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' &&
      printf '%s' "$health_body" | grep -Eq '"target"[[:space:]]*:[[:space:]]*"local"'; then
      ok=1
      break
    fi
  fi
  sleep 2
done

if [[ "$ok" -ne 1 ]]; then
  echo "health check failed for $CONTAINER: did not see \"ok\":true and \"target\":\"local\" within timeout" >&2
  echo "Last /api/health body: ${health_body:-<no response>}" >&2
  docker logs "$CONTAINER" 2>&1 | tail -n 80 >&2 || true
  exit 1
fi

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

echo "Deployed https://${HOSTNAME} (slot=${SLOT}, port=${HOST_PORT})"
