#!/usr/bin/env bash
# Unit-style tests for backup.sh and restore.sh.
#
#   bash deploy/hetzner-staging/scripts/backup.test.sh
#
# It runs the real scripts against a throwaway root, with `docker`, `tar`,
# `id`, `age`, `gpg`, `rclone` and `aws` replaced by stubs on PATH, so
# nothing here talks to a daemon, a registry, a database or the network.
# `sha256sum`/`shasum` are used for real: hashing a local file touches
# nothing external, the same reasoning deploy-slot.test.sh applies to
# leaving `grep`/`awk` unstubbed. What this proves is the part a backup or a
# restore gets wrong quietly: which containers get dumped, whether the
# secrets tarball actually gets encrypted (with whichever tool is really on
# PATH), whether retention keeps the right dated directories, whether an S3
# upload is attempted only when configured, and whether a restore ever
# touches anything before its manifest checksum has been verified.

set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BACKUP="${HERE}/backup.sh"
RESTORE="${HERE}/restore.sh"

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

# ── A throwaway host ─────────────────────────────────────────────────────
# One temp dir stands in for /var/backups/flowstarter, /var/www/sites and
# /etc/flowstarter.
ROOT="$(mktemp -d)"
trap 'rm -rf "$ROOT"' EXIT

mkdir -p "$ROOT/backups" "$ROOT/sites/acme-widgets" "$ROOT/etc" "$ROOT/bin"
echo '<html>acme</html>' >"$ROOT/sites/acme-widgets/index.html"
echo 'STAGING_SECRET=x' >"$ROOT/etc/staging.env"

# `id -u` reports 0 so backup.sh/restore.sh's require_root passes without
# actually running this test suite as root.
cat >"$ROOT/bin/id" <<'STUB'
#!/usr/bin/env bash
if [ "$1" = "-u" ]; then
  echo "${STUB_UID:-0}"
  exit 0
fi
exit 1
STUB

# docker ps / docker exec, logging every call. `DOCKER_PS_NAMES` supplies a
# fixed container list (newline separated) so container discovery is
# exercised without a daemon. `docker exec CONTAINER pg_dump ...` writes
# fake dump bytes to stdout; `docker exec -i CONTAINER pg_restore ...`
# consumes stdin and records what it would have restored.
cat >"$ROOT/bin/docker" <<'STUB'
#!/usr/bin/env bash
echo "docker $*" >>"$STUB_LOG"
if [ "$1" = "ps" ]; then
  printf '%s\n' "${DOCKER_PS_NAMES:-}"
  exit 0
fi
if [ "$1" = "exec" ]; then
  shift
  if [ "$1" = "-i" ]; then
    shift
    container="$1"
    shift
    cat >/dev/null
    echo "RESTORED ${container}: $*" >>"${STUB_LOG}.restore"
    exit "${DOCKER_RESTORE_EXIT:-0}"
  else
    container="$1"
    echo "FAKE-DUMP-CONTENT-for-${container}"
    exit 0
  fi
fi
exit 0
STUB

# tar, logging every call. `-czf DEST ...` writes a small marker file at DEST
# so sha256sum has real bytes to hash. `-xzf SRC -C DIR ENTRY` records the
# extraction instead of needing a real archive layout.
cat >"$ROOT/bin/tar" <<'STUB'
#!/usr/bin/env bash
echo "tar $*" >>"$STUB_LOG"
mode="$1"
case "$mode" in
  -czf)
    outfile="$2"
    echo "FAKE-TAR-CONTENT-for-$(basename "$outfile")" >"$outfile"
    ;;
  -xzf)
    infile="$2"
    shift 2
    target_dir="."
    entry=""
    while [ $# -gt 0 ]; do
      case "$1" in
        -C)
          target_dir="$2"
          shift 2
          ;;
        *)
          entry="$1"
          shift
          ;;
      esac
    done
    mkdir -p "${target_dir}/$(dirname "$entry")"
    echo "EXTRACTED ${infile} -> ${target_dir}/${entry}" >>"${STUB_LOG}.extract"
    mkdir -p "${target_dir}/${entry}"
    ;;
esac
exit 0
STUB

# age, only ever placed on PATH for the scenarios that test the age branch.
cat >"$ROOT/bin/age" <<'STUB'
#!/usr/bin/env bash
echo "age $*" >>"$STUB_LOG"
outfile=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && outfile="$a"
  prev="$a"
