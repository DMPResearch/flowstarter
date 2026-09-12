#!/usr/bin/env bash
# Tests for the on-demand TLS policy detection in
# scripts/install-existing-host-agent.sh, run directly with
# `bash scripts/__tests__/install-existing-host-agent.test.sh`.
#
# This exercises `integrate_on_demand_policy` — the exact function the
# installer calls — against fixture Caddyfiles, without needing root, Docker,
# Caddy or systemd. Sourcing the installer defines the function (and `main`)
# but does not run `main`, because the installer guards that behind
# `[[ "${BASH_SOURCE[0]}" == "${0}" ]]`.
#
# Regression covered: before this fix, ANY `on_demand_tls` block already
# present in the host's Caddyfile made the installer abort — including the
# platform's own policy, which cloud-init writes into every host it
# provisions with previews enabled. That refused the installer's very
# purpose on those hosts. The fix recognises the platform's policy by the
# "flowstarter-managed-on-demand-tls" marker comment cloud-init emits next to
# it, and integrates instead of aborting, while still aborting for a policy
# that carries neither the marker nor this script's own import line.
set -uo pipefail

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
installer="$script_dir/../install-existing-host-agent.sh"

# shellcheck source=/dev/null
source "$installer"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

failures=0

pass() {
  echo "ok - $1"
}

fail() {
  echo "not ok - $1"
  failures=$((failures + 1))
}

assert_eq() {
  local desc="$1" expected="$2" actual="$3"
  if [[ "$actual" == "$expected" ]]; then
    pass "$desc"
  else
    fail "$desc (expected '$expected', got '$actual')"
  fi
}

assert_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" == *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc (expected to find '$needle')"
  fi
}

assert_not_contains() {
  local desc="$1" haystack="$2" needle="$3"
  if [[ "$haystack" != *"$needle"* ]]; then
    pass "$desc"
  else
    fail "$desc (did not expect to find '$needle')"
  fi
}

# ── Case 1: no on-demand policy at all ──────────────────────────────────
no_policy_file="$tmpdir/no-policy.Caddyfile"
cat > "$no_policy_file" <<'CADDY'
{
  email ops@example.com
}
import /etc/caddy/sites/*.caddy
CADDY

if mode=$(integrate_on_demand_policy "$no_policy_file" 2>"$tmpdir/no-policy.stderr"); then
  assert_eq 'no policy: reports "own"' 'own' "$mode"
  after=$(cat "$no_policy_file")
  assert_contains 'no policy: adds this script'"'"'s import marker' "$after" \
    'import /etc/caddy/flowstarter-preview-global.caddy'
  assert_contains 'no policy: adds the sites import glob' "$after" \
    'import /etc/caddy/sites/*.caddy'
  assert_contains 'no policy: adds the platform import glob' "$after" \
    'import /etc/caddy/platform/*.caddy'
else
  fail 'no policy: integrate_on_demand_policy should succeed'
fi

# ── Case 2: the platform's own policy (what cloud-init.ts writes) ──────
platform_policy_file="$tmpdir/platform-policy.Caddyfile"
cat > "$platform_policy_file" <<'CADDY'
{
  email ops@example.com
  # flowstarter-managed-on-demand-tls
  on_demand_tls {
    ask http://127.0.0.1:8444/tls-ask
  }
}
import /etc/caddy/sites/*.caddy
CADDY
before_platform=$(cat "$platform_policy_file")

if mode=$(integrate_on_demand_policy "$platform_policy_file" 2>"$tmpdir/platform-policy.stderr"); then
  assert_eq 'platform policy: reports "platform", not an abort' 'platform' "$mode"
  after=$(cat "$platform_policy_file")
  assert_not_contains \
    'platform policy: does not add a second (redundant) on_demand_tls import' \
    "$after" 'import /etc/caddy/flowstarter-preview-global.caddy'
  assert_eq 'platform policy: only ever had the one on_demand_tls directive' \
    "$(grep -c 'on_demand_tls' <<<"$after")" \
    "$(grep -c 'on_demand_tls' <<<"$before_platform")"
else
  fail 'platform policy: integrate_on_demand_policy should NOT abort (this is the regression)'
  cat "$tmpdir/platform-policy.stderr" >&2
fi

# ── Case 3: a foreign on-demand policy this script did not write ───────
foreign_policy_file="$tmpdir/foreign-policy.Caddyfile"
cat > "$foreign_policy_file" <<'CADDY'
{
  email ops@example.com
  on_demand_tls {
    ask http://127.0.0.1:9999/some-other-ask-endpoint
  }
}
import /etc/caddy/sites/*.caddy
CADDY
before_foreign=$(cat "$foreign_policy_file")

if mode=$(integrate_on_demand_policy "$foreign_policy_file" 2>"$tmpdir/foreign-policy.stderr"); then
  fail "foreign policy: integrate_on_demand_policy should abort, got mode '$mode'"
else
  pass 'foreign policy: integrate_on_demand_policy aborts (non-zero exit)'
  stderr=$(cat "$tmpdir/foreign-policy.stderr")
  assert_contains 'foreign policy: error names the problem' "$stderr" \
    'Existing on-demand TLS policy requires explicit integration'
  assert_contains 'foreign policy: error explains what to do' "$stderr" \
    'Merge the policies by hand'
  after=$(cat "$foreign_policy_file")
  assert_eq 'foreign policy: the file is left untouched' "$before_foreign" "$after"
fi

echo ""
if [[ "$failures" -eq 0 ]]; then
  echo "All checks passed."
  exit 0
else
  echo "$failures check(s) failed."
  exit 1
fi
