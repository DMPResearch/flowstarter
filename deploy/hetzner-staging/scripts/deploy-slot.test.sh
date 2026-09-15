#!/usr/bin/env bash
# Unit-style tests for deploy-slot.sh and destroy-slot.sh slot handling.
#
#   bash deploy/hetzner-staging/scripts/deploy-slot.test.sh
#
# It runs the real scripts against a throwaway root, with `docker`, `curl`,
# `systemctl`, `caddy` and `supabase-stack.sh` replaced by stubs on PATH, so
# nothing here talks to a daemon, a registry, a database or a host. What it
# proves is the part a deploy gets wrong quietly: which slot maps to which
# port, hostname, env file, container and Caddy vhost, which slots run the
# Supabase stack steps, and which health marker each one waits for.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEPLOY="${HERE}/deploy-slot.sh"
DESTROY="${HERE}/destroy-slot.sh"

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

# ── A throwaway host ────────────────────────────────────────────────────────
# One temp dir stands in for /opt/flowstarter/staging, /etc/caddy/platform,
# /etc/flowstarter and /etc/flowstarter/tls.
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/opt" "$ROOT/caddy" "$ROOT/etc" "$ROOT/tls" "$ROOT/bin"
: >"$ROOT/opt/docker-compose.yml"

# Stubs. `curl` answers whatever HEALTH_BODY says, which is how each slot's
# health assertion is exercised without a container.
cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >> "$STUB_LOG"
# Logged on every invocation (pull and compose up both count), which is
# enough to prove deploy-slot.sh exported it before either ran.
echo "env FLOWSTARTER_BUILD_COMMIT=${FLOWSTARTER_BUILD_COMMIT-<unset>}" >> "$STUB_LOG"
# destroy-slot.sh's image cleanup: which image the (fake) container runs,
# and who else (fake) still runs it, both controllable per test case.
if [ "$1" = "container" ] && [ "$2" = "inspect" ]; then
  printf '%s\n' "${DOCKER_CONTAINER_IMAGE-}"
  exit 0
fi
if [ "$1" = "ps" ] && [ "$2" = "-a" ]; then
  printf '%s\n' "${DOCKER_ANCESTOR_USERS-}"
  exit 0
fi
exit 0
STUB
cat >"$ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >> "$STUB_LOG"
printf '%s' "${HEALTH_BODY:-}"
[ -n "${HEALTH_BODY:-}" ]
STUB
cat >"$ROOT/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
exit 0
STUB
cat >"$ROOT/bin/caddy" <<'STUB'
#!/usr/bin/env bash
echo "caddy $*" >> "$STUB_LOG"
exit 0
STUB
cat >"$ROOT/opt/supabase-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "supabase-stack $*" >> "$STUB_LOG"
exit 0
STUB
# `df -Pm <path>` stub for the disk-floor preflight: column 4 (Available) is
# DF_FREE_MB, defaulted high so a test only sets it to exercise the floor.
cat >"$ROOT/bin/df" <<'STUB'
#!/usr/bin/env bash
echo "df $*" >> "$STUB_LOG"
printf 'Filesystem 1M-blocks Used Available Capacity Mounted\n'
printf '/dev/stub 999999 0 %s 1%% /\n' "${DF_FREE_MB:-999999}"
STUB
# Retention pass stub: prune-images.sh itself is unit-tested on its own
# (prune-images.test.sh); this file only has to prove deploy-slot.sh calls
# it at the right two points and reacts correctly to its exit code.
cat >"$ROOT/opt/prune-images.sh" <<'STUB'
#!/usr/bin/env bash
echo "PRUNE_CALL" >> "$STUB_LOG"
exit "${PRUNE_EXIT_CODE:-0}"
STUB
chmod +x "$ROOT/bin/"* "$ROOT/opt/supabase-stack.sh" "$ROOT/opt/prune-images.sh"

export PATH="$ROOT/bin:$PATH"
export STUB_LOG="$ROOT/stub.log"

# `sleep 2` in the health loop would make a failing case take two minutes.
# The stubbed curl answers on the first poll in every passing case, and the
# one failing case below overrides the loop's patience instead.
run_deploy() {
  : >"$STUB_LOG"
  STAGING_ROOT="$ROOT/opt" \
    CADDY_PLATFORM_DIR="$ROOT/caddy" \
    PROD_TLS_DIR="$ROOT/tls" \
    SUPABASE_STACK_SCRIPT="$ROOT/opt/supabase-stack.sh" \
    FLOWSTARTER_ENV_FILE="$ENV_FILE" \
    bash "$DEPLOY" "$@" 2>&1
}

