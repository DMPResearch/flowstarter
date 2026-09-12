#!/usr/bin/env bash
# Manage the self-hosted Cal.com compose project on the Hetzner host.
#
# This is the ONLY thing that should run `docker compose` against
# ../cal/docker-compose.yml. Two containers, one project (`flowstarter-cal`):
# `flowstarter-cal-db` (Postgres 16, Cal's own schema) and
# `flowstarter-cal-web` (the official image, serving cal.flowstarter.dev
# through Caddy). The compose file's header explains why Cal keeps its own
# database and why there is no Cal API container.
#
# Usage:
#   cal-stack.sh up                # compose up -d, wait for both containers healthy
#   cal-stack.sh down              # compose down (never -v; the volume is client data)
#   cal-stack.sh status            # names, health, published ports, running image tag
#   cal-stack.sh check             # assert loopback-only publishing
#   cal-stack.sh admin             # create the first Cal admin user, idempotently
#   cal-stack.sh provisioner-role  # create/refresh the least-privilege Postgres role
#   cal-stack.sh health            # end-to-end probe through Caddy and over loopback
#   cal-stack.sh install-caddy     # install the vhost snippet and reload Caddy
#
# Run as root: every subcommand either talks to the Docker socket or reads
# /etc/flowstarter/cal.env, and both are root-only on this box.
#
# WHY `check` matters more here than anywhere else: /etc/docker/daemon.json's
# `{"ip":"127.0.0.1"}` only constrains the DEFAULT bridge. A compose-created
# network ignores it, so a compose file that forgot either the explicit
# `127.0.0.1:` prefix on a port or the network's
# `com.docker.network.bridge.host_binding_ipv4` driver option would publish
# Cal's database and its unauthenticated setup route straight onto the
# internet, past `ufw`. `check` asserts both, the same way supabase-stack.sh's
# `check` asserts the CLI stack's binding, and nobody should call this stack
# healthy until it passes.
#
# Nothing in this file ever prints a secret. The admin password is sent to Cal
# through a mode-600 temp FILE rather than a command-line argument (an argv is
# visible to every process on the box through `ps`), and the provisioner
# password is only ever written into the env file and interpolated into SQL
# that goes to psql's stdin.
#
# Env overrides (documented defaults; there are deliberately no bare numbers or
# paths in the logic below, the same rule backup.sh and deploy-slot.sh follow):
#   CAL_DIR                   install directory on the host, default /opt/flowstarter/cal
#   CAL_COMPOSE_FILE          default $CAL_DIR/docker-compose.yml
#   CAL_COMPOSE_PROJECT       compose project name, default flowstarter-cal
#   CAL_NETWORK               compose network name, default flowstarter-cal
#   CAL_ENV_FILE              default /etc/flowstarter/cal.env (mode 600, operator-owned)
#   CAL_DB_CONTAINER          default flowstarter-cal-db
#   CAL_WEB_CONTAINER         default flowstarter-cal-web
#   CAL_WEB_HOST_PORT         loopback port the web app is published on, default 3200
#   CAL_DB_HOST_PORT          loopback port Postgres is published on, default 5433
#   CAL_POSTGRES_USER         Cal's database owner, default calcom
#   CAL_POSTGRES_DB           Cal's database, default calcom
#   CAL_PUBLIC_URL            public origin behind Caddy, default https://cal.flowstarter.dev
#   CAL_LOOPBACK_ADDRESS      the only address ports may be published on, default 127.0.0.1
#   CAL_HEALTH_TIMEOUT_SECONDS  bound on `up`'s wait for health, default 600 (Cal runs
#                               `prisma migrate deploy` and seeds its app store before it
#                               listens; on a cold database that is minutes, not seconds)
#   CAL_HEALTH_POLL_SECONDS   seconds between health polls during `up`, default 5
#   CAL_PROBE_TIMEOUT_SECONDS per-request curl timeout `health` uses, default 10
#   CAL_PROVISIONER_ROLE      least-privilege role name, default flowstarter_provisioner
#   CAL_CADDY_SOURCE          vhost snippet to install, default $CAL_DIR/cal.caddy
#   CAL_CADDY_SNIPPET         where it is installed, default /etc/caddy/platform/cal.caddy
#
# Keys read out of $CAL_ENV_FILE (never printed, never written by CI):
#   CAL_ADMIN_USERNAME, CAL_ADMIN_EMAIL, CAL_ADMIN_PASSWORD, CAL_ADMIN_FULL_NAME
#   (optional, defaults to the username), CAL_PROVISIONER_PASSWORD (generated
#   and appended by `provisioner-role` when absent).

