#!/usr/bin/env bash
###############################################################################
# wait-for-staging-slot.sh
#
# Waits for a Hetzner platform slot to answer `/api/health` with `"ok":true`
# and, by default, `"target":"local"` (the marker that says the slot is talking
# to the Supabase CLI stack on the host rather than a hosted project). On
# success it writes the slot's base URL to $GITHUB_OUTPUT as `url=<https://...>`.
#
# This replaces wait-for-netlify-deploy.sh. Pull requests no longer get a
# Netlify Deploy Preview; they get a real slot at
# https://pr-<n>.staging.flowstarter.dev, deployed by
# .depot/workflows/staging-pr-deploy.yml, with a database behind it.
#
# Required env:
#   TARGET_URL        base URL of the slot, no trailing slash
#
# Optional env:
#   TIMEOUT_SECONDS   total wait budget (default 900 = 15 min, which is the
#                     staging PR lane's own build-and-deploy budget)
#   POLL_INTERVAL     seconds between polls (default 15)
#   EXPECT_TARGET     "local" (default) to require "target":"local"; set to
#                     "production" to require "env":"production" instead;
#                     "any" to accept any healthy answer
#
# Exit codes:
#   0  → the slot is healthy, URL written to $GITHUB_OUTPUT
#   1  → missing env, or the slot never became healthy inside the budget
###############################################################################

set -euo pipefail

: "${TARGET_URL:?TARGET_URL is required}"

TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-900}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
EXPECT_TARGET="${EXPECT_TARGET:-local}"

url="${TARGET_URL%/}"

case "$EXPECT_TARGET" in
  local)
    pattern='"target"[[:space:]]*:[[:space:]]*"local"'
    desc='"target":"local"'
    ;;
  production)
    pattern='"env"[[:space:]]*:[[:space:]]*"production"'
    desc='"env":"production"'
    ;;
  any)
    pattern=''
    desc='(no environment marker required)'
    ;;
  *)
    echo "unsupported EXPECT_TARGET: $EXPECT_TARGET (expected local, production or any)" >&2
    exit 1
    ;;
esac

echo "Waiting up to ${TIMEOUT_SECONDS}s for ${url}/api/health to report \"ok\":true and ${desc} ..."

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
body=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(curl -fsS --max-time 20 "${url}/api/health" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    if [ -z "$pattern" ] || printf '%s' "$body" | grep -Eq "$pattern"; then
      echo "Healthy: ${url}/api/health"
      if [ -n "${GITHUB_OUTPUT:-}" ]; then
        echo "url=${url}" >> "$GITHUB_OUTPUT"
      fi
      exit 0
    fi
  fi
  sleep "$POLL_INTERVAL"
done

echo "Timed out after ${TIMEOUT_SECONDS}s waiting for ${url}/api/health." >&2
echo "Last body: ${body:-<no response>}" >&2
exit 1