# ── Slot parsing ────────────────────────────────────────────────────────────
echo "deploy-slot.sh: slot parsing"
ENV_FILE="$ROOT/etc/staging.env"
: >"$ENV_FILE"

for bad in prod-1 production PROD "pr-0" "pr-01" pr- "main extra" "" "../etc"; do
  out="$(run_deploy "$bad" img 2>&1)"
  rc=$?
  if [ "$rc" -ne 0 ]; then
    ok "rejects slot '${bad}'"
  else
    no "rejects slot '${bad}'" "exited 0"
  fi
done

# ── Staging slots keep their old contract ───────────────────────────────────
echo "deploy-slot.sh: slot main"
export HEALTH_BODY='{"ok":true,"supabase":{"env":"staging","target":"local","host":"127.0.0.1"}}'
out="$(run_deploy main ghcr.io/x/y:sha)"
log="$(cat "$STUB_LOG")"
assert_contains "$out" "Deployed https://staging.flowstarter.dev" "main resolves staging.flowstarter.dev"
assert_contains "$out" "(slot=main, port=3000)" "main defaults to port 3000"
assert_contains "$log" "supabase-stack ensure" "main runs the stack ensure step"
assert_contains "$log" "supabase-stack check" "main runs the stack check step"
assert_contains "$log" "supabase-stack migrate" "main runs migrations"
assert_contains "$log" "supabase-stack write-env" "main refreshes the keys"
assert_contains "$(cat "$ENV_FILE")" "FLOWSTARTER_ENV=staging" "main writes FLOWSTARTER_ENV=staging"
assert_contains "$(cat "$ROOT/caddy/main.caddy")" "staging.flowstarter.dev {" "main writes its vhost"
assert_contains "$(cat "$ROOT/caddy/main.caddy")" "reverse_proxy 127.0.0.1:3000" "main proxies port 3000"
assert_contains "$log" "env FLOWSTARTER_BUILD_COMMIT=sha" "main exports the image tag as FLOWSTARTER_BUILD_COMMIT"

echo "deploy-slot.sh: slot pr-73"
out="$(run_deploy pr-73 ghcr.io/x/y:pr-73)"
log="$(cat "$STUB_LOG")"
assert_contains "$out" "Deployed https://pr-73.staging.flowstarter.dev" "pr-73 resolves its subdomain"
assert_contains "$out" "(slot=pr-73, port=3073)" "pr-73 derives port 3073"
assert_contains "$log" "supabase-stack ensure" "pr-73 runs the stack ensure step"
assert_not_contains "$log" "supabase-stack migrate" "pr-73 does not migrate"
assert_not_contains "$log" "supabase-stack write-env" "pr-73 does not rewrite the keys"
assert_contains "$log" "env FLOWSTARTER_BUILD_COMMIT=pr-73" "pr-73 exports its own image tag as FLOWSTARTER_BUILD_COMMIT"

# ── Disk retention: preflight and post-deploy (2026-09-15 incident) ────────
echo "deploy-slot.sh: image retention runs as a preflight and again after a successful deploy"
unset DF_FREE_MB PRUNE_EXIT_CODE FLOWSTARTER_DISK_FLOOR_MB 2>/dev/null || true
out="$(run_deploy main ghcr.io/x/y:sha)"
log="$(cat "$STUB_LOG")"
calls="$(grep -c '^PRUNE_CALL$' <<<"$log")"
if [ "$calls" -eq 2 ]; then
  ok "prune-images.sh runs exactly twice: preflight and post-deploy"
else
  no "prune-images.sh runs exactly twice: preflight and post-deploy" "ran ${calls} times: ${log}"
fi
assert_contains "$out" "Deployed https://staging.flowstarter.dev" "the deploy still succeeds"

echo "deploy-slot.sh: disk floor preflight refuses a deploy when free space is still short after retention"
export DF_FREE_MB=100
out="$(run_deploy main ghcr.io/x/y:sha)"
rc=$?
log="$(cat "$STUB_LOG")"
unset DF_FREE_MB
if [ "$rc" -ne 0 ]; then
  ok "refuses to deploy below the disk floor"
else
  no "refuses to deploy below the disk floor" "exited 0"
