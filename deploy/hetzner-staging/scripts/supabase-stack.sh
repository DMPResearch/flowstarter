#!/usr/bin/env bash
# Manage the Supabase CLI local stack on the Hetzner staging host.
#
# Every staging slot (main and pr-N) talks to the SAME stack, started once on
# the host and bound to 127.0.0.1 only. This is the same `supabase start`
# developers and the quality gate use, not a hosted Supabase project, see
# deploy/hetzner-staging/README.md, "Database".
#
# Usage:
#   supabase-stack.sh ensure      # install the CLI if needed, start the stack if not running
#   supabase-stack.sh migrate     # apply pending migrations, print migration list
#   supabase-stack.sh write-env   # upsert Supabase keys into /etc/flowstarter/staging.env
#   supabase-stack.sh check       # verify loopback-only binding and REST reachability
#   supabase-stack.sh status      # `supabase status`
#
# Run as root. Requires: curl, node, ss, a Debian/Ubuntu host (apt/dpkg).
#
# Env overrides:
#   REPO_DIR          default /opt/flowstarter/staging/repo (must contain supabase/config.toml)
#   FLOWSTARTER_ENV_FILE default /etc/flowstarter/staging.env
#   ANON              anon key `check` uses instead of resolving one itself
#
# The stack signs tokens with the published Supabase CLI demo JWT secret
# (`super-secret-jwt-token-with-at-least-32-characters-long`), the same
# string every `supabase start` on every machine uses. That is fine for a
# throwaway local stack; it is only safe here because the stack must never be
# reachable from the internet. See README.md for the Docker daemon.json and
# Hetzner Cloud Firewall requirements this script's `check` subcommand
# verifies.

set -euo pipefail

SUPABASE_CLI_VERSION="2.95.4"
REPO_DIR="${REPO_DIR:-/opt/flowstarter/staging/repo}"
ENV_FILE="${FLOWSTARTER_ENV_FILE:-/etc/flowstarter/staging.env}"
API_URL="http://127.0.0.1:54321"
DB_PORT="54322"
API_PORT="54321"
DEMO_JWT_SECRET="super-secret-jwt-token-with-at-least-32-characters-long"
# Kept: gotrue, kong, postgrest, storage-api, postgres-meta, enough for
# `supabase status -o env` to still be able to report keys, and for the app's
# health check to reach auth, REST, and storage. Excluded: everything the
# staging app never calls.
EXCLUDE_SERVICES="studio,edge-runtime,logflare,vector,supavisor,imgproxy,mailpit,realtime"

STATUS_ENV_CACHE=""
STATUS_ENV_FETCHED=0

usage() {
  cat >&2 <<'EOF'
Usage: supabase-stack.sh <ensure|migrate|write-env|check|status>

  ensure     Install the Supabase CLI (2.95.4) if missing, start the local
             stack if it is not already running.
  migrate    Apply pending migrations, then print `supabase migration list`.
  write-env  Upsert Supabase keys into /etc/flowstarter/staging.env.
  check      Fail unless 54321/54322 are bound to 127.0.0.1 only and the
             REST endpoint answers.
  status     Print `supabase status`.
EOF
}

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" -ne 0 ]]; then
    echo "supabase-stack.sh must be run as root (current uid: ${uid})." >&2
    exit 1
  fi
}

require_repo_dir() {
  if [[ ! -f "${REPO_DIR}/supabase/config.toml" ]]; then
    echo "REPO_DIR (${REPO_DIR}) has no supabase/config.toml." >&2
    echo "CI syncs the repository's supabase/ directory there before deploying; sync it manually and retry." >&2
    exit 1
  fi
}

# ── Supabase CLI install ────────────────────────────────────────────────────

installed_cli_version() {
  if ! command -v supabase >/dev/null 2>&1; then
    return 1
  fi
  supabase --version 2>/dev/null || true
}

install_cli_if_needed() {
  local current
  current="$(installed_cli_version || true)"
  if [[ "$current" == "$SUPABASE_CLI_VERSION" ]]; then
    echo "Supabase CLI ${SUPABASE_CLI_VERSION} already installed."
    return 0
  fi
  if [[ -n "$current" ]]; then
    echo "Supabase CLI present at version '${current}', expected ${SUPABASE_CLI_VERSION}; reinstalling."
  fi

  local arch deb_arch
  arch="$(uname -m)"
  case "$arch" in
    x86_64 | amd64) deb_arch="amd64" ;;
    aarch64 | arm64) deb_arch="arm64" ;;
    *)
      echo "Unsupported architecture for the Supabase CLI .deb: ${arch}" >&2
      exit 1
      ;;
  esac

  local tmp deb_url deb_path
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064
  trap "rm -rf '${tmp}'" EXIT
  deb_url="https://github.com/supabase/cli/releases/download/v${SUPABASE_CLI_VERSION}/supabase_${SUPABASE_CLI_VERSION}_linux_${deb_arch}.deb"
  deb_path="${tmp}/supabase.deb"
  echo "Installing Supabase CLI ${SUPABASE_CLI_VERSION} (${deb_arch}) from ${deb_url}"
  curl -fsSL -o "$deb_path" "$deb_url"

  if command -v apt-get >/dev/null 2>&1; then
    apt-get install -y "$deb_path"
  else
    dpkg -i "$deb_path"
  fi
  rm -rf "$tmp"
  trap - EXIT

  command -v supabase >/dev/null 2>&1 || {
    echo "Supabase CLI install failed: 'supabase' not on PATH after install." >&2
    exit 1
  }
  echo "Installed: $(supabase --version)"
}

