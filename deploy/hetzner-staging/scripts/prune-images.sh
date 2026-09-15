#!/usr/bin/env bash
# Reclaim disk on a Hetzner platform host by removing old per-commit
# flowstarter-main images `docker pull` leaves behind, plus dangling build
# cache alongside them.
#
# Incident, 2026-09-15: the root disk (150 GB) on fs-sites-01 hit 100%
# because every deploy pulls its own tagged image
# (ghcr.io/dmpresearch/flowstarter-main:<sha>, 1.6-2.05 GB each) and nothing
# ever removed an old one — 173 images, 132.6 GB reclaimable by the time
# anyone noticed. The local Supabase DB container went unhealthy on a full
# disk and every staging deploy lane (main and every pr-N) failed at "ensure
# stack". This script is deploy-slot.sh's fix at the source: it runs a
# retention pass after every successful deploy, and again as a preflight
# before the next one (see deploy-slot.sh), so the same pileup cannot
# recur unnoticed.
#
# Usage:
#   prune-images.sh [--dry-run]
#
# Retention rule: an image is kept if either
#   (a) some running container — any image, any repo — is using it, or
#   (b) it is one of the FLOWSTARTER_IMAGE_KEEP_COUNT most recently created
#       images in FLOWSTARTER_IMAGE_REPO.
# Every other image in FLOWSTARTER_IMAGE_REPO is removed with a plain
# `docker rmi` (never `-f`: rule (a) already keeps anything a running
# container needs, so the only thing `-f` could do here is untag an image
# the daemon has some other, unaccounted-for reason to keep — same
# reasoning as `removeImageUnlessProtected` in
# apps/deploy-agent/src/docker-runtime.ts: not forcing turns the daemon
# itself into the check). Dangling build cache (`docker builder prune`, no
# `-a`: that only clears cache no image references at all, never cache that
# could still save a future build) is pruned every run too.
#
# --dry-run prints exactly what a real run would do — which images would be
# kept and why, which would be removed, and that build cache would be
# pruned — without running `docker rmi` or `docker builder prune`.
#
# Env overrides:
#   FLOWSTARTER_IMAGE_REPO       image to retain/prune, default
#                                ghcr.io/dmpresearch/flowstarter-main
#   FLOWSTARTER_IMAGE_KEEP_COUNT images in that repo kept beyond whatever a
#                                running container needs, default 5 (see
#                                DEFAULT_IMAGE_KEEP_COUNT below — named so
#                                the count is never a bare literal buried in
#                                the deletion logic, same pattern as
#                                backup.sh's DEFAULT_KEEP_DAILY/WEEKLY)
#   FLOWSTARTER_OPS_ENV_FILE     optional file of the same two overrides,
#                                default /etc/flowstarter/staging-ops.env;
#                                sourced (if present) before the defaults
#                                above are applied, so an operator can
#                                change either knob by editing one mode-600
#                                file on the box, with no CI change and no
#                                edit to this script. Same install pattern
#                                as staging.env/prod.env; unlike those, this
#                                file is optional and nothing ever writes it
#                                but a person.

set -euo pipefail

DRY_RUN=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=1 ;;
    *)
      echo "unknown argument: $arg (expected --dry-run)" >&2
      exit 1
      ;;
  esac
done

FLOWSTARTER_OPS_ENV_FILE="${FLOWSTARTER_OPS_ENV_FILE:-/etc/flowstarter/staging-ops.env}"
if [[ -f "$FLOWSTARTER_OPS_ENV_FILE" ]]; then
  set -a
  # shellcheck source=/dev/null
  source "$FLOWSTARTER_OPS_ENV_FILE"
  set +a
fi

DEFAULT_IMAGE_KEEP_COUNT=5
FLOWSTARTER_IMAGE_REPO="${FLOWSTARTER_IMAGE_REPO:-ghcr.io/dmpresearch/flowstarter-main}"
FLOWSTARTER_IMAGE_KEEP_COUNT="${FLOWSTARTER_IMAGE_KEEP_COUNT:-$DEFAULT_IMAGE_KEEP_COUNT}"

if ! [[ "$FLOWSTARTER_IMAGE_KEEP_COUNT" =~ ^[1-9][0-9]*$ ]]; then
  echo "FLOWSTARTER_IMAGE_KEEP_COUNT must be a positive integer, got: ${FLOWSTARTER_IMAGE_KEEP_COUNT}" >&2
  exit 1
fi

if ! command -v docker >/dev/null 2>&1; then
  echo "docker not found on PATH; nothing to prune" >&2
  exit 0
