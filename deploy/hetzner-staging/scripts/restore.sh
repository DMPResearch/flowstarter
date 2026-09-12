#!/usr/bin/env bash
# Restores ONE database, OR the site tree (or one site within it), from a
# dated directory backup.sh produced under $BACKUP_ROOT. Never restores
# /etc/flowstarter: that tarball holds secrets and is encrypted, and putting
# secrets back onto a box is rare enough and dangerous enough that it stays a
# deliberate by-hand operation (decrypt with `age --decrypt` or `gpg
# --decrypt` using the same recipient/passphrase backup.sh used, then extract
# with `tar -xzf`), not something a script should do unattended.
#
# Usage:
#   restore.sh --date YYYY-MM-DD --database <project_id> [--dry-run]
#   restore.sh --date YYYY-MM-DD --site [<slug>] [--dry-run] [--force]
#
# Examples:
#   restore.sh --date 2026-09-10 --database flowstarter --dry-run
#   restore.sh --date 2026-09-10 --database flowstarter
#   restore.sh --date 2026-09-10 --site acme-widgets --force
#   restore.sh --date 2026-09-10 --site --dry-run     # the whole tree
#
# <project_id> is the same value supabase/config.toml's project_id uses for
# the stack being restored (backup.sh names the dump file after the
# container it came from, supabase_db_<project_id>). There is no default:
# the manifest only ever names the artifact it hashed, never "the" database,
# so --database is required and never guessed.
#
# --dry-run prints exactly what would happen (which artifact, which
# container or path) and exits before touching anything. A real restore
# always verifies the artifact's sha256 against the backup's manifest.sha256
# first and refuses if it does not match; a backup that fails its own
# checksum is not something to restore from blind.
#
# Env overrides (same names and defaults as backup.sh, since a restore reads
# what a backup wrote):
#   BACKUP_ROOT   root of the backup tree, default /var/backups/flowstarter
#   SITES_DIR     client sites tree, default /var/www/sites
#
# Run as root for a real (non-dry-run) restore: it writes into a Docker
# container and into /var/www/sites.

set -euo pipefail

BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/flowstarter}"
SITES_DIR="${SITES_DIR:-/var/www/sites}"

DATE=""
DATABASE=""
SITE_MODE=0
SITE_SLUG=""
DRY_RUN=0
FORCE=0

# Kept in step with backup.sh by hand, and named the same way so a `grep` for
# either finds both.
DEFAULT_POSTGRES_USER=postgres
DEFAULT_POSTGRES_DB=postgres
DEFAULT_TRUSTED_ROLE_CONTAINER_PATTERN='^supabase_db_'
RESTORE_TRUSTED_ROLE_CONTAINER_PATTERN="${BACKUP_TRUSTED_ROLE_CONTAINER_PATTERN:-$DEFAULT_TRUSTED_ROLE_CONTAINER_PATTERN}"

usage() {
  cat >&2 <<'EOF'
Usage:
  restore.sh --date YYYY-MM-DD --database <project_id> [--dry-run]
  restore.sh --date YYYY-MM-DD --site [<slug>] [--dry-run] [--force]

  --date       required. The dated directory under $BACKUP_ROOT to restore from.
  --database   restore one database dump into its running container. Takes a
               Supabase project id (supabase_db_<project_id>) or an exact
               container name, which is how the Cal.com database
               (flowstarter-cal-db) is restored. Mutually exclusive with
               --site.
  --site       restore the client sites tree, or one site's directory if
               <slug> is given. Mutually exclusive with --database.
  --dry-run    print the plan and exit; nothing is touched.
  --force      required to overwrite an existing site directory; ignored
               (and unnecessary) for --dry-run.
EOF
}

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" -ne 0 ]]; then
    echo "restore.sh must be run as root for a real restore (current uid: ${uid}). Use --dry-run to preview without root." >&2
    exit 1
  fi
}

sha256_cmd() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    shasum -a 256 "$path"
  fi
}