# ── supabase status -o env, cached and parsed ───────────────────────────────

status_env() {
  if [[ "$STATUS_ENV_FETCHED" -eq 0 ]]; then
    STATUS_ENV_CACHE="$(supabase status -o env --workdir "$REPO_DIR" 2>/dev/null || true)"
    STATUS_ENV_FETCHED=1
  fi
  printf '%s\n' "$STATUS_ENV_CACHE"
}

status_field() {
  local key="$1"
  status_env | sed -n "s/^${key}=\"\\(.*\\)\"\$/\\1/p" | head -n1
}

resolve_jwt_secret() {
  local secret
  secret="$(status_field JWT_SECRET)"
  printf '%s' "${secret:-$DEMO_JWT_SECRET}"
}

# HS256 JWT, no dependencies. Same approach as
# apps/flowstarter-main/scripts/verify-rls-local.mjs's mintRoleKey(), a
# 10-year expiry so this key does not need re-minting on every deploy.
mint_key() {
  local role="$1" secret="$2"
  # shellcheck disable=SC2016 # single-quoted on purpose: the ${...} / `...`
  # below are JS to be expanded by node, not by this shell. role/secret are
  # passed as argv, not interpolated into the script text.
  node -e '
    const { createHmac } = require("node:crypto");
    const [role, secret] = process.argv.slice(1);
    const b64url = (input) =>
      Buffer.from(input)
        .toString("base64")
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "");
    const header = b64url(JSON.stringify({ alg: "HS256", typ: "JWT" }));
    const now = Math.floor(Date.now() / 1000);
    const payload = b64url(
      JSON.stringify({ iss: "supabase-demo", role, iat: now, exp: now + 315360000 }),
    );
    const signature = createHmac("sha256", secret)
      .update(`${header}.${payload}`)
      .digest("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
    process.stdout.write(`${header}.${payload}.${signature}`);
  ' "$role" "$secret"
}

resolve_anon_key() {
  # `check` can be handed a key explicitly (ANON=... supabase-stack.sh check);
  # otherwise every caller falls back to `supabase status`, then mints one.
  if [[ -n "${ANON:-}" ]]; then
    printf '%s' "$ANON"
    return
  fi
  local from_status
  from_status="$(status_field ANON_KEY)"
  if [[ -n "$from_status" ]]; then
    printf '%s' "$from_status"
    return
  fi
  mint_key anon "$(resolve_jwt_secret)"
}

resolve_service_role_key() {
  local from_status
  from_status="$(status_field SERVICE_ROLE_KEY)"
  if [[ -n "$from_status" ]]; then
    printf '%s' "$from_status"
    return
  fi
  mint_key service_role "$(resolve_jwt_secret)"
}

key_preview() {
  printf '%s' "${1:0:8}..."
}

# ── Subcommands ──────────────────────────────────────────────────────────

cmd_ensure() {
  require_repo_dir
  install_cli_if_needed

  if supabase status --workdir "$REPO_DIR" >/dev/null 2>&1; then
    echo "Supabase stack already running for ${REPO_DIR}; nothing to do."
    return 0
  fi

  echo "Starting Supabase CLI stack for ${REPO_DIR} (excluding: ${EXCLUDE_SERVICES})..."
  supabase start --workdir "$REPO_DIR" --exclude "$EXCLUDE_SERVICES"
  echo "Supabase stack started."
}

cmd_migrate() {
  require_repo_dir
  echo "Applying migrations against the local stack..."
  # --include-all, because a migration's timestamp is when it was WRITTEN and
  # the order they reach `main` is when they were MERGED, and the two disagree
  # the moment two pull requests are open at once. Without it, a migration
  # stamped earlier than one already applied makes `supabase migration up`
  # refuse outright ("Found local migration files to be inserted before the
  # last migration on remote database"), which reds this lane for every commit
  # afterwards until somebody logs into the box by hand.
  #
  # This is staging: one shared, disposable stack that CI owns. If an
  # out-of-order apply ever leaves it visibly different from a clean one, the
  # remedy is `supabase db reset --workdir /opt/flowstarter/staging/repo` on
  # the host, not a red deploy lane. Production is not migrated from here at
  # all (slot `prod` runs none of this), so nothing about this relaxes the
  # care taken with the hosted project.
  supabase migration up --include-all --workdir "$REPO_DIR"
  echo "Migration status:"
  # --local, because the bare `migration list` compares the local stack
  # against a LINKED remote project and exits 1 with "Cannot find project ref.
  # Have you run supabase link?" when there is none. The Hetzner host is
  # deliberately never linked to a hosted project, so without this flag the
  # last command of this function always fails, `set -e` propagates it, and
  # deploy-slot.sh aborts every deploy of slot `main` after the migrations
  # have already been applied successfully.
  supabase migration list --local --workdir "$REPO_DIR"
}

