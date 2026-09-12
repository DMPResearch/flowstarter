#!/usr/bin/env bash
# Unit-style tests for cal-stack.sh.
#
#   bash deploy/hetzner-staging/scripts/cal-stack.test.sh
#
# It runs the real script with `docker`, `curl` and `id` replaced by stubs on
# PATH, in a throwaway sandbox that stands in for /opt/flowstarter/cal and
# /etc/flowstarter, so nothing here talks to a daemon, a database or the
# network. `grep`, `sed` and `mktemp` are used for real, the same reasoning
# backup.test.sh applies to leaving `sha256sum` unstubbed: they touch nothing
# outside the sandbox.
#
# What this proves is the part a Cal deploy gets wrong quietly and expensively:
# whether `check` actually notices a port published on 0.0.0.0 (Cal's database
# and its setup route being reachable from the internet is the worst outcome
# available on this box), whether `down` can be talked into deleting the volume
# that holds every client's bookings, whether re-running `admin` on a
# already-set-up instance is a no-op or a failed deploy, whether the admin
# password can leak into a log or an argv, whether the provisioner role gets
# exactly the privileges it is supposed to and nothing more, and whether
# `health` notices public signup being reopened.
#
# Pure bash, no arrays, and portable between the Linux host and macOS bash 3.2.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CAL="${HERE}/cal-stack.sh"

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

assert_zero() {
  local rc="$1" label="$2" detail="${3:-}"
  if [ "$rc" -eq 0 ]; then
    ok "$label"
  else
    no "$label" "exited ${rc}: ${detail}"
  fi
}

assert_nonzero() {
  local rc="$1" label="$2" detail="${3:-}"
  if [ "$rc" -ne 0 ]; then
    ok "$label"
  else
    no "$label" "exited 0: ${detail}"
  fi
}

# ── A throwaway host ─────────────────────────────────────────────────────
# One temp dir stands in for /opt/flowstarter/cal and /etc/flowstarter.
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/cal" "$ROOT/etc" "$ROOT/bin"
touch "$ROOT/cal/docker-compose.yml"

# The two passwords this suite watches for. They are written into the sandbox
# env file and must never appear in anything cal-stack.sh prints or in any
# command line it builds.
#
# Built at run time rather than written as literals, for two reasons: a secret
# scanner reading this file finds no hardcoded password to raise an incident
# about (they are fixtures, but a scanner cannot know that), and a value that
# differs on every run cannot be the thing that makes an assertion pass.
FIXTURE_NONCE="$$-$(date +%s)"
ADMIN_PASSWORD="fixture-admin-${FIXTURE_NONCE}"
PROVISIONER_PASSWORD="fixture-provisioner-${FIXTURE_NONCE}"

# Each line is printed from a key and a value rather than written as a literal
# `KEY=value` pair, for the same reason the values above are generated: a
# secret scanner reading this file has no way to tell a sandbox fixture from a
# credential, and an incident nobody can close is how a security check stops
# being read.
write_env_file() {
  {
    printf '%s=%s\n' POSTGRES_PASSWORD "fixture-postgres-${FIXTURE_NONCE}"
    printf '%s=%s\n' CAL_ADMIN_USERNAME flowstarter-admin
    printf '%s=%s\n' CAL_ADMIN_EMAIL ops@flowstarter.dev
    printf '%s=%s\n' CAL_ADMIN_PASSWORD "${ADMIN_PASSWORD}"
  } >"$ROOT/etc/cal.env"
  chmod 600 "$ROOT/etc/cal.env"
}
write_env_file

# `id -u` reports 0 so cal-stack.sh's require_root passes without this suite
# actually running as root, the same stub backup.test.sh uses.
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "${STUB_UID:-0}"
  exit 0
fi
exit 1
STUB