# Verifies one artifact's sha256 against the dated directory's manifest
# before anything destructive runs. Refuses (non-zero exit) on a missing
# manifest, a missing manifest entry, or a mismatch: any of those means the
# backup cannot be trusted as-is.
verify_manifest_entry() {
  local dest_dir="$1" filename="$2"
  local manifest="${dest_dir}/manifest.sha256"
  if [[ ! -f "$manifest" ]]; then
    echo "No manifest.sha256 found in ${dest_dir}; refusing to restore an unverified backup." >&2
    exit 1
  fi
  local expected
  expected="$(awk -v f="$filename" '$2==f {print $1}' "$manifest")"
  if [[ -z "$expected" ]]; then
    echo "manifest.sha256 in ${dest_dir} has no entry for ${filename}; refusing to restore." >&2
    exit 1
  fi
  local actual
  actual="$(cd "$dest_dir" && sha256_cmd "$filename" | awk '{print $1}')"
  if [[ "$expected" != "$actual" ]]; then
    echo "sha256 mismatch for ${dest_dir}/${filename}: manifest says ${expected}, computed ${actual}. Refusing to restore a backup that fails its own integrity check." >&2
    exit 1
  fi
  echo "Verified ${filename} against manifest.sha256."
}

parse_args() {
  while [[ $# -gt 0 ]]; do
    case "$1" in
      --date)
        DATE="${2:?--date requires a value}"
        shift 2
        ;;
      --database)
        DATABASE="${2:?--database requires a value}"
        shift 2
        ;;
      --site)
        SITE_MODE=1
        # An optional positional value follows --site only when it does not
        # itself look like another flag, so `--site --dry-run` still means
        # "the whole tree, dry run" rather than swallowing the next flag.
        if [[ $# -ge 2 && "$2" != --* ]]; then
          SITE_SLUG="$2"
          shift 2
        else
          shift 1
        fi
        ;;
      --dry-run)
        DRY_RUN=1
        shift 1
        ;;
      --force)
        FORCE=1
        shift 1
        ;;
      -h | --help)
        usage
        exit 0
        ;;
      *)
        echo "Unknown argument: $1" >&2
        usage
        exit 1
        ;;
    esac
  done

  if [[ -z "$DATE" ]]; then
    echo "--date is required." >&2
    usage
    exit 1
  fi
  if [[ -n "$DATABASE" && "$SITE_MODE" -eq 1 ]]; then
    echo "--database and --site are mutually exclusive." >&2
    exit 1
  fi
  if [[ -z "$DATABASE" && "$SITE_MODE" -eq 0 ]]; then
    echo "One of --database or --site is required." >&2
    usage
    exit 1
  fi
}

# Which container a `--database` argument names.
#
# Historically this was only ever a Supabase CLI stack, so the argument was a
# project id and the container name was built from it. The Cal.com database is
# also backed up now, and its container is called `flowstarter-cal-db` — not
# `supabase_db_anything` — so an exact container name is accepted too. Tried in
# that order, because a project id is what the documented usage says and what
# an operator under pressure is most likely to type.
resolve_container() {
  local candidate="supabase_db_${DATABASE}"
  if docker ps --format '{{.Names}}' | grep -qxF "$candidate"; then
    printf '%s' "$candidate"
    return 0
  fi
  if docker ps --format '{{.Names}}' | grep -qxF "$DATABASE"; then
    printf '%s' "$DATABASE"
    return 0
  fi
  # Nothing running matches. Keep the historical shape so the "container is not
  # running" warning below still names the thing the operator asked for.
  printf '%s' "$candidate"
}

# The role and database to restore as, mirroring backup.sh exactly.
#
# The two halves have to agree or a restore silently targets the wrong
# database: Cal's container is calcom/calcom, while a Supabase container
# reports `POSTGRES_USER=supabase_admin` in its environment but can only be
# reached over the socket as `postgres`. See the long comment on
# BACKUP_TRUSTED_ROLE_CONTAINER_PATTERN in backup.sh.
restore_role_for() {
  local container="$1"
  if printf '%s\n' "$container" | grep -qE "$RESTORE_TRUSTED_ROLE_CONTAINER_PATTERN"; then
    printf '%s' "$DEFAULT_POSTGRES_USER"
    return 0
  fi
  local user
  user="$(docker exec "$container" printenv POSTGRES_USER 2>/dev/null || true)"
  printf '%s' "${user:-$DEFAULT_POSTGRES_USER}"
}

