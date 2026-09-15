#!/usr/bin/env bash
# Manage the Flowstarter template library (MCP server) on the Hetzner sites
# host.
#
# This is the ONLY thing that should run `docker compose` against
# ../mcp/docker-compose.yml. One container, one project (`flowstarter-mcp`):
# the read-only catalog the discovery funnel's live preview asks for a
# template and its sources. Its compose file's header explains why it is the
# one service on this box that does NOT use host networking.
#
# Usage:
#   mcp-stack.sh up [image]        # pull, up -d, wait healthy, check
#   mcp-stack.sh down              # compose down (nothing here has state)
#   mcp-stack.sh status            # name, health, running image tag
#   mcp-stack.sh check             # assert loopback-only, a real shared
#                                  # secret that MATCHES the app slot's, that
#                                  # auth is not disabled, and the catalog
#   mcp-stack.sh health            # probe /health, and assert /mcp refuses an
#                                  # untokened tool call
#   mcp-stack.sh recreate [image]  # rm -f + up, which is what applies env changes
#
# `[image]` is what the CI lane passes (ghcr.io/dmpresearch/flowstarter-mcp:<sha>).
# Omit it and the image the container is ALREADY running is reused, so a
# hand-run `recreate` to apply an env change never silently rolls the library
# back to whatever `:main` happens to point at.
#
# Run as root: every subcommand either talks to the Docker socket or reads
# /etc/flowstarter/mcp-staging.env, and both are root-only here.
#
# WHY `check` MATTERS HERE:
#
#   1. `scaffold_template` returns the complete sources of a template. The one
#      thing gating it is FLOWSTARTER_MCP_INTERNAL_TOKEN, compared in constant
#      time — and `DISABLE_AUTH=true`, the local-development bypass, does not
#      weaken that check, it removes it. A container with that variable set
#      looks identical from outside to one without.
#   2. The token has to match the app slot's byte for byte. A mismatch is not
#      a startup failure: the library boots, /health is green, and every
#      preview run dies at its first tool call with an authentication error
#      three layers below where anyone is looking. `check` compares the two
#      files' values by hash, so the mismatch is caught before a visitor finds
#      it and neither value is ever printed.
#   3. The catalog is the other silent one. A template missing from the image
#      does not fail anything; it just means the selection agent picks a
#      worse-fitting template for somebody's business, which nothing
#      downstream can tell apart from a judgement call. And a fixture template
#      PRESENT in the image (demo-coach, dorin-portfolio) is worse: the app
#      image installs node_modules for neither, so a run that picks one dies
#      at `astro build`.
#
# Nothing in this file ever prints a secret: the secret checks assert a length
# and compare hashes, and never echo a value.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${MCP_COMPOSE_FILE:-$HERE/../mcp/docker-compose.yml}"
ENV_FILE="${MCP_ENV_FILE:-/etc/flowstarter/mcp-staging.env}"
# The app slot's env file, read for one purpose only: to prove the shared
# secret on both sides is the same one. Never written here.
APP_ENV_FILE="${MCP_APP_ENV_FILE:-/etc/flowstarter/staging.env}"
CONTAINER="${MCP_CONTAINER:-flowstarter-mcp-staging}"
DEFAULT_IMAGE="${MCP_IMAGE:-ghcr.io/dmpresearch/flowstarter-mcp:main}"
IMAGE="$DEFAULT_IMAGE"
HOST_PORT="${MCP_HOST_PORT:-3001}"
# The template catalog this image is expected to serve, in the order
# TEMPLATE_CATALOG lists them in packages/agentic-codegen/src/workspace.ts.
EXPECTED_TEMPLATES="${MCP_EXPECTED_TEMPLATES:-creative-portfolio local-trade professional-services wellness-therapy}"
HEALTH_TIMEOUT="${MCP_HEALTH_TIMEOUT:-120}"
DOCKER="${DOCKER:-docker}"