done
[ -n "$outfile" ] && echo "FAKE-AGE-CIPHERTEXT" >"$outfile"
exit 0
STUB

# gpg, standing in for the real thing so the age-absent branch does not
# depend on a real gpg binary or a real passphrase round trip, only on
# backup.sh's own choice of tool and its passphrase-file mode check.
cat >"$ROOT/bin/gpg" <<'STUB'
#!/usr/bin/env bash
echo "gpg $*" >>"$STUB_LOG"
outfile=""
prev=""
for a in "$@"; do
  [ "$prev" = "-o" ] && outfile="$a"
  prev="$a"
done
[ -n "$outfile" ] && echo "FAKE-GPG-CIPHERTEXT" >"$outfile"
exit 0
STUB

cat >"$ROOT/bin/rclone" <<'STUB'
#!/usr/bin/env bash
echo "rclone $*" >>"$STUB_LOG"
exit "${RCLONE_EXIT:-0}"
STUB

cat >"$ROOT/bin/aws" <<'STUB'
#!/usr/bin/env bash
echo "aws $*" >>"$STUB_LOG"
exit "${AWS_EXIT:-0}"
STUB

chmod +x "$ROOT/bin/"*

# A PATH with every stub directory available; individual tests remove
# age/gpg/rclone/aws from a private bin dir to exercise "not installed".
SYSTEM_PATH="$PATH"
export PATH="$ROOT/bin:$PATH"
export STUB_LOG="$ROOT/stub.log"

# shellcheck disable=SC2120,SC2119 # backup.sh itself takes no positional
# args in normal use; "$@" is passed through only so a future test can hand
# it --help or similar without changing this helper.
run_backup() {
  : >"$STUB_LOG"
  rm -f "${STUB_LOG}.restore" "${STUB_LOG}.extract"
  BACKUP_ROOT="$ROOT/backups" \
    SITES_DIR="$ROOT/sites" \
    FLOWSTARTER_ETC_DIR="$ROOT/etc" \
    DOCKER_PS_NAMES="${DOCKER_PS_NAMES:-}" \
    bash "$BACKUP" "$@" 2>&1
}

run_restore() {
  : >"$STUB_LOG"
  rm -f "${STUB_LOG}.restore" "${STUB_LOG}.extract"
  BACKUP_ROOT="$ROOT/backups" \
    SITES_DIR="$ROOT/sites" \
    bash "$RESTORE" "$@" 2>&1
}

# ── Container discovery ──────────────────────────────────────────────────
echo "backup.sh: container discovery"
export DOCKER_PS_NAMES=$'supabase_db_flowstarter\nsupabase_kong_flowstarter\nsome_other_container'
export BACKUP_KEEP_DAILY=7
export BACKUP_KEEP_WEEKLY=4
export BACKUP_AGE_RECIPIENT="age1notarealkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
out="$(run_backup)"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "docker ps --format {{.Names}}" "backup.sh lists containers with docker ps"
assert_contains "$log" "docker exec supabase_db_flowstarter pg_dump" "the real stack container is dumped"
assert_not_contains "$log" "docker exec supabase_kong_flowstarter pg_dump" "a decoy container name is not dumped"
assert_not_contains "$log" "docker exec some_other_container pg_dump" "an unrelated container is not dumped"
if [ -f "$ROOT/backups/$(date -u +%Y-%m-%d)/db-supabase_db_flowstarter.dump" ]; then
  ok "the dump lands under today's dated directory"
else
  no "the dump lands under today's dated directory"
fi

# ── Manifest ─────────────────────────────────────────────────────────────
echo "backup.sh: manifest"
today_dir="$ROOT/backups/$(date -u +%Y-%m-%d)"
manifest="${today_dir}/manifest.sha256"
if [ -f "$manifest" ]; then
  ok "manifest.sha256 was written"
else
  no "manifest.sha256 was written"
