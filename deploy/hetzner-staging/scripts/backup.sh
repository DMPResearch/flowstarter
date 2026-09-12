#!/usr/bin/env bash
# Nightly backup of everything on this Hetzner host that is not reproducible
# from git: every Supabase CLI stack's Postgres database, the client sites
# tree, and /etc/flowstarter (env files, TLS keys, and now this script's own
# gpg passphrase file, see below).
#
# This backs up the STAGING/PROD BOX's local state. The hosted production
# Supabase project is a separate thing, backed up by
# scripts/supabase-prod-backup.mjs at the repo root, run by hand from an
# operator's machine, never from this host or from CI.
#
# Usage:
#   backup.sh
#
# Meant to run nightly via systemd, see ../systemd/flowstarter-backup.service
# and ../systemd/flowstarter-backup.timer. Run as root: it reads
# /etc/flowstarter and talks to the Docker socket.
#
# Encryption of the /etc/flowstarter tarball (never the site files tarball,
# which carries nothing secret):
#   - age, if `age` is on PATH. The recipient (public key) comes from
#     BACKUP_AGE_RECIPIENT_FILE (a file holding one age public key, the
#     format `age -R` expects) or, if that is unset, BACKUP_AGE_RECIPIENT
#     (the public key given inline). One of the two must be set when age is
#     the tool in use.
#   - gpg --symmetric, if age is not on PATH. The passphrase comes from a
#     file named by BACKUP_GPG_PASSPHRASE_FILE, which must exist and be mode
#     600. The script refuses to run rather than fall back to an interactive
#     prompt or a weaker default; a passphrase file that is readable by
#     anyone but root defeats the point of encrypting the tarball at all.
# The choice between the two is made at runtime by checking `command -v
# age`, never hardcoded, so a box that later installs age switches over with
# no script change.
#
# Env overrides (documented defaults, never bare numbers or paths in the
# logic below, the same idea as capEur() in
# apps/flowstarter-main/src/lib/ai/funnel-cost.ts applied to retention counts):
#   BACKUP_ROOT                 root of the backup tree, default /var/backups/flowstarter
#   SITES_DIR                   client sites tree, default /var/www/sites
#   FLOWSTARTER_ETC_DIR         secrets directory, default /etc/flowstarter
#   PG_DUMP_ARGS                extra flags appended to `pg_dump`, default none
#   BACKUP_AGE_RECIPIENT_FILE   path to a file holding an age public key
#   BACKUP_AGE_RECIPIENT        an age public key given directly (used only
#                                if BACKUP_AGE_RECIPIENT_FILE is unset)
#   BACKUP_GPG_PASSPHRASE_FILE  default /etc/flowstarter/backup-gpg-passphrase
#   BACKUP_KEEP_DAILY           dated directories always kept, default 7
#   BACKUP_KEEP_WEEKLY          weekly directories kept beyond that, default 4
#   BACKUP_S3_BUCKET            bucket/container name; unset skips upload entirely
#   BACKUP_S3_ENDPOINT          S3-compatible endpoint URL (Hetzner Object
#                                Storage, Backblaze B2, etc.), optional
#   BACKUP_S3_PREFIX            key prefix under the bucket, default this host's hostname
#
# Retention rule (see retention_apply() below for the implementation): the
# most recent BACKUP_KEEP_DAILY dated directories are always kept. Beyond
# that window, directories are grouped into consecutive runs of 7 (this job
# runs nightly, so one dated directory is one elapsed day and a run of 7 is
# one elapsed week without needing to parse a weekday or an ISO week number
# out of a directory name), and the oldest survivor of each of the most
# recent BACKUP_KEEP_WEEKLY runs is kept. Everything else is deleted.
#
# S3 upload: uploads with whichever of rclone or aws is on PATH, preferring
# rclone (it is the tool actually installed for this on the Hetzner image;
# aws is the fallback for a box that only has the AWS CLI). With no
# BACKUP_S3_* configuration this step is skipped cleanly, no error. A failed
# upload does NOT undo or re-run the local backup: the dump and tarballs
# already on disk are what restore.sh and a human trust, and a transient
# network blip should not cost a night's local backup. It DOES make the
# overall script exit non-zero, on purpose, once every local step has
# finished: a nightly timer's failed run shows up in `systemctl status` /
# the journal, which is the only way an operator finds out the remote copy
# is stale before they need it.
#
# Never prints a secret (passphrase, S3 key, age recipient) to stdout/stderr
# at any point.

