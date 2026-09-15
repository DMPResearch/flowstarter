#!/usr/bin/env bash
# Manage the Flowstarter build worker container on the Hetzner sites host.
#
# This is the ONLY thing that should run `docker compose` against
# ../build-worker/docker-compose.yml. One container, one project
# (`flowstarter-build-worker`): the service that drains
# `flowstarter_agent_jobs`. Its compose file's header explains the two things
# that make this deployment different from every other slot on this box — it
# holds the host's Docker socket, and its worktrees are bind-mounted at an
# identical absolute path on both sides.
#
# Usage:
#   worker-stack.sh up [image]        # pull, up -d, wait healthy, check
#   worker-stack.sh down              # compose down (no -v: there is no volume,
#                                     # but a half-finished worktree is still
#                                     # somebody's build)
#   worker-stack.sh status            # name, health, running image tag
#   worker-stack.sh check             # assert loopback-only, a real secret,
#                                     # docker isolation, an identical worktrees path
#   worker-stack.sh health            # probe /health, and assert dispatch
#                                     # refuses an unsigned POST
#   worker-stack.sh recreate [image]  # rm -f + up, which is what applies env changes
#   worker-stack.sh image             # build the disposable validation image on this host
#
# `[image]` is what the CI lane passes (ghcr.io/dmpresearch/flowstarter-build-
# worker:<sha>). Omit it and the image the container is ALREADY running is
# reused, so a hand-run `recreate` to apply an env change never silently rolls
# the worker back to whatever `:main` happens to point at.
#
# Run as root: every subcommand either talks to the Docker socket or reads
# /etc/flowstarter/build-worker-staging.env, and both are root-only here.
#
# WHY `check` MATTERS HERE, beyond the editor's version of the same idea:
#
#   1. The container runs with `network_mode: host`. There is no `ports:`
#      section to get wrong, and no Docker publish rule to lean on: the ONLY
#      thing keeping this worker off the internet is that it binds
#      127.0.0.1. A `0.0.0.0` bind would hand `POST /jobs/full-site` — and the
#      unauthenticated `/artifacts/<token>.tar.gz` route that serves clients'
#      unreleased sites — to anything that can reach this box on 8787.
#   2. Isolation is a rule of the environment, not a preference. `staging`
#      forces docker isolation, and the sealed build step needs an image with
#      pnpm already prepared. The worker refuses to boot without both, but
#      "refused to boot" and "is not running" look identical from outside, so
#      this asserts the image exists BEFORE the container is started and can
#      say which `docker build` is missing.
#
# Nothing in this file ever prints a secret: the secret check asserts a length
# and never echoes the value.

set -Eeuo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
COMPOSE_FILE="${BUILD_WORKER_COMPOSE_FILE:-$HERE/../build-worker/docker-compose.yml}"
ENV_FILE="${BUILD_WORKER_ENV_FILE:-/etc/flowstarter/build-worker-staging.env}"
CONTAINER="${BUILD_WORKER_CONTAINER:-flowstarter-build-worker-staging}"
DEFAULT_IMAGE="${BUILD_WORKER_IMAGE:-ghcr.io/dmpresearch/flowstarter-build-worker:main}"
IMAGE="$DEFAULT_IMAGE"
STATE_ROOT="${BUILD_WORKER_STATE_ROOT:-/srv/flowstarter/build-worker}"
# uid:gid the worker runs as inside the container (the stock `node` user). The
# state directories have to be owned by it on the host, or the first `git init`
# fails with EACCES on a path the operator can plainly see.
STATE_OWNER="${BUILD_WORKER_STATE_OWNER:-1000:1000}"
VALIDATION_IMAGE="${BUILD_WORKER_VALIDATION_IMAGE:-flowstarter/build-validation:node22-pnpm10}"
VALIDATION_PNPM_VERSION="${BUILD_WORKER_VALIDATION_PNPM_VERSION:-10.29.2}"
# Where a checkout of this repository lives on the host, for `image`.
REPO_DIR="${BUILD_WORKER_REPO_DIR:-/opt/flowstarter/staging/repo}"
HEALTH_TIMEOUT="${BUILD_WORKER_HEALTH_TIMEOUT:-180}"
DOCKER="${DOCKER:-docker}"

say() { printf '[worker-stack] %s\n' "$*"; }
die() {
  printf '[worker-stack] %s\n' "$*" >&2
  exit 1
}

# The host's docker group, so the container's non-root user can open the
# socket. Read here rather than written into the compose file: the gid is a
# property of the host, and a wrong one fails as an unreadable EACCES.
docker_gid() {
  local gid
  gid="$(getent group docker | cut -d: -f3 2>/dev/null || true)"
  [ -n "$gid" ] || die "this host has no 'docker' group; the worker's non-root user could not open /var/run/docker.sock"
  printf '%s' "$gid"
}