fi
manifest_body="$(cat "$manifest" 2>/dev/null)"
assert_contains "$manifest_body" "db-supabase_db_flowstarter.dump" "the manifest lists the database dump"
assert_contains "$manifest_body" "sites.tar.gz" "the manifest lists the sites tarball"
assert_contains "$manifest_body" "etc-flowstarter.tar.gz.age" "the manifest lists the encrypted secrets tarball"
# Recompute one entry's hash independently and compare, proving the manifest
# is not just present but correct.
expected_hash="$(cd "$today_dir" && sha256sum db-supabase_db_flowstarter.dump 2>/dev/null | awk '{print $1}')"
[ -z "$expected_hash" ] && expected_hash="$(cd "$today_dir" && shasum -a 256 db-supabase_db_flowstarter.dump | awk '{print $1}')"
manifest_hash="$(awk '$2=="db-supabase_db_flowstarter.dump" {print $1}' "$manifest")"
if [ -n "$expected_hash" ] && [ "$expected_hash" = "$manifest_hash" ]; then
  ok "the manifest's sha256 for the dump matches an independent recomputation"
else
  no "the manifest's sha256 for the dump matches an independent recomputation" "expected ${expected_hash}, got ${manifest_hash}"
fi

# ── Encryption: age branch ───────────────────────────────────────────────
echo "backup.sh: encrypts /etc/flowstarter with age when age is on PATH"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "age -r age1notarealkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" "age is invoked with the configured recipient"
assert_not_contains "$log" "gpg " "gpg is not invoked when age is available"
if [ -f "${today_dir}/etc-flowstarter.tar.gz.age" ]; then
  ok "the .age ciphertext file exists"
else
  no "the .age ciphertext file exists"
fi
if [ ! -f "${today_dir}/etc-flowstarter.tar.gz" ]; then
  ok "the plaintext secrets tarball does not survive the run"
else
  no "the plaintext secrets tarball does not survive the run"
fi

# ── Encryption: gpg fallback branch ──────────────────────────────────────
echo "backup.sh: falls back to gpg with a mode-600 passphrase file when age is absent"
NOAGE_BIN="$ROOT/bin-noage"
mkdir -p "$NOAGE_BIN"
for tool in docker tar id gpg rclone aws; do
  cp "$ROOT/bin/$tool" "$NOAGE_BIN/$tool"
done
rm -rf "$ROOT/backups/$(date -u +%Y-%m-%d)"

PASS_FILE="$ROOT/etc/backup-gpg-passphrase"
echo 'not-a-real-passphrase' >"$PASS_FILE"
chmod 600 "$PASS_FILE"

: >"$STUB_LOG"
out="$(PATH="$NOAGE_BIN:$SYSTEM_PATH" \
  BACKUP_ROOT="$ROOT/backups" SITES_DIR="$ROOT/sites" FLOWSTARTER_ETC_DIR="$ROOT/etc" \
  BACKUP_GPG_PASSPHRASE_FILE="$PASS_FILE" \
  DOCKER_PS_NAMES="$DOCKER_PS_NAMES" \
  bash "$BACKUP" 2>&1)"
log="$(cat "$STUB_LOG")"
assert_contains "$log" "gpg --batch --yes --symmetric" "gpg is invoked when age is not on PATH"
today_dir="$ROOT/backups/$(date -u +%Y-%m-%d)"
if [ -f "${today_dir}/etc-flowstarter.tar.gz.gpg" ]; then
  ok "the .gpg ciphertext file exists"
else
  no "the .gpg ciphertext file exists"
fi

echo "backup.sh: refuses gpg fallback when the passphrase file mode is wrong"
chmod 644 "$PASS_FILE"
rm -rf "$ROOT/backups/$(date -u +%Y-%m-%d)"
out="$(PATH="$NOAGE_BIN:$SYSTEM_PATH" BACKUP_ROOT="$ROOT/backups" SITES_DIR="$ROOT/sites" \
  FLOWSTARTER_ETC_DIR="$ROOT/etc" BACKUP_GPG_PASSPHRASE_FILE="$PASS_FILE" \
  DOCKER_PS_NAMES="$DOCKER_PS_NAMES" bash "$BACKUP" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "backup.sh refuses when the gpg passphrase file is not mode 600"
else
  no "backup.sh refuses when the gpg passphrase file is not mode 600" "exited 0"
fi
assert_contains "$out" "must be 600" "the refusal names the mode problem"
chmod 600 "$PASS_FILE"

