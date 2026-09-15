#!/usr/bin/env bash
# Unit-style tests for sync-supabase.sh.
#
#   bash deploy/hetzner-staging/scripts/sync-supabase.test.sh
#
# It runs the real script against a throwaway REPO_DIR, feeding it real tar
# streams built from real fixture directories (tar itself is not stubbed:
# building and reading a tar archive touches nothing outside the sandbox,
# the same reasoning deploy-slot.test.sh applies to leaving `grep`/`awk`
# unstubbed). Only `id` is replaced, so the suite does not need to run as
# root to exercise a script that refuses to run as anything else.
#
# What this proves is the part the old inline `tar -xf - --overwrite` got
# wrong expensively: a file the repo no longer ships must actually be gone
# from the host afterwards, not just sit there next to the file that
# replaced it (PR #140 -- a renamed migration left both filenames on the box
# and broke every deploy until someone logged in and deleted the stale one
# by hand); that a sync bad enough to collide two migrations on one version
# must refuse before touching the live tree, not after; and that file modes
# survive the swap.
#
# Pure bash, no arrays, and portable between the Linux host and macOS bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/sync-supabase.sh"

pass=0
fail=0

ok() {
  pass=$((pass + 1))
  echo "  ok   $1"
}

no() {
  fail=$((fail + 1))
  echo "  FAIL $1"
  [ $# -gt 1 ] && echo "       $2"
}

assert_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    ok "$label"
  else
    no "$label" "expected to find: ${needle}"
  fi
}

assert_not_contains() {
  local haystack="$1" needle="$2" label="$3"
  if printf '%s' "$haystack" | grep -qF -- "$needle"; then
    no "$label" "did not expect to find: ${needle}"
  else
    ok "$label"
  fi
}

# ── A throwaway host ─────────────────────────────────────────────────────
# One temp dir stands in for /opt/flowstarter/staging; SRC stands in for the
# repo checkout the workflow tars up.
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/opt/repo" "$ROOT/src" "$ROOT/bin"

# `id -u` reports 0 so sync-supabase.sh's require_root passes without
# actually running this test suite as root.
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "${STUB_UID:-0}"
  exit 0
fi
exit 1
STUB
chmod +x "$ROOT/bin/id"

export PATH="$ROOT/bin:$PATH"
REPO_DIR="$ROOT/opt/repo"
export REPO_DIR
SCRIPTS_DEST_DIR="$ROOT/opt/staging"
export SCRIPTS_DEST_DIR
MCP_DEST_DIR="$ROOT/opt/mcp"
export MCP_DEST_DIR

# Builds a tar stream of $ROOT/src/supabase and runs the script against it.
run_sync() {
  (cd "$ROOT/src" && tar -cf - supabase) | REPO_DIR="$REPO_DIR" bash "$SCRIPT" 2>&1
}

reset_src() {
  rm -rf "$ROOT/src/supabase"
  mkdir -p "$ROOT/src/supabase/migrations"
  echo "workdir = \".\"" >"$ROOT/src/supabase/config.toml"
}

# Builds a tar stream of BOTH $ROOT/src/supabase and $ROOT/src/scripts --
# two top-level entries, same as staging-deploy.yml's
# `tar -C . -cf - supabase -C deploy/hetzner-staging scripts`.
run_sync_with_scripts() {
  (cd "$ROOT/src" && tar -cf - supabase scripts) | REPO_DIR="$REPO_DIR" SCRIPTS_DEST_DIR="$SCRIPTS_DEST_DIR" bash "$SCRIPT" 2>&1
}

reset_scripts_src() {
  rm -rf "$ROOT/src/scripts"
  mkdir -p "$ROOT/src/scripts"
}

BUILD_WORKER_DEST_DIR="$ROOT/opt/build-worker"
export BUILD_WORKER_DEST_DIR

# Builds a tar stream of all FOUR top-level entries -- supabase, scripts, mcp
# and build-worker -- same as staging-deploy.yml's
# `tar -C . -cf - supabase -C deploy/hetzner-staging scripts mcp build-worker`.
run_sync_with_mcp() {
  (cd "$ROOT/src" && tar -cf - supabase scripts mcp) \
    | REPO_DIR="$REPO_DIR" SCRIPTS_DEST_DIR="$SCRIPTS_DEST_DIR" MCP_DEST_DIR="$MCP_DEST_DIR" bash "$SCRIPT" 2>&1
}