set -euo pipefail

# ── Env overrides ────────────────────────────────────────────────────────
CAL_DIR="${CAL_DIR:-/opt/flowstarter/cal}"
CAL_COMPOSE_FILE="${CAL_COMPOSE_FILE:-${CAL_DIR}/docker-compose.yml}"
CAL_COMPOSE_PROJECT="${CAL_COMPOSE_PROJECT:-flowstarter-cal}"
CAL_NETWORK="${CAL_NETWORK:-flowstarter-cal}"
CAL_ENV_FILE="${CAL_ENV_FILE:-/etc/flowstarter/cal.env}"
CAL_DB_CONTAINER="${CAL_DB_CONTAINER:-flowstarter-cal-db}"
CAL_WEB_CONTAINER="${CAL_WEB_CONTAINER:-flowstarter-cal-web}"
CAL_WEB_HOST_PORT="${CAL_WEB_HOST_PORT:-3200}"
CAL_DB_HOST_PORT="${CAL_DB_HOST_PORT:-5433}"
CAL_POSTGRES_USER="${CAL_POSTGRES_USER:-calcom}"
CAL_POSTGRES_DB="${CAL_POSTGRES_DB:-calcom}"
CAL_PUBLIC_URL="${CAL_PUBLIC_URL:-https://cal.flowstarter.dev}"
CAL_LOOPBACK_ADDRESS="${CAL_LOOPBACK_ADDRESS:-127.0.0.1}"
CAL_PROVISIONER_ROLE="${CAL_PROVISIONER_ROLE:-flowstarter_provisioner}"
CAL_CADDY_SOURCE="${CAL_CADDY_SOURCE:-${CAL_DIR}/cal.caddy}"
CAL_CADDY_SNIPPET="${CAL_CADDY_SNIPPET:-/etc/caddy/platform/cal.caddy}"

# Named defaults for the timing knobs rather than literals buried in the wait
# loop, the same pattern backup.sh uses for its retention counts: a magic
# number inside the loop is much easier to get wrong than a named default an
# operator can read off the top of the file and override.
DEFAULT_HEALTH_TIMEOUT_SECONDS=600
DEFAULT_HEALTH_POLL_SECONDS=5
DEFAULT_PROBE_TIMEOUT_SECONDS=10

# The ::1 form is accepted alongside the configured loopback address because
# Docker publishes an IPv6 loopback binding as `[::1]:PORT` on a dual-stack
# box; that is still loopback, and refusing it would fail `check` on a host
# doing exactly the right thing. Anything else, 0.0.0.0 above all, is a
# published port and a finding.
IPV6_LOOPBACK="::1"

# The compose network driver option that makes a port with no explicit address
# still land on loopback. Its absence is the trap described in the header.
NETWORK_BINDING_OPTION="com.docker.network.bridge.host_binding_ipv4"

# Cal's own setup route. It creates the FIRST user only, and answers 400 with
# "No setup needed." forever after, which is what makes `admin` idempotent.
CAL_SETUP_PATH="/api/auth/setup"
CAL_SETUP_DONE_MARKER="No setup needed."

# Paths `health` probes. /auth/login rather than /: the root path redirects
# when signed out and a 307 is not proof that the app rendered. /signup must be
# 404 because public signup is closed at the edge (cal.caddy) as well as in the
# app (NEXT_PUBLIC_DISABLE_SIGNUP) — a 200 there means a future image, a
# flipped env var or a route rename has quietly reopened public account
# creation on a host whose whole purpose is accounts we created ourselves.
CAL_LOGIN_PATH="/auth/login"
CAL_SIGNUP_PATH="/signup"
EXPECTED_LOGIN_STATUS=200
EXPECTED_SIGNUP_STATUS=404