fi
assert_contains "$out" "refusing to deploy" "the refusal message says so"
assert_contains "$out" "100 MB free" "the refusal message names the free space it saw"
assert_contains "$out" "10240 MB floor" "the refusal message names the default floor"
assert_not_contains "$log" "docker pull" "no image is pulled once the preflight refuses"
assert_not_contains "$log" "systemctl reload" "no Caddy reload happens once the preflight refuses"
calls="$(grep -c '^PRUNE_CALL$' <<<"$log")"
if [ "$calls" -eq 1 ]; then
  ok "retention still ran once (the preflight attempt) before the refusal"
else
  no "retention still ran once (the preflight attempt) before the refusal" "ran ${calls} times"
fi

echo "deploy-slot.sh: the disk floor is a named, overridable knob"
export DF_FREE_MB=500 FLOWSTARTER_DISK_FLOOR_MB=100
out="$(run_deploy main ghcr.io/x/y:sha)"
rc=$?
unset DF_FREE_MB FLOWSTARTER_DISK_FLOOR_MB
if [ "$rc" -eq 0 ]; then
  ok "a lower FLOWSTARTER_DISK_FLOOR_MB lets an otherwise-refused deploy through"
else
  no "a lower FLOWSTARTER_DISK_FLOOR_MB lets an otherwise-refused deploy through" "$out"
fi

echo "deploy-slot.sh: a missing retention script warns but does not block the deploy"
out="$(PRUNE_IMAGES_SCRIPT="$ROOT/opt/does-not-exist.sh" run_deploy main ghcr.io/x/y:sha)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "a missing prune-images.sh does not fail the deploy"
else
  no "a missing prune-images.sh does not fail the deploy" "$out"
fi
assert_contains "$out" "retention script not found" "it says why it skipped retention"

echo "deploy-slot.sh: a failing post-deploy retention pass does not turn a successful deploy into a failure"
export PRUNE_EXIT_CODE=1
out="$(run_deploy main ghcr.io/x/y:sha)"
rc=$?
unset PRUNE_EXIT_CODE
if [ "$rc" -eq 0 ]; then
  ok "the deploy still exits 0"
else
  no "the deploy still exits 0" "$out"
fi
assert_contains "$out" "Deployed https://staging.flowstarter.dev" "the deploy still reports success"
assert_contains "$out" "exited non-zero" "the retention failure is still visible in the log"

# ── The prod slot ───────────────────────────────────────────────────────────
echo "deploy-slot.sh: slot prod"
ENV_FILE="$ROOT/etc/prod.env"
printf 'FLOWSTARTER_ENV=staging\nCLERK_SECRET_KEY=x\n' >"$ENV_FILE"
export HEALTH_BODY='{"ok":true,"supabase":{"env":"production","target":"remote","host":"ref.supabase.co"}}'
out="$(run_deploy prod ghcr.io/x/y:release-2026-09-14)"
log="$(cat "$STUB_LOG")"
snippet="$(cat "$ROOT/caddy/prod.caddy")"

assert_contains "$out" "Deployed https://flowstarter.net" "prod resolves flowstarter.net"
assert_contains "$out" "(slot=prod, port=3100)" "prod defaults to port 3100"
assert_contains "$out" 'expecting "env":"production"' "prod asserts the production env marker"
assert_not_contains "$log" "supabase-stack" "prod runs no Supabase stack step at all"
assert_contains "$log" "docker pull ghcr.io/x/y:release-2026-09-14" "prod pulls the tagged image"
assert_contains "$log" "env FLOWSTARTER_BUILD_COMMIT=release-2026-09-14" "prod exports its release tag as FLOWSTARTER_BUILD_COMMIT"

env_now="$(cat "$ENV_FILE")"
assert_contains "$env_now" "FLOWSTARTER_ENV=production" "prod rewrites FLOWSTARTER_ENV to production"
assert_not_contains "$env_now" "FLOWSTARTER_ENV=staging" "the stale staging value is gone"
assert_contains "$env_now" "CLERK_SECRET_KEY=x" "the rest of the env file survives the rewrite"

assert_contains "$snippet" "flowstarter.net {" "prod serves the apex"
assert_contains "$snippet" "www.flowstarter.net {" "prod serves www"
assert_contains "$snippet" "redir https://flowstarter.net{uri} permanent" "www redirects to the apex"
assert_contains "$snippet" "reverse_proxy 127.0.0.1:3100" "prod proxies port 3100"
assert_contains "$snippet" "tls internal" "prod falls back to tls internal with no Origin CA cert"
assert_contains "$snippet" "Cloudflare SSL/TLS MUST be set to Full" "the fallback says which Cloudflare mode it needs"

