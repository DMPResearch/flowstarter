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
# Locking
#   This host runs ONE shared Supabase CLI stack and ONE Caddy config
#   directory for every slot. Two lanes deploying in the same minute (e.g.
#   `main` and a `pr-N`, or two `pr-N`s) can otherwise interleave
#   `supabase-stack.sh ensure/check/migrate` or the write-then-reload of a
#   Caddy snippet, and one of them fails at random (observed 2026-09-14:
#   pr-127's SSH deploy step failed while main and pr-134 were deploying in
#   the same minute; the same command succeeded by hand right after). Both
#   sections are wrapped in `flock` on STAGING_LOCK_FILE, acquired and
#   released separately so the lock is never held across the two. Per-slot
#   work that touches nothing shared -- the image pull, `docker compose up`,
#   the health wait -- runs outside both locks and stays parallel across
#   slots.
#
# Requires: docker compose, caddy (or systemctl reload caddy), flock, write
# access to /etc/caddy/platform and /opt/flowstarter/staging, supabase-stack.sh
# alongside this script (staging slots only).
#
# Env overrides (locking):
#   STAGING_LOCK_FILE     default ${STAGING_ROOT}/deploy.lock
#   STAGING_LOCK_TIMEOUT  seconds to wait for the lock before giving up, default 300
#
# Disk retention (2026-09-15 incident: the root disk filled to 100% because
# nothing ever removed an old per-commit image; see prune-images.sh's header
# for the full account). Every deploy runs prune-images.sh twice: once here,
# as a preflight, before anything else, and once more after a successful
# deploy. Unlike the Supabase-stack/Caddy sections above, neither call is
# wrapped in the flock: prune-images.sh only ever runs a non-forced
# `docker rmi` and `docker builder prune`, both of which the daemon itself
# makes safe to run twice at once (a second `docker rmi` of an already-gone
# tag just fails, which prune-images.sh already treats as a soft skip; a
# second `docker builder prune` is a no-op) — nothing here writes shared
# config the way the Caddy snippet or the Supabase migration state does.
#
# Env overrides (disk retention):
#   PRUNE_IMAGES_SCRIPT      default ${STAGING_ROOT}/prune-images.sh
#   FLOWSTARTER_DISK_FLOOR_MB   preflight fails below this many MB free,
#                               after running retention, default 10240 (10
#                               GiB — see DEFAULT_DISK_FLOOR_MB)
#   FLOWSTARTER_DISK_CHECK_PATH path `df` is asked about, default / (the
#                               2026-09-15 incident was the root disk)
#   See prune-images.sh's own header for FLOWSTARTER_IMAGE_REPO,
#   FLOWSTARTER_IMAGE_KEEP_COUNT and FLOWSTARTER_OPS_ENV_FILE.

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
STAGING_LOCK_FILE="${STAGING_LOCK_FILE:-${STAGING_ROOT}/deploy.lock}"
STAGING_LOCK_TIMEOUT="${STAGING_LOCK_TIMEOUT:-300}"

PRUNE_IMAGES_SCRIPT="${PRUNE_IMAGES_SCRIPT:-${STAGING_ROOT}/prune-images.sh}"
# Named default, not a literal buried in the check below — same reasoning as
# backup.sh's DEFAULT_KEEP_DAILY/WEEKLY. 10 GiB: room for at least a couple
# of ~2 GB image pulls plus headroom for the Supabase/Cal stacks and a
# nightly backup run, on a 150 GB disk.
DEFAULT_DISK_FLOOR_MB=10240
FLOWSTARTER_DISK_FLOOR_MB="${FLOWSTARTER_DISK_FLOOR_MB:-$DEFAULT_DISK_FLOOR_MB}"
FLOWSTARTER_DISK_CHECK_PATH="${FLOWSTARTER_DISK_CHECK_PATH:-/}"

if [[ ! "$SLOT" =~ ^(main|prod|pr-[1-9][0-9]*)$ ]]; then
  echo "invalid slot: $SLOT (expected main, prod or pr-<number>)" >&2
  exit 1
fi

# ── Disk retention: preflight ───────────────────────────────────────────────
# Run the same retention pass a successful deploy runs at the end (below)
# here too, before anything else, so a box that already needs it gets
# cleaned before this deploy's own image pull adds to the pile rather than
# after. Then refuse to proceed if free space is still below the floor once
# that pass is done: failing here, with a clear message, beats failing later
# at some unrelated step — a full disk was first noticed, 2026-09-15, as the
# Supabase stack going unhealthy at "ensure stack", not as a disk error.
echo "Running image retention (${PRUNE_IMAGES_SCRIPT}) before checking free space on ${FLOWSTARTER_DISK_CHECK_PATH} ..."
if [[ -x "$PRUNE_IMAGES_SCRIPT" ]]; then
  "$PRUNE_IMAGES_SCRIPT" || echo "warning: ${PRUNE_IMAGES_SCRIPT} exited non-zero; continuing to the disk check anyway" >&2
else
  echo "warning: retention script not found or not executable at ${PRUNE_IMAGES_SCRIPT}; skipping image retention" >&2
fi

FREE_MB="$(df -Pm "$FLOWSTARTER_DISK_CHECK_PATH" 2>/dev/null | awk 'NR==2 {print $4}')"
if [[ -z "${FREE_MB:-}" ]]; then
  echo "warning: could not determine free space on ${FLOWSTARTER_DISK_CHECK_PATH} (df failed or produced no output); continuing without the disk floor check" >&2