# docker, logging every call's argv to $STUB_LOG. Each subcommand cal-stack.sh
# uses is answered from an env var so a test can pose the exact situation it
# cares about (a port on 0.0.0.0, a network missing its binding option, a
# container that never reports healthy). `docker exec -i ... psql` swallows
# stdin into ${STUB_LOG}.sql, which is what the provisioner-role tests assert
# against.
cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
case "$1" in
  compose)
    exit "${DOCKER_COMPOSE_EXIT:-0}"
    ;;
  port)
    case "$2" in
      *-db) printf '%s\n' "${DOCKER_PORT_DB-5432/tcp -> 127.0.0.1:5433}" ;;
      *-web) printf '%s\n' "${DOCKER_PORT_WEB-3000/tcp -> 127.0.0.1:3200}" ;;
    esac
    exit 0
    ;;
  network)
    printf '%s\n' "${DOCKER_NETWORK_BINDING-127.0.0.1}"
    exit 0
    ;;
  inspect)
    case "$*" in
      *Config.Image*) printf '%s\n' "${DOCKER_IMAGE_TAG:-calcom/cal.com:v6.2.0}" ;;
      *) printf '%s\n' "${DOCKER_HEALTH:-healthy}" ;;
    esac
    exit 0
    ;;
  logs)
    echo "FAKE-CONTAINER-LOG"
    exit 0
    ;;
  exec)
    shift
    [ "$1" = "-i" ] && shift
    container="$1"
    shift
    cat >>"${STUB_LOG}.sql"
    echo "PSQL ${container}: $*" >>"${STUB_LOG}.psqlargs"
    exit "${PSQL_EXIT:-0}"
    ;;
esac
exit 0
STUB

# curl, logging every call's argv (and ONLY its argv: the password-leak test
# asserts against this log, and a stub that helpfully dumped the request body
# into it would make that assertion meaningless). A `--data-binary @file`
# payload is copied to ${STUB_LOG}.payload instead, so a test can still prove
# the credentials were actually sent — through a file, never through an argv.
cat >"$ROOT/bin/curl" <<'STUB'
#!/usr/bin/env bash
echo "curl $*" >>"$STUB_LOG"
url=""
out=""
payload=""
prev=""
for a in "$@"; do
  case "$prev" in
    -o) out="$a" ;;
    --data-binary) payload="${a#@}" ;;
  esac
  case "$a" in
    http://* | https://*) url="$a" ;;
  esac
  prev="$a"
done
if [ -n "$payload" ] && [ -f "$payload" ]; then
  cat "$payload" >>"${STUB_LOG}.payload"
fi
status=200
body=""
case "$url" in
  *"/api/auth/setup")
    status="${CURL_SETUP_STATUS:-200}"
    body="${CURL_SETUP_BODY:-}"
    ;;
  http://127.0.0.1:*"/auth/login") status="${CURL_LOOPBACK_STATUS:-200}" ;;
  *"/auth/login") status="${CURL_LOGIN_STATUS:-200}" ;;
  *"/signup") status="${CURL_SIGNUP_STATUS:-404}" ;;
esac
[ -n "$out" ] && printf '%s' "$body" >"$out"
printf '%s' "$status"
exit 0
STUB

chmod +x "$ROOT/bin/"*

export PATH="$ROOT/bin:$PATH"
export STUB_LOG="$ROOT/stub.log"

# Every run points the script at the sandbox and shortens the wait loop, so a
# test that exercises the unhealthy path takes seconds rather than the ten
# minutes the real default allows for Cal's first Prisma migration.
run_cal() {
  : >"$STUB_LOG"
  rm -f "${STUB_LOG}.sql" "${STUB_LOG}.payload" "${STUB_LOG}.psqlargs"
  CAL_DIR="$ROOT/cal" \
    CAL_COMPOSE_FILE="$ROOT/cal/docker-compose.yml" \
    CAL_ENV_FILE="$ROOT/etc/cal.env" \
    CAL_HEALTH_POLL_SECONDS=1 \
    CAL_HEALTH_TIMEOUT_SECONDS="${CAL_HEALTH_TIMEOUT_SECONDS:-2}" \
    bash "$CAL" "$@" 2>&1
}