say() { printf '[mcp-stack] %s\n' "$*"; }
die() {
  printf '[mcp-stack] %s\n' "$*" >&2
  exit 1
}

compose() {
  MCP_ENV_FILE="$ENV_FILE" \
  MCP_CONTAINER="$CONTAINER" \
  MCP_IMAGE="$IMAGE" \
  MCP_HOST_PORT="$HOST_PORT" \
    "$DOCKER" compose -f "$COMPOSE_FILE" "$@"
}

# The image this deploy should run. An argument wins; otherwise the one the
# container is already on, so a `recreate` that only means "re-read the env
# file" cannot quietly roll the library onto a different commit — which here
# would also change which template SOURCES it serves.
resolve_image() {
  if [ -n "${1:-}" ]; then
    IMAGE="$1"
    return
  fi
  IMAGE="$("$DOCKER" inspect -f '{{.Config.Image}}' "$CONTAINER" 2>/dev/null || true)"
  IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
}

require_env_file() {
  [ -f "$ENV_FILE" ] \
    || die "missing $ENV_FILE (copy mcp/mcp.env.example, mode 600)"
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  [ "$mode" = "600" ] || die "$ENV_FILE must be mode 600, found $mode"
}

# One value out of an env file, without sourcing it. Sourcing would execute
# whatever is in a file full of secrets, and a stray backtick in a token would
# run as this script's root shell.
env_value() {
  sed -n "s/^${2}=//p" "$1" | tail -n 1
}

# A digest of a secret, for comparing two copies of it without printing
# either. Truncated to 12 characters in any message: enough to say "these two
# differ", far too little to be worth anything on its own. `shasum` is the
# fallback so this script's own tests can run on a developer's macOS, which
# has no sha256sum.
secret_digest() {
  if command -v sha256sum >/dev/null 2>&1; then
    printf '%s' "$1" | sha256sum | awk '{print $1}'
  else
    printf '%s' "$1" | shasum -a 256 | awk '{print $1}'
  fi
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) state
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$("$DOCKER" inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    case "$state" in
      healthy)
        say "$CONTAINER is healthy"
        return 0
        ;;
      unhealthy) die "$CONTAINER went unhealthy; see: docker logs $CONTAINER" ;;
    esac
    sleep 3
  done
  die "$CONTAINER did not become healthy within ${HEALTH_TIMEOUT}s; see: docker logs $CONTAINER"
}

cmd_up() {
  require_env_file
  say "deploying $IMAGE"
  # Pull before `up`, so a registry problem fails here with its own error
  # rather than as a compose message about a service that would not start.
  #
  # A failed pull is fatal only when this host does not already have the
  # image — the same rule deploy-slot.sh and worker-stack.sh apply, for the
  # same reason: an operator who built the image ON the box (which is how this
  # library was first brought up on fs-sites-01) has a tag that exists nowhere
  # to pull it from.
  if ! "$DOCKER" pull "$IMAGE" >/dev/null 2>&1; then
    "$DOCKER" image inspect "$IMAGE" >/dev/null 2>&1 \
      || die "could not pull $IMAGE and it is not on this host. Check the tag, and that this host is logged in to the registry (docker login ghcr.io)."
    say "could not pull $IMAGE, but it is already on this host; starting the local copy"
  fi
  compose up -d
  wait_healthy
  cmd_check
}

cmd_recreate() {
  # `docker restart` does NOT re-read --env-file. Anything that changed in the
  # env file needs the container replaced, and an operator who reaches for
  # restart will spend an afternoon on it.
  require_env_file
  "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  cmd_up
}

cmd_down() {
  compose down
}

cmd_status() {
  "$DOCKER" ps --filter "name=^/${CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Image}}'
}

