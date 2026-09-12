#!/usr/bin/env bash
# Deploy (or replace) one platform slot on the Hetzner host.
#
# Usage:
#   deploy-slot.sh <slot> <image> [host_port]
#
# Examples:
#   deploy-slot.sh main ghcr.io/dmpresearch/flowstarter-main:abc123 3000
#   deploy-slot.sh pr-73 ghcr.io/dmpresearch/flowstarter-main:pr-73 3073
#   deploy-slot.sh prod ghcr.io/dmpresearch/flowstarter-main:release-2026-09-14 3100
#
# Slots:
#   main  → https://staging.flowstarter.dev           port 3000   staging.env
#   pr-N  → https://pr-N.staging.flowstarter.dev      port 3000+N staging.env
#   prod  → https://flowstarter.net (+ www redirect)  port 3100   prod.env
#
# Staging slots (main, pr-N)
#   They share ONE Supabase CLI stack running on the host, bound to
#   127.0.0.1:54321/:54322 (see supabase-stack.sh, README.md "Database"). This
#   script makes sure that stack is up before starting the container; only slot
#   `main` applies migrations and refreshes the keys in staging.env, since PR
#   slots share the schema main last applied. The Caddy snippet, the only
#   thing that makes a slot reachable from the internet, is written only after
#   the container is healthy and its own /api/health confirms it is talking to
#   the local stack, not a remote one.
#
# The prod slot
#   Production runs against the hosted Supabase project, so it does NOT touch
#   the local stack: no `ensure`, no `check`, no `migrate`, no `write-env`. Its
#   health gate asserts `"env":"production"` instead of `"target":"local"`.
#   Production schema changes are applied deliberately, by hand, against the
#   hosted project; nothing in this script writes to it.
#
# Requires: docker compose, caddy (or systemctl reload caddy), write access to
# /etc/caddy/platform and /opt/flowstarter/staging, supabase-stack.sh
# alongside this script (staging slots only).

set -euo pipefail

SLOT="${1:?slot required (main|prod|pr-N)}"
IMAGE="${2:?image required}"
HOST_PORT="${3:-}"

STAGING_ROOT="${STAGING_ROOT:-/opt/flowstarter/staging}"
CADDY_PLATFORM_DIR="${CADDY_PLATFORM_DIR:-/etc/caddy/platform}"
COMPOSE_FILE="${STAGING_ROOT}/docker-compose.yml"
DOMAIN_BASE="${STAGING_DOMAIN_BASE:-staging.flowstarter.dev}"
PROD_DOMAIN="${PROD_DOMAIN:-flowstarter.net}"
PROD_TLS_DIR="${PROD_TLS_DIR:-/etc/flowstarter/tls}"
SUPABASE_STACK_SCRIPT="${SUPABASE_STACK_SCRIPT:-${STAGING_ROOT}/supabase-stack.sh}"
SUPABASE_REPO_DIR="${SUPABASE_REPO_DIR:-${STAGING_ROOT}/repo}"

if [[ ! "$SLOT" =~ ^(main|prod|pr-[1-9][0-9]*)$ ]]; then
  echo "invalid slot: $SLOT (expected main, prod or pr-<number>)" >&2
  exit 1
fi

# ── Per-slot mapping ────────────────────────────────────────────────────────
# One place decides port, hostname, env file, container and compose project, so
# the branches below (and destroy-slot.sh) cannot drift apart.
case "$SLOT" in
  prod)
    DEFAULT_PORT=3100
    PRIMARY_HOSTNAME="$PROD_DOMAIN"
    DEFAULT_ENV_FILE="/etc/flowstarter/prod.env"
    CONTAINER="flowstarter-prod"
    PROJECT="fs-prod"
    FLOWSTARTER_ENV_VALUE="production"
    ;;
  main)
    DEFAULT_PORT=3000
    PRIMARY_HOSTNAME="$DOMAIN_BASE"
    DEFAULT_ENV_FILE="/etc/flowstarter/staging.env"
    CONTAINER="flowstarter-staging-main"
    PROJECT="fs-staging-main"
    FLOWSTARTER_ENV_VALUE="staging"
    ;;
  *)
    # pr-73 → 3073 (keeps ports in 3000-3999 for PR numbers under 1000)
    PR_NUM="${SLOT#pr-}"
    DEFAULT_PORT=$((3000 + PR_NUM))
    PRIMARY_HOSTNAME="${SLOT}.${DOMAIN_BASE}"
    DEFAULT_ENV_FILE="/etc/flowstarter/staging.env"
    CONTAINER="flowstarter-staging-${SLOT}"
    PROJECT="fs-staging-${SLOT}"
    FLOWSTARTER_ENV_VALUE="staging"
    ;;