restore_db_name_for() {
  local container="$1" db
  db="$(docker exec "$container" printenv POSTGRES_DB 2>/dev/null || true)"
  printf '%s' "${db:-$DEFAULT_POSTGRES_DB}"
}

restore_database() {
  local dest_dir="$1"
  local container
  container="$(resolve_container)"
  local dump_file="db-${container}.dump"
  local dump_path="${dest_dir}/${dump_file}"

  if [[ ! -f "$dump_path" ]]; then
    echo "No dump found at ${dump_path} for --database ${DATABASE}." >&2
    exit 1
  fi
  verify_manifest_entry "$dest_dir" "$dump_file"

  if ! docker ps --format '{{.Names}}' | grep -qxF "$container"; then
    echo "Warning: container ${container} does not appear to be running. It must be running (the stack started) before this restore can proceed." >&2
    [[ "$DRY_RUN" -eq 0 ]] && exit 1
  fi

  local user db
  user="$(restore_role_for "$container")"
  db="$(restore_db_name_for "$container")"

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Would restore ${dump_path}"
    echo "[dry-run]   into container ${container}, database ${db}, as ${user}, via:"
    echo "[dry-run]   docker exec -i ${container} pg_restore -w -U ${user} -d ${db} --clean --if-exists"
    echo "[dry-run] No changes made."
    return 0
  fi

  require_root
  echo "Restoring ${dump_path} into ${container} (user: ${user}, database: ${db}) ..."
  # --clean --if-exists drops the objects the dump recreates first, so a
  # restore is idempotent against a database that already has (possibly
  # stale) schema and data in it, which is the normal case for a disaster
  # recovery drill against a freshly started stack.
  # `-w` for the same reason backup.sh passes it: a restore run from a
  # terminal-less context must fail rather than sit on a password prompt.
  docker exec -i "$container" pg_restore -w -U "$user" -d "$db" --clean --if-exists <"$dump_path"
  echo "Restore complete."
}

restore_site() {
  local dest_dir="$1"
  local sites_tar="sites.tar.gz"
  local sites_tar_path="${dest_dir}/${sites_tar}"

  if [[ ! -f "$sites_tar_path" ]]; then
    echo "No site archive found at ${sites_tar_path}." >&2
    exit 1
  fi
  verify_manifest_entry "$dest_dir" "$sites_tar"

  local sites_parent sites_base target archive_entry
  sites_parent="$(dirname "$SITES_DIR")"
  sites_base="$(basename "$SITES_DIR")"

  if [[ -n "$SITE_SLUG" ]]; then
    target="${SITES_DIR}/${SITE_SLUG}"
    archive_entry="${sites_base}/${SITE_SLUG}"
  else
    target="$SITES_DIR"
    archive_entry="$sites_base"
  fi

  if [[ "$DRY_RUN" -eq 1 ]]; then
    echo "[dry-run] Would extract ${archive_entry} from ${sites_tar_path}"
    echo "[dry-run]   into ${target}, via:"
    echo "[dry-run]   tar -xzf ${sites_tar_path} -C ${sites_parent} ${archive_entry}"
    echo "[dry-run] No changes made."
    return 0
  fi

  if [[ -e "$target" && "$FORCE" -ne 1 ]]; then
    echo "${target} already exists; refusing to overwrite without --force." >&2
    exit 1
  fi

  require_root
  echo "Restoring ${archive_entry} from ${sites_tar_path} into ${target} ..."
  mkdir -p "$sites_parent"
  tar -xzf "$sites_tar_path" -C "$sites_parent" "$archive_entry"
  echo "Restore complete."
}

main() {
  parse_args "$@"
  local dest_dir="${BACKUP_ROOT}/${DATE}"
  if [[ ! -d "$dest_dir" ]]; then
    echo "No backup directory at ${dest_dir}." >&2
    exit 1
  fi

  if [[ -n "$DATABASE" ]]; then
    restore_database "$dest_dir"
  else
    restore_site "$dest_dir"
  fi
}

main "$@"
