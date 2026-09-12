#!/usr/bin/env bash
###############################################################################
# wait-for-staging-slot.sh
#
# Waits for a Hetzner platform slot to answer `/api/health` with `"ok":true`,
# by default `"target":"local"` (the marker that says the slot is talking to
# the Supabase CLI stack on the host rather than a hosted project), and, when
# EXPECTED_COMMIT is set, `"commit":"<that value>"`.
#
# The commit check exists because health alone does not identify which build
# is answering. Deploying a slot (.depot/workflows/staging-pr-deploy.yml /
# staging-deploy.yml) takes minutes: build the image, push it, SSH in, `docker
# compose up`. The PREVIOUS container keeps answering "ok":true and
# "target":"local" the whole time a new one is being rolled out, so a caller
# that only checked those two fields could pass immediately against stale
# code and then run assertions the commit under test hasn't shipped yet (or
# worse, that a commit no one is testing already broke). /api/health now
# reports the build's own git commit (see
# apps/flowstarter-main/src/app/api/health/route.ts and this repo's
# FLOWSTARTER_BUILD_COMMIT build arg / env var, threaded through
# deploy/hetzner-staging/Dockerfile and deploy-slot.sh), and this script waits
# for that field to equal EXPECTED_COMMIT before calling the slot ready, so a
# rollout in progress is a wait, not a false pass.
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
#   EXPECTED_COMMIT   when set, also requires "commit":"<value>" (exact
#                     string match) in the health body, so a slot mid-rollout
#                     to a different commit is treated as not yet ready
#                     rather than a false pass. Unset by default: a caller
#                     with no commit to name (there is none left in this repo,
#                     but a future one might not) keeps the old
#                     ok+target/env-only behaviour.
#
# Exit codes:
#   0  → the slot is healthy (and, if EXPECTED_COMMIT is set, on that commit),
#        URL written to $GITHUB_OUTPUT
#   1  → missing env, or the slot never became ready inside the budget
###############################################################################

set -euo pipefail

: "${TARGET_URL:?TARGET_URL is required}"

TIMEOUT_SECONDS="${TIMEOUT_SECONDS:-900}"
POLL_INTERVAL="${POLL_INTERVAL:-15}"
EXPECT_TARGET="${EXPECT_TARGET:-local}"
EXPECTED_COMMIT="${EXPECTED_COMMIT:-}"

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

if [ -n "$EXPECTED_COMMIT" ]; then
  desc="${desc} and \"commit\":\"${EXPECTED_COMMIT}\""
fi

# Pulls the value out of `"commit":"<value>"` rather than building a regex out
# of EXPECTED_COMMIT: an exact string comparison needs no escaping no matter
# what the value looks like. Empty (no such field, or an empty value) when the
# body has no commit field at all, which is the correct answer for a slot
# built before this field existed.
last_commit_reported() {
  # `|| true`: grep finding no "commit" field is not a script error under
  # `set -e` -- it means the responding build predates this field (or the
  # response was empty), and the caller reads that as an empty string.
  printf '%s' "$1" |
    { grep -Eo '"commit"[[:space:]]*:[[:space:]]*"[^"]*"' || true; } |
    tail -n1 |
    sed -E 's/.*"([^"]*)"$/\1/'
}

echo "Waiting up to ${TIMEOUT_SECONDS}s for ${url}/api/health to report \"ok\":true and ${desc} ..."

deadline=$(( $(date +%s) + TIMEOUT_SECONDS ))
body=""
while [ "$(date +%s)" -lt "$deadline" ]; do
  body="$(curl -fsS --max-time 20 "${url}/api/health" 2>/dev/null || true)"
  if printf '%s' "$body" | grep -Eq '"ok"[[:space:]]*:[[:space:]]*true'; then
    if [ -z "$pattern" ] || printf '%s' "$body" | grep -Eq "$pattern"; then
      if [ -z "$EXPECTED_COMMIT" ] || [ "$(last_commit_reported "$body")" = "$EXPECTED_COMMIT" ]; then
        echo "Healthy: ${url}/api/health"
        if [ -n "${GITHUB_OUTPUT:-}" ]; then
          echo "url=${url}" >> "$GITHUB_OUTPUT"
        fi
        exit 0
      fi
    fi
  fi
  sleep "$POLL_INTERVAL"
done

echo "Timed out after ${TIMEOUT_SECONDS}s waiting for ${url}/api/health to report \"ok\":true and ${desc}." >&2
if [ -n "$EXPECTED_COMMIT" ]; then
  last_commit="$(last_commit_reported "$body")"
  echo "Last commit the slot reported: ${last_commit:-<none>} (expected ${EXPECTED_COMMIT})." >&2
fi
echo "Last body: ${body:-<no response>}" >&2
exit 1
