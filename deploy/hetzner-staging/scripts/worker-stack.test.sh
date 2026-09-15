#!/usr/bin/env bash
# Unit-style tests for worker-stack.sh's `check` and `health` guards.
#
#   bash deploy/hetzner-staging/scripts/worker-stack.test.sh
#
# It runs the real script against a throwaway env file, with `docker`, `ss`,
# `getent` and `curl` replaced by stubs on PATH, so nothing here talks to a
# daemon, a socket or a network.
#
# What this proves is the set of mistakes that are expensive precisely because
# they do not look like mistakes — the container is up, the health probe is
# green, and the deployment is wrong anyway:
#
#   * a `0.0.0.0` bind. This container runs with `network_mode: host`, so
#     there is no Docker publish rule to fall back on: the bind address IS the
#     firewall. A wrong one serves `POST /jobs/full-site` and the
#     unauthenticated artifact route to the internet, and looks perfectly
#     healthy doing it.
#   * a worktrees root that exists in the container but not on the host. The
#     Docker daemon resolves the validation container's bind source on the
#     HOST, so this produces a build that fails on a missing package.json for
#     a site whose files are plainly there — the single hardest failure in
#     this deployment to read backwards.
#   * a missing validation image, where the honest message is which
#     `docker build` to run, not "container exited".
#
# Pure bash, no arrays, and portable between the Linux host and macOS bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SCRIPT="${HERE}/worker-stack.sh"

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

mkdir -p "$ROOT/bin" "$ROOT/state/worktrees"

# `docker` answers from STUB_* variables the cases below set, so each test
# describes one host's configuration rather than one command's output.
cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
case "$1" in
  image)
    # docker image inspect <ref>
    [ "${STUB_IMAGE_PRESENT:-1}" = "1" ] && exit 0
    exit 1
    ;;
  inspect)
    # docker inspect -f '{{.State.Health.Status}}' <container>
    echo "${STUB_HEALTH:-healthy}"
    exit 0
    ;;
  exec)
    shift 2 # drop `exec` and the container name
    case "$1" in
      sh)
        script="$3"
        case "$script" in
          *FLOWSTARTER_BUILD_WORKER_HOST*) printf '%s' "${STUB_HOST:-127.0.0.1}" ;;
          *FLOWSTARTER_BUILD_WORKER_PORT*) printf '%s' "${STUB_PORT:-8787}" ;;
          *FLOWSTARTER_BUILD_WORKER_SECRET*) printf '%s' "${STUB_SECRET_LEN:-64}" ;;
          *FLOWSTARTER_BUILD_ISOLATION*) printf '%s' "${STUB_ISOLATION:-docker}" ;;
          *) printf '' ;;
        esac
        exit 0
        ;;
      test)
        # `test -d <worktrees root>` inside the container
        [ "${STUB_CONTAINER_HAS_WORKTREES:-1}" = "1" ] && exit 0
        exit 1
        ;;
      docker)
        # the worker reaching the host daemon through the mounted socket
        [ "${STUB_DAEMON_REACHABLE:-1}" = "1" ] && { echo "27.5.1"; exit 0; }
        exit 1
        ;;
    esac
    exit 0
    ;;
esac
exit 0
STUB

# `ss -ltn sport = :8787` — header line plus one socket, as the real one prints.
cat >"$ROOT/bin/ss" <<'STUB'
#!/usr/bin/env bash
echo "State  Recv-Q Send-Q Local Address:Port  Peer Address:Port"
echo "LISTEN 0      512    ${STUB_BOUND:-127.0.0.1:8787}      0.0.0.0:*"
exit 0
STUB

cat >"$ROOT/bin/getent" <<'STUB'
#!/usr/bin/env bash
echo "docker:x:987:deploy"
exit 0
STUB

# `curl -fsS .../health` and the unsigned-dispatch probe.
cat >"$ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
for arg in "$@"; do
  case "$arg" in
    *"/jobs/full-site") printf '%s' "${STUB_DISPATCH_STATUS:-401}"; exit 0 ;;
    *"/health")
      [ "${STUB_HEALTH_OK:-1}" = "1" ] || exit 22
      printf '%s' '{"ok":true,"version":"0.1.0","active":0,"waiting":0}'
      exit 0
      ;;
  esac
done
exit 0
STUB

chmod +x "$ROOT/bin/"*
export PATH="$ROOT/bin:$PATH"

ENV_FILE="$ROOT/build-worker-staging.env"