# The provisioner's table and sequence grants, as newline-separated lists
# rather than bash arrays. Arrays are avoided throughout this deploy directory
# (backup.sh's encrypt_secrets_tarball explains why: an empty array expanded
# under `set -u` behaves differently across bash versions, and these scripts
# run on both the host's bash 5 and a developer's macOS bash 3.2).
#
# Identifiers are pre-quoted because Cal's Prisma schema uses PascalCase table
# names, which Postgres folds to lower case unless they are quoted. The list is
# exactly what the provisioner needs in order to create a client's booking
# page: the user, their schedule and its availability rows, their event types,
# the join table between the two, and the webhook that tells this product a
# booking happened. Nothing else, no DELETE anywhere, and no DDL — a bug in the
# provisioner must not be able to drop a client's bookings.
CAL_PROVISIONER_TABLES='"users"
"Schedule"
"Availability"
"EventType"
"_user_eventtype"
"Webhook"'

# Only the tables with an integer identity column have a sequence; the join
# table has none, and "Webhook" keys on a string id.
CAL_PROVISIONER_SEQUENCES='"users_id_seq"
"Schedule_id_seq"
"Availability_id_seq"
"EventType_id_seq"'

CAL_PROVISIONER_TABLE_PRIVILEGES="SELECT, INSERT, UPDATE"
CAL_PROVISIONER_SEQUENCE_PRIVILEGES="USAGE, SELECT"

usage() {
  cat >&2 <<'EOF'
Usage: cal-stack.sh <up|down|status|check|admin|provisioner-role|health|install-caddy>

  up                Start the flowstarter-cal compose project and wait, with a
                    bound, for both containers to report healthy.
  down              Stop it. Refuses -v/--volumes: the named volume holds every
                    client's booking page and their bookings.
  status            Container names, health, published ports, running image tag.
  check             Fail unless every published Cal port is bound to loopback
                    only and the compose network carries the loopback
                    host_binding_ipv4 driver option.
  admin             Create the first Cal admin user from /etc/flowstarter/cal.env.
                    Idempotent: Cal answers 400 "No setup needed." once any user
                    exists, which this treats as success.
  provisioner-role  Create or refresh the least-privilege Postgres role the
                    product's provisioner logs in as, and print its connection
                    URL without the password.
  health            Probe the public origin and the loopback port; non-zero on
                    any failure.
  install-caddy     Copy the vhost snippet into /etc/caddy/platform and reload.
EOF
}

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" -ne 0 ]]; then
    echo "cal-stack.sh must be run as root (current uid: ${uid})." >&2
    exit 1
  fi
}

require_compose_file() {
  if [[ ! -f "$CAL_COMPOSE_FILE" ]]; then
    echo "CAL_COMPOSE_FILE (${CAL_COMPOSE_FILE}) does not exist." >&2
    echo "Copy deploy/hetzner-staging/cal/docker-compose.yml to ${CAL_DIR}/ first; see deploy/hetzner-staging/README.md." >&2
    exit 1
  fi
}

require_env_file() {
  if [[ ! -f "$CAL_ENV_FILE" ]]; then
    echo "CAL_ENV_FILE (${CAL_ENV_FILE}) does not exist." >&2
    echo "Create it by hand, mode 600, root-owned: it holds Cal's database password, its NextAuth secret and the admin credentials, and nothing in CI writes it." >&2
    exit 1
  fi
}

# ── Small helpers ────────────────────────────────────────────────────────

# A tunable that must be a positive integer falls back to its documented
# default when it is anything else, rather than producing a wait loop that
# spins forever (poll 0) or a numeric comparison that aborts the script under
# `set -e` (a non-numeric timeout compared with -lt).
positive_int_or_default() {
  local raw="$1" fallback="$2"
  if [[ "$raw" =~ ^[0-9]+$ ]] && [[ "$raw" -gt 0 ]]; then
    printf '%s' "$raw"
  else
    printf '%s' "$fallback"
  fi
}

health_timeout_seconds() {
  positive_int_or_default "${CAL_HEALTH_TIMEOUT_SECONDS:-}" "$DEFAULT_HEALTH_TIMEOUT_SECONDS"
}

health_poll_seconds() {
  positive_int_or_default "${CAL_HEALTH_POLL_SECONDS:-}" "$DEFAULT_HEALTH_POLL_SECONDS"
}

probe_timeout_seconds() {
  positive_int_or_default "${CAL_PROBE_TIMEOUT_SECONDS:-}" "$DEFAULT_PROBE_TIMEOUT_SECONDS"
}

compose() {
  docker compose -p "$CAL_COMPOSE_PROJECT" -f "$CAL_COMPOSE_FILE" "$@"
}

