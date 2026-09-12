#!/usr/bin/env bash
# Makes "a dev server on my Mac, with local Supabase" reproducible on a
# fresh machine or a fresh clone: checks the toolchain, installs whatever is
# missing (macOS via Homebrew), wires up env files, brings up the local
# Supabase stack, and finishes with the same health summary as
# scripts/dev-doctor.sh.
#
# Written for macOS with Homebrew. On Linux this script still runs every
# check and tells you what's missing and how to fix it, but it will not try
# to install anything for you -- use your distro's package manager for
# anything marked [fail] (git, a Node 22 via nvm/fnm, corepack + pnpm at the
# pinned version, Docker, the Supabase CLI at 2.95.4, the Stripe CLI).
#
# Usage:
#   bash scripts/dev-bootstrap.sh              # check, install, start, summarize
#   bash scripts/dev-bootstrap.sh --check      # report only, changes nothing
#   bash scripts/dev-bootstrap.sh --no-supabase  # skip starting the local stack
#
# Idempotent: safe to run again on a machine that already has some or all of
# this. Never starts apps/flowstarter-main, the build worker, the deploy
# agent, or the editor -- only the local Supabase stack (unless
# --no-supabase) and one-off CLI calls needed to check or configure things.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
MAIN_DIR="$ROOT/apps/flowstarter-main"

PIN_NODE_MAJOR=22
PIN_PNPM_VERSION="$(grep -m1 '"packageManager"' "$ROOT/package.json" | sed -E 's/.*"pnpm@([^"]+)".*/\1/')"
SUPABASE_CLI_PIN="2.95.4"
NVM_DIR="${NVM_DIR:-$HOME/.nvm}"

CHECK_MODE=false
NO_SUPABASE=false

for arg in "$@"; do
  case "$arg" in
    --check)
      CHECK_MODE=true
      ;;
    --no-supabase)
      NO_SUPABASE=true
      ;;
    -h|--help)
      sed -n '2,20p' "${BASH_SOURCE[0]}"
      exit 0
      ;;
    *)
      echo "Unknown flag: $arg (expected --check and/or --no-supabase)" >&2
      exit 2
      ;;
  esac
done

IS_MACOS=false
if [[ "$(uname -s)" == "Darwin" ]]; then
  IS_MACOS=true
fi

HARD_FAIL=0

log_step() {
  printf '\n==> %s\n' "$1"
}

log_ok() {
  printf '  [ok]   %s\n' "$1"
}

log_warn() {
  printf '  [warn] %s\n' "$1"
}

log_fail() {
  printf '  [fail] %s\n' "$1"
}

if [[ "$IS_MACOS" != "true" ]]; then
  log_warn "Not macOS: this script only auto-installs via Homebrew on macOS. Every check below still runs; install anything marked [fail] with your distro's package manager, matching the pins in this file's header."
fi

if [[ "$CHECK_MODE" == "true" ]]; then
  echo "Flowstarter dev bootstrap (--check: report only, no changes)"
else
  echo "Flowstarter dev bootstrap"
fi
echo "========================="

# --- Homebrew -----------------------------------------------------------

ensure_homebrew() {
  if command -v brew >/dev/null 2>&1; then
    log_ok "Homebrew: $(brew --version | head -n1)"
    return 0
  fi
  if [[ "$IS_MACOS" != "true" ]]; then
    log_warn "Homebrew not applicable (not macOS)"
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" ]]; then
    log_fail "Homebrew not found. Fix: install from https://brew.sh, then re-run."
    return 1
  fi
  log_step "Installing Homebrew"
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
  if command -v brew >/dev/null 2>&1; then
    log_ok "Homebrew installed: $(brew --version | head -n1)"
    return 0
  fi
  log_fail "Homebrew install did not complete. Fix: install manually from https://brew.sh, then re-run."
  return 1
}

# --- git ------------------------------------------------------------------