echo "deploy-slot.sh: an env file with no trailing newline"
ENV_FILE="$ROOT/etc/prod-no-newline.env"
printf 'CLERK_SECRET_KEY=x' >"$ENV_FILE"
out="$(run_deploy prod ghcr.io/x/y:release-2026-09-14)"
env_now="$(cat "$ENV_FILE")"
assert_contains "$env_now" "CLERK_SECRET_KEY=x" "the last line survives"
assert_not_contains "$env_now" "CLERK_SECRET_KEY=xFLOWSTARTER_ENV" "the new line is not glued onto it"
assert_contains "$env_now" "FLOWSTARTER_ENV=production" "the environment is still set"
ENV_FILE="$ROOT/etc/prod.env"

echo "deploy-slot.sh: slot prod with a Cloudflare Origin CA certificate"
: >"$ROOT/tls/flowstarter.net.crt"
: >"$ROOT/tls/flowstarter.net.key"
out="$(run_deploy prod ghcr.io/x/y:release-2026-09-14)"
snippet="$(cat "$ROOT/caddy/prod.caddy")"
assert_contains "$snippet" "tls ${ROOT}/tls/flowstarter.net.crt ${ROOT}/tls/flowstarter.net.key" "prod uses the Origin CA certificate when present"
assert_not_contains "$snippet" "tls internal" "prod stops using the local CA once the cert is there"
assert_contains "$snippet" "Full (strict)" "the Origin CA snippet says Full (strict)"
rm -f "$ROOT/tls/flowstarter.net.crt" "$ROOT/tls/flowstarter.net.key"

# ── A slot that never reports the right environment is never published ──────
echo "deploy-slot.sh: health gate"
rm -f "$ROOT/caddy/prod.caddy"
export HEALTH_BODY='{"ok":true,"supabase":{"env":"staging","target":"local","host":"127.0.0.1"}}'
# The retry loop is 60 x 2s. Shrink the wait by pointing `sleep` at a no-op.
cat >"$ROOT/bin/sleep" <<'STUB'
#!/usr/bin/env bash
exit 0
STUB
chmod +x "$ROOT/bin/sleep"
out="$(run_deploy prod ghcr.io/x/y:staging-image)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "prod refuses a staging image (health says env=staging)"
else
  no "prod refuses a staging image (health says env=staging)" "exited 0"
fi
if [ ! -f "$ROOT/caddy/prod.caddy" ]; then
  ok "no Caddy snippet is written when the health gate fails"
else
  no "no Caddy snippet is written when the health gate fails" "prod.caddy exists"
fi
rm -f "$ROOT/bin/sleep"

# ── Locking: the shared Supabase stack and Caddy sections serialise ────────
# Two lanes deploying at once on the real host raced supabase-stack.sh and
# the Caddy write-then-reload, failing one at random (pr-127, 2026-09-14).
# These cases run the real deploy-slot.sh twice at once against stubs that
# sleep while "inside" the locked sections, so an actual overlap -- not just
# a passing exit code -- is what would fail the test.
echo "deploy-slot.sh: locking"
export HEALTH_BODY='{"ok":true,"supabase":{"env":"staging","target":"local","host":"127.0.0.1"}}'
ENV_FILE="$ROOT/etc/staging.env"
: >"$ENV_FILE"

CONC_ROOT="$ROOT/conc"
mkdir -p "$CONC_ROOT"
ORDER_LOG="$CONC_ROOT/order.log"
BUSY_FLAG="$CONC_ROOT/busy"
export ORDER_LOG BUSY_FLAG
: >"$ORDER_LOG"
rm -f "$BUSY_FLAG"

# Both stubs share $BUSY_FLAG/$ORDER_LOG, so this catches an overlap between
# ANY two lock holders, not just two calls to the same stub: one process's
# Supabase-stack section racing another's Caddy section would be exactly the
# kind of interleave the real incident hit.
cat >"$ROOT/opt/supabase-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "supabase-stack $*" >> "$STUB_LOG"
if [ "$1" = "ensure" ]; then
  if [ -e "$BUSY_FLAG" ]; then
    echo "OVERLAP supabase-stack($$) found $(cat "$BUSY_FLAG")" >> "$ORDER_LOG"
  fi
  echo "supabase-stack($$)" > "$BUSY_FLAG"
  echo "ENTER supabase-stack($$)" >> "$ORDER_LOG"
  sleep 0.4
  echo "EXIT supabase-stack($$)" >> "$ORDER_LOG"
  rm -f "$BUSY_FLAG"