set -euo pipefail

# ── Env overrides ────────────────────────────────────────────────────────
BACKUP_ROOT="${BACKUP_ROOT:-/var/backups/flowstarter}"
SITES_DIR="${SITES_DIR:-/var/www/sites}"
ETC_DIR="${FLOWSTARTER_ETC_DIR:-/etc/flowstarter}"
PG_DUMP_ARGS="${PG_DUMP_ARGS:-}"
BACKUP_AGE_RECIPIENT_FILE="${BACKUP_AGE_RECIPIENT_FILE:-}"
BACKUP_AGE_RECIPIENT="${BACKUP_AGE_RECIPIENT:-}"
BACKUP_GPG_PASSPHRASE_FILE="${BACKUP_GPG_PASSPHRASE_FILE:-/etc/flowstarter/backup-gpg-passphrase}"
BACKUP_S3_BUCKET="${BACKUP_S3_BUCKET:-}"
BACKUP_S3_ENDPOINT="${BACKUP_S3_ENDPOINT:-}"
BACKUP_S3_PREFIX="${BACKUP_S3_PREFIX:-$(hostname 2>/dev/null || printf 'host')}"

# Named, documented defaults for the retention knobs, same pattern as
# capEur() in funnel-cost.ts: a magic number buried in the deletion logic
# below would be much easier to get wrong than a named constant with a
# fallback.
DEFAULT_KEEP_DAILY=7
DEFAULT_KEEP_WEEKLY=4

usage() {
  cat >&2 <<'EOF'
Usage: backup.sh

  Dumps every Supabase CLI stack's Postgres database, tars /var/www/sites
  and /etc/flowstarter (the latter encrypted), writes a sha256 manifest, and
  applies retention, all under $BACKUP_ROOT/<UTC date>/. See the header
  comment in this file for every env var it reads.
EOF
}

require_root() {
  local uid
  uid="$(id -u)"
  if [[ "$uid" -ne 0 ]]; then
    echo "backup.sh must be run as root (current uid: ${uid})." >&2
    exit 1
  fi
}

# ── Small portable helpers ──────────────────────────────────────────────────

# GNU stat (Linux, the real host) uses -c; BSD stat (macOS, where this
# script's tests run) uses -f. Both are tried so the mode check works in
# both places without picking a platform to fail on.
file_mode() {
  local path="$1"
  stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null
}

sha256_cmd() {
  local path="$1"
  if command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$path"
  else
    shasum -a 256 "$path"
  fi
}

# Hashes a file and prints a `sha256sum -c`-compatible line with a path
# relative to the file's own directory, so the manifest still verifies after
# the whole dated directory is copied or moved somewhere else.
manifest_line_for() {
  local path="$1" dir name
  dir="$(dirname "$path")"
  name="$(basename "$path")"
  (cd "$dir" && sha256_cmd "$name")
}

keep_daily_count() {
  local raw="${BACKUP_KEEP_DAILY:-}"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s' "$raw"
  else
    printf '%s' "$DEFAULT_KEEP_DAILY"
  fi
}

keep_weekly_count() {
  local raw="${BACKUP_KEEP_WEEKLY:-}"
  if [[ "$raw" =~ ^[0-9]+$ ]]; then
    printf '%s' "$raw"
  else
    printf '%s' "$DEFAULT_KEEP_WEEKLY"
  fi
}

# ── Database dumps ───────────────────────────────────────────────────────

# A host can in principle run more than one Supabase CLI stack, so containers
# are discovered by the `supabase_db_<project_id>` naming pattern rather than
# a single hardcoded name (this project's is `supabase_db_flowstarter`, see
# supabase/config.toml's project_id).
discover_stack_containers() {
  docker ps --format '{{.Names}}' | grep -E '^supabase_db_' || true
}