# Reads one key out of the env file without sourcing it: sourcing would both
# pull a file full of secrets into this shell's environment (and therefore into
# every child process, including docker's) and execute whatever happens to be
# written in there. Last assignment wins, the way a shell sourcing the file
# would resolve a duplicated key.
env_value() {
  local key="$1" raw=""
  [[ -f "$CAL_ENV_FILE" ]] || return 0
  raw="$(grep -E "^${key}=" "$CAL_ENV_FILE" | tail -n1 || true)"
  [[ -z "$raw" ]] && return 0
  raw="${raw#*=}"
  # Tolerate a quoted value: docker's env_file does not strip quotes, but
  # operators write them anyway, and a password that reaches psql with its
  # quotes still attached fails in a way that is miserable to debug.
  raw="${raw%\"}"
  raw="${raw#\"}"
  raw="${raw%\'}"
  raw="${raw#\'}"
  printf '%s' "$raw"
}

container_health() {
  local container="$1"
  # `.State.Health.Status` does not exist for a container without a
  # healthcheck, and the inspect fails outright for one that does not exist;
  # both mean "not healthy yet" to every caller, which is why the template has
  # a fallback and the failure is swallowed.
  docker inspect --format '{{if .State.Health}}{{.State.Health.Status}}{{else}}{{.State.Status}}{{end}}' \
    "$container" 2>/dev/null || true
}

container_image() {
  local container="$1"
  # `.Config.Image` is the tag the container was actually started from, which
  # is the question `status` is answering. `.Image` would print a sha256 digest
  # that tells an operator nothing about which Cal release is running.
  docker inspect --format '{{.Config.Image}}' "$container" 2>/dev/null || true
}

container_ports() {
  local container="$1"
  docker port "$container" 2>/dev/null || true
}

# ── up / down / status ───────────────────────────────────────────────────

wait_for_healthy() {
  local container="$1" timeout poll waited=0 state=""
  timeout="$(health_timeout_seconds)"
  poll="$(health_poll_seconds)"

  while [[ "$waited" -lt "$timeout" ]]; do
    state="$(container_health "$container")"
    if [[ "$state" == "healthy" ]]; then
      echo "  ${container}: healthy after ${waited}s"
      return 0
    fi
    sleep "$poll"
    waited=$((waited + poll))
  done

  echo "  ${container}: still '${state:-unknown}' after ${timeout}s" >&2
  # The tail of the container's log is the only thing that tells an operator
  # whether this was a slow Prisma migration or a real failure, and it is gone
  # from their terminal the moment a deploy lane moves on.
  docker logs "$container" 2>&1 | tail -n 40 >&2 || true
  return 1
}

cmd_up() {
  require_compose_file
  require_env_file
  echo "Starting compose project ${CAL_COMPOSE_PROJECT} from ${CAL_COMPOSE_FILE} ..."
  compose up -d

  echo "Waiting up to $(health_timeout_seconds)s for both containers to report healthy ..."
  local failed=0
  wait_for_healthy "$CAL_DB_CONTAINER" || failed=1
  wait_for_healthy "$CAL_WEB_CONTAINER" || failed=1
  if [[ "$failed" -ne 0 ]]; then
    echo "cal-stack.sh up: FAILED (containers did not become healthy)" >&2
    exit 1
  fi
  echo "cal-stack.sh up: OK"
}

cmd_down() {
  # `docker compose down -v` deletes the named volume, and that volume is every
  # client's booking page, their event types and their booking history. It is
  # not reproducible from git and the only other copy is last night's backup.
  # There is deliberately no --force escape hatch: an operator who really means
  # it can run `docker volume rm` themselves and type the volume's name while
  # they do it.
  local arg
  for arg in "$@"; do
    case "$arg" in
      -v | --volumes)
        echo "cal-stack.sh down refuses ${arg}." >&2
        echo "The flowstarter-cal volume holds every client's booking page and their bookings; it is not reproducible from git." >&2
        echo "If you genuinely mean to destroy it, take a backup first and then run 'docker volume rm' by hand (see docs/operations/backups.md)." >&2
        exit 1
        ;;
    esac
  done

  require_compose_file
  echo "Stopping compose project ${CAL_COMPOSE_PROJECT} (the data volume is kept) ..."
  compose down "$@"
  echo "cal-stack.sh down: OK"
}

