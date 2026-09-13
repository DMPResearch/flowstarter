#!/usr/bin/env bash
# Static checks for the runner image shipping the discovery funnel's preview
# templates (deploy/hetzner-staging/Dockerfile, .dockerignore and
# docker-compose.yml, plus README.md's documentation of the two env vars the
# feature needs on the box).
#
#   bash deploy/hetzner-staging/scripts/image-templates.test.sh
#
# This does not invoke Docker — none of the other tests in this directory do
# either, and a real build takes minutes and needs a registry pull. What it
# proves instead is the part that broke silently before this change: that
# the four templates the discovery funnel can actually build from
# (creative-portfolio, local-trade, professional-services, wellness-therapy)
# are the ones the image installs and un-ignores, that dorin-portfolio and
# demo-coach are not, that the templates land at a path stable enough for
# pnpm's own CLI shims to keep working (see the Dockerfile's `templates`
# stage comment for why that is not a style preference), that the runner
# switches to a non-root user only after that layer is in place, and that
# the two FLOWSTARTER_PREVIEW_DEPLOY_AGENT_* variable names are actually
# spelled out on the page an operator provisioning the box will read.
#
# A real build was run once by hand (`docker build --target templates`,
# 2026-09-13) to prove `astro build` succeeds inside the image as the
# non-root user; that is not repeatable in a unit test without Docker and a
# multi-minute pnpm install, so it stays a manual step instead of a CI one.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${HERE}/../../.." && pwd)"
DOCKERFILE="${ROOT}/deploy/hetzner-staging/Dockerfile"
DOCKERIGNORE="${ROOT}/.dockerignore"
COMPOSE="${ROOT}/deploy/hetzner-staging/docker-compose.yml"
README="${ROOT}/deploy/hetzner-staging/README.md"

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

# Line number of a needle, or empty if absent — used below to check that one
# thing happens before another (COPY before USER, etc).
line_of() {
  grep -nF -- "$2" "$1" | head -1 | cut -d: -f1
}

dockerfile="$(cat "$DOCKERFILE")"
dockerignore="$(cat "$DOCKERIGNORE")"
compose="$(cat "$COMPOSE")"
readme="$(cat "$README")"

echo "Dockerfile: the templates stage"
assert_contains "$dockerfile" "FROM base AS templates" "a templates stage exists"
for t in creative-portfolio local-trade professional-services wellness-therapy; do
  assert_contains "$dockerfile" "apps/flowstarter-templates/${t}" "${t} is installed"
done
assert_not_contains "$dockerfile" "apps/flowstarter-templates/dorin-portfolio" "dorin-portfolio (legacy) is not installed"
assert_not_contains "$dockerfile" "apps/flowstarter-templates/demo-coach" "demo-coach (editor dev fixture) is not installed"
assert_contains "$dockerfile" "pnpm install --frozen-lockfile --prod --ignore-scripts" "the templates install is --prod --ignore-scripts"

echo
echo "Dockerfile: the runner stage"
copy_line="$(line_of "$DOCKERFILE" "COPY --from=templates")"
user_line="$(line_of "$DOCKERFILE" "USER node")"
env_root_line="$(line_of "$DOCKERFILE" "ENV FLOWSTARTER_TEMPLATE_ROOT=")"
if [ -n "$copy_line" ] && [ -n "$user_line" ] && [ "$copy_line" -lt "$user_line" ]; then
  ok "the templates layer is copied in before the runner drops to a non-root user"
else
  no "the templates layer is copied in before the runner drops to a non-root user" \
    "COPY at line ${copy_line:-?}, USER node at line ${user_line:-?}"
fi
if [ -n "$env_root_line" ] && [ -n "$user_line" ] && [ "$env_root_line" -lt "$user_line" ]; then
  ok "FLOWSTARTER_TEMPLATE_ROOT is set before the runner drops to a non-root user"
else
  no "FLOWSTARTER_TEMPLATE_ROOT is set before the runner drops to a non-root user"
fi
assert_contains "$dockerfile" "ENV FLOWSTARTER_TEMPLATE_ROOT=/srv/preview-templates/apps/flowstarter-templates" \
  "FLOWSTARTER_TEMPLATE_ROOT points at the copied-in layer"
assert_contains "$dockerfile" "USER node" "the runner switches to a non-root user"
assert_contains "$dockerfile" "chown node:node" \
  "the four templates' own node_modules directories are handed to the non-root user (Vite's dep cache needs to write there)"

echo
echo ".dockerignore: only the vetted four are let through"
assert_contains "$dockerignore" "apps/flowstarter-templates/**" "the templates directory is excluded by default"
for t in creative-portfolio local-trade professional-services wellness-therapy; do
  assert_contains "$dockerignore" "!apps/flowstarter-templates/${t}/**" "${t} is un-ignored"
done
assert_not_contains "$dockerignore" "!apps/flowstarter-templates/dorin-portfolio/**" "dorin-portfolio stays ignored"
assert_not_contains "$dockerignore" "!apps/flowstarter-templates/demo-coach/**" "demo-coach stays ignored"

echo
echo "docker-compose.yml: scratch space for the preview build"
assert_contains "$compose" "tmpfs:" "a tmpfs mount is declared"
assert_contains "$compose" "/tmp:size=" "the mount targets /tmp with a size cap"

echo
echo "README.md: the two env vars a box needs"
assert_contains "$readme" "FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL" "FLOWSTARTER_PREVIEW_DEPLOY_AGENT_URL is documented"
assert_contains "$readme" "FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET" "FLOWSTARTER_PREVIEW_DEPLOY_AGENT_SECRET is documented"
assert_contains "$readme" "127.0.0.1:8444" "the loopback port already set on the box is written down"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