reset_mcp_src() {
  rm -rf "$ROOT/src/mcp"
  mkdir -p "$ROOT/src/mcp"
}

# Same idea, for the build worker's compose file.
run_sync_with_build_worker() {
  (cd "$ROOT/src" && tar -cf - supabase scripts build-worker) \
    | REPO_DIR="$REPO_DIR" SCRIPTS_DEST_DIR="$SCRIPTS_DEST_DIR" \
      BUILD_WORKER_DEST_DIR="$BUILD_WORKER_DEST_DIR" bash "$SCRIPT" 2>&1
}

reset_build_worker_src() {
  rm -rf "$ROOT/src/build-worker"
  mkdir -p "$ROOT/src/build-worker"
}

# ── A first sync onto an empty host ─────────────────────────────────────────
echo "sync-supabase.sh: first sync"
reset_src
: >"$ROOT/src/supabase/migrations/20260913120000_workspaces_cal_provisioning.sql"
out="$(run_sync)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "first sync onto an empty host succeeds"
else
  no "first sync onto an empty host succeeds" "$out"
fi
if [ -f "$REPO_DIR/supabase/migrations/20260913120000_workspaces_cal_provisioning.sql" ]; then
  ok "the migration lands under REPO_DIR/supabase/migrations"
else
  no "the migration lands under REPO_DIR/supabase/migrations"
fi
assert_contains "$out" "Synced supabase/ into" "sync prints where it landed"
if [ ! -d "$ROOT/opt/repo.supabase.sync" ] && [ ! -d "$REPO_DIR/supabase.stale" ]; then
  ok "no staging or stale directory is left behind on success"
else
  no "no staging or stale directory is left behind on success" "$(ls -la "$ROOT/opt")"
fi

# ── The sync is authoritative: a removed file actually disappears ──────────
echo "sync-supabase.sh: authoritative sync removes a stale file"
reset_src
: >"$ROOT/src/supabase/migrations/20260913121000_assets_original_name.sql"
out="$(run_sync)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "sync with the renamed migration succeeds"
else
  no "sync with the renamed migration succeeds" "$out"
fi
if [ -f "$REPO_DIR/supabase/migrations/20260913121000_assets_original_name.sql" ]; then
  ok "the new filename is present"
else
  no "the new filename is present"
fi
if [ ! -e "$REPO_DIR/supabase/migrations/20260913120000_workspaces_cal_provisioning.sql" ]; then
  ok "the file dropped from this sync is gone from the host, not just left alone"
else
  no "the file dropped from this sync is gone from the host, not just left alone"
fi

# ── File modes survive the swap ─────────────────────────────────────────────
echo "sync-supabase.sh: file modes"
reset_src
chmod 640 "$ROOT/src/supabase/config.toml"
run_sync >/dev/null
mode="$(stat -c '%a' "$REPO_DIR/supabase/config.toml" 2>/dev/null || stat -f '%Lp' "$REPO_DIR/supabase/config.toml")"
if [ "$mode" = "640" ]; then
  ok "config.toml keeps its mode (640) across the swap"
else
  no "config.toml keeps its mode (640) across the swap" "got ${mode}"
fi

# ── A version collision refuses before touching the live tree ──────────────
echo "sync-supabase.sh: a version collision in the incoming sync"
reset_src
: >"$ROOT/src/supabase/migrations/20260913121000_assets_original_name.sql"
before="$(ls "$REPO_DIR/supabase/migrations")"
: >"$ROOT/src/supabase/migrations/20260913121000_duplicate.sql"
out="$(run_sync)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "sync refuses when the incoming migrations collide on version"
else
  no "sync refuses when the incoming migrations collide on version" "exited 0"
fi
assert_contains "$out" "20260913121000" "the error names the colliding version"
assert_contains "$out" "20260913121000_assets_original_name.sql" "the error names the first colliding file"
assert_contains "$out" "20260913121000_duplicate.sql" "the error names the second colliding file"
after="$(ls "$REPO_DIR/supabase/migrations")"
if [ "$before" = "$after" ]; then
  ok "the live tree on the host is untouched when the guard trips"
else
  no "the live tree on the host is untouched when the guard trips" "before=[${before}] after=[${after}]"
