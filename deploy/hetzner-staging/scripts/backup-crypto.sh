# shellcheck shell=bash
# Shared encryption/decryption tool selection for backup.sh and restore.sh.
#
# Sourced, not executed (`source "$(dirname "${BASH_SOURCE[0]}")/backup-crypto.sh"`):
# it only defines functions and touches no filesystem state itself, so the
# same `set -euo pipefail` and env-var contract in effect in the caller keeps
# working — the pattern deploy-slot.sh's helpers already exist inline, but
# with two callers here (backup writes, restore reads) a change to which
# tool wins, or to the passphrase-mode check, would otherwise have to be made
# twice and could drift. One file two callers import cannot drift; there is
# nothing left to keep in sync.
#
# Chooses `age` when it is on PATH, else `gpg --symmetric` with a passphrase
# file that must already be mode 600 — refusing rather than falling back to
# an interactive prompt or a weaker default, the same reasoning backup.sh's
# header has always given. The choice is made once per process
# (select_encryption_tool sets ENC_TOOL/ENC_EXT as globals) so every artifact
# in one run uses the same tool, and a restore can tell which tool encrypted
# a given artifact from its extension alone.
#
# Env vars read (documented in backup.sh's own header):
#   BACKUP_AGE_RECIPIENT_FILE, BACKUP_AGE_RECIPIENT, BACKUP_GPG_PASSPHRASE_FILE

file_mode() {
  local path="$1"
  stat -c '%a' "$path" 2>/dev/null || stat -f '%Lp' "$path" 2>/dev/null
}

# Sets ENC_TOOL (age|gpg) and ENC_EXT (age|gpg) as globals, or exits non-zero
# with a message naming the problem. Call once, before any artifact is
# produced, so a bad configuration is refused before dumping a single byte.
select_encryption_tool() {
  if command -v age >/dev/null 2>&1; then
    if [[ -n "${BACKUP_AGE_RECIPIENT_FILE:-}" ]]; then
      if [[ ! -f "$BACKUP_AGE_RECIPIENT_FILE" ]]; then
        echo "BACKUP_AGE_RECIPIENT_FILE (${BACKUP_AGE_RECIPIENT_FILE}) does not exist." >&2
        exit 1
      fi
    elif [[ -z "${BACKUP_AGE_RECIPIENT:-}" ]]; then
      echo "age is on PATH but neither BACKUP_AGE_RECIPIENT_FILE nor BACKUP_AGE_RECIPIENT is set." >&2
      exit 1
    fi
    ENC_TOOL="age"
    # shellcheck disable=SC2034 # read by callers (backup.sh) after sourcing
    ENC_EXT="age"
    return 0
  fi

  # age is not installed: fall back to gpg symmetric encryption, but only
  # with a passphrase file that already has the mode a secret deserves.
  # Refusing here is deliberate: a missing or world-readable passphrase file
  # means either this backup or the passphrase itself is unprotected, and a
  # nightly timer (or a restore) should fail loudly rather than encrypt or
  # decrypt with something an operator never meant to use.
  local passphrase_file="${BACKUP_GPG_PASSPHRASE_FILE:-/etc/flowstarter/backup-gpg-passphrase}"
  if [[ ! -f "$passphrase_file" ]]; then
    echo "age is not installed and BACKUP_GPG_PASSPHRASE_FILE (${passphrase_file}) does not exist." >&2
    exit 1
  fi
  local mode
  mode="$(file_mode "$passphrase_file")"
  if [[ "$mode" != "600" ]]; then
    echo "Refusing to use ${passphrase_file} as a gpg passphrase file: mode is ${mode}, must be 600." >&2
    exit 1
  fi
  ENC_TOOL="gpg"
  # shellcheck disable=SC2034 # read by callers (backup.sh) after sourcing
  ENC_EXT="gpg"
}

# Reads plaintext on stdin, writes ciphertext on stdout. Streaming end to
# end — the caller pipes a producer straight into this rather than ever
# writing a plaintext file — so encrypt_stream itself never touches disk.
# Requires select_encryption_tool to have run first.
encrypt_stream() {
  if [[ "$ENC_TOOL" == "age" ]]; then
    if [[ -n "${BACKUP_AGE_RECIPIENT_FILE:-}" ]]; then
      age -R "$BACKUP_AGE_RECIPIENT_FILE"
    else
      age -r "$BACKUP_AGE_RECIPIENT"
    fi
  else
    local passphrase_file="${BACKUP_GPG_PASSPHRASE_FILE:-/etc/flowstarter/backup-gpg-passphrase}"
    gpg --batch --yes --symmetric --cipher-algo AES256 \
      --passphrase-file "$passphrase_file"
  fi
}

# Reads ciphertext on stdin, writes plaintext on stdout, choosing the tool
# from the artifact's own extension ("age" or "gpg") rather than whichever
# tool this host happens to have on PATH right now — a restore has to work
# with whatever encrypted the backup, even after a host is later reprovisioned
# with a different tool.
decrypt_stream() {
  local ext="$1"
  case "$ext" in
    age)
      if ! command -v age >/dev/null 2>&1; then
        echo "This artifact was encrypted with age, but age is not on PATH." >&2
        exit 1
      fi
      if [[ -n "${BACKUP_AGE_IDENTITY_FILE:-}" ]]; then
        age --decrypt -i "$BACKUP_AGE_IDENTITY_FILE"
      else
        age --decrypt
      fi
      ;;
    gpg)
      if ! command -v gpg >/dev/null 2>&1; then
        echo "This artifact was encrypted with gpg, but gpg is not on PATH." >&2
        exit 1
      fi
      local passphrase_file="${BACKUP_GPG_PASSPHRASE_FILE:-/etc/flowstarter/backup-gpg-passphrase}"
      if [[ ! -f "$passphrase_file" ]]; then
        echo "BACKUP_GPG_PASSPHRASE_FILE (${passphrase_file}) does not exist; cannot decrypt." >&2
        exit 1
      fi
      gpg --batch --yes --decrypt --passphrase-file "$passphrase_file"
      ;;
    *)
      echo "Unknown encryption extension: ${ext}" >&2
      exit 1
      ;;
  esac
}