ensure_git() {
  if command -v git >/dev/null 2>&1; then
    log_ok "git: $(git --version)"
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" || "$IS_MACOS" != "true" ]]; then
    log_fail "git not found. Fix (macOS): xcode-select --install (or: brew install git). Fix (Linux): install git with your package manager."
    return 1
  fi
  log_step "Installing git (Homebrew)"
  brew install git
  log_ok "git: $(git --version)"
}

# --- Node 22, via nvm or fnm ------------------------------------------------

node_22_installed_under_nvm() {
  [[ -d "$NVM_DIR/versions/node" ]] || return 1
  find "$NVM_DIR/versions/node" -maxdepth 1 -name "v${PIN_NODE_MAJOR}.*" -print -quit 2>/dev/null | grep -q .
}

node_22_installed_under_fnm() {
  command -v fnm >/dev/null 2>&1 || return 1
  fnm list 2>/dev/null | grep -q "v${PIN_NODE_MAJOR}\."
}

ensure_node() {
  if command -v node >/dev/null 2>&1; then
    local node_version node_major
    node_version="$(node --version)"
    node_major="$(echo "$node_version" | sed -E 's/^v([0-9]+).*/\1/')"
    if [[ "$node_major" == "$PIN_NODE_MAJOR" ]]; then
      log_ok "node $node_version active (pin: $PIN_NODE_MAJOR.x)"
      return 0
    fi
    log_warn "node $node_version active, pin is $PIN_NODE_MAJOR.x"
  else
    log_warn "node not found on PATH"
  fi

  if node_22_installed_under_nvm; then
    log_ok "node $PIN_NODE_MAJOR is installed under nvm ($NVM_DIR) -- run 'nvm use $PIN_NODE_MAJOR' (or 'nvm alias default $PIN_NODE_MAJOR')"
    return 0
  fi
  if node_22_installed_under_fnm; then
    log_ok "node $PIN_NODE_MAJOR is installed under fnm -- run 'fnm use $PIN_NODE_MAJOR' (or 'fnm default $PIN_NODE_MAJOR')"
    return 0
  fi

  if [[ "$CHECK_MODE" == "true" ]]; then
    log_fail "No Node $PIN_NODE_MAJOR found under nvm or fnm. Fix: brew install nvm && nvm install $PIN_NODE_MAJOR (or: brew install fnm && fnm install $PIN_NODE_MAJOR)."
    return 1
  fi

  if [[ "$IS_MACOS" != "true" ]]; then
    log_fail "No Node $PIN_NODE_MAJOR found. Fix: install nvm (https://github.com/nvm-sh/nvm) or fnm, then Node $PIN_NODE_MAJOR."
    return 1
  fi

  if ! command -v fnm >/dev/null 2>&1 && [[ ! -s "$NVM_DIR/nvm.sh" ]]; then
    log_step "Installing nvm (Homebrew)"
    brew install nvm
    mkdir -p "$NVM_DIR"
  fi

  if [[ -s "$NVM_DIR/nvm.sh" ]]; then
    log_step "Installing Node $PIN_NODE_MAJOR via nvm"
    # shellcheck source=/dev/null
    \. "$NVM_DIR/nvm.sh"
    nvm install "$PIN_NODE_MAJOR"
    log_ok "node $PIN_NODE_MAJOR installed under nvm"
    log_warn "Not yet active in your login shell -- add nvm's init lines to your shell profile if missing (brew's Homebrew nvm caveats show them), open a new terminal, or run 'nvm use $PIN_NODE_MAJOR' now."
    return 0
  fi

  if command -v fnm >/dev/null 2>&1; then
    log_step "Installing Node $PIN_NODE_MAJOR via fnm"
    fnm install "$PIN_NODE_MAJOR"
    log_ok "node $PIN_NODE_MAJOR installed under fnm"
    log_warn "Not yet active in your login shell -- add fnm's init lines to your shell profile if missing, open a new terminal, or run 'fnm use $PIN_NODE_MAJOR' now."
    return 0
  fi

  log_fail "Could not install a Node version manager. Fix: brew install nvm && nvm install $PIN_NODE_MAJOR."
  return 1
}