esac

HOST_PORT="${HOST_PORT:-$DEFAULT_PORT}"
ENV_FILE="${FLOWSTARTER_ENV_FILE:-$DEFAULT_ENV_FILE}"

mkdir -p "$CADDY_PLATFORM_DIR" "$STAGING_ROOT"

export FLOWSTARTER_IMAGE="$IMAGE"
export FLOWSTARTER_CONTAINER="$CONTAINER"
export FLOWSTARTER_HOST_PORT="$HOST_PORT"
export FLOWSTARTER_ENV_FILE="$ENV_FILE"

# docker-compose.yml no longer hard-codes FLOWSTARTER_ENV=staging; it reads the
# value from the slot's env file, which is what lets one compose file serve
# both staging and production. An env file written before that change carries
# no such line, and the app would then fall back to NODE_ENV and call a staging
# container "production". Upsert the line rather than trust it.
if [[ ! -f "$ENV_FILE" ]]; then
  echo "env file not found: $ENV_FILE (create it, mode 600, before deploying slot ${SLOT})" >&2
  exit 1
fi
if grep -q '^FLOWSTARTER_ENV=' "$ENV_FILE"; then
  # Rewritten through a temp file and `cat >` rather than `sed -i` or `mv`:
  # `cat >` into the existing path keeps the file's mode 600 and its
  # ownership, where `mv` would hand it the temp file's. The temp file is made
  # beside the original (same directory, same filesystem) so a file holding
  # secrets never appears under a world-traversable /tmp.
  ENV_TMP="$(mktemp "${ENV_FILE}.XXXXXX")"
  grep -v '^FLOWSTARTER_ENV=' "$ENV_FILE" >"$ENV_TMP" || true
  printf 'FLOWSTARTER_ENV=%s\n' "$FLOWSTARTER_ENV_VALUE" >>"$ENV_TMP"
  cat "$ENV_TMP" >"$ENV_FILE"
  rm -f "$ENV_TMP"
else
  # An env file whose last line has no newline would otherwise get
  # `...keyFLOWSTARTER_ENV=production` glued onto it.
  if [[ -s "$ENV_FILE" ]] && [[ -n "$(tail -c 1 "$ENV_FILE")" ]]; then
    printf '\n' >>"$ENV_FILE"
  fi
  printf 'FLOWSTARTER_ENV=%s\n' "$FLOWSTARTER_ENV_VALUE" >>"$ENV_FILE"
fi
echo "Set FLOWSTARTER_ENV=${FLOWSTARTER_ENV_VALUE} in ${ENV_FILE}"

if [[ "$SLOT" == "prod" ]]; then
  echo "Slot prod talks to the hosted Supabase project; skipping every local-stack step."
else
  echo "Ensuring the Supabase CLI stack is running on the host ..."
  REPO_DIR="$SUPABASE_REPO_DIR" FLOWSTARTER_ENV_FILE="$ENV_FILE" \
    "$SUPABASE_STACK_SCRIPT" ensure

  # A stack published on 0.0.0.0 would expose a database signed with the public
  # demo JWT secret to the internet. Refuse to deploy any staging slot on such
  # a host.
  echo "Checking that the stack is bound to loopback only ..."
  REPO_DIR="$SUPABASE_REPO_DIR" "$SUPABASE_STACK_SCRIPT" check

  if [[ "$SLOT" == "main" ]]; then
    echo "Applying migrations (slot main owns the schema every staging slot shares) ..."
    REPO_DIR="$SUPABASE_REPO_DIR" "$SUPABASE_STACK_SCRIPT" migrate

    echo "Refreshing Supabase keys in $ENV_FILE ..."
    REPO_DIR="$SUPABASE_REPO_DIR" FLOWSTARTER_ENV_FILE="$ENV_FILE" \
      "$SUPABASE_STACK_SCRIPT" write-env
  fi
fi

echo "Pulling $IMAGE ..."
docker pull "$IMAGE"