# ── Retention ────────────────────────────────────────────────────────────
echo "backup.sh: retention keeps the daily window and the weekly survivors"
RET_ROOT="$(mktemp -d)"
days_ago() {
  local n="$1"
  if date -u -d "-${n} days" +%Y-%m-%d >/dev/null 2>&1; then
    date -u -d "-${n} days" +%Y-%m-%d
  else
    date -u -v-"${n}"d +%Y-%m-%d
  fi
}
# 20 dated directories: today plus 19 further back. keep-daily=3 keeps the
# 3 newest unconditionally; keep-weekly=2 additionally keeps index 3+6=9 and
# 3+13=16 (the oldest of each following 7-wide block), so days-ago 9 and 16
# survive and everything else beyond the daily window is removed.
for n in $(seq 0 19); do
  mkdir -p "$RET_ROOT/$(days_ago "$n")"
done
BACKUP_ROOT="$RET_ROOT" SITES_DIR="$ROOT/sites" FLOWSTARTER_ETC_DIR="$ROOT/does-not-exist" \
  DOCKER_PS_NAMES="" BACKUP_KEEP_DAILY=3 BACKUP_KEEP_WEEKLY=2 \
  BACKUP_AGE_RECIPIENT="age1notarealkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  bash "$BACKUP" >/dev/null 2>&1

# shellcheck disable=SC2038 # every entry under $RET_ROOT is a dated
# directory this same test created, named plainly (YYYY-MM-DD).
remaining="$(find "$RET_ROOT" -maxdepth 1 -mindepth 1 -type d | xargs -n1 basename | sort)"
for n in 0 1 2; do
  d="$(days_ago "$n")"
  if printf '%s\n' "$remaining" | grep -qxF "$d"; then
    ok "daily backup ${d} (days-ago=${n}) survives retention"
  else
    no "daily backup ${d} (days-ago=${n}) survives retention"
  fi
done
for n in 9 16; do
  d="$(days_ago "$n")"
  if printf '%s\n' "$remaining" | grep -qxF "$d"; then
    ok "weekly backup ${d} (days-ago=${n}) survives retention"
  else
    no "weekly backup ${d} (days-ago=${n}) survives retention"
  fi
done
for n in 4 10 19; do
  d="$(days_ago "$n")"
  if printf '%s\n' "$remaining" | grep -qxF "$d"; then
    no "backup ${d} (days-ago=${n}) should have been removed"
  else
    ok "backup ${d} (days-ago=${n}) was removed by retention"
  fi
done
rm -rf "$RET_ROOT"

# ── S3 upload ────────────────────────────────────────────────────────────
echo "backup.sh: S3 upload is skipped cleanly with no BACKUP_S3_* set"
rm -rf "$ROOT/backups/$(date -u +%Y-%m-%d)"
out="$(run_backup)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_not_contains "$log" "rclone " "rclone is not invoked with no BACKUP_S3_BUCKET"
assert_not_contains "$log" "aws " "aws is not invoked with no BACKUP_S3_BUCKET"
assert_contains "$out" "skipping remote upload" "the skip is logged"
if [ "$rc" -eq 0 ]; then
  ok "backup.sh exits 0 when upload is skipped"
else
  no "backup.sh exits 0 when upload is skipped"
fi

echo "backup.sh: S3 upload is attempted (via rclone) when configured"
rm -rf "$ROOT/backups/$(date -u +%Y-%m-%d)"
out="$(: >"$STUB_LOG"; BACKUP_ROOT="$ROOT/backups" SITES_DIR="$ROOT/sites" FLOWSTARTER_ETC_DIR="$ROOT/etc" \
  DOCKER_PS_NAMES="$DOCKER_PS_NAMES" BACKUP_S3_BUCKET=flowstarter-backups \
  BACKUP_AGE_RECIPIENT="age1notarealkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  bash "$BACKUP" 2>&1)"
rc=$?
log="$(cat "$STUB_LOG")"
assert_contains "$log" "rclone copy" "rclone is invoked when BACKUP_S3_BUCKET is set"
if [ "$rc" -eq 0 ]; then
  ok "backup.sh exits 0 when the upload succeeds"
else
  no "backup.sh exits 0 when the upload succeeds"
fi

echo "backup.sh: a failed upload exits non-zero but keeps the local backup"
rm -rf "$ROOT/backups/$(date -u +%Y-%m-%d)"
out="$(: >"$STUB_LOG"; BACKUP_ROOT="$ROOT/backups" SITES_DIR="$ROOT/sites" FLOWSTARTER_ETC_DIR="$ROOT/etc" \
  DOCKER_PS_NAMES="$DOCKER_PS_NAMES" BACKUP_S3_BUCKET=flowstarter-backups RCLONE_EXIT=1 \
  BACKUP_AGE_RECIPIENT="age1notarealkeyxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" \
  bash "$BACKUP" 2>&1)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "backup.sh exits non-zero when the upload fails"