# --- pnpm, via corepack -----------------------------------------------------

ensure_pnpm() {
  if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version)" == "$PIN_PNPM_VERSION" ]]; then
    log_ok "pnpm $PIN_PNPM_VERSION active"
    return 0
  fi

  if command -v pnpm >/dev/null 2>&1; then
    log_warn "pnpm $(pnpm --version) active, pin is $PIN_PNPM_VERSION"
  else
    log_warn "pnpm not found on PATH"
  fi

  if [[ "$CHECK_MODE" == "true" ]]; then
    log_fail "pnpm not at $PIN_PNPM_VERSION. Fix: corepack enable && corepack prepare pnpm@$PIN_PNPM_VERSION --activate (or: npm install -g pnpm@$PIN_PNPM_VERSION)."
    return 1
  fi

  log_step "Activating pnpm $PIN_PNPM_VERSION"
  if command -v corepack >/dev/null 2>&1; then
    corepack enable >/dev/null 2>&1 || true
    corepack prepare "pnpm@$PIN_PNPM_VERSION" --activate
  else
    log_warn "corepack not found on the active node (Node $PIN_NODE_MAJOR ships it; a newer active Node here may not). Falling back to 'npm install -g'."
    npm install -g "pnpm@$PIN_PNPM_VERSION"
  fi

  if command -v pnpm >/dev/null 2>&1 && [[ "$(pnpm --version)" == "$PIN_PNPM_VERSION" ]]; then
    log_ok "pnpm $PIN_PNPM_VERSION active"
    return 0
  fi

  log_fail "pnpm is still not at $PIN_PNPM_VERSION. Fix: open a new terminal (PATH may need the corepack shim first) and re-run, or 'npm install -g pnpm@$PIN_PNPM_VERSION'."
  return 1
}

# --- Docker / OrbStack: presence only, never installed ----------------------

ensure_docker() {
  if command -v docker >/dev/null 2>&1; then
    if docker info >/dev/null 2>&1; then
      log_ok "Docker daemon running ($(docker --version))"
      return 0
    fi
    log_fail "Docker CLI found but the daemon is not responding. Fix: open Docker Desktop or OrbStack, then re-run."
    return 1
  fi
  if [[ -d "/Applications/Docker.app" ]] || [[ -d "/Applications/OrbStack.app" ]]; then
    log_fail "Docker Desktop or OrbStack is installed but not on PATH or not running. Fix: open it once, then re-run."
    return 1
  fi
  log_fail "No Docker Desktop or OrbStack found. Fix: install one by hand (https://www.docker.com/products/docker-desktop or https://orbstack.dev) -- this script will not install it for you."
  return 1
}

# --- Supabase CLI, pinned ---------------------------------------------------

ensure_supabase_cli() {
  if command -v supabase >/dev/null 2>&1; then
    local ver
    ver="$(supabase --version 2>/dev/null | tr -d '[:space:]')"
    if [[ "$ver" == "$SUPABASE_CLI_PIN" ]]; then
      log_ok "supabase CLI $ver"
    else
      log_warn "supabase CLI $ver active, CI pins $SUPABASE_CLI_PIN (Homebrew tracks latest; a version-specific issue is why this might matter)"
    fi
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" || "$IS_MACOS" != "true" ]]; then
    log_fail "supabase CLI not found. Fix (macOS): brew install supabase/tap/supabase. Fix (Linux): https://supabase.com/docs/guides/cli (target $SUPABASE_CLI_PIN)."
    return 1
  fi
  log_step "Installing Supabase CLI (Homebrew)"
  brew install supabase/tap/supabase
  log_ok "supabase CLI: $(supabase --version 2>/dev/null | tr -d '[:space:]')"
}

# --- Stripe CLI --------------------------------------------------------------

