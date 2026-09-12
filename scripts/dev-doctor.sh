#!/usr/bin/env bash
# On-demand health summary for the local dev stack: local Supabase, the app's
# env files, and the Node/pnpm/Docker toolchain pins. Read-only -- it never
# starts, stops, or restarts anything, and it never prints a real secret
# value, only key names and short status words.
#
# Usage:
#   bash scripts/dev-doctor.sh
#
# Also used as the last step of `scripts/dev-bootstrap.sh`. This script
# always exits 0 (it is a report); look at the [fail]/[warn] lines and the
# summary count at the bottom.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_DIR="$ROOT/apps/flowstarter-main"

PIN_NODE_MAJOR=22
PIN_PNPM_VERSION="$(grep -m1 '"packageManager"' "$ROOT/package.json" | sed -E 's/.*"pnpm@([^"]+)".*/\1/')"
SUPABASE_CLI_PIN="2.95.4"

OK_COUNT=0
WARN_COUNT=0
FAIL_COUNT=0

log_ok() {
  printf '  [ok]   %s\n' "$1"
  OK_COUNT=$((OK_COUNT + 1))
}

log_warn() {
  printf '  [warn] %s\n' "$1"
  WARN_COUNT=$((WARN_COUNT + 1))
}

log_fail() {
  printf '  [fail] %s\n' "$1"
  FAIL_COUNT=$((FAIL_COUNT + 1))
}

section() {
  printf '\n%s\n' "$1"
}

# Reads a KEY=value out of the app's env files, later files winning, the
# same precedence `e2e/support/local-env.mjs` uses. Never echoes the value.
get_env_value() {
  local key="$1" value="" file line
  for file in "$MAIN_DIR/.env" "$MAIN_DIR/.env.local" "$MAIN_DIR/.env.development.local"; do
    [[ -f "$file" ]] || continue
    line="$(grep -E "^${key}=" "$file" 2>/dev/null | tail -n1 || true)"
    if [[ -n "$line" ]]; then
      value="${line#*=}"
      value="${value%\"}"
      value="${value#\"}"
      value="${value%\'}"
      value="${value#\'}"
    fi
  done
  printf '%s' "$value"
}

is_placeholder() {
  local value="$1"
  [[ -z "$value" ]] && return 0
  case "$value" in
    your-*|replace-with-*) return 0 ;;
  esac
  return 1
}

# Prints just the names of keys in $2.. that still need a real value, under
# label $1. Prints nothing when the whole group already looks real.
report_key_group() {
  local label="$1"
  shift
  local key value needed=()
  for key in "$@"; do
    value="$(get_env_value "$key")"
    if is_placeholder "$value"; then
      needed+=("$key")
    fi
  done
  if [[ ${#needed[@]} -gt 0 ]]; then
    local joined="" k
    for k in "${needed[@]}"; do
      if [[ -z "$joined" ]]; then
        joined="$k"
      else
        joined="$joined, $k"
      fi
    done
    printf '    %-22s %s\n' "$label" "$joined"
  fi
}

port_status() {
  local port="$1" line
  if ! command -v lsof >/dev/null 2>&1; then
    printf 'unknown (no lsof)'
    return 0
  fi
  line="$(lsof -nP -iTCP:"$port" -sTCP:LISTEN 2>/dev/null | tail -n +2 | head -n1 || true)"
  if [[ -n "$line" ]]; then
    printf 'in use (%s, pid %s)' "$(echo "$line" | awk '{print $1}')" "$(echo "$line" | awk '{print $2}')"
  else
    printf 'free'
  fi
}

echo "Flowstarter dev doctor"
echo "======================"

section "Toolchain"
if command -v node >/dev/null 2>&1; then
  node_version="$(node --version)"
  node_major="$(echo "$node_version" | sed -E 's/^v([0-9]+).*/\1/')"
  if [[ "$node_major" == "$PIN_NODE_MAJOR" ]]; then
    log_ok "node $node_version (pin: $PIN_NODE_MAJOR.x)"
  else
    log_warn "node $node_version active, pin is $PIN_NODE_MAJOR.x -- 'nvm use $PIN_NODE_MAJOR' or 'fnm use $PIN_NODE_MAJOR' before 'pnpm dev'"
  fi
else
  log_fail "node not found on PATH"
fi

if command -v pnpm >/dev/null 2>&1; then
  pnpm_version="$(pnpm --version)"
  if [[ "$pnpm_version" == "$PIN_PNPM_VERSION" ]]; then
    log_ok "pnpm $pnpm_version (pin: $PIN_PNPM_VERSION)"
  else
    log_warn "pnpm $pnpm_version active, pin is $PIN_PNPM_VERSION -- corepack prepare pnpm@$PIN_PNPM_VERSION --activate"
  fi
else
  log_fail "pnpm not found on PATH"
fi

if command -v docker >/dev/null 2>&1; then
  if docker info >/dev/null 2>&1; then
    log_ok "Docker daemon running"
  else
    log_warn "Docker CLI found but the daemon is not responding -- open Docker Desktop or OrbStack"
  fi
else
  log_fail "Docker not found (Docker Desktop or OrbStack)"
fi

if command -v supabase >/dev/null 2>&1; then
  supabase_version="$(supabase --version 2>/dev/null | tr -d '[:space:]')"
  if [[ "$supabase_version" == "$SUPABASE_CLI_PIN" ]]; then
    log_ok "supabase CLI $supabase_version (pin: $SUPABASE_CLI_PIN)"
  else
    log_warn "supabase CLI $supabase_version active, CI pins $SUPABASE_CLI_PIN"
  fi
else
  log_fail "supabase CLI not found"
fi

section "Ports"
printf '  3000  (Main, next dev):        %s\n' "$(port_status 3000)"
printf '  54321 (Supabase API/Kong):     %s\n' "$(port_status 54321)"
printf '  54322 (Supabase Postgres):     %s\n' "$(port_status 54322)"

section "Local Supabase stack"
rest_code="$(curl -s -o /dev/null -m 3 -w '%{http_code}' http://127.0.0.1:54321/rest/v1/ 2>/dev/null || echo "000")"
if [[ "$rest_code" == "200" ]]; then
  log_ok "REST endpoint http://127.0.0.1:54321/rest/v1/ -> 200"

  if command -v supabase >/dev/null 2>&1; then
    applied_count="$(cd "$ROOT" && supabase migration list --local 2>/dev/null | grep -cE '^ *[0-9]{14} \|' || true)"
    total_files="$(find "$ROOT/supabase/migrations" -maxdepth 1 -name '*.sql' 2>/dev/null | wc -l | tr -d ' ')"
    log_ok "Migrations: $applied_count applied against the stack (this checkout has $total_files migration files)"
  else
    log_warn "Can't check migrations without the supabase CLI"
  fi
else
  log_warn "REST endpoint not reachable (http code: $rest_code) -- run 'pnpm db:start'"
fi

section "apps/flowstarter-main env files"
for f in .env .env.local .env.development.local; do
  if [[ -f "$MAIN_DIR/$f" ]]; then
    log_ok "$f present"
  else
    if [[ "$f" == ".env.development.local" ]]; then
      log_warn "$f missing -- run 'pnpm db:env' once the local Supabase stack is up"
    else
      log_fail "$f missing -- run scripts/dev-bootstrap.sh, or: cp apps/flowstarter-main/.env.example apps/flowstarter-main/$f"
    fi
  fi
done

section "Keys that still need a real value"
before_missing_output="$(
  report_key_group "Clerk (test)" NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY
  report_key_group "OpenRouter" OPENROUTER_API_KEY
  report_key_group "Stripe (test)" NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
  report_key_group "Resend" RESEND_API_KEY
)"
if [[ -n "$before_missing_output" ]]; then
  echo "$before_missing_output"
else
  echo "  none -- Clerk, OpenRouter, Stripe and Resend all look set"
fi

section "Supabase dev env (written by 'pnpm db:env')"
report_supabase_dev_output="$(report_key_group "Supabase" NEXT_PUBLIC_SUPABASE_URL NEXT_PUBLIC_SUPABASE_ANON_KEY SUPABASE_SERVICE_ROLE_KEY)"
if [[ -n "$report_supabase_dev_output" ]]; then
  echo "$report_supabase_dev_output"
else
  echo "  none -- Supabase URL and keys are set"
fi

section "Summary"
echo "  ok: $OK_COUNT   warn: $WARN_COUNT   fail: $FAIL_COUNT"
exit 0
