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
#
# Image cleanup: a pr-N slot's image (ghcr.io/dmpresearch/flowstarter-main:
# <commit-sha>, same repo/tag family prune-images.sh retains) otherwise sits
# on disk until prune-images.sh's own keep-count on the next deploy elsewhere
# happens to reach it — closing a PR should not have to wait on someone else's
# deploy. This script resolves the image the container was running BEFORE
# removing the container, then removes that image too, but only if no other
# container (any slot, any state) still references it — same non-forced
# `docker rmi` as prune-images.sh, and the same reason: the daemon itself is
# the check that nothing else needs it.

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

# Resolved before the container is removed below — there is nothing left to
# ask afterwards. `--no-trunc` matches the full sha256 ID `docker ps -a
# --filter ancestor=` and prune-images.sh both use, so the "does anything
# else use it" check a few lines down is not fooled by a truncated ID
# collision.
IMAGE_ID="$(docker container inspect --format '{{.Image}}' "$CONTAINER" 2>/dev/null || true)"

if [[ -f "$COMPOSE_FILE" ]]; then
  FLOWSTARTER_CONTAINER="$CONTAINER" \
    docker compose -p "$PROJECT" -f "$COMPOSE_FILE" down --remove-orphans || true
fi
docker rm -f "$CONTAINER" 2>/dev/null || true

if [[ -n "$IMAGE_ID" ]]; then
  OTHER_USERS="$(docker ps -a -q --filter "ancestor=${IMAGE_ID}" 2>/dev/null || true)"
  if [[ -z "$OTHER_USERS" ]]; then
    if docker rmi "$IMAGE_ID" >/dev/null 2>&1; then
      echo "Removed image ${IMAGE_ID} (no other container was using it)"
    fi
    # A failed, non-forced `docker rmi` here (something still references it
    # that `docker ps -a --filter ancestor=` did not catch — a build cache
    # layer, a manual `docker tag`) is not this script's problem: the same
    # image is also covered by prune-images.sh's own retention pass, and
    # forcing it would risk the exact untagged-image trap
    # removeImageUnlessProtected (apps/deploy-agent/src/docker-runtime.ts)
    # documents.
  else
    echo "Leaving image ${IMAGE_ID} in place; still used by: ${OTHER_USERS}"
  fi
fi

SNIPPET="${CADDY_PLATFORM_DIR}/${SLOT}.caddy"
rm -f "$SNIPPET"

if command -v systemctl >/dev/null 2>&1; then
  systemctl reload caddy || true
else
  caddy reload --config /etc/caddy/Caddyfile --force || true
fi

echo "Destroyed slot ${SLOT}"