compose() {
  BUILD_WORKER_ENV_FILE="$ENV_FILE" \
  BUILD_WORKER_CONTAINER="$CONTAINER" \
  BUILD_WORKER_STATE_ROOT="$STATE_ROOT" \
  BUILD_WORKER_IMAGE="$IMAGE" \
  DOCKER_GID="$(docker_gid)" \
    "$DOCKER" compose -f "$COMPOSE_FILE" "$@"
}

# The image this deploy should run. An argument wins; otherwise the one the
# container is already on, so a `recreate` that only means "re-read the env
# file" cannot quietly roll the worker onto a different commit.
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
    || die "missing $ENV_FILE (copy build-worker.env.example, mode 600)"
  local mode
  mode="$(stat -c '%a' "$ENV_FILE" 2>/dev/null || stat -f '%Lp' "$ENV_FILE")"
  [ "$mode" = "600" ] || die "$ENV_FILE must be mode 600, found $mode"
}

# One value out of the env file, without sourcing it. Sourcing would execute
# whatever is in a file full of secrets, and a stray backtick in a password
# would run as this script's root shell.
env_value() {
  sed -n "s/^${1}=//p" "$ENV_FILE" | tail -n 1
}

ensure_state() {
  local dir
  for dir in repository worktrees artifacts output; do
    mkdir -p "$STATE_ROOT/$dir"
  done
  chown -R "$STATE_OWNER" "$STATE_ROOT"
  chmod 750 "$STATE_ROOT"
  say "state root $STATE_ROOT is present, owned by $STATE_OWNER"
}

cmd_image() {
  # The disposable container a generated site is actually built inside. Built
  # here, on this host, from this repository's own Dockerfile: the worker
  # invokes the Docker CLI with no registry credentials, so the image has to be
  # local or public, and a locally built one is the only version of it we can
  # say we control.
  #
  # Three places it can be, in order of how deliberate they are: an operator's
  # explicit override, the copy installed beside the compose file (which is
  # what a box with no full checkout has), and a repo checkout if one is
  # present. The last is the only one CI's supabase/ sync cannot produce, so it
  # must not be the only one.
  local dockerfile=""
  local candidate
  for candidate in \
    "${BUILD_WORKER_VALIDATION_DOCKERFILE:-}" \
    "$HERE/../build-worker/validation-runtime.Dockerfile" \
    "$REPO_DIR/apps/build-worker/docker/validation-runtime.Dockerfile"; do
    if [ -n "$candidate" ] && [ -f "$candidate" ]; then
      dockerfile="$candidate"
      break
    fi
  done
  [ -n "$dockerfile" ] \
    || die "no validation Dockerfile found. Looked at \$BUILD_WORKER_VALIDATION_DOCKERFILE, $HERE/../build-worker/validation-runtime.Dockerfile and $REPO_DIR/apps/build-worker/docker/validation-runtime.Dockerfile. Copy apps/build-worker/docker/validation-runtime.Dockerfile to the second of those."
  say "building $VALIDATION_IMAGE (pnpm $VALIDATION_PNPM_VERSION baked in)"
  "$DOCKER" build \
    -f "$dockerfile" \
    --build-arg "PNPM_VERSION=$VALIDATION_PNPM_VERSION" \
    -t "$VALIDATION_IMAGE" \
    "$(dirname "$dockerfile")"
  say "built $VALIDATION_IMAGE"
}