fi
exit 0
STUB
cat >"$ROOT/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
if [ -e "$BUSY_FLAG" ]; then
  echo "OVERLAP systemctl($$) found $(cat "$BUSY_FLAG")" >> "$ORDER_LOG"
fi
echo "systemctl($$)" > "$BUSY_FLAG"
echo "ENTER systemctl($$)" >> "$ORDER_LOG"
sleep 0.4
echo "EXIT systemctl($$)" >> "$ORDER_LOG"
rm -f "$BUSY_FLAG"
exit 0
STUB
chmod +x "$ROOT/opt/supabase-stack.sh" "$ROOT/bin/systemctl"

# Sets $LAST_BG_PID rather than returning the pid through a `$(...)` command
# substitution: that runs in its own subshell, so the backgrounded job would
# be that subshell's child, not this script's -- and `wait` only works on a
# direct child.
deploy_bg() {
  local slot="$1" tag="$2" outfile="$3" logfile="$4"
  (
    STAGING_ROOT="$ROOT/opt" \
      CADDY_PLATFORM_DIR="$ROOT/caddy" \
      PROD_TLS_DIR="$ROOT/tls" \
      SUPABASE_STACK_SCRIPT="$ROOT/opt/supabase-stack.sh" \
      FLOWSTARTER_ENV_FILE="$ENV_FILE" \
      STUB_LOG="$logfile" \
      bash "$DEPLOY" "$slot" "ghcr.io/x/y:$tag" >"$outfile" 2>&1
  ) &
  LAST_BG_PID=$!
}

: >"$CONC_ROOT/out-main"
: >"$CONC_ROOT/out-pr9"
deploy_bg main sha-main "$CONC_ROOT/out-main" "$CONC_ROOT/log-main"
pid_main="$LAST_BG_PID"
deploy_bg pr-9 sha-pr9 "$CONC_ROOT/out-pr9" "$CONC_ROOT/log-pr9"
pid_pr9="$LAST_BG_PID"
rc_main=0
rc_pr9=0
wait "$pid_main" || rc_main=$?
wait "$pid_pr9" || rc_pr9=$?

if [ "$rc_main" -eq 0 ] && [ "$rc_pr9" -eq 0 ]; then
  ok "two concurrent deploys both still succeed"
else
  no "two concurrent deploys both still succeed" "main rc=${rc_main} pr-9 rc=${rc_pr9}"
fi
if ! grep -q OVERLAP "$ORDER_LOG"; then
  ok "two concurrent deploys serialise the shared Supabase-stack/Caddy sections"
else
  no "two concurrent deploys serialise the shared Supabase-stack/Caddy sections" "$(cat "$ORDER_LOG")"
fi

echo "deploy-slot.sh: the lock is released when a locked step fails"
: >"$ENV_FILE"
cat >"$ROOT/opt/supabase-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "supabase-stack $*" >> "$STUB_LOG"
[ "$1" = "check" ] && exit 1
exit 0
STUB
chmod +x "$ROOT/opt/supabase-stack.sh"
out="$(run_deploy main ghcr.io/x/y:will-fail)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "a failing locked step exits non-zero"
else
  no "a failing locked step exits non-zero" "exited 0"
fi

# A working stub, and a short timeout: if the failed run above left the flock
# held, this would time out after 2s instead of succeeding immediately.
cat >"$ROOT/opt/supabase-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "supabase-stack $*" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$ROOT/opt/supabase-stack.sh"
export STAGING_LOCK_TIMEOUT=2
out2="$(run_deploy main ghcr.io/x/y:after-failure)"
rc2=$?
unset STAGING_LOCK_TIMEOUT
if [ "$rc2" -eq 0 ]; then
  ok "the lock from the failed run is released, so the next deploy does not wait out the timeout"
else
  no "the lock from the failed run is released, so the next deploy does not wait out the timeout" "$out2"
fi

echo "deploy-slot.sh: the lock wait times out with a clear message"
: >"$ENV_FILE"
LOCK_FILE="$ROOT/opt/deploy.lock"
: >"$LOCK_FILE"
printf 'slot=pr-999 pid=99999 step=stuck-test since=2026-01-01T00:00:00Z\n' >"${LOCK_FILE}.holder"
(
  exec 9>"$LOCK_FILE"
  flock 9
  sleep 3
) >/dev/null 2>&1 &
holder_pid=$!
sleep 0.3
export STAGING_LOCK_TIMEOUT=1
out="$(run_deploy main ghcr.io/x/y:blocked)"
rc=$?
unset STAGING_LOCK_TIMEOUT
wait "$holder_pid" 2>/dev/null || true
if [ "$rc" -ne 0 ]; then
  ok "deploy-slot.sh fails rather than wait forever once the lock's timeout elapses"
