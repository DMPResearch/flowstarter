#!/usr/bin/env bash
# Unit-style tests for wait-for-staging-slot.sh's health-body matching.
#
#   bash .github/scripts/wait-for-staging-slot.test.sh
#
# `curl` is stubbed on PATH so nothing here makes a network call, and `sleep`
# is stubbed to a no-op so a case designed to time out still finishes in well
# under a second of wall clock rather than the real budget. Follows the style
# of deploy/hetzner-staging/scripts/deploy-slot.test.sh: real script, stubbed
# world, ok/no counters.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/wait-for-staging-slot.sh"

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

ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT
mkdir -p "$ROOT/bin"

# `curl` answers whatever HEALTH_BODY says. `-fsS --max-time 20 <url>` is
# always the invocation; the stub ignores its arguments and only cares about
# the body, matching the health assertion under test rather than the
# transport.
cat >"$ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
printf '%s' "${HEALTH_BODY:-}"
[ -n "${HEALTH_BODY:-}" ]
STUB

# The real loop's `sleep "$POLL_INTERVAL"` would make a mismatch/timeout case
# take real minutes. Stubbed to a no-op, the loop still spins until
# TIMEOUT_SECONDS of real wall-clock time has passed (a `date +%s` deadline,
# not a sleep count), so tests use a 1-2 second budget to stay fast.
cat >"$ROOT/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB

chmod +x "$ROOT/bin/"*
export PATH="$ROOT/bin:$PATH"

# Runs the script with the given env already exported by the caller, capturing
# its own exit code (not the script's stdout) as this function's stdout, so
# `rc="$(... run)"` gets a clean "0" or "1" regardless of what the script
# itself printed.
run() {
  : >"$ROOT/output"
  GITHUB_OUTPUT="$ROOT/output" bash "$SCRIPT" >"$ROOT/stdout" 2>"$ROOT/stderr"
  echo $?
}

echo "wait-for-staging-slot.sh: commit matching"

export HEALTH_BODY='{"ok":true,"supabase":{"target":"local"},"commit":"abc123"}'
rc="$(TARGET_URL=https://pr-9.staging.flowstarter.dev TIMEOUT_SECONDS=2 POLL_INTERVAL=0 EXPECT_TARGET=local EXPECTED_COMMIT=abc123 run)"
if [ "$rc" = "0" ]; then
  ok "succeeds once ok, target and the expected commit all match"
else
  no "succeeds once ok, target and the expected commit all match" "exit ${rc}, stderr: $(cat "$ROOT/stderr")"
fi
assert_contains "$(cat "$ROOT/output")" "url=https://pr-9.staging.flowstarter.dev" "writes the url output on a match"

echo "wait-for-staging-slot.sh: commit mismatch (the race this script exists to close)"
export HEALTH_BODY='{"ok":true,"supabase":{"target":"local"},"commit":"deadbeef"}'
rc="$(TARGET_URL=https://pr-9.staging.flowstarter.dev TIMEOUT_SECONDS=1 POLL_INTERVAL=0 EXPECT_TARGET=local EXPECTED_COMMIT=abc123 run)"
if [ "$rc" != "0" ]; then
  ok "fails (times out) when ok and target pass but the reported commit does not match"
else
  no "fails (times out) when ok and target pass but the reported commit does not match" "exit 0"
fi
if grep -q '^url=' "$ROOT/output" 2>/dev/null; then
  no "writes no url output on a commit mismatch"
else
  ok "writes no url output on a commit mismatch"
fi
assert_contains "$(cat "$ROOT/stderr")" "deadbeef" "the timeout message names the last commit the slot actually reported"
assert_contains "$(cat "$ROOT/stderr")" "abc123" "the timeout message names the commit that was expected"

echo "wait-for-staging-slot.sh: a slot that never reports a commit field at all"
export HEALTH_BODY='{"ok":true,"supabase":{"target":"local"}}'
rc="$(TARGET_URL=https://pr-9.staging.flowstarter.dev TIMEOUT_SECONDS=1 POLL_INTERVAL=0 EXPECT_TARGET=local EXPECTED_COMMIT=abc123 run)"
if [ "$rc" != "0" ]; then
  ok "fails when EXPECTED_COMMIT is set but the body has no commit field (an old build)"
else
  no "fails when EXPECTED_COMMIT is set but the body has no commit field (an old build)" "exit 0"
fi
assert_contains "$(cat "$ROOT/stderr")" "<none>" "the timeout message says no commit was reported at all"

echo "wait-for-staging-slot.sh: EXPECTED_COMMIT is optional (back-compat with other callers)"
export HEALTH_BODY='{"ok":true,"supabase":{"target":"local"}}'
rc="$(TARGET_URL=https://staging.flowstarter.dev TIMEOUT_SECONDS=2 POLL_INTERVAL=0 EXPECT_TARGET=local run)"
if [ "$rc" = "0" ]; then
  ok "still succeeds with no EXPECTED_COMMIT and no commit field in the body"
else
  no "still succeeds with no EXPECTED_COMMIT and no commit field in the body" "exit ${rc}"
fi

export HEALTH_BODY='{"ok":true,"supabase":{"target":"local"},"commit":"whatever"}'
rc="$(TARGET_URL=https://staging.flowstarter.dev TIMEOUT_SECONDS=2 POLL_INTERVAL=0 EXPECT_TARGET=local run)"
if [ "$rc" = "0" ]; then
  ok "still succeeds with no EXPECTED_COMMIT even when the body does report one"
else
  no "still succeeds with no EXPECTED_COMMIT even when the body does report one" "exit ${rc}"
fi

echo "wait-for-staging-slot.sh: ok and target are still enforced alongside a matching commit"
export HEALTH_BODY='{"ok":false,"supabase":{"target":"local"},"commit":"abc123"}'
rc="$(TARGET_URL=https://pr-9.staging.flowstarter.dev TIMEOUT_SECONDS=1 POLL_INTERVAL=0 EXPECT_TARGET=local EXPECTED_COMMIT=abc123 run)"
if [ "$rc" != "0" ]; then
  ok "still fails when ok is false, even though the commit matches"
else
  no "still fails when ok is false, even though the commit matches" "exit 0"
fi

export HEALTH_BODY='{"ok":true,"supabase":{"target":"remote"},"commit":"abc123"}'
rc="$(TARGET_URL=https://pr-9.staging.flowstarter.dev TIMEOUT_SECONDS=1 POLL_INTERVAL=0 EXPECT_TARGET=local EXPECTED_COMMIT=abc123 run)"
if [ "$rc" != "0" ]; then
  ok "still fails when target is not local, even though the commit matches"
else
  no "still fails when target is not local, even though the commit matches" "exit 0"
fi

echo "wait-for-staging-slot.sh: missing TARGET_URL"
unset HEALTH_BODY
rc="$(TIMEOUT_SECONDS=1 POLL_INTERVAL=0 EXPECTED_COMMIT=abc123 run)"
if [ "$rc" != "0" ]; then
  ok "fails fast when TARGET_URL is not set"
else
  no "fails fast when TARGET_URL is not set" "exit 0"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