echo "Starting $CONTAINER on 127.0.0.1:${HOST_PORT} ..."
docker compose -p "$PROJECT" -f "$COMPOSE_FILE" up -d --force-recreate --remove-orphans

# The Caddy snippet is what makes a slot reachable from the internet, so it is
# written only once the container answers healthy AND reports the environment
# it is supposed to be: a staging slot must be talking to the local Supabase
# stack and never a remote (production) project, and the prod slot must be
# running as `production` rather than a staging image landed on the wrong port.
# No jq: a substring grep on the compact JSON is enough and keeps this script
# dependency-free.
if [[ "$SLOT" == "prod" ]]; then
  HEALTH_PATTERN='"env"[[:space:]]*:[[:space:]]*"production"'
  HEALTH_DESC='"env":"production"'
else
  HEALTH_PATTERN='"target"[[:space:]]*:[[:space:]]*"local"'
  HEALTH_DESC='"target":"local"'
fi

echo "Waiting for health on :${HOST_PORT} (expecting ${HEALTH_DESC}) ..."
ok=0
health_body=""
for _ in $(seq 1 60); do
  if health_body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/api/health" 2>/dev/null)"; then
    if printf '%s' "$health_body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true' &&
      printf '%s' "$health_body" | grep -Eq "$HEALTH_PATTERN"; then
      ok=1
      break
    fi
  fi
  sleep 2
done

if [[ "$ok" -ne 1 ]]; then
  echo "health check failed for $CONTAINER: did not see \"ok\":true and ${HEALTH_DESC} within timeout" >&2
  echo "Last /api/health body: ${health_body:-<no response>}" >&2
  docker logs "$CONTAINER" 2>&1 | tail -n 80 >&2 || true
  exit 1
fi

SNIPPET="${CADDY_PLATFORM_DIR}/${SLOT}.caddy"
if [[ "$SLOT" == "prod" ]]; then
  # Cloudflare proxies flowstarter.net, so Caddy never sees a Let's Encrypt
  # HTTP-01 challenge and must not reach for a public certificate. Two
  # supported modes, in order of preference:
  #   1. A Cloudflare Origin CA certificate under /etc/flowstarter/tls. Pair it
  #      with Cloudflare SSL/TLS mode "Full (strict)".
  #   2. `tls internal`, Caddy's own local CA. Cloudflare SSL/TLS must then be
  #      "Full", not "Full (strict)", because Cloudflare cannot chain that
  #      certificate to a public root.
  PROD_CRT="${PROD_TLS_DIR}/${PROD_DOMAIN}.crt"
  PROD_KEY="${PROD_TLS_DIR}/${PROD_DOMAIN}.key"
  if [[ -f "$PROD_CRT" && -f "$PROD_KEY" ]]; then
    TLS_LINE="tls ${PROD_CRT} ${PROD_KEY}"
    TLS_NOTE="# Cloudflare Origin CA certificate in use. Cloudflare SSL/TLS: Full (strict)."
  else
    TLS_LINE="tls internal"
    TLS_NOTE="# No Origin CA certificate at ${PROD_CRT}; using Caddy's local CA.
	# Cloudflare SSL/TLS MUST be set to Full (NOT Full strict) while this holds."
  fi
  cat >"$SNIPPET" <<EOF
# Managed by flowstarter deploy-slot.sh, slot ${SLOT}
www.${PROD_DOMAIN} {
	${TLS_NOTE}
	${TLS_LINE}
	redir https://${PROD_DOMAIN}{uri} permanent
}

${PROD_DOMAIN} {
	${TLS_NOTE}
	${TLS_LINE}
	encode gzip
	reverse_proxy 127.0.0.1:${HOST_PORT}
}
EOF
else
  cat >"$SNIPPET" <<EOF
# Managed by flowstarter staging deploy-slot.sh, slot ${SLOT}
${PRIMARY_HOSTNAME} {
	encode gzip
	reverse_proxy 127.0.0.1:${HOST_PORT}
}
EOF
fi

echo "Wrote $SNIPPET"
if command -v systemctl >/dev/null 2>&1; then
  systemctl reload caddy
else
  caddy reload --config /etc/caddy/Caddyfile --force
fi

echo "Deployed https://${PRIMARY_HOSTNAME} (slot=${SLOT}, port=${HOST_PORT})"
