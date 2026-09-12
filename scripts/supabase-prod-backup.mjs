#!/usr/bin/env node
/**
 * A logical backup of the HOSTED production Supabase project.
 *
 * The project's own dashboard backup setting (Point-in-Time Recovery on a
 * Pro plan, or nothing at all on the free tier) is a separate,
 * Darius-only decision — see docs/operations/backups.md, "What still needs
 * Darius". This script is a second, independent copy, taken through the
 * Supabase CLI's own `db dump`, encrypted, and written to a local file. It
 * does not replace the dashboard setting; use both.
 *
 * RUN THIS FROM YOUR OWN MACHINE. NEVER FROM CI.
 * `SUPABASE_PROD_DB_URL` is a connection string with a password in it. If it
 * ever became a Depot/GitHub Actions secret, every pull-request workflow in
 * this repository would have a path to it (a fork PR's `pull_request`
 * trigger cannot read repository secrets, but a compromised dependency
 * inside a lane that legitimately reads one still could). Nothing in this
 * repository's CI configuration references `SUPABASE_PROD_DB_URL`, and
 * nothing ever should. There is no automation that runs this on a schedule;
 * that is a deliberate omission, not a gap to fill inside this repository —
 * if you want it scheduled, do that from the ops machine's own cron/launchd,
 * outside this codebase.
 *
 * Guard: refuses to run at all unless BOTH of these are set:
 *   FLOWSTARTER_ENV=production
 *   FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1
 * This is the same shape as the rule `apps/flowstarter-main/src/lib/
 * supabase-target.ts` enforces everywhere else in the product: nothing but a
 * deliberate, explicit production run may talk to anything other than the
 * loopback local stack. It also refuses under a detected CI environment
 * (`CI` set) as a second, independent check — even a correctly configured
 * pair of env vars should never be reachable from an automated runner today.
 *
 * `SUPABASE_PROD_DB_URL` (required, a Postgres connection string, must be
 * percent-encoded per `supabase db dump --help`) is read once, handed to the
 * Supabase CLI as an argument (never interpolated into a shell string, so it
 * cannot leak through a shell history or a `ps` listing on a multi-user
 * machine any more than any other CLI invocation would), and is never
 * printed, logged, or included in any error message this script raises.
 *
 * Usage:
 *   FLOWSTARTER_ENV=production FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1 \
 *     SUPABASE_PROD_DB_URL='postgres://...' \
 *     node scripts/supabase-prod-backup.mjs [--out-dir <dir>]
 *
 * Output: <out-dir>/supabase-prod-<UTC date>.sql, encrypted in place to
 * <...>.sql.age (if `age` is on PATH) or <...>.sql.gpg (gpg --symmetric,
 * with a passphrase FILE, mode 600 — never a prompt). The plaintext dump is
 * deleted as soon as the encrypted copy exists. Same tool-choice logic as
 * `deploy/hetzner-staging/scripts/backup.sh`'s `/etc/flowstarter` tarball;
 * see that script if you are auditing the two for consistency.
 *
 * Env:
 *   SUPABASE_PROD_DB_URL          required, never printed, never in a repo file
 *   SUPABASE_PROD_BACKUP_OUT_DIR  default: ./supabase-prod-backups (relative
 *                                  to the current working directory, i.e.
 *                                  wherever you run this from — this script
 *                                  never assumes the repo root is a safe
 *                                  place to leave an encrypted database dump)
 *   BACKUP_AGE_RECIPIENT_FILE     a file holding one age public key
 *   BACKUP_AGE_RECIPIENT          an age public key given directly (used
 *                                  only if BACKUP_AGE_RECIPIENT_FILE is unset)
 *   BACKUP_GPG_PASSPHRASE_FILE    default ./supabase-prod-backup-gpg-passphrase
 *                                  (relative to the current working
 *                                  directory), must exist and be mode 600
 *
 * RESTORE. `supabase db dump` (no `--data-only`, the default this script
 * uses) writes a plain SQL script, not a custom-format archive — there is no
 * `-Fc` equivalent exposed by the CLI's `dump` command. So the restore is
 * `psql`, not `pg_restore`:
 *
 *   age --decrypt -o dump.sql supabase-prod-2026-09-12.sql.age
 *   # or: gpg --batch --yes --decrypt --passphrase-file <file> \
 *   #       -o dump.sql supabase-prod-2026-09-12.sql.gpg
 *   psql "$SUPABASE_PROD_DB_URL" -f dump.sql
 *
 * Restoring a full logical dump onto a project that already has data is
 * destructive (the dump recreates objects the target already has). Restore
 * onto a fresh project, or only after you have confirmed with the team that
 * a full restore is genuinely what this moment calls for.
 */

import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { platform } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function arg(name) {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1 || index === process.argv.length - 1) return undefined;
  return process.argv[index + 1];
}

function refuse(message) {
  console.error(`supabase-prod-backup.mjs: refusing to run: ${message}`);
  process.exit(1);
}