cmd_check() {
  require_env_file

  # 1. Loopback, observed rather than assumed. The compose file publishes
  #    127.0.0.1:${HOST_PORT}:3001 and /etc/docker/daemon.json defaults the
  #    publish address to loopback as well, so this is belt and braces — but
  #    it is the assertion that would catch either of them being edited, and
  #    what is behind this port is every template's complete sources.
  local bound
  bound="$(ss -ltn "sport = :${HOST_PORT}" 2>/dev/null | awk 'NR>1 {print $4}' | head -n 1)"
  [ -n "$bound" ] \
    || die "nothing is listening on port ${HOST_PORT}; is $CONTAINER running? (mcp-stack.sh status)"
  case "$bound" in
    127.0.0.1:* | "[::1]:"*) say "port ${HOST_PORT} is bound on $bound" ;;
    *)
      die "REFUSING: port ${HOST_PORT} is listening on $bound, not loopback. That publishes scaffold_template — every template's complete sources — to anything that can reach this box. Fix the ports: line in the compose file and run: mcp-stack.sh recreate"
      ;;
  esac

  # 2. Authentication is actually on. DISABLE_AUTH does not weaken the token
  #    check, it removes it: `verifyToolAuth` returns an authenticated context
  #    for every caller before it looks at a token at all.
  local disable_auth
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  disable_auth="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${DISABLE_AUTH:-}"' 2>/dev/null || true)"
  [ "$disable_auth" != "true" ] \
    || die "REFUSING: DISABLE_AUTH=true in $CONTAINER. That is the local-development bypass: every MCP tool call would be served without a token. Remove it from $ENV_FILE and run: mcp-stack.sh recreate"
  say "tool calls are authenticated (DISABLE_AUTH is not set)"

  # 3. A usable shared secret. Length only; the value is never echoed.
  local secret_len
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  secret_len="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${FLOWSTARTER_MCP_INTERNAL_TOKEN:-}" | wc -c' 2>/dev/null | tr -d ' ')"
  if [ "${secret_len:-0}" -lt 32 ]; then
    die "FLOWSTARTER_MCP_INTERNAL_TOKEN is missing or shorter than 32 characters. The server would have refused to boot with no authentication configured at all; the app's client refuses to construct itself below 32."
  fi
  say "shared secret is present (${secret_len} characters)"

  # 4. ...and it is the SAME secret the app slot holds. This is the check that
  #    earns this subcommand: a mismatch boots cleanly, passes every probe
  #    above, and then fails every single preview run at its first tool call.
  #    Compared by digest, so neither value is read into a message.
  if [ -f "$APP_ENV_FILE" ]; then
    local app_secret mcp_secret app_digest mcp_digest
    app_secret="$(env_value "$APP_ENV_FILE" FLOWSTARTER_MCP_INTERNAL_TOKEN)"
    mcp_secret="$(env_value "$ENV_FILE" FLOWSTARTER_MCP_INTERNAL_TOKEN)"
    if [ -z "$app_secret" ]; then
      die "FLOWSTARTER_MCP_INTERNAL_TOKEN is not set in $APP_ENV_FILE. The library is running and the app cannot call it: generation is refused before a job exists."
    fi
    app_digest="$(secret_digest "$app_secret")"
    mcp_digest="$(secret_digest "$mcp_secret")"
    [ "$app_digest" = "$mcp_digest" ] \
      || die "the shared secret in $APP_ENV_FILE (sha256 ${app_digest:0:12}) is not the one in $ENV_FILE (sha256 ${mcp_digest:0:12}). Every preview run would fail at its first tool call. Make them identical and run: mcp-stack.sh recreate"
    say "the app slot and the library hold the same shared secret (sha256 ${mcp_digest:0:12})"

    # The app's half of the wiring, while this file is open. A library that is
    # up and an app that was never told about it is the exact gap this whole
    # deployment closes.
    local app_url
    app_url="$(env_value "$APP_ENV_FILE" FLOWSTARTER_MCP_URL)"
    case "$app_url" in
      http://127.0.0.1:"${HOST_PORT}"/mcp | http://localhost:"${HOST_PORT}"/mcp)
        say "the app slot points FLOWSTARTER_MCP_URL at this library"
        ;;
      '')
        die "FLOWSTARTER_MCP_URL is not set in $APP_ENV_FILE. The library is running and the app will still refuse every preview with reason 'not-configured'. Set it to http://127.0.0.1:${HOST_PORT}/mcp and redeploy the slot."
        ;;
      *)
        die "FLOWSTARTER_MCP_URL in $APP_ENV_FILE is '$app_url', which is not this library (expected http://127.0.0.1:${HOST_PORT}/mcp). Note the path must be /mcp: /health is served at the server's root and the app's probe replaces the pathname rather than appending to it."
        ;;
    esac
  else
    say "no $APP_ENV_FILE on this host; skipping the shared-secret and URL comparison"
  fi

  # 5. The catalog, both ways: every expected template present, and no
  #    fixtures. Read off the image's own filesystem rather than through an
  #    MCP call, so this needs no token on a command line.
  local templates_dir slug
  templates_dir='/app/apps/flowstarter-templates'
  for slug in $EXPECTED_TEMPLATES; do
    "$DOCKER" exec "$CONTAINER" test -f "${templates_dir}/${slug}/config.json" \
      || die "the catalog template '$slug' is not in this image. The selection agent would silently choose from a smaller catalog. Check apps/flowstarter-library/mcp-server/Dockerfile.dockerignore and rebuild."
  done
  for slug in demo-coach dorin-portfolio; do
    if "$DOCKER" exec "$CONTAINER" test -d "${templates_dir}/${slug}" 2>/dev/null; then
      die "'$slug' is in this image. It is a fixture, not a catalog template, and the app image installs no node_modules for it — a run that picked it would die at 'astro build'. Rebuild from apps/flowstarter-library/mcp-server/Dockerfile."
    fi
  done
  say "catalog: $EXPECTED_TEMPLATES (and no fixtures)"
}

