# Staging disk exhaustion, 2026-09-15

The root disk (150 GB) on `fs-sites-01` filled to 100%. Every deploy pulls
its own tagged `ghcr.io/dmpresearch/flowstarter-main:<sha>` image (1.6 to
2.05 GB each) and nothing removed an old one — 173 images had accumulated,
132.6 GB reclaimable by the time anyone noticed. The local Supabase DB
container went unhealthy on the full disk, and every staging deploy lane
(`main` and every `pr-<n>`) failed at "ensure stack" as a result.

Cleaned up by hand at the time: `docker image prune -af --filter until=1h`,
`docker builder prune -af`.

## The fix

**PR #175 merged.** It added:

- `deploy/hetzner-staging/scripts/prune-images.sh` — keeps every image a
  running container uses, plus the `FLOWSTARTER_IMAGE_KEEP_COUNT` (default 5)
  most recently created images in `FLOWSTARTER_IMAGE_REPO` (default
  `ghcr.io/dmpresearch/flowstarter-main`), removes the rest with a
  non-forced `docker rmi`, and prunes dangling build cache. `--dry-run`
  prints what a real pass would do without removing anything.
- `deploy-slot.sh` runs that script twice per deploy: as a **preflight**,
  before anything else, refusing to deploy if free space on `/` is still
  below `FLOWSTARTER_DISK_FLOOR_MB` (default 10 GiB) after the retention
  pass; and again, best-effort, after a successful deploy.
- `destroy-slot.sh` resolves and removes a closed slot's own image if no
  other container still uses it, so it does not wait on the keep-count to
  reach it.

## The rule

Do not let a deploy lane run unbounded image growth again: the preflight is
what enforces the floor, not a human noticing the disk is full. If the floor
check itself starts failing deploys that should succeed, adjust
`FLOWSTARTER_IMAGE_KEEP_COUNT` / `FLOWSTARTER_DISK_FLOOR_MB`, do not remove
the check.

## The disk filled again anyway, same day

Merging #175 did not put it on the box. `deploy-slot.sh` (like every script
under `deploy/hetzner-staging/scripts/`) only ever reached `fs-sites-01` via
a one-time manual `cp` at bootstrap — nothing in CI ever updated it after
that. So `main` had the retention fix, `staging-deploy.yml` kept "deploying"
successfully, and the box kept running `deploy-slot.sh` from commit
`e813c99d1` regardless: no preflight, no retention, no floor check, because
none of that code was actually running there. The disk filled again, and it
was found and fixed by hand a second time, the same night.

**The fix for the fix:** `staging-deploy.yml`'s sync step now tars
`deploy/hetzner-staging/scripts/` alongside `supabase/` on every push to
`main`, and `sync-supabase.sh` — the one script already allowlisted in
`/etc/sudoers.d/flowstarter-deploy` (`FLOWSTARTER_SLOTS =
/opt/flowstarter/staging/*.sh`, which covers installing any script under
that glob, not just running one) — installs whichever `*.sh` files changed
into `/opt/flowstarter/staging/`, atomically, only when the content
actually differs. A "Verify installed scripts match the repo" step right
after compares sha256 sums between the checkout and the host and fails the
deploy loudly if they ever disagree again. No sudoers change was needed.
See `deploy/hetzner-staging/README.md`, "What CI is allowed to run as
root", and `sync-supabase.sh`'s own header comment.

So: merging a fix to a script under `scripts/` is no longer the end of the
story by itself, but it also no longer needs a follow-up manual install —
the very next `staging-deploy` run puts it on the box and proves it did.

See also `docs/dev-machine.md`, "Staging and production on Hetzner", and
`deploy/hetzner-staging/README.md`.