cmd_write_env() {
  require_repo_dir
  local anon_key service_role_key tmp_filtered tmp_new
  anon_key="$(resolve_anon_key)"
  service_role_key="$(resolve_service_role_key)"

  mkdir -p "$(dirname "$ENV_FILE")"
  tmp_filtered="$(mktemp)"
  tmp_new="$(mktemp)"
  # shellcheck disable=SC2064
  trap "rm -f '${tmp_filtered}' '${tmp_new}'" EXIT

  if [[ -f "$ENV_FILE" ]]; then
    grep -Ev '^(FLOWSTARTER_ENV|NEXT_PUBLIC_SUPABASE_URL|NEXT_PUBLIC_SUPABASE_ANON_KEY|SUPABASE_SERVICE_ROLE_KEY|SUPABASE_PROJECT_REF)=' \
      "$ENV_FILE" >"$tmp_filtered" || true
  fi

  {
    cat "$tmp_filtered"
    echo "FLOWSTARTER_ENV=staging"
    echo "NEXT_PUBLIC_SUPABASE_URL=${API_URL}"
    echo "NEXT_PUBLIC_SUPABASE_ANON_KEY=${anon_key}"
    echo "SUPABASE_SERVICE_ROLE_KEY=${service_role_key}"
  } >"$tmp_new"

  install -m 600 "$tmp_new" "$ENV_FILE"
  rm -f "$tmp_filtered" "$tmp_new"
  trap - EXIT

  echo "Wrote ${ENV_FILE}:"
  echo "  NEXT_PUBLIC_SUPABASE_URL=${API_URL}"
  echo "  NEXT_PUBLIC_SUPABASE_ANON_KEY=$(key_preview "$anon_key")"
  echo "  SUPABASE_SERVICE_ROLE_KEY=$(key_preview "$service_role_key")"
  echo "  (SUPABASE_PROJECT_REF removed if present)"
}

check_port_loopback_only() {
  local port="$1" found=0 ok=1 addr host
  while IFS= read -r addr; do
    [[ -z "$addr" ]] && continue
    found=1
    host="${addr%:*}"
    host="${host#[}"
    host="${host%]}"
    if [[ "$host" != "127.0.0.1" && "$host" != "::1" ]]; then
      echo "  FAIL: port ${port} bound on non-loopback address ${addr}" >&2
      ok=0
    fi
  done < <(ss -ltn 2>/dev/null | awk -v p="$port" '{n=split($4,a,":"); if (a[n]==p) print $4}')

  if [[ "$found" -eq 0 ]]; then
    echo "  FAIL: port ${port} is not listening" >&2
    return 1
  fi
  if [[ "$ok" -eq 0 ]]; then
    return 1
  fi
  echo "  OK: port ${port} bound to loopback only"
  return 0
}

cmd_check() {
  local failed=0
  echo "Checking that ports ${API_PORT} and ${DB_PORT} are bound to 127.0.0.1 only (ss -ltn)..."
  check_port_loopback_only "$API_PORT" || failed=1
  check_port_loopback_only "$DB_PORT" || failed=1

  echo "Checking REST reachability at ${API_URL}/rest/v1/ ..."
  local anon
  anon="$(resolve_anon_key)"
  if [[ -z "$anon" ]]; then
    echo "  FAIL: no anon key available to test with" >&2
    failed=1
  elif curl -fsS -H "apikey: ${anon}" "${API_URL}/rest/v1/" >/dev/null 2>&1; then
    echo "  OK: ${API_URL}/rest/v1/ answered with apikey"
  else
    echo "  FAIL: ${API_URL}/rest/v1/ did not answer" >&2
    failed=1
  fi

  if [[ "$failed" -ne 0 ]]; then
    echo "supabase-stack.sh check: FAILED" >&2
    exit 1
  fi
  echo "supabase-stack.sh check: OK"
}

cmd_status() {
  require_repo_dir
  supabase status --workdir "$REPO_DIR"
}

main() {
  local cmd="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$cmd" in
    ensure | migrate | write-env | check | status) ;;
    *)
      usage
      exit 1
      ;;
  esac

  require_root

  case "$cmd" in
    ensure) cmd_ensure "$@" ;;
    migrate) cmd_migrate "$@" ;;
    write-env) cmd_write_env "$@" ;;
    check) cmd_check "$@" ;;
    status) cmd_status "$@" ;;
  esac
}

main "$@"
