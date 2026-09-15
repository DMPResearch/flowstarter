#!/usr/bin/env bash
# Sync the repository's supabase/ directory onto this host, authoritatively,
# and install this deploy user's own scripts (deploy-slot.sh, destroy-slot.sh,
# supabase-stack.sh, this script itself, etc.) from the same checkout.
#
# Usage (stdin is a tar stream, not an argument):
#   tar -C . -cf - supabase \
#     -C deploy/hetzner-staging scripts mcp build-worker | sync-supabase.sh
#
# The `-C` flags give the stream four top-level entries -- "supabase",
# "scripts", "mcp" and "build-worker" -- from two different directories of the
# repo checkout (this is what staging-deploy.yml's "Sync supabase/, scripts/
# and the mcp/build-worker compose files to the host" step sends). A stream
# carrying only some of them -- the older, still-supported forms -- is also
# accepted; each install is skipped in that case, not an error, so a person
# bootstrapping the box by hand with the one-liner from README.md's "One-time
# box setup" doesn't need to change anything.
#
# Reads a tar stream from stdin and makes REPO_DIR/supabase/ match it
# exactly: files the repo no longer has are gone afterwards, not merely left
# alone.
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
# "One-time box setup") at /opt/flowstarter/staging/sync-supabase.sh, so it
# is covered by the same sudoers Cmnd_Alias every other deploy script is
# (`/opt/flowstarter/staging/*.sh`, see /etc/sudoers.d/flowstarter-deploy on
# the host). The in-line extract-to-temp-and-swap commands this replaces
# were never added to sudoers and broke staging-deploy.yml's sync step
# outright ("sudo: a password is required") the moment they shipped:
# sudoers matches literal commands, not shell logic embedded in an ssh
# argument, so anything beyond the exact `mkdir`/`tar` pair the deploy user
# was granted needs to live in a script sudoers can name by path instead.
#
# 2026-09-15: this is also why the scripts under scripts/ themselves used to
# go stale on the box -- nothing installed them past the one-time bootstrap
# copy, so a merged fix (PR #175's image retention) sat on `main` for days
# while the box kept running deploy-slot.sh from the commit it was last
# bootstrapped with, and the disk filled anyway. This script now installs
# scripts/*.sh from the synced repo copy too (see install_scripts below),
# on every deploy, for exactly the reason it already syncs supabase/ on
# every deploy: main and the box must never be allowed to drift apart
# silently. See docs/operations/deploy-disk.md.
#
# Env overrides:
#   REPO_DIR          default /opt/flowstarter/staging/repo (same default
#                      supabase-stack.sh uses; supabase/config.toml lives
#                      under here once synced)
#   SCRIPTS_DEST_DIR  default /opt/flowstarter/staging (where deploy-slot.sh,
#                      this script, etc. actually run from; see
#                      /etc/sudoers.d/flowstarter-deploy)

set -euo pipefail

REPO_DIR="${REPO_DIR:-/opt/flowstarter/staging/repo}"
STAGE_DIR="${REPO_DIR}.supabase.sync"
STALE_DIR="${REPO_DIR}/supabase.stale"
SCRIPTS_DEST_DIR="${SCRIPTS_DEST_DIR:-/opt/flowstarter/staging}"
# The template library's compose file. It lives beside the editor's rather
# than in SCRIPTS_DEST_DIR because mcp-stack.sh resolves it relative to itself
# (`$HERE/../mcp/docker-compose.yml`), exactly as editor-stack.sh resolves the
# editor's -- and because SCRIPTS_DEST_DIR is what sudoers grants by glob,
# which should stay a directory of scripts and nothing else.
MCP_DEST_DIR="${MCP_DEST_DIR:-/opt/flowstarter/mcp}"
# The build worker's compose file. It lives beside the editor's rather than in
# SCRIPTS_DEST_DIR because worker-stack.sh resolves it relative to itself
# (`$HERE/../build-worker/docker-compose.yml`), exactly as editor-stack.sh
# resolves the editor's -- and because SCRIPTS_DEST_DIR is what sudoers grants
# by glob, which should stay a directory of scripts and nothing else.
BUILD_WORKER_DEST_DIR="${BUILD_WORKER_DEST_DIR:-/opt/flowstarter/build-worker}"

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

sha256_cmd() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    shasum -a 256 "$path"
  fi
}

