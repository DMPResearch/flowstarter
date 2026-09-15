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

**PR #175 is open, not yet merged.** It adds:

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

Until #175 merges, a full disk on `fs-sites-01` still means running the
prune commands above by hand and confirming `docker system df` before
retrying a failed deploy.

## The rule

Do not let a deploy lane run unbounded image growth again: once #175 is
merged and deployed, the preflight is what enforces the floor, not a human
noticing the disk is full. If the floor check itself starts failing deploys
that should succeed, adjust `FLOWSTARTER_IMAGE_KEEP_COUNT` /
`FLOWSTARTER_DISK_FLOOR_MB`, do not remove the check.

See also `docs/dev-machine.md`, "Staging and production on Hetzner", and
`deploy/hetzner-staging/README.md`.