fi
if [ ! -d "$REPO_DIR/supabase.stale" ] && [ ! -d "$ROOT/opt/repo.supabase.sync" ]; then
  ok "no staging or stale directory is left behind when the guard trips"
else
  no "no staging or stale directory is left behind when the guard trips" "$(ls -la "$ROOT/opt")"
fi

# ── A tar stream with no top-level supabase/ is refused, not swapped in ────
echo "sync-supabase.sh: a tar stream without a top-level supabase/ entry"
before="$(ls "$REPO_DIR/supabase/migrations")"
out="$(cd "$ROOT" && tar -cf - src/supabase | REPO_DIR="$REPO_DIR" bash "$SCRIPT" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "sync refuses a tar stream with no top-level supabase/ entry"
else
  no "sync refuses a tar stream with no top-level supabase/ entry" "exited 0"
fi
after="$(ls "$REPO_DIR/supabase/migrations")"
if [ "$before" = "$after" ]; then
  ok "the live tree is untouched when the tar stream is malformed"
else
  no "the live tree is untouched when the tar stream is malformed" "before=[${before}] after=[${after}]"
fi

# ── install_scripts: a brand-new script name is installed ──────────────────
echo "sync-supabase.sh: scripts install — a new script"
reset_src
reset_scripts_src
{
  echo '#!/usr/bin/env bash'
  echo 'echo hi'
} >"$ROOT/src/scripts/hello.sh"
out="$(run_sync_with_scripts)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "sync with a new script succeeds"
else
  no "sync with a new script succeeds" "$out"
fi
if [ -f "$SCRIPTS_DEST_DIR/hello.sh" ]; then
  ok "the new script lands in SCRIPTS_DEST_DIR"
else
  no "the new script lands in SCRIPTS_DEST_DIR"
fi
mode="$(stat -c '%a' "$SCRIPTS_DEST_DIR/hello.sh" 2>/dev/null || stat -f '%Lp' "$SCRIPTS_DEST_DIR/hello.sh")"
if [ "$mode" = "755" ]; then
  ok "a brand-new script is installed at mode 755"
else
  no "a brand-new script is installed at mode 755" "got ${mode}"
fi
assert_contains "$out" "installed hello.sh" "the install is logged with the script's name"
assert_contains "$out" "sha256" "the install log line names the sha256 prefix"

# ── install_scripts: identical content is a no-op ───────────────────────────
echo "sync-supabase.sh: scripts install — identical content is a no-op"
out="$(run_sync_with_scripts)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "re-syncing the same script content succeeds"
else
  no "re-syncing the same script content succeeds" "$out"
fi
assert_not_contains "$out" "installed hello.sh" "an unchanged script is not reinstalled"
assert_contains "$out" "scripts already up to date" "sync-supabase.sh says nothing needed installing"

# ── install_scripts: differing content is replaced atomically, mode 755 ────
echo "sync-supabase.sh: scripts install — differing content is replaced"
{
  echo '#!/usr/bin/env bash'
  echo 'echo bye'
} >"$ROOT/src/scripts/hello.sh"
chmod 644 "$ROOT/src/scripts/hello.sh"  # deliberately not executable in the incoming tar
out="$(run_sync_with_scripts)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "re-syncing changed script content succeeds"
else
  no "re-syncing changed script content succeeds" "$out"
fi
assert_contains "$out" "installed hello.sh" "changed content is reinstalled"
if grep -q "echo bye" "$SCRIPTS_DEST_DIR/hello.sh"; then
  ok "the installed script's content actually changed"
else
  no "the installed script's content actually changed" "$(cat "$SCRIPTS_DEST_DIR/hello.sh")"
fi
mode="$(stat -c '%a' "$SCRIPTS_DEST_DIR/hello.sh" 2>/dev/null || stat -f '%Lp' "$SCRIPTS_DEST_DIR/hello.sh")"
if [ "$mode" = "755" ]; then
  ok "the replacement is chmod 755 even though the incoming file was not executable"
else
  no "the replacement is chmod 755 even though the incoming file was not executable" "got ${mode}"
fi
if ! ls "$SCRIPTS_DEST_DIR"/.hello.sh.*.new >/dev/null 2>&1; then
  ok "no leftover temp file after the atomic replace"
else
  no "no leftover temp file after the atomic replace" "$(ls "$SCRIPTS_DEST_DIR")"
fi