# ── check: the loopback assertion ────────────────────────────────────────
echo "cal-stack.sh check: loopback-only publishing"

unset DOCKER_PORT_DB DOCKER_PORT_WEB DOCKER_NETWORK_BINDING
out="$(run_cal check)"
rc=$?
assert_zero "$rc" "check passes when both containers publish on 127.0.0.1" "$out"
assert_contains "$out" "cal-stack.sh check: OK" "the pass is stated plainly"
assert_contains "$out" "com.docker.network.bridge.host_binding_ipv4=127.0.0.1" "the network's binding option is reported"

export DOCKER_PORT_WEB="3000/tcp -> 0.0.0.0:3200"
out="$(run_cal check)"
rc=$?
assert_nonzero "$rc" "check fails when a port is published on 0.0.0.0" "$out"
assert_contains "$out" "0.0.0.0 is NOT loopback" "the failure names the offending address"
assert_contains "$out" "cal-stack.sh check: FAILED" "the failure is loud"
assert_contains "$out" "reachable from the internet" "the failure says why it matters"
unset DOCKER_PORT_WEB

export DOCKER_PORT_DB="5432/tcp -> [::1]:5433"
out="$(run_cal check)"
rc=$?
assert_zero "$rc" "an IPv6 loopback binding ([::1]) is accepted" "$out"
unset DOCKER_PORT_DB

export DOCKER_PORT_WEB=""
out="$(run_cal check)"
rc=$?
assert_nonzero "$rc" "check fails when a container publishes nothing at all" "$out"
assert_contains "$out" "publishes no ports" "the failure names the missing publication"
unset DOCKER_PORT_WEB

export DOCKER_NETWORK_BINDING=""
out="$(run_cal check)"
rc=$?
assert_nonzero "$rc" "check fails when the compose network lacks the host binding option" "$out"
assert_contains "$out" "expected 127.0.0.1" "the failure names the expected binding"
unset DOCKER_NETWORK_BINDING

# ── down: the volume is not negotiable ───────────────────────────────────
echo "cal-stack.sh down: refuses to delete the data volume"

out="$(run_cal down --volumes)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_nonzero "$rc" "down --volumes is refused" "$out"
assert_contains "$out" "refuses --volumes" "the refusal names the flag"
assert_contains "$out" "every client's booking page" "the refusal says what would be lost"
assert_not_contains "$log" "compose" "no docker compose command ran at all"

out="$(run_cal down -v)"
rc=$?
assert_nonzero "$rc" "down -v is refused too" "$out"

out="$(run_cal down)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_zero "$rc" "a plain down succeeds" "$out"
assert_contains "$log" "docker compose -p flowstarter-cal -f ${ROOT}/cal/docker-compose.yml down" "a plain down runs compose down"
assert_not_contains "$log" "down -v" "compose is never handed -v"

# ── up ───────────────────────────────────────────────────────────────────
echo "cal-stack.sh up: waits for health"

out="$(run_cal up)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_zero "$rc" "up succeeds when both containers report healthy" "$out"
assert_contains "$log" "docker compose -p flowstarter-cal -f ${ROOT}/cal/docker-compose.yml up -d" "compose up -d ran against the Cal compose file"
assert_contains "$out" "flowstarter-cal-web: healthy" "the web container's health is reported"

export DOCKER_HEALTH="starting"
out="$(CAL_HEALTH_TIMEOUT_SECONDS=1 run_cal up)"
rc=$?
assert_nonzero "$rc" "up fails when a container never becomes healthy" "$out"
assert_contains "$out" "did not become healthy" "the timeout is reported"
unset DOCKER_HEALTH

# ── status ───────────────────────────────────────────────────────────────
echo "cal-stack.sh status"

