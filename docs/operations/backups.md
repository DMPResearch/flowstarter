# Backups

Before this, there were none: not for the hosted production Supabase
project, not for the Supabase CLI stack that is staging's (and, on the Hetzner
box, the box's own) database, not for `/var/www/sites/` where customer sites
live. `terms/page.tsx` promised clients "automated backups" while none
existed anywhere in the repository or on any host. See
`docs/quality/mvp-readiness-2026-09-12.md`, "Data", and launch checklist
items 6 and 7.

There are two, separate backup paths, because there are two separate
databases (see `deploy/hetzner-staging/README.md`, "Database"):

1. **The box** (`deploy/hetzner-staging/scripts/backup.sh` /
   `restore.sh`): the Supabase CLI stack running on the Hetzner host (which is
   staging's and, if it is ever used there too, the box's own database), the
   client sites tree, and the host's own secrets.
2. **The hosted production project** (`scripts/supabase-prod-backup.mjs`):
   a logical dump taken from an operator's own machine, never from CI or the
   box.

## 1. The box

### What is backed up

Nightly, via `flowstarter-backup.timer` (see "Installation" below), as root:

- **Every Supabase CLI stack database on the host.** Discovered by container
  name pattern (`supabase_db_<project_id>`, e.g. `supabase_db_flowstarter`)
  rather than one hardcoded name, so a host running more than one stack still
  gets all of them. Each is dumped with `pg_dump -U postgres -Fc` run
  **inside** its own container (custom format, already compressed; nothing
  reaches into the container's filesystem or port).
- **`/var/www/sites/`**, the client sites tree deploy-agent writes to, tarred
  and gzipped. Not secret, not encrypted.
- **`/etc/flowstarter/`**, the host's env files and TLS keys, tarred, gzipped,
  and then encrypted (see "Encryption" below). This is the one artifact that
  matters if the backup itself leaks.

Everything lands under `/var/backups/flowstarter/<UTC date>/`, alongside a
`manifest.sha256` of every artifact in that directory, so `restore.sh` (and a
human) can verify an artifact has not been corrupted or tampered with before
trusting it.

### Retention

`BACKUP_KEEP_DAILY` (default 7) most recent dated directories are always
kept. Beyond that, directories are grouped into runs of 7 (one nightly backup
per elapsed day, so a run of 7 approximates a calendar week without parsing a
weekday out of a directory name) and the oldest survivor of each of the most
recent `BACKUP_KEEP_WEEKLY` (default 4) runs is kept. Everything else is
deleted. Both counts are env-configured, never a bare number in the deletion
logic.

### Encryption

Chosen at runtime, never hardcoded to one tool:

- **`age`**, if it is on `PATH` (Ubuntu 24.04's own `apt` carries it). The
  recipient (public key) comes from `BACKUP_AGE_RECIPIENT_FILE` (a file
  holding one age public key) or `BACKUP_AGE_RECIPIENT` (the key given
  inline).
- **`gpg --symmetric`**, if `age` is not installed. The passphrase comes from
  `BACKUP_GPG_PASSPHRASE_FILE` (default
  `/etc/flowstarter/backup-gpg-passphrase`), which must exist and be mode
  `600`. The script refuses outright, rather than falling back to a weaker
  default or an interactive prompt, if that file is missing or its mode is
  wrong: a nightly timer failing loudly beats it silently encrypting with
  something nobody meant to use.

### Off-box copy (optional)

Set `BACKUP_S3_BUCKET` (plus optionally `BACKUP_S3_ENDPOINT` for an
S3-compatible provider other than AWS, and `BACKUP_S3_PREFIX`, default the
host's own hostname) to also push the dated directory to an S3-compatible
bucket, using whichever of `rclone` or the `aws` CLI is on `PATH`. Unset,
this step is skipped cleanly, no error. A failed upload does **not** undo or
re-run the local backup — the dump and tarballs already on disk are what
`restore.sh` and a human trust — but it does make the script exit non-zero
once every local step has finished, so a nightly timer's failed remote copy
shows up in `systemctl status` / the journal rather than only ever being
found the day someone needs it.

### Restoring

```sh
# See what would happen, touch nothing:
restore.sh --date 2026-09-10 --database flowstarter --dry-run

# Restore one Supabase CLI stack's database (its own container must already
# be running; this restores INTO it):
restore.sh --date 2026-09-10 --database flowstarter

# Restore the whole client sites tree, or one site:
restore.sh --date 2026-09-10 --site --dry-run
restore.sh --date 2026-09-10 --site acme-widgets --force
```

`<project_id>` after `--database` is the same value `supabase/config.toml`'s
`project_id` uses for the stack being restored — `backup.sh` names the dump
file after the container it came from, `supabase_db_<project_id>`. There is
no default and none is guessed.

Every real (non-`--dry-run`) restore first verifies the artifact's sha256
against `manifest.sha256` and refuses if it does not match — a backup that
fails its own checksum is not something to restore from blind. A site
directory that already exists on disk is never overwritten without `--force`.

`/etc/flowstarter` is never restored by this script. Putting secrets back
onto a box is rare and dangerous enough to stay a deliberate, by-hand
operation: decrypt with `age --decrypt` or `gpg --decrypt` (whichever
`backup.sh` used, by the same recipient/passphrase), then `tar -xzf` it
yourself.

Database restore shape, for reference:

```sh
docker exec -i supabase_db_<project_id> pg_restore -U postgres -d postgres --clean --if-exists <dump-file>
```

(`restore.sh` does this for you once the checksum passes; shown here so the
shape is not a mystery if you ever need to do it by hand.)

### The drill

Rehearse this on a disposable host or the local Supabase CLI stack, not
production:

1. Run `backup.sh` once (or wait for the timer) and note the date directory
   it wrote.
2. `restore.sh --date <that date> --database <project_id> --dry-run` and read
   the plan.
3. Actually restore into a **throwaway** stack (never a live one you care
   about) and confirm the data lands: `docker exec supabase_db_<project_id>
   psql -U postgres -d postgres -c '\dt'` and spot-check a row you know was
   there.
4. Do the same for `--site`, into a scratch directory, and diff it against
   the live tree.

If either step fails, that is the drill working: fix it before the box needs
it for real.

### Installation

Wired into the bundle's "One-time box setup" in
`deploy/hetzner-staging/README.md`: the scripts are copied alongside the
existing ones, `/etc/flowstarter/backup.env` holds the `BACKUP_*`
configuration (mode 600, mirroring `staging.env`/`prod.env`), and
`flowstarter-backup.timer` (nightly, jittered with `RandomizedDelaySec`, and
`Persistent=true` so a box that was off at 03:00 still runs the next time it
boots) drives `flowstarter-backup.service`, a oneshot unit. See that README
for the exact commands; the next host provisioned from the bundle gets this
by construction, not by an operator remembering an extra step.

## 2. The hosted production Supabase project

The hosted project's own backup setting (Supabase's dashboard toggle) is a
separate, Darius-only decision — see the end of this document. Independent
of that, `scripts/supabase-prod-backup.mjs` takes a logical dump through the
Supabase CLI:

```sh
FLOWSTARTER_ENV=production \
FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1 \
SUPABASE_PROD_DB_URL='postgres://...' \
node scripts/supabase-prod-backup.mjs
```

Both `FLOWSTARTER_ENV=production` and `FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1`
are required together, or the script refuses outright. This mirrors the
existing rule enforced everywhere else in the product
(`apps/flowstarter-main/src/lib/supabase-target.ts`) that nothing but a
deliberate, explicit production run may talk to anything other than the
loopback local stack. `SUPABASE_PROD_DB_URL` is never read from a repo file
and never printed, by the script or by anything it shells out to.

**Run this from your own machine, never from CI.** `SUPABASE_PROD_DB_URL`
must never become a CI secret exposed to a pull-request workflow — a fork PR
or a compromised dependency in that lane would then have a path to the
production database's connection string. There is no automation for this
today; it is a manual, occasional operator action until an operator machine
runs it on a schedule of its own (cron, launchd, whatever the operator
already uses), which is deliberately out of scope for this repository.

The dump is encrypted the same way `backup.sh`'s `/etc/flowstarter` tarball
is (age if available, else gpg symmetric with a mode-600 passphrase file,
`BACKUP_AGE_RECIPIENT_FILE`/`BACKUP_AGE_RECIPIENT`/`BACKUP_GPG_PASSPHRASE_FILE`
read the same way). `supabase db dump` has no custom-format (`-Fc`)
equivalent — it always writes a plain SQL script — so the restore is `psql`,
not `pg_restore`:

```sh
age --decrypt -o dump.sql supabase-prod-2026-09-12.sql.age
# or: gpg --batch --yes --decrypt --passphrase-file <file> -o dump.sql supabase-prod-2026-09-12.sql.gpg
psql "$SUPABASE_PROD_DB_URL" -f dump.sql
```

Output defaults to `./supabase-prod-backups/` (relative to wherever you run
the script from, not the repo root — `SUPABASE_PROD_BACKUP_OUT_DIR` or
`--out-dir` overrides it). The full detail, including the CI refusal
(`CI` set refuses outright, independent of the two required env vars), is in
the script's own header comment.

### What still needs Darius

- **Turning on the hosted project's own dashboard backup setting** (Supabase
  Pro plans include point-in-time recovery; the free tier does not). This
  script is a second, independent copy, not a replacement for that setting —
  use both.
- **Deciding where the encrypted dumps and the box's `BACKUP_S3_*` copies
  live long-term.** No S3-compatible bucket exists yet; until one is
  provisioned and `BACKUP_S3_BUCKET` is set, both backup paths are
  local-only (the box's own disk, and whatever disk `supabase-prod-backup.mjs`
  is run from).
- **Choosing and distributing the age key pair or the gpg passphrase**, and
  storing the private half somewhere that is not the box being backed up —
  an encrypted backup an operator cannot decrypt is not a backup.
- **Actually running the drill above once**, on a real (disposable) host,
  before relying on any of this for the first paying customer.

See also `docs/operations/alerts.md` and `docs/release-process.md`.