cmd_health() {
  local body
  body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/health")" \
    || die "the library did not answer on 127.0.0.1:${HOST_PORT}. This is the exact probe the app runs before it will start a generation run (generation-availability.ts), so a failure here is a funnel that refuses every preview."
  say "library: $body"

  # The MCP endpoint itself must refuse a tool call that carries no token.
  # Asserted with no token at all, so the refusal proves the auth rule and not
  # a malformed argument. The transport answers 200 with a JSON-RPC result
  # whose content is the error, so the status code is not the thing to read —
  # the body is.
  local refusal
  refusal="$(curl -fsS -X POST "http://127.0.0.1:${HOST_PORT}/mcp" \
    -H 'content-type: application/json' \
    -H 'accept: application/json, text/event-stream' \
    --data '{"jsonrpc":"2.0","id":1,"method":"tools/call","params":{"name":"list_templates","arguments":{}}}' \
    2>/dev/null || true)"
  case "$refusal" in
    *UNAUTHORIZED*) say "an untokened tool call is refused (UNAUTHORIZED)" ;;
    *)
      die "POST /mcp did not refuse an untokened list_templates. Either DISABLE_AUTH is set or the auth path has regressed; scaffold_template would serve every template's sources to any caller on this box."
      ;;
  esac
}

case "${1:-}" in
  # resolve_image runs HERE, before cmd_recreate's `docker rm -f`: once the
  # container is gone there is nothing left to read the current image off.
  up)
    resolve_image "${2:-}"
    cmd_up
    ;;
  recreate)
    resolve_image "${2:-}"
    cmd_recreate
    ;;
  down) cmd_down ;;
  status) cmd_status ;;
  check) cmd_check ;;
  health) cmd_health ;;
  *)
    die "usage: mcp-stack.sh {up [image]|recreate [image]|down|status|check|health}"
    ;;
esac