# Dumps one container's `postgres` database (the CLI stack's default and
# only application database) with `pg_dump` run INSIDE the container, custom
# format (-Fc, already compressed, so this is not gzipped again), streamed
# out over the container's own stdout into a host file. PG_DUMP_ARGS is
# deliberately word-split (shellcheck disabled below) so an operator can add
# flags such as --exclude-table without this script needing to know about
# every possible pg_dump option.
dump_database() {
  local container="$1" out_file="$2"
  echo "Dumping ${container} (database: postgres) -> ${out_file}"
  # shellcheck disable=SC2086
  docker exec "$container" pg_dump -U postgres -Fc $PG_DUMP_ARGS postgres >"$out_file"
}

# ── Encryption ───────────────────────────────────────────────────────────

# Decides age vs gpg at runtime and never prints the recipient or passphrase.
encrypt_secrets_tarball() {
  local src="$1" dest="$2"

  # Bash arrays are deliberately avoided throughout this script (matching
  # deploy-slot.sh and supabase-stack.sh, neither of which use one): an
  # empty array expanded under `set -u` behaves inconsistently across bash
  # versions, and plain conditionals are just as clear here.
  if command -v age >/dev/null 2>&1; then
    if [[ -n "$BACKUP_AGE_RECIPIENT_FILE" ]]; then
      if [[ ! -f "$BACKUP_AGE_RECIPIENT_FILE" ]]; then
        echo "BACKUP_AGE_RECIPIENT_FILE (${BACKUP_AGE_RECIPIENT_FILE}) does not exist." >&2
        exit 1
      fi
      age -R "$BACKUP_AGE_RECIPIENT_FILE" -o "$dest" "$src"
    elif [[ -n "$BACKUP_AGE_RECIPIENT" ]]; then
      age -r "$BACKUP_AGE_RECIPIENT" -o "$dest" "$src"
    else
      echo "age is on PATH but neither BACKUP_AGE_RECIPIENT_FILE nor BACKUP_AGE_RECIPIENT is set." >&2
      exit 1
    fi
    return 0
  fi

  # age is not installed: fall back to gpg symmetric encryption, but only
  # with a passphrase file that already has the mode a secret deserves.
  # Refusing here is deliberate: a missing or world-readable passphrase file
  # means either this backup or the passphrase itself is unprotected, and a
  # nightly timer should fail loudly rather than encrypt with something an
  # operator never meant to use.
  if [[ ! -f "$BACKUP_GPG_PASSPHRASE_FILE" ]]; then
    echo "age is not installed and BACKUP_GPG_PASSPHRASE_FILE (${BACKUP_GPG_PASSPHRASE_FILE}) does not exist." >&2
    exit 1
  fi
  local mode
  mode="$(file_mode "$BACKUP_GPG_PASSPHRASE_FILE")"
  if [[ "$mode" != "600" ]]; then
    echo "Refusing to use ${BACKUP_GPG_PASSPHRASE_FILE} as a gpg passphrase file: mode is ${mode}, must be 600." >&2
    exit 1
  fi
  gpg --batch --yes --symmetric --cipher-algo AES256 \
    --passphrase-file "$BACKUP_GPG_PASSPHRASE_FILE" -o "$dest" "$src"
}

# ── Retention ────────────────────────────────────────────────────────────