cmd_status() {
  local container ports line
  while IFS= read -r container; do
    [[ -z "$container" ]] && continue
    echo "${container}:"
    echo "  health: $(container_health "$container")"
    echo "  image:  $(container_image "$container")"
    ports="$(container_ports "$container")"
    if [[ -z "$ports" ]]; then
      echo "  ports:  (none published)"
      continue
    fi
    while IFS= read -r line; do
      [[ -z "$line" ]] && continue
      echo "  ports:  ${line}"
    done <<<"$ports"
  done <<<"${CAL_DB_CONTAINER}"$'\n'"${CAL_WEB_CONTAINER}"
}

# ── check ────────────────────────────────────────────────────────────────

# `docker port` prints one line per published port, in the shape
# `3000/tcp -> 127.0.0.1:3200` (or `[::1]:3200` for an IPv6 binding). The
# address on the right of the arrow is the whole question: anything that is not
# loopback is reachable from the internet, because Docker's publishing rules
# are applied upstream of ufw.
check_container_loopback_only() {
  local container="$1" ports line addr host ok=1
  ports="$(container_ports "$container")"
  if [[ -z "$ports" ]]; then
    echo "  FAIL: ${container} publishes no ports (is it running?)" >&2
    return 1
  fi

  while IFS= read -r line; do
    [[ -z "$line" ]] && continue
    addr="${line##*-> }"
    host="${addr%:*}"
    host="${host#[}"
    host="${host%]}"
    if [[ "$host" != "$CAL_LOOPBACK_ADDRESS" && "$host" != "$IPV6_LOOPBACK" ]]; then
      echo "  FAIL: ${container} publishes ${line} — ${host} is NOT loopback" >&2
      ok=0
    else
      echo "  OK: ${container} ${line}"
    fi
  done <<<"$ports"

  [[ "$ok" -eq 1 ]]
}

