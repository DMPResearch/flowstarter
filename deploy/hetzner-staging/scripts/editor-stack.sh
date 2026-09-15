#!/usr/bin/env bash
# Manage the Flowstarter editor container on the Hetzner sites host.
#
# This is the ONLY thing that should run `docker compose` against
# ../editor/docker-compose.yml. One container, one project
# (`flowstarter-editor`): the router/supervisor, which spawns one editor
# process per workspace slug on demand and idle-stops them. The compose file's
# header explains why it is one container and not one per client.
#
# Usage:
#   editor-stack.sh up       # compose up -d, wait for the container healthy
#   editor-stack.sh down     # compose down (never -v: /workspaces holds a
#                            # session an operator may not have shipped yet)
#   editor-stack.sh status   # name, health, published ports, running image tag
#   editor-stack.sh check    # assert loopback-only publishing + a control secret
#   editor-stack.sh health   # probe the router over loopback
#   editor-stack.sh recreate # rm -f + up, which is what applies env changes
#
# Run as root: every subcommand either talks to the Docker socket or reads
# /etc/flowstarter/editor.env, and both are root-only on this box.
#
# WHY `check` matters here. Two separate ways this container could be exposed:
#
#   1. /etc/docker/daemon.json's `{"ip":"127.0.0.1"}` only constrains the
#      DEFAULT bridge. A compose-created network ignores it, so a missing
#      `127.0.0.1:` port prefix or a missing
#      `com.docker.network.bridge.host_binding_ipv4` driver option publishes
#      3773 on 0.0.0.0, past ufw. Same trap the Supabase CLI stack fell into
#      on this box, and the same assertion cal-stack.sh makes.
#   2. With no EDITOR_CONTROL_SECRET set, the container still starts and still
#      serves editors -- it is the control plane that refuses, with 503. That
#      is the safe default, but it means "the editor is up" and "an operator
#      can open a session" are different facts, and `check` asserts both.
#
# Nothing in this file ever prints a secret: the control-secret check asserts
# a length and never echoes the value.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${EDITOR_COMPOSE_FILE:-$HERE/../editor/docker-compose.yml}"
ENV_FILE="${EDITOR_ENV_FILE:-/etc/flowstarter/editor.env}"
CONTAINER="${EDITOR_CONTAINER:-flowstarter-editor}"
HOST_PORT="${EDITOR_HOST_PORT:-3773}"
HEALTH_TIMEOUT="${EDITOR_HEALTH_TIMEOUT:-120}"
DOCKER="${DOCKER:-docker}"

say() { printf '[editor-stack] %s\n' "$*"; }
die() {
  printf '[editor-stack] %s\n' "$*" >&2
  exit 1
}

compose() {
  EDITOR_ENV_FILE="$ENV_FILE" "$DOCKER" compose -f "$COMPOSE_FILE" "$@"
}

require_env_file() {
  [ -f "$ENV_FILE" ] || die "missing $ENV_FILE (copy editor.env.example, mode 600)"
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  [ "$mode" = "600" ] || die "$ENV_FILE must be mode 600, found $mode"
}

wait_healthy() {
  local deadline=$((SECONDS + HEALTH_TIMEOUT)) state
  while [ "$SECONDS" -lt "$deadline" ]; do
    state="$("$DOCKER" inspect -f '{{.State.Health.Status}}' "$CONTAINER" 2>/dev/null || echo missing)"
    case "$state" in
      healthy) say "$CONTAINER is healthy"; return 0 ;;
      unhealthy) die "$CONTAINER went unhealthy; see: docker logs $CONTAINER" ;;
    esac
    sleep 3
  done
  die "$CONTAINER did not become healthy within ${HEALTH_TIMEOUT}s"
}

cmd_up() {
  require_env_file
  compose up -d
  wait_healthy
  cmd_check
}

cmd_recreate() {
  # `docker restart` does NOT re-read --env-file. Anything that changed in
  # /etc/flowstarter/editor.env needs the container replaced, and an operator
  # who reaches for restart will spend an afternoon on it.
  require_env_file
  "$DOCKER" rm -f "$CONTAINER" >/dev/null 2>&1 || true
  cmd_up
}

cmd_down() {
  # Never `-v`. The `editor-workspaces` volume can hold a session an operator
  # has not shipped, and the `editor-state` volume holds their conversation.
  compose down
}

cmd_status() {
  "$DOCKER" ps --filter "name=^/${CONTAINER}$" \
    --format 'table {{.Names}}\t{{.Status}}\t{{.Ports}}\t{{.Image}}'
}

cmd_check() {
  # The compose file runs the container with `network_mode: host` (added
  # 2026-09-15, see the compose file's own comment): the editor's Clerk gate
  # resolves a browser's identity straight against Supabase, and the only
  # way a container reaches a host service published on 127.0.0.1 (not
  # 0.0.0.0), same as the app slots' own local Supabase CLI stack, is to
  # share the host's network namespace. Under host networking there is no
  # Docker-level port publish for `docker port` to report, so the loopback
  # guarantee is asserted the way it is for those app slots: a listening
  # socket on the host itself, bound to 127.0.0.1 specifically.
  local listening
  listening="$(ss -ltn 2>/dev/null | awk '$4 ~ /:3773$/ {print $4}')"
  [ -n "$listening" ] || die "nothing is listening on port 3773 on this host"
  case "$listening" in
    127.0.0.1:3773) say "publishing is loopback-only ($listening)" ;;
    *) die "REFUSING: 3773 is listening on $listening, not 127.0.0.1:3773. Fix ROUTER_HOST in the compose file's environment block before going further." ;;
  esac

  # Length only. The value is never echoed.
  local secret_len
  secret_len="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${EDITOR_CONTROL_SECRET:-}" | wc -c' 2>/dev/null | tr -d ' ')"
  if [ "${secret_len:-0}" -lt 32 ]; then
    die "EDITOR_CONTROL_SECRET is missing or shorter than 32 characters, so the control plane will answer 503 and no operator can open a session."
  fi
  say "control secret is present (${secret_len} characters)"

  local domain
  domain="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${EDITOR_PUBLIC_DOMAIN:-}"' 2>/dev/null)"
  [ -n "$domain" ] || die "EDITOR_PUBLIC_DOMAIN is unset; the router would fall back to a default that does not match this box's client sites."
  say "public domain is $domain"
}

cmd_health() {
  local body
  body="$(curl -fsS "http://127.0.0.1:${HOST_PORT}/__router/health")" \
    || die "the router did not answer on 127.0.0.1:${HOST_PORT}"
  say "router: $body"
  # The control plane must NOT answer a request that looks like it came
  # through the tenant vhost, even with a correct secret. Asserted here with
  # no secret at all, so a 404 proves the header rule and not the auth one.
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' \
    -H 'x-forwarded-host: acme.example' \
    -X POST "http://127.0.0.1:${HOST_PORT}/__router/sessions")"
  [ "$status" = "404" ] \
    || die "the control plane answered $status to a forwarded request; it must 404. A browser on a client site can reach this path."
  say "control plane refuses forwarded requests (404)"
}

case "${1:-}" in
  up) cmd_up ;;
  recreate) cmd_recreate ;;
  down) cmd_down ;;
  status) cmd_status ;;
  check) cmd_check ;;
  health) cmd_health ;;
  *)
    die "usage: editor-stack.sh {up|recreate|down|status|check|health}"
    ;;
esac