elif [[ "$FREE_MB" -lt "$FLOWSTARTER_DISK_FLOOR_MB" ]]; then
  echo "refusing to deploy ${SLOT}: only ${FREE_MB} MB free on ${FLOWSTARTER_DISK_CHECK_PATH}, below the ${FLOWSTARTER_DISK_FLOOR_MB} MB floor (FLOWSTARTER_DISK_FLOOR_MB) even after running image retention (${PRUNE_IMAGES_SCRIPT}). Free space by hand before retrying — see README.md, \"Disk\"." >&2
  exit 1
fi

# ── Shared-host locking ─────────────────────────────────────────────────────
# fd 200, not bash 4's `exec {FD}>...`, so this still runs under the bash 3.2
# shipped on macOS as well as the host's bash. Held only around the two
# sections that touch state shared by every slot on the box: the Supabase
# CLI stack, and the Caddy config directory + reload. Each section acquires
# and releases independently -- the lock is never held across both, and
# never held during the image pull, `docker compose up`, or the health wait,
# so independent slots keep deploying in parallel there.
lock_acquire() {
  local label="$1"
  mkdir -p "$(dirname "$STAGING_LOCK_FILE")"
  exec 200>>"$STAGING_LOCK_FILE"
  if ! flock -w "$STAGING_LOCK_TIMEOUT" 200; then
    local holder
    holder="$(cat "${STAGING_LOCK_FILE}.holder" 2>/dev/null || true)"
    echo "timed out after ${STAGING_LOCK_TIMEOUT}s waiting for the deploy lock (${STAGING_LOCK_FILE}) needed for: ${label}" >&2
    echo "lock currently held by: ${holder:-<unknown; check for a stuck deploy on this host>}" >&2
    exec 200>&-
    exit 1
  fi
  # Diagnostic only, not the source of truth for the lock itself (the flock
  # syscall on fd 200 is): read by a waiter that times out, so a stuck
  # deploy names itself instead of leaving the next lane to guess.
  printf 'slot=%s pid=%s step=%s since=%s\n' "$SLOT" "$$" "$label" "$(date -u +%FT%TZ)" >"${STAGING_LOCK_FILE}.holder"
  echo "Acquired deploy lock (${STAGING_LOCK_FILE}) for: ${label}"
}

lock_release() {
  rm -f "${STAGING_LOCK_FILE}.holder" 2>/dev/null || true
  exec 200>&-
  echo "Released deploy lock (${STAGING_LOCK_FILE})"
}

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
# /api/health reports this as `commit`, which is what
# wait-for-staging-slot.sh polls for so it can tell a slot still serving the
# previous build (while this one deploys underneath it) apart from one
# already on the commit under test. The image is content-addressed by tag
# (ghcr.io/dmpresearch/flowstarter-main:<sha> for every staging slot; a
# release tag for prod), so the tag itself is the source of truth here and
# needs no rebuild to expose -- this takes effect via docker-compose.yml's
# `environment:` (which overrides both the env file and whatever the image
# baked in from Dockerfile's FLOWSTARTER_BUILD_COMMIT build arg) even for an
# image built before that arg existed.
export FLOWSTARTER_BUILD_COMMIT="${IMAGE##*:}"

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
  # Every staging slot shares this one stack; see "Locking" above.
  lock_acquire "the shared Supabase CLI stack (ensure/check/migrate)"

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

  lock_release
fi

echo "Pulling $IMAGE ..."
# A pull failure is only fatal if this host does not already have the image.
#
# Two real cases, and neither is a reason to refuse a deploy. An operator
# building an image ON the box during an incident -- which is how the build
# worker was first brought up on fs-sites-01, from a source tarball rather
# than from GHCR -- has an image that exists nowhere to pull it from. And a
# registry that is momentarily unreachable should not block redeploying a tag
# already sitting on this disk.
#
# It is still a pull first, and still fatal for a tag this host has never
# seen: a typo'd or never-pushed tag fails here exactly as it did before,
# because `docker image inspect` will not find it either.
if ! docker pull "$IMAGE"; then
  if docker image inspect "$IMAGE" >/dev/null 2>&1; then
    echo "warning: could not pull ${IMAGE}, but it is already on this host; deploying the local copy" >&2
  else
    echo "refusing to deploy ${SLOT}: ${IMAGE} could not be pulled and is not on this host. Check the tag, and that this host is logged in to the registry (docker login ghcr.io)." >&2
    exit 1
  fi
fi

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

# The Caddy config directory is shared by every slot on the box too: two
# lanes writing their own *.caddy file and reloading at once can race the
# reload itself. See "Locking" above.
lock_acquire "writing the Caddy config and reloading Caddy"

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

lock_release

# ── Disk retention: after a successful deploy ───────────────────────────────
# Reached only once the health gate and the Caddy reload above have both
# succeeded. Best-effort: a failure here must not turn a successful deploy
# into a failed one — it will simply catch up on the next deploy's preflight
# (or the next successful one's own retention pass).
echo "Running image retention (${PRUNE_IMAGES_SCRIPT}) after a successful deploy ..."
if [[ -x "$PRUNE_IMAGES_SCRIPT" ]]; then
  "$PRUNE_IMAGES_SCRIPT" || echo "warning: ${PRUNE_IMAGES_SCRIPT} exited non-zero after deploy; it will catch up on the next deploy" >&2
else
  echo "warning: retention script not found or not executable at ${PRUNE_IMAGES_SCRIPT}; skipping image retention" >&2
fi

echo "Deployed https://${PRIMARY_HOSTNAME} (slot=${SLOT}, port=${HOST_PORT})"