check_network_binding() {
  local value
  value="$(docker network inspect --format "{{index .Options \"${NETWORK_BINDING_OPTION}\"}}" "$CAL_NETWORK" 2>/dev/null || true)"
  # Docker's Go template prints `<no value>` for a missing map key, which is
  # exactly the case that matters: a network created without this option
  # publishes on 0.0.0.0 the moment a port is added without an explicit
  # address, and nobody notices until someone scans the box.
  if [[ "$value" != "$CAL_LOOPBACK_ADDRESS" ]]; then
    echo "  FAIL: network ${CAL_NETWORK} has ${NETWORK_BINDING_OPTION}='${value:-<unset>}', expected ${CAL_LOOPBACK_ADDRESS}" >&2
    return 1
  fi
  echo "  OK: network ${CAL_NETWORK} carries ${NETWORK_BINDING_OPTION}=${CAL_LOOPBACK_ADDRESS}"
  return 0
}

cmd_check() {
  local failed=0
  echo "Checking that every published Cal port is bound to ${CAL_LOOPBACK_ADDRESS} only (docker port) ..."
  check_container_loopback_only "$CAL_DB_CONTAINER" || failed=1
  check_container_loopback_only "$CAL_WEB_CONTAINER" || failed=1

  echo "Checking the compose network's host binding option ..."
  check_network_binding || failed=1

  if [[ "$failed" -ne 0 ]]; then
    echo "" >&2
    echo "cal-stack.sh check: FAILED — the Cal stack is, or may be, reachable from the internet." >&2
    echo "Cal's database and its setup route must never be published beyond loopback; Caddy on 443 is the only way in." >&2
    echo "Fix the bindings in ${CAL_COMPOSE_FILE}, recreate the project (cal-stack.sh down && cal-stack.sh up), and re-run this check." >&2
    exit 1
  fi
  echo "cal-stack.sh check: OK"
}

# ── admin ────────────────────────────────────────────────────────────────

# Escapes a value for embedding in a JSON string. Only the two characters JSON
# forbids raw are handled: these credentials come from an env file an operator
# wrote, so a literal newline or control character in one is an operator error
# worth failing on rather than silently encoding.
json_escape() {
  printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g'
}

cmd_admin() {
  require_env_file

  local username email password full_name
  username="$(env_value CAL_ADMIN_USERNAME)"
  email="$(env_value CAL_ADMIN_EMAIL)"
  password="$(env_value CAL_ADMIN_PASSWORD)"
  full_name="$(env_value CAL_ADMIN_FULL_NAME)"
  # The setup route requires a name; defaulting it to the username keeps the
  # env file down to the three keys that actually matter.
  full_name="${full_name:-$username}"

  local missing=""
  [[ -z "$username" ]] && missing="${missing}CAL_ADMIN_USERNAME "
  [[ -z "$email" ]] && missing="${missing}CAL_ADMIN_EMAIL "
  [[ -z "$password" ]] && missing="${missing}CAL_ADMIN_PASSWORD "
  if [[ -n "$missing" ]]; then
    echo "Missing from ${CAL_ENV_FILE}: ${missing}" >&2
    exit 1
  fi

  local url tmp payload body status response
  url="http://${CAL_LOOPBACK_ADDRESS}:${CAL_WEB_HOST_PORT}${CAL_SETUP_PATH}"
  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064 # $tmp is expanded now on purpose: the trap must
  # name the directory this invocation created, not whatever the variable holds
  # when the trap fires.
  trap "rm -rf '${tmp}'" EXIT
  payload="${tmp}/setup.json"
  body="${tmp}/response.body"

  # The payload is written to a mode-600 file and handed to curl as @file
  # rather than as a --data argument: a command line is readable by every user
  # on the box through `ps` for as long as the process lives, and this one
  # carries the admin password.
  (
    umask 077
    cat >"$payload" <<EOF
{"username":"$(json_escape "$username")","full_name":"$(json_escape "$full_name")","email_address":"$(json_escape "$email")","password":"$(json_escape "$password")"}
EOF
  )

  echo "Creating the first Cal admin user (${username} <${email}>) via ${url} ..."
  status="$(curl -sS -o "$body" -w '%{http_code}' \
    -X POST -H 'Content-Type: application/json' \
    --data-binary "@${payload}" "$url" || true)"

  response="$(cat "$body" 2>/dev/null || true)"
  rm -rf "$tmp"
  trap - EXIT

  case "$status" in
    200 | 201)
      echo "cal-stack.sh admin: OK — admin user ${username} created."
      return 0
      ;;
    400)
      # Cal's setup route exists only to create the FIRST user; once any user
      # exists it answers 400 with this message forever. That is the whole
      # reason this subcommand is safe to re-run on every deploy.
      if printf '%s' "$response" | grep -qF "$CAL_SETUP_DONE_MARKER"; then
        echo "cal-stack.sh admin: OK — Cal already has a user, so setup is closed (\"${CAL_SETUP_DONE_MARKER}\"). Nothing to do."
        return 0
      fi
      echo "cal-stack.sh admin: FAILED — ${url} answered 400: ${response}" >&2
      exit 1
      ;;
    *)
      echo "cal-stack.sh admin: FAILED — ${url} answered ${status:-<no response>}: ${response}" >&2
      echo "An empty status means cal-web is not listening yet; run 'cal-stack.sh up' and retry." >&2
      exit 1
      ;;
  esac
}

# ── provisioner-role ─────────────────────────────────────────────────────

generate_password() {
  # Hex, so the value needs no quoting anywhere it later travels: an env file,
  # a SQL literal, a connection URL. `openssl` is on this box; the /dev/urandom
  # fallback keeps the script working on one where it is not.
  if command -v openssl >/dev/null 2>&1; then
    openssl rand -hex 32
  else
    LC_ALL=C tr -dc 'a-f0-9' </dev/urandom | head -c 64
  fi
}