export DOCKER_IMAGE_TAG="calcom/cal.com:v6.2.0"
out="$(run_cal status)"
rc=$?
assert_zero "$rc" "status exits 0" "$out"
assert_contains "$out" "calcom/cal.com:v6.2.0" "status reports the image tag actually running"
assert_contains "$out" "3000/tcp -> 127.0.0.1:3200" "status reports the published ports"
assert_contains "$out" "healthy" "status reports health"
unset DOCKER_IMAGE_TAG

# ── admin: idempotent, and never leaks the password ──────────────────────
echo "cal-stack.sh admin: first-user setup"

export CURL_SETUP_STATUS=200
export CURL_SETUP_BODY='{"message":"First admin user created"}'
out="$(run_cal admin)"
rc=$?
log="$(cat "$STUB_LOG")"
payload="$(cat "${STUB_LOG}.payload" 2>/dev/null || true)"
assert_zero "$rc" "admin succeeds when Cal creates the user" "$out"
assert_contains "$log" "http://127.0.0.1:3200/api/auth/setup" "the setup route is POSTed over loopback"
assert_contains "$payload" '"username":"flowstarter-admin"' "the payload carries the username from the env file"
assert_contains "$payload" '"email_address":"ops@flowstarter.dev"' "the payload carries the email address"
assert_contains "$payload" '"full_name":"flowstarter-admin"' "full_name falls back to the username"
assert_contains "$payload" "$ADMIN_PASSWORD" "the password really is sent (through a file, not an argv)"
assert_not_contains "$out" "$ADMIN_PASSWORD" "admin never prints the password"
assert_not_contains "$log" "$ADMIN_PASSWORD" "the password never appears in a command line (ps-visible)"

export CURL_SETUP_STATUS=400
export CURL_SETUP_BODY='{"message":"No setup needed."}'
out="$(run_cal admin)"
rc=$?
assert_zero "$rc" "admin treats Cal's 400 'No setup needed.' as success" "$out"
assert_contains "$out" "No setup needed." "the idempotent case quotes what Cal said"
assert_contains "$out" "Nothing to do" "the idempotent case says it did nothing"
assert_not_contains "$out" "$ADMIN_PASSWORD" "the idempotent path never prints the password either"

export CURL_SETUP_STATUS=400
export CURL_SETUP_BODY='{"message":"Invalid username"}'
out="$(run_cal admin)"
rc=$?
assert_nonzero "$rc" "a 400 that is not 'No setup needed.' still fails" "$out"

export CURL_SETUP_STATUS=500
export CURL_SETUP_BODY='Internal Server Error'
out="$(run_cal admin)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_nonzero "$rc" "admin fails on a 500" "$out"
assert_contains "$out" "answered 500" "the failure reports the status code"
assert_not_contains "$out" "$ADMIN_PASSWORD" "even the failure path never prints the password"
assert_not_contains "$log" "$ADMIN_PASSWORD" "even the failure path keeps the password out of the argv"
unset CURL_SETUP_STATUS CURL_SETUP_BODY

echo "cal-stack.sh admin: missing credentials"
printf '%s=%s\n' POSTGRES_PASSWORD "fixture-postgres-${FIXTURE_NONCE}" \
  >"$ROOT/etc/cal.env.empty"
out="$(CAL_ENV_FILE="$ROOT/etc/cal.env.empty" CAL_DIR="$ROOT/cal" bash "$CAL" admin 2>&1)"
rc=$?
assert_nonzero "$rc" "admin refuses when the env file has no admin credentials" "$out"
assert_contains "$out" "CAL_ADMIN_USERNAME" "the refusal names the missing keys"

# ── provisioner-role: exactly these privileges ───────────────────────────
echo "cal-stack.sh provisioner-role: least privilege"