retention_apply() {
  local keep_daily keep_weekly
  keep_daily="$(keep_daily_count)"
  keep_weekly="$(keep_weekly_count)"

  # Newline-separated lists rather than bash arrays throughout this
  # function, matching deploy-slot.sh and supabase-stack.sh (neither uses an
  # array): it sidesteps every bash-version quirk around expanding a
  # possibly-empty array under `set -u`, at the cost of a few more `sed`/
  # `grep` calls, which is a fine trade for a script that runs once a night.
  #
  # `-printf` is GNU-find-only; piping through `xargs -n1 basename` gets the
  # same bare directory names on both the GNU find on the real host and the
  # BSD find this runs under in tests.
  local dirs
  # shellcheck disable=SC2038 # the -name glob restricts results to
  # YYYY-MM-DD, a fixed digit-and-hyphen shape with no room for a filename
  # `xargs` could ever misparse.
  dirs="$(
    find "$BACKUP_ROOT" -maxdepth 1 -mindepth 1 -type d \
      -name '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' 2>/dev/null |
      xargs -n1 basename |
      sort -r
  )"
  if [[ -z "$dirs" ]]; then
    return 0
  fi

  local keep_list
  keep_list="$(printf '%s\n' "$dirs" | head -n "$keep_daily")"

  local rest rest_count
  rest="$(printf '%s\n' "$dirs" | tail -n "+$((keep_daily + 1))")"
  if [[ -z "$rest" ]]; then
    rest_count=0
  else
    rest_count="$(printf '%s\n' "$rest" | wc -l | tr -d ' ')"
  fi

  # `rest` is still newest-first. Group it into runs of 7 (one nightly
  # backup per elapsed day, so a run of 7 approximates one calendar week)
  # and keep the oldest directory in each of the most recent `keep_weekly`
  # runs; that is the last line of each 7-wide slice. This is simpler than
  # parsing a weekday or an ISO week number out of a directory name, and
  # converges to the same roughly-weekly cadence in practice.
  local group=0 start end line
  while [[ "$group" -lt "$keep_weekly" ]]; do
    start=$((group * 7))
    [[ "$start" -ge "$rest_count" ]] && break
    end=$((start + 6))
    [[ "$end" -ge "$rest_count" ]] && end=$((rest_count - 1))
    line="$(printf '%s\n' "$rest" | sed -n "$((end + 1))p")"
    keep_list="$(printf '%s\n%s\n' "$keep_list" "$line")"
    group=$((group + 1))
  done

  local d
  while IFS= read -r d; do
    [[ -z "$d" ]] && continue
    if printf '%s\n' "$keep_list" | grep -qxF "$d"; then
      continue
    fi
    echo "Retention: removing ${BACKUP_ROOT}/${d} (beyond keep-daily=${keep_daily}, keep-weekly=${keep_weekly})"
    rm -rf "${BACKUP_ROOT:?}/${d:?}"
  done <<<"$dirs"
}

# ── Optional S3-compatible upload ───────────────────────────────────────────

# Prefers rclone over aws when both are on PATH: rclone is what the Hetzner
# image actually installs for this job; aws is only a fallback for a box
# that ended up with the AWS CLI instead. Returns non-zero only when an
# upload was attempted and failed; a skip (no BACKUP_S3_BUCKET) is success.
upload_to_s3() {
  local dest_dir="$1"

  if [[ -z "$BACKUP_S3_BUCKET" ]]; then
    echo "BACKUP_S3_BUCKET is not set; skipping remote upload."
    return 0
  fi

  local remote_path
  remote_path="${BACKUP_S3_PREFIX}/$(basename "$dest_dir")"

  if command -v rclone >/dev/null 2>&1; then
    local rclone_ok=1
    if [[ -n "$BACKUP_S3_ENDPOINT" ]]; then
      rclone copy "$dest_dir" "${BACKUP_S3_BUCKET}:${remote_path}" --s3-endpoint "$BACKUP_S3_ENDPOINT" || rclone_ok=0
    else
      rclone copy "$dest_dir" "${BACKUP_S3_BUCKET}:${remote_path}" || rclone_ok=0
    fi
    if [[ "$rclone_ok" -eq 1 ]]; then
      echo "Uploaded ${dest_dir} to ${BACKUP_S3_BUCKET}:${remote_path} via rclone."
      return 0
    fi
    echo "BACKUP UPLOAD FAILED: rclone could not copy ${dest_dir} to ${BACKUP_S3_BUCKET}:${remote_path}. The local backup is intact; investigate the journal for this unit and retry the upload by hand." >&2
    return 1
  fi

  if command -v aws >/dev/null 2>&1; then
    local aws_ok=1
    if [[ -n "$BACKUP_S3_ENDPOINT" ]]; then
      aws s3 cp "$dest_dir" "s3://${BACKUP_S3_BUCKET}/${remote_path}" --recursive --endpoint-url "$BACKUP_S3_ENDPOINT" || aws_ok=0
    else
      aws s3 cp "$dest_dir" "s3://${BACKUP_S3_BUCKET}/${remote_path}" --recursive || aws_ok=0
    fi
    if [[ "$aws_ok" -eq 1 ]]; then
      echo "Uploaded ${dest_dir} to s3://${BACKUP_S3_BUCKET}/${remote_path} via aws."
      return 0
    fi
    echo "BACKUP UPLOAD FAILED: aws could not copy ${dest_dir} to s3://${BACKUP_S3_BUCKET}/${remote_path}. The local backup is intact; investigate the journal for this unit and retry the upload by hand." >&2
    return 1
  fi

  echo "BACKUP_S3_BUCKET is set but neither rclone nor aws is on PATH; cannot upload." >&2
  return 1
}