# Reads CAL_PROVISIONER_PASSWORD out of the env file, generating and persisting
# one when the key is absent or empty, then prints it for the caller. The value
# is written through a temp file BESIDE the env file (same directory, same
# filesystem, so a file holding a secret never appears under a
# world-traversable /tmp) and copied back with `cat >`, which keeps the
# original's mode 600 and its ownership where `mv` would hand it the temp
# file's — the same trick deploy-slot.sh uses for FLOWSTARTER_ENV.
ensure_provisioner_password() {
  local existing
  existing="$(env_value CAL_PROVISIONER_PASSWORD)"
  if [[ -n "$existing" ]]; then
    printf '%s' "$existing"
    return 0
  fi

  local generated
  generated="$(generate_password)"

  if grep -qE '^CAL_PROVISIONER_PASSWORD=' "$CAL_ENV_FILE"; then
    local env_tmp
    env_tmp="$(mktemp "${CAL_ENV_FILE}.XXXXXX")"
    chmod 600 "$env_tmp"
    grep -vE '^CAL_PROVISIONER_PASSWORD=' "$CAL_ENV_FILE" >"$env_tmp" || true
    printf 'CAL_PROVISIONER_PASSWORD=%s\n' "$generated" >>"$env_tmp"
    cat "$env_tmp" >"$CAL_ENV_FILE"
    rm -f "$env_tmp"
  else
    # An env file whose last line has no trailing newline would otherwise get
    # the new key glued onto the end of it.
    if [[ -s "$CAL_ENV_FILE" ]] && [[ -n "$(tail -c 1 "$CAL_ENV_FILE")" ]]; then
      printf '\n' >>"$CAL_ENV_FILE"
    fi
    printf 'CAL_PROVISIONER_PASSWORD=%s\n' "$generated" >>"$CAL_ENV_FILE"
  fi

  printf '%s' "$generated"
}

# Runs SQL from stdin inside the database container. ON_ERROR_STOP=1 so a
# failed statement fails this script instead of being buried mid-output, and -q
# because the SQL carries the role's password and psql's default chatter about
# what it is doing is noise an operator does not need.
psql_exec() {
  docker exec -i "$CAL_DB_CONTAINER" \
    psql -U "$CAL_POSTGRES_USER" -d "$CAL_POSTGRES_DB" -v ON_ERROR_STOP=1 -q
}

provisioner_sql() {
  local password="$1" escaped role db table sequence
  # A single quote inside a SQL literal is escaped by doubling it. A backslash
  # needs nothing: Postgres has standard_conforming_strings on by default, so a
  # backslash in an ordinary string literal is already a literal backslash. The
  # generated password is hex and hits neither case; this is here for a
  # password an operator pasted in themselves.
  escaped="$(printf '%s' "$password" | sed -e "s/'/''/g")"
  role="$CAL_PROVISIONER_ROLE"
  db="$CAL_POSTGRES_DB"

  # CREATE ROLE has no IF NOT EXISTS, so the existence test goes in a DO block
  # and the ALTER branch doubles as the password refresh. Re-running is
  # therefore a no-op apart from setting the password to the value already in
  # the env file.
  cat <<EOF
DO \$\$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = '${role}') THEN
    CREATE ROLE "${role}" LOGIN PASSWORD '${escaped}';
  ELSE
    ALTER ROLE "${role}" LOGIN PASSWORD '${escaped}';
  END IF;
END
\$\$;

GRANT CONNECT ON DATABASE "${db}" TO "${role}";
GRANT USAGE ON SCHEMA public TO "${role}";
EOF

  # GRANT is idempotent in Postgres (granting a privilege already held is a
  # no-op), so these two loops need no existence test to be safe to re-run.
  # Nothing here grants DELETE, TRUNCATE, REFERENCES or CREATE, and nothing
  # grants anything on a table outside the list above: the provisioner is
  # allowed to create and adjust a client's booking page and nothing else.
  while IFS= read -r table; do
    [[ -z "$table" ]] && continue
    echo "GRANT ${CAL_PROVISIONER_TABLE_PRIVILEGES} ON TABLE public.${table} TO \"${role}\";"
  done <<<"$CAL_PROVISIONER_TABLES"

  while IFS= read -r sequence; do
    [[ -z "$sequence" ]] && continue
    echo "GRANT ${CAL_PROVISIONER_SEQUENCE_PRIVILEGES} ON SEQUENCE public.${sequence} TO \"${role}\";"
  done <<<"$CAL_PROVISIONER_SEQUENCES"
}