# ── install_scripts: installing a copy of sync-supabase.sh itself is safe ──
# This is the self-update case: SCRIPTS_DEST_DIR/sync-supabase.sh is what a
# real host actually re-execs on every future deploy, so replacing it must
# not corrupt the copy that is (in production) still running -- it is `mv`,
# not a truncate-in-place, so this is the same atomic swap as any other
# script.
echo "sync-supabase.sh: scripts install — installs a copy of itself"
cp "$SCRIPT" "$ROOT/src/scripts/sync-supabase.sh"
out="$(run_sync_with_scripts)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "syncing a copy of sync-supabase.sh itself succeeds"
else
  no "syncing a copy of sync-supabase.sh itself succeeds" "$out"
fi
if [ -f "$SCRIPTS_DEST_DIR/sync-supabase.sh" ]; then
  ok "the installed copy of sync-supabase.sh exists"
else
  no "the installed copy of sync-supabase.sh exists"
fi
assert_contains "$out" "installed sync-supabase.sh" "installing a copy of itself is logged like any other script"

# ── A tar stream with no top-level scripts/ entry leaves prior installs alone
echo "sync-supabase.sh: a tar stream without a top-level scripts/ entry"
reset_src
out="$(run_sync)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a supabase-only sync (no scripts/ entry) still succeeds"
else
  no "a supabase-only sync (no scripts/ entry) still succeeds" "$out"
fi
assert_contains "$out" "no scripts/ in the tar stream" "sync-supabase.sh says it skipped installing scripts"
if [ -f "$SCRIPTS_DEST_DIR/hello.sh" ]; then
  ok "a previously installed script is left alone when this sync omits scripts/"
else
  no "a previously installed script is left alone when this sync omits scripts/"
fi

# ── The template library's compose file ─────────────────────────────────────
# It travels in the same tar stream as the scripts, for the same reason: it is
# a file the box runs and `main` owns. What must NOT travel with it is the env
# file beside it in the repo -- that one is an example, and the real one holds
# the shared secret the app slot authenticates with.
echo "sync-supabase.sh: mcp install"
reset_src
reset_scripts_src
reset_mcp_src
printf 'services:\n  mcp:\n    image: ghcr.io/dmpresearch/flowstarter-mcp:main\n' >"$ROOT/src/mcp/docker-compose.yml"
printf 'FLOWSTARTER_MCP_INTERNAL_TOKEN=replace-me\n' >"$ROOT/src/mcp/mcp.env.example"
out="$(run_sync_with_mcp)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a sync carrying mcp/ succeeds"
else
  no "a sync carrying mcp/ succeeds" "$out"
fi
if [ -f "$MCP_DEST_DIR/docker-compose.yml" ]; then
  ok "the compose file lands in MCP_DEST_DIR"
else
  no "the compose file lands in MCP_DEST_DIR"
fi
assert_contains "$out" "installed mcp/docker-compose.yml" "the install is logged with its hash"
if [ ! -e "$MCP_DEST_DIR/mcp.env.example" ]; then
  ok "the example env file is NOT installed alongside it"
else
  no "the example env file is NOT installed alongside it" "a lane that can write an env file can write a secret"
fi
mode="$(stat -c '%a' "$MCP_DEST_DIR/docker-compose.yml" 2>/dev/null || stat -f '%Lp' "$MCP_DEST_DIR/docker-compose.yml")"
if [ "$mode" = "644" ]; then
  ok "the compose file is installed 644"
else
  no "the compose file is installed 644" "found $mode"
fi

echo "sync-supabase.sh: mcp install — an unchanged compose file is not rewritten"
out="$(run_sync_with_mcp)"
assert_contains "$out" "already up to date" "an identical compose file is left alone"

echo "sync-supabase.sh: mcp install — a changed compose file is replaced"
printf 'services:\n  mcp:\n    mem_limit: 512m\n' >"$ROOT/src/mcp/docker-compose.yml"
out="$(run_sync_with_mcp)"
assert_contains "$out" "installed mcp/docker-compose.yml" "the changed compose file is reinstalled"
assert_contains "$(cat "$MCP_DEST_DIR/docker-compose.yml")" "mem_limit: 512m" "the installed content actually changed"
if [ -z "$(find "$MCP_DEST_DIR" -name '.docker-compose.yml.*.new' 2>/dev/null)" ]; then
  ok "no leftover temp file after the atomic replace"