require_validation_image() {
  "$DOCKER" image inspect "$VALIDATION_IMAGE" >/dev/null 2>&1 && return 0
  die "the validation image $VALIDATION_IMAGE is not on this host. A staging worker cannot run a generated build without it: the sealed build step (--network=none) needs pnpm already prepared in the image, and the worker refuses to boot otherwise. Run: worker-stack.sh image"
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
  require_validation_image
  ensure_state
  say "deploying $IMAGE"
  # Pull before `up`, so a registry problem fails here with its own error
  # rather than as a compose message about a service that would not start.
  #
  # A failed pull is fatal only when this host does not already have the image.
  # The same rule deploy-slot.sh applies, for the same reason: an operator who
  # built the image ON the box — which is how this worker was first brought up
  # on fs-sites-01, from a source tarball rather than from GHCR — has a tag
  # that exists nowhere to pull it from, and a redeploy of a tag already on
  # disk should survive a registry that is briefly unreachable. A tag this host
  # has never seen still fails, because `image inspect` will not find it either.
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

  # 1. Loopback. With host networking this is the only thing between the
  #    worker and the internet, so it is asserted twice: what the process was
  #    told, and what it actually bound.
  local host port
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  host="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${FLOWSTARTER_BUILD_WORKER_HOST:-0.0.0.0}"' 2>/dev/null || true)"
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  port="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${FLOWSTARTER_BUILD_WORKER_PORT:-8787}"' 2>/dev/null || true)"
  [ -n "$port" ] || die "could not read FLOWSTARTER_BUILD_WORKER_PORT from $CONTAINER; is it running?"
  case "$host" in
    127.0.0.1 | ::1 | localhost) say "the worker is configured to bind $host:$port" ;;
    *)
      die "REFUSING: FLOWSTARTER_BUILD_WORKER_HOST is '$host', not 127.0.0.1. This container runs with host networking, so that is a plain open port on this box serving POST /jobs/full-site and the unauthenticated artifact route. Fix $ENV_FILE and run: worker-stack.sh recreate"
      ;;
  esac

  local bound
  bound="$(ss -ltn "sport = :${port}" 2>/dev/null | awk 'NR>1 {print $4}' | head -n 1)"
  if [ -n "$bound" ]; then
    case "$bound" in
      127.0.0.1:* | "[::1]:"*) say "port $port is bound on $bound" ;;
      *) die "REFUSING: port $port is listening on $bound, not loopback." ;;
    esac
  fi

  # 2. A usable shared secret. Length only; the value is never echoed, and it
  #    must match the app slot's or every dispatch is a 401 nobody sees.
  local secret_len
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  secret_len="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${FLOWSTARTER_BUILD_WORKER_SECRET:-}" | wc -c' 2>/dev/null | tr -d ' ')"
  if [ "${secret_len:-0}" -lt 32 ]; then
    die "FLOWSTARTER_BUILD_WORKER_SECRET is missing or shorter than 32 characters. The worker would have refused to boot; the app would refuse to dispatch."
  fi
  say "shared secret is present (${secret_len} characters)"

  # 3. Isolation. The worker already refuses to boot without these, but a
  #    container that is up for another reason (an older image, a hand-edited
  #    env file) must not be read as proof that they hold.
  local isolation
  # shellcheck disable=SC2016  # expanded by the shell INSIDE the container, not here.
  isolation="$("$DOCKER" exec "$CONTAINER" sh -c 'printf %s "${FLOWSTARTER_BUILD_ISOLATION:-docker}"' 2>/dev/null || true)"
  [ "$isolation" = "docker" ] \
    || die "FLOWSTARTER_BUILD_ISOLATION is '$isolation'. In staging a generated Astro config would run as this worker's user, with this worker's filesystem."
  say "generated builds run under docker isolation"
  require_validation_image
  say "validation image $VALIDATION_IMAGE is present"

  # 4. The worktrees root, at a path the HOST daemon can resolve. This is the
  #    failure the compose file's header exists for: a mismatch here produces a
  #    build that fails on a missing package.json for a site whose files are
  #    plainly there.
  local worktrees
  worktrees="$(env_value FLOWSTARTER_WORKTREES_ROOT)"
  [ -n "$worktrees" ] || die "FLOWSTARTER_WORKTREES_ROOT is not set in $ENV_FILE"
  [ -d "$worktrees" ] \
    || die "FLOWSTARTER_WORKTREES_ROOT ($worktrees) does not exist ON THE HOST. The Docker daemon resolves the validation container's bind source there, not inside the worker, so every build would mount an empty /site."
  "$DOCKER" exec "$CONTAINER" test -d "$worktrees" \
    || die "FLOWSTARTER_WORKTREES_ROOT ($worktrees) exists on the host but not in the container; the bind mount is not at an identical path."
  say "worktrees root $worktrees resolves identically on host and in container"

  # 5. The socket, which is the reason any of this needs saying out loud.
  "$DOCKER" exec "$CONTAINER" docker version --format '{{.Server.Version}}' >/dev/null 2>&1 \
    || die "the worker cannot reach the host Docker daemon. Check that /var/run/docker.sock is mounted and that the container's group_add carries this host's docker gid ($(docker_gid))."
  say "the worker can reach the host daemon (it spawns one disposable container per validation command)"
}

cmd_health() {
  local port body
  port="$(env_value FLOWSTARTER_BUILD_WORKER_PORT)"
  port="${port:-8787}"
  body="$(curl -fsS "http://127.0.0.1:${port}/health")" \
    || die "the worker did not answer on 127.0.0.1:${port}"
  say "worker: $body"

  # Dispatch must refuse an unsigned POST. Asserted with no bearer at all, so
  # a 401 proves the auth rule and not a malformed body.
  local status
  status="$(curl -s -o /dev/null -w '%{http_code}' \
    -H 'content-type: application/json' \
    -X POST --data '{}' "http://127.0.0.1:${port}/jobs/full-site")"
  [ "$status" = "401" ] \
    || die "dispatch answered $status to an unsigned POST; it must be 401."
  say "dispatch refuses an unsigned POST (401)"
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
  image) cmd_image ;;
  *)
    die "usage: worker-stack.sh {up [image]|recreate|down|status|check|health|image}"
    ;;
esac
