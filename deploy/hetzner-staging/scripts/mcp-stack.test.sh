#!/usr/bin/env bash
# Unit-style tests for mcp-stack.sh's `check` and `health` guards.
#
#   bash deploy/hetzner-staging/scripts/mcp-stack.test.sh
#
# It runs the real script against throwaway env files, with `docker`, `ss` and
# `curl` replaced by stubs on PATH, so nothing here talks to a daemon, a
# socket or a network.
#
# What this proves is the set of mistakes that are expensive precisely because
# they do not look like mistakes — the container is up, /health is green, and
# the deployment is wrong anyway:
#
#   * `DISABLE_AUTH=true`. It does not weaken the token check, it removes it:
#     every MCP tool call is served without a token, and `scaffold_template`
#     hands out every template's complete sources.
#   * a shared secret that does not match the app slot's. The library boots,
#     every probe passes, and then every preview run dies at its first tool
#     call with an authentication error three layers below where anyone looks.
#   * FLOWSTARTER_MCP_URL missing from the app slot's env file. The library is
#     running and the funnel still answers every visitor "we will build it by
#     hand and email it to you".
#   * a catalog that is short a template, or carrying a fixture. Neither fails
#     anything: the first shows up as the selection agent picking a
#     worse-fitting template, the second as a build that dies at `astro build`
#     for a dependency the app image never installed.
#
# Pure bash, no arrays, and portable between the Linux host and macOS bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/mcp-stack.sh"

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

assert_status() {
  local actual="$1" expected="$2" label="$3"
  if [ "$actual" = "$expected" ]; then
    ok "$label"
  else
    no "$label" "expected exit ${expected}, got ${actual}"
  fi
}

# ── A throwaway host ─────────────────────────────────────────────────────
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/bin"

# `docker` answers from STUB_* variables the cases below set, so each test
# describes one host's configuration rather than one command's output.
cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  exec)
    shift 2 # drop `exec` and the container name
    case "$1" in
      sh)
        script="$3"
        case "$script" in
          *DISABLE_AUTH*) printf '%s' "${STUB_DISABLE_AUTH:-}" ;;
          *FLOWSTARTER_MCP_INTERNAL_TOKEN*) printf '%s' "${STUB_SECRET_LEN:-64}" ;;
          *) printf '' ;;
        esac
        exit 0
        ;;
      test)
        # `test -f <dir>/<slug>/config.json` or `test -d <dir>/<slug>`
        path="$3"
        case "$path" in
          *demo-coach* | *dorin-portfolio*)
            [ "${STUB_FIXTURE_PRESENT:-0}" = "1" ] && exit 0
            exit 1
            ;;
          *"${STUB_MISSING_TEMPLATE:-__none__}"*) exit 1 ;;
          *) exit 0 ;;
        esac
        ;;
    esac
    exit 0
    ;;
  inspect)
    printf '%s' "${STUB_IMAGE_REF:-ghcr.io/dmpresearch/flowstarter-mcp:main}"
    exit 0
    ;;
esac
exit 0
STUB

cat >"$ROOT/bin/ss" <<'STUB'
#!/usr/bin/env bash
# `ss -ltn "sport = :3001"`. Header line first, like the real thing.
echo "State Recv-Q Send-Q Local-Address:Port Peer-Address:Port"
[ "${STUB_NOT_LISTENING:-0}" = "1" ] && exit 0
echo "LISTEN 0 4096 ${STUB_BOUND:-127.0.0.1:3001} 0.0.0.0:*"
STUB

cat >"$ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
# Two calls: GET /health, then POST /mcp. Told apart by the presence of --data.
for arg in "$@"; do
  case "$arg" in
    --data)
      printf '%s' "${STUB_MCP_BODY:-event: message
data: {\"result\":{\"content\":[{\"type\":\"text\",\"text\":\"{\\\"error\\\":\\\"Unauthorized\\\",\\\"statusCode\\\":401,\\\"code\\\":\\\"UNAUTHORIZED\\\"}\"}],\"isError\":true}}}"
      exit 0
      ;;
  esac
done
[ "${STUB_HEALTH_DOWN:-0}" = "1" ] && exit 22
printf '%s' '{"status":"healthy","service":"mcp-server","version":"1.0.0","transport":"streamable-http"}'
STUB

chmod +x "$ROOT/bin/docker" "$ROOT/bin/ss" "$ROOT/bin/curl"
PATH="$ROOT/bin:$PATH"
export PATH

SECRET='0123456789abcdef0123456789abcdef0123456789abcdef'

# Writes the pair of env files a case needs. $1 is the library's token, $2 the
# app slot's, $3 the app slot's FLOWSTARTER_MCP_URL (empty to omit the line).
write_env_files() {
  : >"$ROOT/mcp.env"
  [ -n "${1:-}" ] && echo "FLOWSTARTER_MCP_INTERNAL_TOKEN=$1" >>"$ROOT/mcp.env"
  chmod 600 "$ROOT/mcp.env"

  : >"$ROOT/staging.env"
  echo "NEXT_PUBLIC_SITE_URL=https://staging.flowstarter.dev" >>"$ROOT/staging.env"
  [ -n "${2:-}" ] && echo "FLOWSTARTER_MCP_INTERNAL_TOKEN=$2" >>"$ROOT/staging.env"
  [ -n "${3:-}" ] && echo "FLOWSTARTER_MCP_URL=$3" >>"$ROOT/staging.env"
  chmod 600 "$ROOT/staging.env"
}

# Clears every stub knob. Bash keeps a `VAR=x func` assignment in effect after
# the function returns, so without this a case that sets one would quietly
# configure every case after it — which is the one bug a test file must not
# have.
reset_stubs() {
  unset STUB_DISABLE_AUTH STUB_SECRET_LEN STUB_BOUND STUB_NOT_LISTENING \
    STUB_FIXTURE_PRESENT STUB_MISSING_TEMPLATE STUB_HEALTH_DOWN STUB_MCP_BODY
}

# Runs `mcp-stack.sh <subcommand>` against the throwaway host. Output and exit
# status come back through OUT / STATUS.
run() {
  OUT="$(
    MCP_ENV_FILE="$ROOT/mcp.env" \
    MCP_APP_ENV_FILE="$ROOT/staging.env" \
    MCP_COMPOSE_FILE="$ROOT/docker-compose.yml" \
      bash "$SCRIPT" "$@" 2>&1
  )"
  STATUS=$?
}

