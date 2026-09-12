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
chmod +x "$ROOT/bin/"* "$ROOT/opt/supabase-stack.sh"

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

echo "deploy-slot.sh: slot pr-73"
out="$(run_deploy pr-73 ghcr.io/x/y:pr-73)"
log="$(cat "$STUB_LOG")"
assert_contains "$out" "Deployed https://pr-73.staging.flowstarter.dev" "pr-73 resolves its subdomain"
assert_contains "$out" "(slot=pr-73, port=3073)" "pr-73 derives port 3073"
assert_contains "$log" "supabase-stack ensure" "pr-73 runs the stack ensure step"
assert_not_contains "$log" "supabase-stack migrate" "pr-73 does not migrate"
assert_not_contains "$log" "supabase-stack write-env" "pr-73 does not rewrite the keys"

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