ensure_stripe_cli() {
  if command -v stripe >/dev/null 2>&1; then
    log_ok "stripe CLI: $(stripe --version 2>/dev/null)"
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" || "$IS_MACOS" != "true" ]]; then
    log_fail "stripe CLI not found. Fix (macOS): brew install stripe/stripe-cli/stripe. Fix (Linux): https://stripe.com/docs/stripe-cli."
    return 1
  fi
  log_step "Installing Stripe CLI (Homebrew)"
  brew install stripe/stripe-cli/stripe
  log_ok "stripe CLI: $(stripe --version 2>/dev/null)"
}

# --- mprocs: soft, since the pnpm devDependency is a fallback ---------------

ensure_mprocs() {
  if command -v mprocs >/dev/null 2>&1; then
    log_ok "mprocs: $(mprocs --version 2>/dev/null || echo present)"
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" || "$IS_MACOS" != "true" ]]; then
    log_warn "mprocs not found on PATH (optional: 'pnpm dev' also works via the repo's own devDependency). Fix: brew install mprocs"
    return 0
  fi
  log_step "Installing mprocs (Homebrew, optional)"
  if ! brew install mprocs; then
    log_warn "mprocs Homebrew install failed; 'pnpm dev' still works via the npm devDependency."
  fi
  return 0
}

# --- ffmpeg: optional, only for clip recording ------------------------------

ensure_ffmpeg_optional() {
  if command -v ffmpeg >/dev/null 2>&1; then
    log_ok "ffmpeg present"
    return 0
  fi
  if [[ "$CHECK_MODE" == "true" || "$IS_MACOS" != "true" ]]; then
    log_warn "ffmpeg not found (optional, only needed for clip recording). Fix: brew install ffmpeg"
    return 0
  fi
  log_step "Installing ffmpeg (Homebrew, optional)"
  if ! brew install ffmpeg; then
    log_warn "ffmpeg install failed; it's optional (clip recording only)."
  fi
  return 0
}

# --- Run the toolchain checks -----------------------------------------------

log_step "Toolchain"
ensure_homebrew || HARD_FAIL=$((HARD_FAIL + 1))
ensure_git || HARD_FAIL=$((HARD_FAIL + 1))
ensure_node || HARD_FAIL=$((HARD_FAIL + 1))
ensure_pnpm || HARD_FAIL=$((HARD_FAIL + 1))
if [[ "$NO_SUPABASE" != "true" ]]; then
  ensure_docker || HARD_FAIL=$((HARD_FAIL + 1))
  ensure_supabase_cli || HARD_FAIL=$((HARD_FAIL + 1))
else
  log_warn "--no-supabase: skipping the Docker and Supabase CLI checks (both are still needed later for 'pnpm dev')"
fi
ensure_stripe_cli || HARD_FAIL=$((HARD_FAIL + 1))
ensure_mprocs || true
ensure_ffmpeg_optional || true

# --- Install workspace deps -------------------------------------------------

log_step "Workspace dependencies"
if [[ "$CHECK_MODE" == "true" ]]; then
  log_warn "Would run: pnpm install --frozen-lockfile"
else
  (cd "$ROOT" && pnpm install --frozen-lockfile)
  log_ok "pnpm install --frozen-lockfile"
fi

# --- Env files ---------------------------------------------------------------

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
    printf '    %-14s %s\n' "$label" "$joined"
  fi
}

log_step "Env files (apps/flowstarter-main)"
for target in .env .env.local; do
  path="$MAIN_DIR/$target"
  if [[ -f "$path" ]]; then
    log_ok "$target already exists (left untouched)"
  elif [[ "$CHECK_MODE" == "true" ]]; then
    log_warn "$target missing. Fix: cp apps/flowstarter-main/.env.example apps/flowstarter-main/$target"
  else
    cp "$MAIN_DIR/.env.example" "$path"
    log_ok "Created $target from .env.example"
  fi
done