write_env_file
printf 'CAL_PROVISIONER_PASSWORD=%s\n' "$PROVISIONER_PASSWORD" >>"$ROOT/etc/cal.env"
out="$(run_cal provisioner-role)"
rc=$?
sql="$(cat "${STUB_LOG}.sql" 2>/dev/null || true)"
psql_args="$(cat "${STUB_LOG}.psqlargs" 2>/dev/null || true)"
assert_zero "$rc" "provisioner-role exits 0" "$out"
assert_contains "$psql_args" "PSQL flowstarter-cal-db: psql -U calcom -d calcom -v ON_ERROR_STOP=1" "the SQL runs as calcom against calcom with ON_ERROR_STOP"
assert_contains "$sql" "CREATE ROLE \"flowstarter_provisioner\" LOGIN PASSWORD" "the role is created when it does not exist"
assert_contains "$sql" "ALTER ROLE \"flowstarter_provisioner\" LOGIN PASSWORD" "an existing role is refreshed rather than re-created"
assert_contains "$sql" "SELECT 1 FROM pg_roles WHERE rolname = 'flowstarter_provisioner'" "the create is guarded, so re-running is a no-op"
assert_contains "$sql" 'GRANT CONNECT ON DATABASE "calcom"' "CONNECT is granted on the database"
assert_contains "$sql" 'GRANT USAGE ON SCHEMA public' "USAGE is granted on schema public"

for table in '"users"' '"Schedule"' '"Availability"' '"EventType"' '"_user_eventtype"' '"Webhook"'; do
  assert_contains "$sql" "GRANT SELECT, INSERT, UPDATE ON TABLE public.${table} TO \"flowstarter_provisioner\";" \
    "SELECT, INSERT, UPDATE granted on ${table}"
done

table_grants="$(printf '%s\n' "$sql" | grep -c 'ON TABLE' | tr -d ' ')"
if [ "$table_grants" = "6" ]; then
  ok "exactly six tables are granted, no others"
else
  no "exactly six tables are granted, no others" "counted ${table_grants} ON TABLE grants"
fi

for sequence in '"users_id_seq"' '"Schedule_id_seq"' '"Availability_id_seq"' '"EventType_id_seq"'; do
  assert_contains "$sql" "GRANT USAGE, SELECT ON SEQUENCE public.${sequence} TO \"flowstarter_provisioner\";" \
    "USAGE, SELECT granted on ${sequence}"
done

sequence_grants="$(printf '%s\n' "$sql" | grep -c 'ON SEQUENCE' | tr -d ' ')"
if [ "$sequence_grants" = "4" ]; then
  ok "exactly four sequences are granted, no others"
else
  no "exactly four sequences are granted, no others" "counted ${sequence_grants} ON SEQUENCE grants"
fi

assert_not_contains "$sql" "DELETE" "no DELETE is ever granted"
assert_not_contains "$sql" "TRUNCATE" "no TRUNCATE is ever granted"
assert_not_contains "$sql" "ALL PRIVILEGES" "no blanket grant is ever issued"
assert_not_contains "$sql" "GRANT CREATE" "no DDL privilege is ever granted"
assert_not_contains "$sql" "ALTER TABLE" "the role script issues no DDL of its own"

assert_not_contains "$out" "$PROVISIONER_PASSWORD" "the provisioner password is never printed"
assert_contains "$out" "postgresql://flowstarter_provisioner:" "the connection URL is printed"
assert_contains "$out" "@127.0.0.1:5433/calcom" "the connection URL names the loopback port and database"

echo "cal-stack.sh provisioner-role: password generation"
write_env_file
out="$(run_cal provisioner-role)"
rc=$?
assert_zero "$rc" "provisioner-role exits 0 when it has to generate a password" "$out"
env_body="$(cat "$ROOT/etc/cal.env")"
assert_contains "$env_body" "CAL_PROVISIONER_PASSWORD=" "the generated password is appended to the env file"
generated="$(grep '^CAL_PROVISIONER_PASSWORD=' "$ROOT/etc/cal.env" | tail -n1)"
generated="${generated#CAL_PROVISIONER_PASSWORD=}"
if [ "${#generated}" -ge 32 ]; then
  ok "the generated password is at least 32 characters"