write_env() {
  cat >"$ENV_FILE" <<EOF
FLOWSTARTER_ENV=staging
FLOWSTARTER_BUILD_WORKER_PORT=${1:-8787}
FLOWSTARTER_BUILD_WORKER_HOST=127.0.0.1
FLOWSTARTER_WORKTREES_ROOT=${2:-$ROOT/state/worktrees}
EOF
  chmod 600 "$ENV_FILE"
}

run_check() {
  BUILD_WORKER_ENV_FILE="$ENV_FILE" \
  BUILD_WORKER_STATE_ROOT="$ROOT/state" \
    bash "$SCRIPT" check 2>&1
}

run_health() {
  BUILD_WORKER_ENV_FILE="$ENV_FILE" \
    bash "$SCRIPT" health 2>&1
}

# ── check: the happy host ────────────────────────────────────────────────
echo "check, on a correctly configured host"
write_env
out="$(run_check)"
status=$?
assert_status "$status" 0 "passes"
assert_contains "$out" "bind 127.0.0.1:8787" "names the loopback bind"
assert_contains "$out" "docker isolation" "confirms generated builds are isolated"
assert_contains "$out" "resolves identically on host and in container" \
  "confirms the worktrees path is the same on both sides"
assert_contains "$out" "reach the host daemon" "confirms the socket works"

# ── check: a 0.0.0.0 bind ────────────────────────────────────────────────
echo "check, with the worker told to bind every interface"
write_env
out="$(STUB_HOST=0.0.0.0 run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "REFUSING" "refuses loudly"
assert_contains "$out" "host networking" "says why a published-port rule will not save it"
assert_contains "$out" "worker-stack.sh recreate" "says how to apply the fix"

# ── check: a listener that ended up on 0.0.0.0 anyway ────────────────────
echo "check, with the socket actually bound past loopback"
write_env
out="$(STUB_BOUND=0.0.0.0:8787 run_check)"
status=$?
assert_status "$status" 1 "refuses on the observed bind, not only the configured one"
assert_contains "$out" "0.0.0.0:8787" "names what it saw"

# ── check: the shared secret ─────────────────────────────────────────────
echo "check, with a shared secret too short to be usable"
write_env
out="$(STUB_SECRET_LEN=12 run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "FLOWSTARTER_BUILD_WORKER_SECRET" "names the variable"
assert_not_contains "$out" "characters)" "never echoes a length as if the value were fine"

# ── check: isolation ─────────────────────────────────────────────────────
echo "check, with a worker configured to build generated code natively"
write_env
out="$(STUB_ISOLATION=native run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "would run as this worker's user" \
  "says what native isolation actually costs"

# ── check: the validation image ──────────────────────────────────────────
echo "check, with no validation image on the host"
write_env
out="$(STUB_IMAGE_PRESENT=0 run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "worker-stack.sh image" "names the command that fixes it"

# ── check: the sibling-container path trap ───────────────────────────────
echo "check, with a worktrees root that does not exist on the host"
write_env 8787 "$ROOT/state/missing-on-host"
out="$(run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "ON THE HOST" "says where the daemon resolves the bind source"
assert_contains "$out" "empty /site" "says what the build would have seen"

echo "check, with a worktrees root missing from the container's side"
write_env
out="$(STUB_CONTAINER_HAS_WORKTREES=0 run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "not at an identical path" "names the mismatch"

# ── check: the env file's own permissions ────────────────────────────────
echo "check, with a world-readable env file"
write_env
chmod 644 "$ENV_FILE"
out="$(run_check)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "must be mode 600" "names the permission it wants"
chmod 600 "$ENV_FILE"

# ── health ───────────────────────────────────────────────────────────────
echo "health, on a live worker"
write_env
out="$(run_health)"
status=$?
assert_status "$status" 0 "passes"
assert_contains "$out" '"ok":true' "reports what the worker said"
assert_contains "$out" "refuses an unsigned POST (401)" "asserts the auth rule"

echo "health, with dispatch answering an unsigned POST"
write_env
out="$(STUB_DISPATCH_STATUS=202 run_health)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "must be 401" "says what it required"

echo "health, with nothing listening"
write_env
out="$(STUB_HEALTH_OK=0 run_health)"
status=$?
assert_status "$status" 1 "refuses"
assert_contains "$out" "did not answer" "says the worker is not there"

echo
echo "worker-stack.test.sh: ${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ] || exit 1