fi

# Image IDs (full sha256, matching `docker container inspect`'s own
# `.Image` field) backing every currently running container, any repo. Not
# an array: arrays are avoided throughout this directory so these scripts
# behave the same on the host's bash and a developer's macOS bash 3.2 (see
# deploy-slot.sh and cal-stack.sh), so this is a newline-separated string
# instead, and membership is a `grep -xF` line match.
PROTECTED_IMAGE_IDS=""
while IFS= read -r cid; do
  [ -n "$cid" ] || continue
  iid="$(docker container inspect --format '{{.Image}}' "$cid" 2>/dev/null || true)"
  [ -n "$iid" ] || continue
  PROTECTED_IMAGE_IDS="${PROTECTED_IMAGE_IDS}${iid}
"
done < <(docker ps -q)

is_protected() {
  local id="$1"
  [ -n "$id" ] && printf '%s' "$PROTECTED_IMAGE_IDS" | grep -qxF "$id"
}

if [ "$DRY_RUN" -eq 1 ]; then
  echo "Retention pass for ${FLOWSTARTER_IMAGE_REPO} (keep count: ${FLOWSTARTER_IMAGE_KEEP_COUNT}) [dry-run]"
  echo "[dry-run] no image will be removed and no build cache will be pruned"
else
  echo "Retention pass for ${FLOWSTARTER_IMAGE_REPO} (keep count: ${FLOWSTARTER_IMAGE_KEEP_COUNT})"
fi

kept_recent=0
removed=0
skipped_in_use=0
# Newest first: `docker image inspect`'s `.Created` is RFC3339Nano, which
# sorts correctly as plain text as long as every image was created by the
# same daemon (it is; this box only ever `docker pull`s, never builds).
# Piped through a process substitution, not a pipe, so `kept_recent` and
# friends survive past the loop instead of dying with a subshell.
while IFS=$'\t' read -r created ref id; do
  [ -n "$id" ] || continue
  if is_protected "$id"; then
    echo "  keep   (running container) ${ref}"
    continue
  fi
  if [ "$kept_recent" -lt "$FLOWSTARTER_IMAGE_KEEP_COUNT" ]; then
    kept_recent=$((kept_recent + 1))
    echo "  keep   (${kept_recent}/${FLOWSTARTER_IMAGE_KEEP_COUNT} most recent, created ${created}) ${ref}"
    continue
  fi
  if [ "$DRY_RUN" -eq 1 ]; then
    echo "  [dry-run] would remove (created ${created}) ${ref}"
    removed=$((removed + 1))
    continue
  fi
  if docker rmi "$ref" >/dev/null 2>&1; then
    echo "  removed (created ${created}) ${ref}"
    removed=$((removed + 1))
  else
    # Never `-f`. A tag `docker rmi` refuses (e.g. the daemon says something
    # still references it) stays on disk rather than getting force-untagged
    # out from under whatever that is — see the header comment.
    echo "  skip   (docker refused to remove it, still in use) ${ref}" >&2
    skipped_in_use=$((skipped_in_use + 1))
  fi
done < <(
  docker images --no-trunc --format '{{.Repository}}:{{.Tag}}\t{{.ID}}' "$FLOWSTARTER_IMAGE_REPO" 2>/dev/null |
    while IFS=$'\t' read -r ref id; do
      # A dangling/untagged row for this repo (Tag "<none>") has no stable
      # name `docker rmi` can act on by reference and only ever comes from
      # an interrupted pull; leave it for a plain `docker image prune`.
      # An `if`, not a `case`: a `case` whose only branch is `continue`,
      # nested this deep inside a pipeline inside a process substitution,
      # is a real parser bug on the bash 3.2 shipped on macOS (reproduced
      # while developing this script) — it is not just a style preference.
      if [ "$ref" = "${FLOWSTARTER_IMAGE_REPO}:<none>" ]; then
        continue
      fi
      created="$(docker image inspect --format '{{.Created}}' "$id" 2>/dev/null || true)"
      [ -n "$created" ] || continue
      printf '%s\t%s\t%s\n' "$created" "$ref" "$id"
    done | sort -r
)

echo "Kept ${kept_recent} recent + running-container images, removed ${removed}, skipped ${skipped_in_use} still in use."

if [ "$DRY_RUN" -eq 1 ]; then
  echo "[dry-run] would run: docker builder prune -f"
else
  echo "Pruning dangling build cache ..."
  docker builder prune -f >/dev/null 2>&1 || echo "warning: docker builder prune failed; continuing" >&2
fi