else
  no "no leftover temp file after the atomic replace"
fi

echo "sync-supabase.sh: a tar stream without a top-level mcp/ entry"
reset_src
reset_scripts_src
out="$(run_sync_with_scripts)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a sync without mcp/ still succeeds"
else
  no "a sync without mcp/ still succeeds" "$out"
fi
assert_contains "$out" "no mcp/ in the tar stream" "sync-supabase.sh says it skipped the compose file"
if [ -f "$MCP_DEST_DIR/docker-compose.yml" ]; then
  ok "a previously installed compose file is left alone when this sync omits mcp/"
else
  no "a previously installed compose file is left alone when this sync omits mcp/"
fi

# ── The build worker's compose file ─────────────────────────────────────────
# Installed for the same reason the scripts are: it is a file the box runs and
# `main` owns. It is deliberately NOT installed into SCRIPTS_DEST_DIR, which
# sudoers grants by glob and should stay a directory of scripts.
echo "sync-supabase.sh: build-worker compose install"
reset_src
reset_scripts_src
reset_build_worker_src
printf 'services:\n  build-worker:\n    image: first\n' \
  >"$ROOT/src/build-worker/docker-compose.yml"
# An env EXAMPLE sits beside it in the repo and must never be installed: the
# real one is /etc/flowstarter/build-worker-staging.env, mode 600.
printf 'FLOWSTARTER_BUILD_WORKER_SECRET=replace-me\n' \
  >"$ROOT/src/build-worker/build-worker.env.example"
out="$(run_sync_with_build_worker)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a sync carrying build-worker/ succeeds"
else
  no "a sync carrying build-worker/ succeeds" "$out"
fi
if [ -f "$BUILD_WORKER_DEST_DIR/docker-compose.yml" ]; then
  ok "the compose file lands in BUILD_WORKER_DEST_DIR"
else
  no "the compose file lands in BUILD_WORKER_DEST_DIR" "$out"
fi
if [ -f "$BUILD_WORKER_DEST_DIR/build-worker.env.example" ]; then
  no "the env example is not installed" "it was copied to the host"
else
  ok "the env example is not installed"
fi
assert_contains "$out" "installed build-worker/docker-compose.yml" \
  "the install is logged with its digest"

echo "sync-supabase.sh: build-worker compose — unchanged content is not rewritten"
out="$(run_sync_with_build_worker)"
assert_contains "$out" "already up to date" "an unchanged compose file is left alone"

echo "sync-supabase.sh: build-worker compose — changed content is replaced atomically"
printf 'services:\n  build-worker:\n    image: second\n' \
  >"$ROOT/src/build-worker/docker-compose.yml"
out="$(run_sync_with_build_worker)"
if grep -q "image: second" "$BUILD_WORKER_DEST_DIR/docker-compose.yml"; then
  ok "the installed compose file actually changed"
else
  no "the installed compose file actually changed" "$(cat "$BUILD_WORKER_DEST_DIR/docker-compose.yml")"
fi
if ! ls "$BUILD_WORKER_DEST_DIR"/.docker-compose.yml.*.new >/dev/null 2>&1; then
  ok "no leftover temp file after the atomic replace"
else
  no "no leftover temp file after the atomic replace" "$(ls "$BUILD_WORKER_DEST_DIR")"
fi

echo "sync-supabase.sh: a tar stream without a top-level build-worker/ entry"
reset_src
out="$(run_sync)"
assert_contains "$out" "no build-worker/ in the tar stream" \
  "sync-supabase.sh says it skipped the build worker"
if grep -q "image: second" "$BUILD_WORKER_DEST_DIR/docker-compose.yml"; then
  ok "a previously installed compose file is left alone when this sync omits it"
else
  no "a previously installed compose file is left alone when this sync omits it"
fi

# ── Refuses to run as non-root ───────────────────────────────────────────────
echo "sync-supabase.sh: requires root"
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "1000"
  exit 0
fi
exit 1
STUB
chmod +x "$ROOT/bin/id"
out="$(printf '' | REPO_DIR="$REPO_DIR" bash "$SCRIPT" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "sync-supabase.sh refuses to run as a non-root uid"
else
  no "sync-supabase.sh refuses to run as a non-root uid" "exited 0"
fi
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "0"
  exit 0
fi
exit 1
STUB
chmod +x "$ROOT/bin/id"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