function assertGuards() {
  if (process.env.CI) {
    refuse(
      'CI is set. This script is for an operator\'s own machine, never a CI runner — see the header comment.'
    );
  }
  if (process.env.FLOWSTARTER_ENV !== 'production') {
    refuse(
      'FLOWSTARTER_ENV must be exactly "production" (it is ' +
        `${JSON.stringify(process.env.FLOWSTARTER_ENV ?? null)}). This guard exists ` +
        'so a stray environment cannot dump the hosted project by accident.'
    );
  }
  if (process.env.FLOWSTARTER_ALLOW_REMOTE_SUPABASE !== '1') {
    refuse(
      'FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1 is required in addition to ' +
        'FLOWSTARTER_ENV=production. Both must be deliberate.'
    );
  }
  if (!process.env.SUPABASE_PROD_DB_URL?.trim()) {
    refuse('SUPABASE_PROD_DB_URL is not set.');
  }
}

/** Strips a value from a string, so an error from a subprocess can never
 * accidentally echo the connection string back out. */
function redact(text, secret) {
  if (!secret) return text;
  return text.split(secret).join('<redacted>');
}

function fileMode(path) {
  // Matches backup.sh's own check: refuse a passphrase file whose mode is
  // not exactly 600, rather than trust a looser permission.
  const mode = statSync(path).mode & 0o777;
  return mode.toString(8).padStart(3, '0');
}

function pickEncryption() {
  try {
    execFileSync('age', ['--version'], { stdio: 'ignore' });
    return 'age';
  } catch {
    return 'gpg';
  }
}

function encryptDump(plainPath) {
  const tool = pickEncryption();
  if (tool === 'age') {
    const recipientFile = process.env.BACKUP_AGE_RECIPIENT_FILE?.trim();
    const recipient = process.env.BACKUP_AGE_RECIPIENT?.trim();
    const encryptedPath = `${plainPath}.age`;
    if (recipientFile) {
      if (!existsSync(recipientFile)) {
        refuse(`BACKUP_AGE_RECIPIENT_FILE (${recipientFile}) does not exist.`);
      }
      execFileSync('age', ['-R', recipientFile, '-o', encryptedPath, plainPath]);
    } else if (recipient) {
      execFileSync('age', ['-r', recipient, '-o', encryptedPath, plainPath]);
    } else {
      refuse(
        'age is on PATH but neither BACKUP_AGE_RECIPIENT_FILE nor BACKUP_AGE_RECIPIENT is set.'
      );
    }
    return encryptedPath;
  }

  const passphraseFile = (
    process.env.BACKUP_GPG_PASSPHRASE_FILE ??
    join(process.cwd(), 'supabase-prod-backup-gpg-passphrase')
  ).trim();
  if (!existsSync(passphraseFile)) {
    refuse(
      `age is not installed and BACKUP_GPG_PASSPHRASE_FILE (${passphraseFile}) does not exist.`
    );
  }
  // Windows has no POSIX mode bits worth checking this way; the mode check
  // is skipped there rather than made to lie.
  if (platform() !== 'win32') {
    const mode = fileMode(passphraseFile);
    if (mode !== '600') {
      refuse(
        `Refusing to use ${passphraseFile} as a gpg passphrase file: mode is ${mode}, must be 600.`
      );
    }
  }
  const encryptedPath = `${plainPath}.gpg`;
  execFileSync('gpg', [
    '--batch',
    '--yes',
    '--symmetric',
    '--cipher-algo',
    'AES256',
    '--passphrase-file',
    passphraseFile,
    '-o',
    encryptedPath,
    plainPath,
  ]);
  return encryptedPath;
}

function main() {
  assertGuards();

  const dbUrl = process.env.SUPABASE_PROD_DB_URL;
  const outDir = resolve(
    arg('out-dir') ?? process.env.SUPABASE_PROD_BACKUP_OUT_DIR ?? './supabase-prod-backups'
  );
  mkdirSync(outDir, { recursive: true });

  const dateStr = new Date().toISOString().slice(0, 10);
  const dumpPath = join(outDir, `supabase-prod-${dateStr}.sql`);

  console.log(`Dumping the configured production database to ${dumpPath} ...`);
  try {
    execFileSync(
      'supabase',
      ['db', 'dump', '--db-url', dbUrl, '-f', dumpPath],
      { cwd: REPO_ROOT, stdio: 'inherit' }
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    refuse(`the Supabase CLI dump failed: ${redact(message, dbUrl)}`);
    return;
  }

  console.log('Encrypting the dump ...');
  const encryptedPath = encryptDump(dumpPath);
  unlinkSync(dumpPath);

  console.log(`Wrote ${encryptedPath}`);
  console.log(
    'Restore: decrypt this file (age --decrypt / gpg --decrypt, see this ' +
      'script\'s header comment for the exact command), then ' +
      '`psql "$SUPABASE_PROD_DB_URL" -f <decrypted file>`. Restore onto a ' +
      'fresh project, not one already carrying data, unless you mean a full ' +
      'destructive overwrite.'
  );
}

main();