else
  no "backup.sh exits non-zero when the upload fails" "exited 0"
fi
assert_contains "$out" "BACKUP UPLOAD FAILED" "the upload failure is logged loudly"
if [ -f "$ROOT/backups/$(date -u +%Y-%m-%d)/manifest.sha256" ]; then
  ok "the local backup's manifest still exists after a failed upload"
else
  no "the local backup's manifest still exists after a failed upload"
fi

# ── restore.sh: dry-run touches nothing ──────────────────────────────────
echo "restore.sh: --dry-run prints the plan and touches nothing"
DATE_STR="$(date -u +%Y-%m-%d)"
out="$(run_restore --date "$DATE_STR" --database flowstarter --dry-run)"
log="$(cat "${STUB_LOG}.restore" 2>/dev/null || true)"
assert_contains "$out" "[dry-run]" "the dry-run plan is printed"
assert_contains "$out" "pg_restore" "the dry-run plan names the restore command"
if [ -z "$log" ]; then
  ok "no destructive docker exec -i (pg_restore) call happened"
else
  no "no destructive docker exec -i (pg_restore) call happened" "$log"
fi

echo "restore.sh --site --dry-run prints the plan and touches nothing"
out="$(run_restore --date "$DATE_STR" --site --dry-run)"
extract_log="$(cat "${STUB_LOG}.extract" 2>/dev/null || true)"
assert_contains "$out" "[dry-run]" "the site dry-run plan is printed"
if [ -z "$extract_log" ]; then
  ok "no tar extraction happened during --dry-run"
else
  no "no tar extraction happened during --dry-run" "$extract_log"
fi

# ── restore.sh: manifest verification ────────────────────────────────────
echo "restore.sh: refuses a real restore when the manifest sha256 does not match"
today_dir="$ROOT/backups/${DATE_STR}"
echo 'tampered bytes' >"${today_dir}/db-supabase_db_flowstarter.dump"
out="$(run_restore --date "$DATE_STR" --database flowstarter)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "restore.sh refuses when the dump no longer matches its manifest entry"
else
  no "restore.sh refuses when the dump no longer matches its manifest entry" "exited 0"
fi
assert_contains "$out" "sha256 mismatch" "the refusal names the problem"
restore_log="$(cat "${STUB_LOG}.restore" 2>/dev/null || true)"
if [ -z "$restore_log" ]; then
  ok "no pg_restore ran against the tampered dump"
else
  no "no pg_restore ran against the tampered dump" "$restore_log"
fi

# ── restore.sh: a real database restore, once verified ───────────────────
echo "restore.sh: a real --database restore runs pg_restore once verified"
rm -rf "$ROOT/backups/$DATE_STR"
run_backup >/dev/null 2>&1
out="$(run_restore --date "$DATE_STR" --database flowstarter)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "restore.sh exits 0 for a verified database restore"
else
  no "restore.sh exits 0 for a verified database restore" "$out"
fi
restore_log="$(cat "${STUB_LOG}.restore" 2>/dev/null || true)"
assert_contains "$restore_log" "RESTORED supabase_db_flowstarter:" "pg_restore ran against the right container"
assert_contains "$restore_log" "pg_restore -U postgres -d postgres --clean --if-exists" "pg_restore ran with the expected flags"

# ── restore.sh: site restore requires --force to overwrite ──────────────
echo "restore.sh: refuses to overwrite an existing site directory without --force"
out="$(run_restore --date "$DATE_STR" --site acme-widgets)"
rc=$?
if [ "$rc" -ne 0 ]; then
  ok "restore.sh refuses an existing site directory without --force"
else
  no "restore.sh refuses an existing site directory without --force" "exited 0"
fi
assert_contains "$out" "--force" "the refusal names the escape hatch"

echo "restore.sh: --force allows the overwrite"
out="$(run_restore --date "$DATE_STR" --site acme-widgets --force)"
rc=$?
if [ "$rc" -eq 0 ]; then
  ok "restore.sh --force restores the site directory"
else
  no "restore.sh --force restores the site directory" "$out"
fi

echo
echo "${pass} passed, ${fail} failed"
[ "$fail" -eq 0 ]
