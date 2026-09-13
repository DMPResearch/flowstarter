#!/usr/bin/env bash
# Unit-style tests for supabase-stack.sh's migrate guard.
#
#   bash deploy/hetzner-staging/scripts/supabase-stack.test.sh
#
# It runs the real script's `migrate` subcommand against a throwaway
# REPO_DIR, with `id` and `supabase` replaced by stubs on PATH, so nothing
# here talks to a daemon or a database. What this proves is the part a stale
# sync gets wrong expensively: two migration files stamped with the same
# version (a renamed migration, PR #140, left both the old and new filename
# on the Hetzner host because the old sync step only ever added or replaced
# files, never deleted them) must fail `migrate` outright, with both
# filenames named in the error, instead of reaching `supabase migration up`
# and failing as a raw database error nobody deploying can act on.
#
# Pure bash, no arrays, and portable between the Linux host and macOS bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/supabase-stack.sh"

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
# One temp dir stands in for /opt/flowstarter/staging/repo.
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/repo/supabase/migrations" "$ROOT/bin"

# `id -u` reports 0 so supabase-stack.sh's require_root passes without
# actually running this test suite as root.
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "${STUB_UID:-0}"
  exit 0
fi
exit 1
STUB

# `supabase migration up` / `supabase migration list --local` both just log
# what they were called with; the guard under test runs before either, so a
# passing case proves the real CLI would have been reached, and a failing
# case proves it never was.
cat >"$ROOT/bin/supabase" <<'STUB'
#!/usr/bin/env bash
echo "supabase $*" >>"$STUB_LOG"
exit 0
STUB

chmod +x "$ROOT/bin/"*

export PATH="$ROOT/bin:$PATH"
export STUB_LOG="$ROOT/stub.log"

: >"$ROOT/repo/supabase/config.toml"

reset_migrations() {
  rm -rf "$ROOT/repo/supabase/migrations"
  mkdir -p "$ROOT/repo/supabase/migrations"
}

run_migrate() {
  : >"$STUB_LOG"
  REPO_DIR="$ROOT/repo" bash "$SCRIPT" migrate 2>&1
}

# ── A clean set of migrations still applies ─────────────────────────────────
echo "supabase-stack.sh migrate: unique versions"
reset_migrations
: >"$ROOT/repo/supabase/migrations/20260913120000_workspaces_cal_provisioning.sql"
: >"$ROOT/repo/supabase/migrations/20260913121000_assets_original_name.sql"
out="$(run_migrate)"
rc=$?
log="$(cat "$STUB_LOG")"
if [ "$rc" -eq 0 ]; then
  ok "migrate succeeds when every migration has a unique version"
else
  no "migrate succeeds when every migration has a unique version" "$out"
fi
assert_contains "$log" "supabase migration up --include-all" "migrate reaches supabase migration up"
assert_contains "$log" "supabase migration list --local" "migrate reaches supabase migration list"

# ── No migrations directory at all is not an error the guard invents ────────
echo "supabase-stack.sh migrate: no migrations directory"
rm -rf "$ROOT/repo/supabase/migrations"
out="$(run_migrate)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "migrate does not fail just because there is no migrations directory yet"
else
  no "migrate does not fail just because there is no migrations directory yet" "$out"
fi
reset_migrations

# ── Two files stamped with the same version ─────────────────────────────────
# This is the actual PR #140 incident: a migration renamed on main, but the
# old sync step left the stale filename on the host next to the new one.
echo "supabase-stack.sh migrate: a version collision"
: >"$ROOT/repo/supabase/migrations/20260913120000_assets_original_name.sql"
: >"$ROOT/repo/supabase/migrations/20260913120000_workspaces_cal_provisioning.sql"
: >"$ROOT/repo/supabase/migrations/20260913121000_funnel_upload_sessions.sql"
out="$(run_migrate)"
rc=$?
log="$(cat "$STUB_LOG")"
if [ "$rc" -ne 0 ]; then
  ok "migrate refuses when two migrations share a version"
else
  no "migrate refuses when two migrations share a version" "exited 0"
fi
assert_contains "$out" "20260913120000" "the error names the colliding version"
assert_contains "$out" "20260913120000_assets_original_name.sql" "the error names the first colliding file"
assert_contains "$out" "20260913120000_workspaces_cal_provisioning.sql" "the error names the second colliding file"
assert_not_contains "$out" "20260913121000_funnel_upload_sessions.sql" "the error does not name the unrelated, non-colliding migration"
assert_not_contains "$log" "supabase migration up" "migrate never reaches supabase migration up once the guard trips"
assert_not_contains "$log" "supabase migration list" "migrate never reaches supabase migration list once the guard trips"

# ── Three-way collision names every file, not just two ──────────────────────
echo "supabase-stack.sh migrate: a three-way version collision"
reset_migrations
: >"$ROOT/repo/supabase/migrations/20260913120000_a.sql"
: >"$ROOT/repo/supabase/migrations/20260913120000_b.sql"
: >"$ROOT/repo/supabase/migrations/20260913120000_c.sql"
out="$(run_migrate)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "migrate refuses a three-way collision"
else
  no "migrate refuses a three-way collision" "exited 0"
fi
assert_contains "$out" "20260913120000_a.sql" "the error names file a"
assert_contains "$out" "20260913120000_b.sql" "the error names file b"
assert_contains "$out" "20260913120000_c.sql" "the error names file c"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