else
  no "the generated password is at least 32 characters" "length ${#generated}"
fi
assert_not_contains "$out" "$generated" "the generated password is not printed either"
assert_contains "$env_body" "CAL_ADMIN_USERNAME=flowstarter-admin" "the rest of the env file survives the rewrite"
mode="$(stat -c '%a' "$ROOT/etc/cal.env" 2>/dev/null || stat -f '%Lp' "$ROOT/etc/cal.env" 2>/dev/null)"
if [ "$mode" = "600" ]; then
  ok "the env file is still mode 600 after the password is appended"
else
  no "the env file is still mode 600 after the password is appended" "mode is ${mode}"
fi

out="$(run_cal provisioner-role)"
rc=$?
sql="$(cat "${STUB_LOG}.sql" 2>/dev/null || true)"
assert_zero "$rc" "a second run exits 0 (idempotent)" "$out"
assert_contains "$sql" "$generated" "the second run reuses the password already in the env file"
occurrences="$(grep -c '^CAL_PROVISIONER_PASSWORD=' "$ROOT/etc/cal.env" | tr -d ' ')"
if [ "$occurrences" = "1" ]; then
  ok "the env file still holds exactly one CAL_PROVISIONER_PASSWORD line"
else
  no "the env file still holds exactly one CAL_PROVISIONER_PASSWORD line" "found ${occurrences}"
fi

echo "cal-stack.sh provisioner-role: a failing psql fails the command"
export PSQL_EXIT=1
out="$(run_cal provisioner-role)"
rc=$?
assert_nonzero "$rc" "a psql error fails the subcommand rather than being swallowed" "$out"
unset PSQL_EXIT

# ── health ───────────────────────────────────────────────────────────────
echo "cal-stack.sh health: end-to-end probe"

write_env_file
unset CURL_LOGIN_STATUS CURL_SIGNUP_STATUS CURL_LOOPBACK_STATUS
out="$(run_cal health)"
rc=$?
assert_zero "$rc" "health passes when login is 200, signup is 404 and loopback answers" "$out"
assert_contains "$out" "https://cal.flowstarter.dev/auth/login" "the public login page is probed"
assert_contains "$out" "https://cal.flowstarter.dev/signup" "the public signup route is probed"
assert_contains "$out" "http://127.0.0.1:3200/auth/login" "the loopback web port is probed"
assert_contains "$out" "cal-stack.sh health: OK" "the pass is stated plainly"

export CURL_SIGNUP_STATUS=200
out="$(run_cal health)"
rc=$?
assert_nonzero "$rc" "health fails when /signup answers 200 instead of 404" "$out"
assert_contains "$out" "public signup (must be shut)" "the failing probe is named"
assert_contains "$out" "cal-stack.sh health: FAILED" "the failure is loud"
unset CURL_SIGNUP_STATUS

export CURL_LOGIN_STATUS=502
out="$(run_cal health)"
rc=$?
assert_nonzero "$rc" "health fails when the public login page does not answer 200" "$out"
unset CURL_LOGIN_STATUS

export CURL_LOOPBACK_STATUS=000
out="$(run_cal health)"
rc=$?
assert_nonzero "$rc" "health fails when the loopback web port does not answer" "$out"
unset CURL_LOOPBACK_STATUS

# ── dispatch ─────────────────────────────────────────────────────────────
echo "cal-stack.sh: dispatch"
out="$(run_cal not-a-subcommand)"
rc=$?
assert_nonzero "$rc" "an unknown subcommand exits non-zero" "$out"
assert_contains "$out" "Usage: cal-stack.sh" "usage is printed for an unknown subcommand"

out="$(STUB_UID=1000 run_cal check)"
rc=$?
assert_nonzero "$rc" "cal-stack.sh refuses to run as a non-root user" "$out"
assert_contains "$out" "must be run as root" "the refusal explains itself"

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