# ── check: the happy path ────────────────────────────────────────────────
echo "check: a correctly configured host"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
run check
assert_status "$STATUS" 0 "passes"
assert_contains "$OUT" "port 3001 is bound on 127.0.0.1:3001" "reports the loopback bind"
assert_contains "$OUT" "tool calls are authenticated" "reports auth is on"
assert_contains "$OUT" "shared secret is present (64 characters)" "reports the secret length"
assert_contains "$OUT" "hold the same shared secret" "reports the secrets match"
assert_contains "$OUT" "points FLOWSTARTER_MCP_URL at this library" "reports the app is wired to it"
assert_contains "$OUT" "catalog: creative-portfolio local-trade professional-services wellness-therapy" "reports the catalog"
assert_not_contains "$OUT" "$SECRET" "never prints the secret"

# ── check: the bind ──────────────────────────────────────────────────────
echo "check: a 0.0.0.0 bind"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_BOUND="0.0.0.0:3001" run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "REFUSING" "says it is refusing"
assert_contains "$OUT" "every template's complete sources" "says what is behind the port"

echo "check: nothing listening"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_NOT_LISTENING=1 run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "nothing is listening on port 3001" "names the port"

# ── check: authentication ────────────────────────────────────────────────
echo "check: DISABLE_AUTH=true"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_DISABLE_AUTH=true run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "DISABLE_AUTH=true" "names the variable"
assert_contains "$OUT" "without a token" "says what it costs"

echo "check: a too-short secret"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_SECRET_LEN=8 run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "shorter than 32 characters" "says why"

# ── check: the secret both sides hold ────────────────────────────────────
echo "check: a secret that does not match the app slot's"
reset_stubs
write_env_files "$SECRET" "a-completely-different-32-plus-character-token" "http://127.0.0.1:3001/mcp"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "is not the one in" "says the two differ"
assert_contains "$OUT" "fail at its first tool call" "says what it costs"
assert_not_contains "$OUT" "$SECRET" "never prints either secret"
assert_not_contains "$OUT" "a-completely-different-32-plus-character-token" "never prints the app's secret either"

echo "check: no secret in the app slot's env file"
reset_stubs
write_env_files "$SECRET" "" "http://127.0.0.1:3001/mcp"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "is not set in" "names the missing key"

# ── check: the app's half of the wiring ──────────────────────────────────
echo "check: FLOWSTARTER_MCP_URL missing from the app slot"
reset_stubs
write_env_files "$SECRET" "$SECRET" ""
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "still refuse every preview with reason 'not-configured'" "says what a visitor sees"

echo "check: FLOWSTARTER_MCP_URL pointing somewhere else"
reset_stubs
write_env_files "$SECRET" "$SECRET" "https://flowstarter-template-library.internal/mcp"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "which is not this library" "says it is the wrong endpoint"

echo "check: FLOWSTARTER_MCP_URL missing the /mcp path"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "the path must be /mcp" "explains the path split"

# ── check: the catalog ───────────────────────────────────────────────────
echo "check: a catalog template missing from the image"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_MISSING_TEMPLATE=wellness-therapy run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "'wellness-therapy' is not in this image" "names the template"
assert_contains "$OUT" "smaller catalog" "says what it costs"

echo "check: a fixture template present in the image"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
STUB_FIXTURE_PRESENT=1 run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "is a fixture, not a catalog template" "says what it is"
assert_contains "$OUT" "astro build" "says where it would fail"

# ── check: the env file itself ───────────────────────────────────────────
echo "check: an env file that is not mode 600"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
chmod 644 "$ROOT/mcp.env"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "must be mode 600" "says the mode"
chmod 600 "$ROOT/mcp.env"

echo "check: no env file at all"
reset_stubs
rm -f "$ROOT/mcp.env"
run check
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "mcp.env.example" "points at the example"

# ── health ───────────────────────────────────────────────────────────────
echo "health: a library that answers and refuses an untokened call"
reset_stubs
write_env_files "$SECRET" "$SECRET" "http://127.0.0.1:3001/mcp"
run health
assert_status "$STATUS" 0 "passes"
assert_contains "$OUT" '"status":"healthy"' "reports the health body"
assert_contains "$OUT" "an untokened tool call is refused" "asserts the auth rule"

echo "health: a library that does not answer"
reset_stubs
STUB_HEALTH_DOWN=1 run health
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "refuses every preview" "says what it costs the funnel"

echo "health: an untokened tool call that SUCCEEDS"
reset_stubs
STUB_MCP_BODY='{"result":{"content":[{"type":"text","text":"{\"templates\":[]}"}]}}' run health
assert_status "$STATUS" 1 "refuses"
assert_contains "$OUT" "did not refuse an untokened list_templates" "names the regression"

# ── usage ────────────────────────────────────────────────────────────────
echo "usage"
reset_stubs
run
assert_status "$STATUS" 1 "refuses with no subcommand"
assert_contains "$OUT" "usage: mcp-stack.sh" "prints usage"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