# ── Main ─────────────────────────────────────────────────────────────────

main() {
  if [[ "${1:-}" == "-h" || "${1:-}" == "--help" ]]; then
    usage
    exit 0
  fi

  require_root
  mkdir -p "$BACKUP_ROOT"

  local date_str dest_dir
  date_str="$(date -u +%Y-%m-%d)"
  dest_dir="${BACKUP_ROOT}/${date_str}"
  mkdir -p "$dest_dir"
  echo "Starting backup into ${dest_dir}"

  # A newline-separated list rather than a bash array, same reasoning as
  # retention_apply(): no array means no bash-version-dependent behaviour
  # around expanding one that turns out to be empty.
  local artifacts=""

  local containers container out_file
  containers="$(discover_stack_containers)"
  if [[ -z "$containers" ]]; then
    echo "No supabase_db_* containers found on this host; skipping database dumps."
  fi
  while IFS= read -r container; do
    [[ -z "$container" ]] && continue
    out_file="${dest_dir}/db-${container}.dump"
    dump_database "$container" "$out_file"
    artifacts="${artifacts}${out_file}"$'\n'
  done <<<"$containers"

  if [[ -d "$SITES_DIR" ]]; then
    local sites_tar="${dest_dir}/sites.tar.gz"
    echo "Archiving ${SITES_DIR} -> ${sites_tar}"
    tar -czf "$sites_tar" -C "$(dirname "$SITES_DIR")" "$(basename "$SITES_DIR")"
    artifacts="${artifacts}${sites_tar}"$'\n'
  else
    echo "SITES_DIR (${SITES_DIR}) does not exist; skipping site archive."
  fi

  if [[ -d "$ETC_DIR" ]]; then
    local plain_etc_tar enc_tool enc_ext encrypted_etc_tar
    plain_etc_tar="${dest_dir}/etc-flowstarter.tar.gz"
    echo "Archiving ${ETC_DIR} -> ${plain_etc_tar}"
    tar -czf "$plain_etc_tar" -C "$(dirname "$ETC_DIR")" "$(basename "$ETC_DIR")"

    if command -v age >/dev/null 2>&1; then
      enc_tool="age"
      enc_ext="age"
    else
      enc_tool="gpg"
      enc_ext="gpg"
    fi
    encrypted_etc_tar="${plain_etc_tar}.${enc_ext}"
    echo "Encrypting ${ETC_DIR} tarball with ${enc_tool} -> ${encrypted_etc_tar}"
    encrypt_secrets_tarball "$plain_etc_tar" "$encrypted_etc_tar"
    # The plaintext tarball held secrets; it must not survive the run.
    rm -f "$plain_etc_tar"
    artifacts="${artifacts}${encrypted_etc_tar}"$'\n'
  else
    echo "ETC_DIR (${ETC_DIR}) does not exist; skipping secrets archive."
  fi

  echo "Writing manifest.sha256 ..."
  local manifest="${dest_dir}/manifest.sha256"
  : >"$manifest"
  local artifact
  while IFS= read -r artifact; do
    [[ -z "$artifact" ]] && continue
    manifest_line_for "$artifact" >>"$manifest"
  done <<<"$artifacts"
  echo "Wrote ${manifest}"

  echo "Applying retention (keep-daily=$(keep_daily_count), keep-weekly=$(keep_weekly_count)) ..."
  retention_apply

  local upload_failed=0
  if ! upload_to_s3 "$dest_dir"; then
    upload_failed=1
  fi

  echo "Backup complete: ${dest_dir}"
  if [[ "$upload_failed" -eq 1 ]]; then
    echo "backup.sh: exiting non-zero because the remote upload failed (the local backup above succeeded)." >&2
    exit 1
  fi
}

main "$@"
