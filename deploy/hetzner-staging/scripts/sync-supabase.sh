#!/usr/bin/env bash
# Sync the repository's supabase/ directory onto this host, authoritatively.
#
# Usage (stdin is a tar stream, not an argument):
#   tar -C . -cf - supabase | sync-supabase.sh
#
# Reads a tar stream from stdin -- produced by `tar -C . -cf - supabase` in
# the repo checkout, with a single top-level "supabase" entry -- and makes
# REPO_DIR/supabase/ match it exactly: files the repo no longer has are gone
# afterwards, not merely left alone.
#
# Extracting straight on top of REPO_DIR/supabase/ (the previous approach,
# `tar -C REPO_DIR -xf - --overwrite`, run inline over ssh from
# staging-deploy.yml) only ever adds or replaces files. When a migration was
# renamed on main (PR #140, 20260913120000_assets_original_name.sql renamed
# to 20260913121000_assets_original_name.sql), the box kept both the old and
# the new filename, `supabase migration up` saw two migrations sharing one
# version, and every deploy of slot `main` failed until the stale file was
# deleted by hand.
#
# This script instead extracts into a throwaway sibling directory, refuses
# to go further if the migrations it just received collide on version (same
# check as supabase-stack.sh's migrate step, run here too so a bad sync
# never reaches the live tree in the first place -- REPO_DIR/supabase is
# left exactly as it was), and only then swaps the staged tree into place
# with two directory renames. REPO_DIR/supabase is therefore always either
# the complete old tree or the complete new one, never a half-applied
# overlay of both. File modes are preserved (tar's default).
#
# Installed alongside deploy-slot.sh and supabase-stack.sh (see README.md,
# "Bootstrap") at /opt/flowstarter/staging/sync-supabase.sh, so it is
# covered by the same sudoers Cmnd_Alias every other deploy script is
# (`/opt/flowstarter/staging/*.sh`, see /etc/sudoers.d/flowstarter-deploy on
# the host). The in-line extract-to-temp-and-swap commands this replaces
# were never added to sudoers and broke staging-deploy.yml's sync step
# outright ("sudo: a password is required") the moment they shipped:
# sudoers matches literal commands, not shell logic embedded in an ssh
# argument, so anything beyond the exact `mkdir`/`tar` pair the deploy user
# was granted needs to live in a script sudoers can name by path instead.
#
# Env overrides:
#   REPO_DIR   default /opt/flowstarter/staging/repo (same default
#              supabase-stack.sh uses; supabase/config.toml lives under
#              here once synced)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/flowstarter/staging/repo}"
STAGE_DIR="${REPO_DIR}.supabase.sync"
STALE_DIR="${REPO_DIR}/supabase.stale"

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" -ne 0 ]]; then
    echo "sync-supabase.sh must be run as root (current uid: ${uid})." >&2
    exit 1
  fi
}

# Same guard as supabase-stack.sh's migrate step, run here first so a
# colliding sync never reaches the live tree at all: this refuses BEFORE the
# swap, not after, so the host keeps whatever it was already running.
check_no_duplicate_migration_versions() {
  local dir="$1"
  [[ -d "$dir" ]] || return 0

  local dupes
  dupes="$(
    find "$dir" -maxdepth 1 -type f -name '*.sql' -exec basename {} \; \
      | sed -nE 's/^([0-9]{14})_.*\.sql$/\1/p' \
      | sort | uniq -d
  )"
  [[ -z "$dupes" ]] && return 0

  echo "sync-supabase.sh: refusing to sync — two migration files share the same version." >&2
  local version
  while IFS= read -r version; do
    [[ -z "$version" ]] && continue
    echo "  version ${version}:" >&2
    find "$dir" -maxdepth 1 -type f -name "${version}_*.sql" -exec basename {} \; \
      | sort | sed 's/^/    /' >&2
  done <<<"$dupes"
  echo "Rename one of them on main so its version (the leading timestamp, not just the slug) is unique, then redeploy. The tree on this host was not touched." >&2
  return 1
}

cleanup() {
  rm -rf "$STAGE_DIR"
}

main() {
  require_root
  trap cleanup EXIT

  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"

  # stdin is the tar stream; a top-level "supabase" entry is expected, which
  # is what `tar -C . -cf - supabase` in the repo checkout produces.
  tar -C "$STAGE_DIR" -xf -

  if [[ ! -d "${STAGE_DIR}/supabase" ]]; then
    echo "sync-supabase.sh: the tar stream on stdin had no top-level 'supabase' directory; nothing swapped in." >&2
    exit 1
  fi

  if ! check_no_duplicate_migration_versions "${STAGE_DIR}/supabase/migrations"; then
    exit 1
  fi

  mkdir -p "$REPO_DIR"
  rm -rf "$STALE_DIR"
  if [[ -d "${REPO_DIR}/supabase" ]]; then
    mv "${REPO_DIR}/supabase" "$STALE_DIR"
  fi
  mv "${STAGE_DIR}/supabase" "${REPO_DIR}/supabase"
  rm -rf "$STALE_DIR"

  echo "Synced supabase/ into ${REPO_DIR}/supabase"
}

main "$@"