else
  no "deploy-slot.sh fails rather than wait forever once the lock's timeout elapses" "exited 0"
fi
assert_contains "$out" "$LOCK_FILE" "the timeout message names the lock file path"
assert_contains "$out" "pr-999" "the timeout message names the stuck holder"
rm -f "${LOCK_FILE}.holder" "$LOCK_FILE"

# Restore the plain stubs the rest of the suite (and destroy-slot.sh below,
# which also reloads Caddy through systemctl) expects.
cat >"$ROOT/bin/systemctl" <<'STUB'
#!/usr/bin/env bash
echo "systemctl $*" >> "$STUB_LOG"
exit 0
STUB
cat >"$ROOT/opt/supabase-stack.sh" <<'STUB'
#!/usr/bin/env bash
echo "supabase-stack $*" >> "$STUB_LOG"
exit 0
STUB
chmod +x "$ROOT/bin/systemctl" "$ROOT/opt/supabase-stack.sh"

# ── destroy-slot.sh ─────────────────────────────────────────────────────────
echo "destroy-slot.sh"
run_destroy() {
  : >"$STUB_LOG"
  STAGING_ROOT="$ROOT/opt" CADDY_PLATFORM_DIR="$ROOT/caddy" \
    bash "$DESTROY" "$@" 2>&1
}

: >"$ROOT/caddy/pr-73.caddy"
out="$(run_destroy pr-73)"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "-p fs-staging-pr-73" "pr-73 tears down its own compose project"
assert_contains "$log" "flowstarter-staging-pr-73" "pr-73 removes its own container"
if [ ! -f "$ROOT/caddy/pr-73.caddy" ]; then
  ok "pr-73 removes its Caddy snippet"
else
  no "pr-73 removes its Caddy snippet"
fi

# ── destroy-slot.sh: image cleanup ──────────────────────────────────────────
# So a destroyed pr-N slot's image does not just sit on disk until
# prune-images.sh's keep-count eventually catches up with it.
echo "destroy-slot.sh: image cleanup"
export DOCKER_CONTAINER_IMAGE="sha256:pr73image"
export DOCKER_ANCESTOR_USERS=""
out="$(run_destroy pr-73)"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "rmi sha256:pr73image" "removes the slot's image once no container is found using it"
assert_contains "$out" "Removed image sha256:pr73image" "and says so"

export DOCKER_ANCESTOR_USERS="some-other-container-id"
out="$(run_destroy pr-73)"
log="$(cat "$STUB_LOG")"
assert_not_contains "$log" "rmi sha256:pr73image" "leaves the image alone when another container still runs it"
assert_contains "$out" "Leaving image sha256:pr73image" "and says why"
assert_contains "$out" "some-other-container-id" "naming who still uses it"
unset DOCKER_ANCESTOR_USERS

export DOCKER_CONTAINER_IMAGE=""
out="$(run_destroy pr-73)"
rc=$?
log="$(cat "$STUB_LOG")"
if [ "$rc" -eq 0 ]; then
  ok "destroying a slot with no resolvable image (already gone) does not fail"
else
  no "destroying a slot with no resolvable image (already gone) does not fail" "$out"
fi
assert_not_contains "$log" " rmi " "no rmi is attempted when no image could be resolved"
unset DOCKER_CONTAINER_IMAGE

out="$(run_destroy prod)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "prod is refused without DESTROY_PROD=1"
else
  no "prod is refused without DESTROY_PROD=1" "exited 0"
fi
assert_contains "$out" "DESTROY_PROD=1" "the refusal says how to mean it"

: >"$ROOT/caddy/prod.caddy"
: >"$STUB_LOG"
out="$(DESTROY_PROD=1 STAGING_ROOT="$ROOT/opt" CADDY_PLATFORM_DIR="$ROOT/caddy" bash "$DESTROY" prod 2>&1)"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "-p fs-prod" "prod tears down the fs-prod project"
assert_contains "$log" "flowstarter-prod" "prod removes the flowstarter-prod container"

out="$(run_destroy bogus)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "destroy rejects an unknown slot"
else
  no "destroy rejects an unknown slot" "exited 0"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