cmd_provisioner_role() {
  require_env_file

  local password
  password="$(ensure_provisioner_password)"

  echo "Creating or refreshing role ${CAL_PROVISIONER_ROLE} in database ${CAL_POSTGRES_DB} ..."
  # The SQL is piped straight into the container and never echoed: it carries
  # the role's password as a literal.
  provisioner_sql "$password" | psql_exec

  echo "cal-stack.sh provisioner-role: OK"
  echo "  role:     ${CAL_PROVISIONER_ROLE}"
  echo "  granted:  ${CAL_PROVISIONER_TABLE_PRIVILEGES} on $(printf '%s' "$CAL_PROVISIONER_TABLES" | tr '\n' ' ')"
  # The URL is printed with the variable's NAME where the password goes, so an
  # operator can copy the shape of it into an env file without this line ever
  # putting the secret into a terminal, a CI log or a scrollback buffer.
  echo "  url:      postgresql://${CAL_PROVISIONER_ROLE}:\$CAL_PROVISIONER_PASSWORD@${CAL_LOOPBACK_ADDRESS}:${CAL_DB_HOST_PORT}/${CAL_POSTGRES_DB}"
  echo "  The password itself is in ${CAL_ENV_FILE} under CAL_PROVISIONER_PASSWORD; copy it into the app slot's env file by hand."
}

# ── health ───────────────────────────────────────────────────────────────

http_status() {
  local url="$1"
  # --max-time so a hung edge cannot hang a deploy lane. curl prints nothing
  # useful when it never got a response, so the status comes back as the empty
  # string, which the caller reports as a failure rather than mistaking it for
  # a code.
  curl -sS -o /dev/null -w '%{http_code}' --max-time "$(probe_timeout_seconds)" "$url" 2>/dev/null || true
}

probe() {
  local label="$1" url="$2" expected="$3" actual
  actual="$(http_status "$url")"
  if [[ "$actual" == "$expected" ]]; then
    printf '  %-26s %-46s %-5s (want %s)\n' "$label" "$url" "${actual:-none}" "$expected"
    return 0
  fi
  printf '  %-26s %-46s %-5s (want %s)  FAIL\n' "$label" "$url" "${actual:-none}" "$expected" >&2
  return 1
}

cmd_health() {
  local failed=0
  echo "Probing Cal end to end:"
  probe "public login page" "${CAL_PUBLIC_URL}${CAL_LOGIN_PATH}" "$EXPECTED_LOGIN_STATUS" || failed=1
  # A 200 here is the finding this probe exists for: signup being shut is what
  # keeps a host full of client accounts from becoming a host full of
  # strangers' accounts.
  probe "public signup (must be shut)" "${CAL_PUBLIC_URL}${CAL_SIGNUP_PATH}" "$EXPECTED_SIGNUP_STATUS" || failed=1
  probe "loopback web port" "http://${CAL_LOOPBACK_ADDRESS}:${CAL_WEB_HOST_PORT}${CAL_LOGIN_PATH}" "$EXPECTED_LOGIN_STATUS" || failed=1

  if [[ "$failed" -ne 0 ]]; then
    echo "cal-stack.sh health: FAILED" >&2
    exit 1
  fi
  echo "cal-stack.sh health: OK"
}

# ── install-caddy ────────────────────────────────────────────────────────

cmd_install_caddy() {
  if [[ ! -f "$CAL_CADDY_SOURCE" ]]; then
    echo "CAL_CADDY_SOURCE (${CAL_CADDY_SOURCE}) does not exist." >&2
    echo "Copy deploy/hetzner-staging/cal/cal.caddy to ${CAL_DIR}/ first." >&2
    exit 1
  fi
  mkdir -p "$(dirname "$CAL_CADDY_SNIPPET")"
  install -m 644 "$CAL_CADDY_SOURCE" "$CAL_CADDY_SNIPPET"
  echo "Installed ${CAL_CADDY_SNIPPET}"
  # systemctl on the real host; `caddy reload` is the fallback for a box
  # running Caddy outside systemd, the same choice deploy-slot.sh makes.
  if command -v systemctl >/dev/null 2>&1; then
    systemctl reload caddy
  else
    caddy reload --config /etc/caddy/Caddyfile --force
  fi
  echo "Reloaded Caddy."
}

main() {
  local cmd="${1:-}"
  [[ $# -gt 0 ]] && shift
  case "$cmd" in
    up | down | status | check | admin | provisioner-role | health | install-caddy) ;;
    *)
      usage
      exit 1
      ;;
  esac

  require_root

  case "$cmd" in
    up) cmd_up "$@" ;;
    down) cmd_down "$@" ;;
    status) cmd_status "$@" ;;
    check) cmd_check "$@" ;;
    admin) cmd_admin "$@" ;;
    provisioner-role) cmd_provisioner_role "$@" ;;
    health) cmd_health "$@" ;;
    install-caddy) cmd_install_caddy "$@" ;;
  esac
}

main "$@"