echo ""
echo "  Keys that still need a real value in apps/flowstarter-main/.env.local:"
key_report="$(
  report_key_group "Clerk" NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY CLERK_SECRET_KEY
  report_key_group "OpenRouter" OPENROUTER_API_KEY
  report_key_group "Stripe" NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY STRIPE_SECRET_KEY STRIPE_WEBHOOK_SECRET
  report_key_group "Resend" RESEND_API_KEY
)"
if [[ -n "$key_report" ]]; then
  echo "$key_report"
else
  echo "    none -- Clerk, OpenRouter, Stripe and Resend all look set"
fi

# --- Local Supabase stack ----------------------------------------------------

if [[ "$NO_SUPABASE" == "true" ]]; then
  log_step "Local Supabase stack"
  log_warn "--no-supabase: skipped 'pnpm db:start', 'supabase migration up --local' and 'pnpm db:env'"
elif [[ "$CHECK_MODE" == "true" ]]; then
  log_step "Local Supabase stack"
  log_warn "Would run: pnpm db:start && supabase migration up --local && pnpm db:env"
else
  log_step "Starting the local Supabase stack (pnpm db:start)"
  (cd "$ROOT" && pnpm run db:start)

  log_step "Applying migrations (supabase migration up --local)"
  (cd "$ROOT" && supabase migration up --local)

  log_step "Writing the dev env (pnpm db:env)"
  (cd "$ROOT" && pnpm run db:env)
fi

# --- Stripe webhook secret hint ----------------------------------------------

if [[ "$CHECK_MODE" == "true" ]]; then
  log_step "Stripe webhook secret"
  log_warn "Would try: stripe listen --print-secret (falls back to a manual hint if not logged in)"
elif command -v stripe >/dev/null 2>&1; then
  log_step "Stripe webhook secret"
  if stripe config --list >/dev/null 2>&1; then
    secret_tmp="$(mktemp)"
    stripe listen --print-secret >"$secret_tmp" 2>/dev/null &
    secret_pid=$!
    waited=0
    while kill -0 "$secret_pid" 2>/dev/null && [[ $waited -lt 15 ]]; do
      sleep 1
      waited=$((waited + 1))
    done
    if kill -0 "$secret_pid" 2>/dev/null; then
      kill "$secret_pid" 2>/dev/null || true
      wait "$secret_pid" 2>/dev/null || true
      log_warn "Timed out waiting for the Stripe CLI. Run 'stripe listen --print-secret' yourself and copy the printed whsec_... into apps/flowstarter-main/.env.local as STRIPE_WEBHOOK_SECRET, then restart the Main proc."
    else
      wait "$secret_pid" 2>/dev/null || true
      if grep -q '^whsec_' "$secret_tmp" 2>/dev/null; then
        log_ok "Stripe webhook secret retrieved (not printed here). Copy it into apps/flowstarter-main/.env.local as STRIPE_WEBHOOK_SECRET: run 'stripe listen --print-secret' yourself to see it, one time per machine, then restart the Main proc."
      else
        log_warn "Could not retrieve a Stripe webhook secret automatically. Run 'stripe listen --print-secret' yourself and copy the whsec_... into .env.local as STRIPE_WEBHOOK_SECRET."
      fi
    fi
    rm -f "$secret_tmp"
  else
    log_warn "Stripe CLI not logged in. One-time: 'stripe login', then 'stripe listen --print-secret' (or just run 'pnpm dev' once) and copy the printed whsec_... into apps/flowstarter-main/.env.local as STRIPE_WEBHOOK_SECRET, then restart the Main proc."
  fi
fi

# --- Health summary -----------------------------------------------------------

log_step "Health summary (scripts/dev-doctor.sh)"
bash "$ROOT/scripts/dev-doctor.sh"

if [[ "$HARD_FAIL" -gt 0 ]]; then
  echo ""
  echo "$HARD_FAIL hard requirement(s) missing or not runnable -- fix the [fail] lines above, then re-run."
  exit 1
fi

echo ""
echo "Bootstrap complete."
exit 0