# Installs *.sh from src_dir into dest_dir, atomically and only where the
# content actually changed:
#
#   - identical content        -> left alone, not even its mtime touched
#   - new or differing content -> written to a dotfile in dest_dir (same
#     directory as the target, so the final `mv` stays on one filesystem),
#     chmod 755, then `mv -f` over the target
#
# `mv` within one directory only repoints the directory entry; it never
# rewrites the inode a currently-running script is reading. bash reads a
# script incrementally as it executes each line, so replacing the file
# in place (truncate + write, or an editor's "overwrite") could hand a
# script that is mid-run a mix of old and new bytes. Renaming a finished
# temp file over the target instead means every reader -- including a
# deploy already in flight, and including this script overwriting its own
# installed copy at SCRIPTS_DEST_DIR/sync-supabase.sh -- sees the complete
# old file or the complete new one, never a corrupt mix. (The *running*
# interpreter is unaffected either way: it was invoked as `bash
# REPO_DIR.supabase.sync/scripts/sync-supabase.sh` or piped via stdin, a
# path distinct from the one this function writes to.)
#
# A brand-new script name (never installed on this box before) is just the
# "differing content" case with no prior file to compare against, so no
# separate bootstrap step is needed for it: the first push that adds
# scripts/some-new-script.sh to the repo installs it here, covered by the
# same sudoers glob (`/opt/flowstarter/staging/*.sh`) as everything else.
install_scripts() {
  local src_dir="$1" dest_dir="$2"

  if [[ ! -d "$src_dir" ]]; then
    echo "sync-supabase.sh: no scripts/ in the tar stream; leaving ${dest_dir} untouched." >&2
    return 0
  fi

  mkdir -p "$dest_dir"

  local installed=0
  local f name dest_file tmp_file new_hash old_hash

  shopt -s nullglob
  for f in "$src_dir"/*.sh; do
    name="$(basename "$f")"
    dest_file="${dest_dir}/${name}"
    new_hash="$(sha256_cmd "$f" | awk '{print $1}')"

    if [[ -f "$dest_file" ]]; then
      old_hash="$(sha256_cmd "$dest_file" | awk '{print $1}')"
      if [[ "$old_hash" == "$new_hash" ]]; then
        continue
      fi
    fi

    tmp_file="${dest_dir}/.${name}.$$.new"
    rm -f "$tmp_file"
    cp "$f" "$tmp_file"
    chmod 755 "$tmp_file"
    mv -f "$tmp_file" "$dest_file"
    installed=$((installed + 1))
    echo "sync-supabase.sh: installed ${name} (sha256 ${new_hash:0:12})"
  done
  shopt -u nullglob

  if [[ "$installed" -eq 0 ]]; then
    echo "sync-supabase.sh: scripts already up to date in ${dest_dir}"
  fi
}

# The template library's compose file, installed the same way and for the same
# reason the scripts above are: it is a file the box runs and `main` owns, and
# the two must not be allowed to drift. Same atomic temp-then-rename, so an
# `mcp-stack.sh up` racing this never reads a half-written compose file.
#
# Only the compose file. The env file beside it in the repo is an EXAMPLE and
# is never installed: the real one is /etc/flowstarter/mcp-staging.env, mode
# 600, and a deploy lane that could write it could write a secret from a repo
# checkout.
install_mcp() {
  local src_dir="$1" dest_dir="$2"
  local src="${src_dir}/docker-compose.yml"

  if [[ ! -f "$src" ]]; then
    echo "sync-supabase.sh: no mcp/ in the tar stream; leaving ${dest_dir} untouched." >&2
    return 0
  fi

  mkdir -p "$dest_dir"
  local dest_file="${dest_dir}/docker-compose.yml"
  local new_hash old_hash tmp_file
  new_hash="$(sha256_cmd "$src" | awk '{print $1}')"
  if [[ -f "$dest_file" ]]; then
    old_hash="$(sha256_cmd "$dest_file" | awk '{print $1}')"
    if [[ "$old_hash" == "$new_hash" ]]; then
      echo "sync-supabase.sh: template library compose file already up to date in ${dest_dir}"
      return 0
    fi
  fi

  tmp_file="${dest_dir}/.docker-compose.yml.$$.new"
  rm -f "$tmp_file"
  cp "$src" "$tmp_file"
  chmod 644 "$tmp_file"
  mv -f "$tmp_file" "$dest_file"
  echo "sync-supabase.sh: installed mcp/docker-compose.yml (sha256 ${new_hash:0:12})"
}

# The build worker's compose file, installed the same way and for the same
# reason the scripts above are: it is a file the box runs and `main` owns, and
# the two must not be allowed to drift. Same atomic temp-then-rename, so a
# `worker-stack.sh up` racing this never reads a half-written compose file.
#
# Only the compose file. The env file beside it in the repo is an EXAMPLE and
# is never installed: the real one is /etc/flowstarter/build-worker-staging.env,
# mode 600, and a deploy lane that could write it could write a secret from a
# repo checkout.
install_build_worker() {
  local src_dir="$1" dest_dir="$2"
  local src="${src_dir}/docker-compose.yml"

  if [[ ! -f "$src" ]]; then
    echo "sync-supabase.sh: no build-worker/ in the tar stream; leaving ${dest_dir} untouched." >&2
    return 0
  fi

  mkdir -p "$dest_dir"
  local dest_file="${dest_dir}/docker-compose.yml"
  local new_hash old_hash tmp_file
  new_hash="$(sha256_cmd "$src" | awk '{print $1}')"
  if [[ -f "$dest_file" ]]; then
    old_hash="$(sha256_cmd "$dest_file" | awk '{print $1}')"
    if [[ "$old_hash" == "$new_hash" ]]; then
      echo "sync-supabase.sh: build worker compose file already up to date in ${dest_dir}"
      return 0
    fi
  fi

  tmp_file="${dest_dir}/.docker-compose.yml.$$.new"
  rm -f "$tmp_file"
  cp "$src" "$tmp_file"
  chmod 644 "$tmp_file"
  mv -f "$tmp_file" "$dest_file"
  echo "sync-supabase.sh: installed build-worker/docker-compose.yml (sha256 ${new_hash:0:12})"
}

main() {
  require_root
  trap cleanup EXIT

  rm -rf "$STAGE_DIR"
  mkdir -p "$STAGE_DIR"

  # stdin is the tar stream; a top-level "supabase" entry is expected
  # (produced by `tar -C . -cf - supabase` in the repo checkout), plus
  # optional top-level "scripts", "mcp" and "build-worker" entries (produced
  # by appending `-C deploy/hetzner-staging scripts mcp build-worker` to that
  # same tar command).
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

  install_scripts "${STAGE_DIR}/scripts" "$SCRIPTS_DEST_DIR"
  install_mcp "${STAGE_DIR}/mcp" "$MCP_DEST_DIR"
  install_build_worker "${STAGE_DIR}/build-worker" "$BUILD_WORKER_DEST_DIR"
}

main "$@"
