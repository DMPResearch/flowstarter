# Release process

One release per week (or on demand). **`main` does not publish production.**
Merges update Hetzner staging; the release workflow tags `main`, verifies
staging, builds the image for that tag and deploys it to the Hetzner `prod`
slot at `https://flowstarter.net`.

Netlify is gone. Production, staging and every PR preview now run as Docker
containers on the same Hetzner box, published by
`deploy/hetzner-staging/scripts/deploy-slot.sh` over SSH.

The whole thing lives in `.depot/workflows/release.yml`. Staging continuous
deploys live in `.depot/workflows/staging-deploy.yml` (main) and
`.depot/workflows/staging-pr-deploy.yml` (per-PR slots).

Two related documents: `docs/operations/backups.md` (what is backed up,
where, and how to restore it) and `docs/operations/alerts.md` (who gets told
when a build, an email or the production health check fails, and how the
noise stays bounded).

## Where production runs

| Thing | Value |
| --- | --- |
| Slot | `prod` |
| Hostnames | `flowstarter.net`, `www.flowstarter.net` (301 to the apex) |
| Host port | 3100, bound to 127.0.0.1, reached only through Caddy |
| Container | `flowstarter-prod` |
| Compose project | `fs-prod` |
| Env file | `/etc/flowstarter/prod.env` (mode 600, `FLOWSTARTER_ENV=production`) |
| Image | `ghcr.io/dmpresearch/flowstarter-main:<release-tag>`, also tagged `:prod` |
| Database | the hosted Supabase project, not the host's local CLI stack |
| Health gate | `/api/health` must report `"ok":true` and `"env":"production"` |

Cloudflare stays **proxied** in front of `flowstarter.net`. Caddy therefore
never sees an ACME challenge and does not ask for a public certificate:
`deploy-slot.sh` writes `tls <crt> <key>` when a Cloudflare Origin CA
certificate is present at `/etc/flowstarter/tls/flowstarter.net.{crt,key}`
(pair that with Cloudflare SSL/TLS **Full (strict)**), and `tls internal`
otherwise (Cloudflare SSL/TLS must then be **Full**, not Full strict). See
`deploy/hetzner-staging/README.md`.

The `prod` slot runs none of the Supabase CLI stack steps. `ensure`, `check`,
`migrate` and `write-env` are staging-only. Production schema changes are
applied deliberately, by hand, against the hosted project.

## The week

| When | What happens |
| --- | --- |
| Every merge to `main` | Depot builds a Docker image and deploys slot `main` to `https://staging.flowstarter.dev` |
| Every PR | Depot deploys slot `pr-<n>` to `https://pr-<n>.staging.flowstarter.dev` (destroyed when the PR closes) |
| Monday 06:00 UTC | Release lane tags `main` as `release-YYYY-MM-DD` and opens a **draft** GitHub Release |
| Immediately after | Staging journey (when `STAGING_URL` is set), then the production image build and `prod` slot deploy, then production contract + synthetic (+ auth journey when credentials exist) |
| Minutes later | If verification passed, the draft is published and marked latest. If it failed, the draft stays a draft and the workflow goes red |

## The jobs

1. **prepare** creates the annotated tag, pushes it, and opens the draft release.
2. **staging-journey** runs `e2e/**/*.journey.spec.ts` against `vars.STAGING_URL`.
3. **deploy-prod** builds the release tag with the production `NEXT_PUBLIC_*`
   values and `BUILD_LIBRARY_PREVIEWS=true`, pushes
   `ghcr.io/<owner>/flowstarter-main:<tag>` and `:prod`, then runs
   `deploy-slot.sh prod <image> 3100` over SSH.
4. **full-e2e** first verifies the `prod` slot this run deployed, directly, with
   `curl --resolve <apex>:443:<box-ip>` — that check never skips, because it is
   the only one guaranteed to be looking at the image just built. It then runs
   contract + production synthetic (+ optional auth) against `vars.PROD_URL`,
   **but only once the apex is actually served by the box**. While Netlify
   still answers there (detected by its `x-nf-request-id` header) those suites
   skip with a loud warning rather than test the old host and report it as
   production verification.
5. **publish** appends verification notes and publishes or holds the draft.

`BUILD_LIBRARY_PREVIEWS=true` is set by **every** lane that builds an image —
this one and both staging lanes. It builds the Astro library templates into
`public/preview/<slug>/` inside the image, because the public `/library` pages
iframe them.

Staging used to leave it false, to keep PR images cheap. That was changed on
2026-09-12: a slot with empty iframes is not a rehearsal of production, and
`e2e/templates-audit.spec.ts` requires `/preview/<slug>/` to answer 2xx for
every template marked `hasPreview`. No staging slot could satisfy that, which
only ever looked fine because the smoke lane was skipping for want of a healthy
slot to point at.

## Rollback

Redeploy the previous tag's image. There is nothing to revert in git and
nothing to rebuild:

```sh
ssh <user>@<hetzner-host>
sudo /opt/flowstarter/staging/deploy-slot.sh prod \
  ghcr.io/dmpresearch/flowstarter-main:release-2026-09-07 3100
```

`deploy-slot.sh` pulls the image, restarts `flowstarter-prod`, waits for
`/api/health` to report `"env":"production"`, and only then rewrites the Caddy
snippet. A rollback that fails its health gate leaves the previous container's
snippet in place rather than pointing the apex at something broken.

Two things a rollback does **not** undo:

- **Database migrations.** Production schema is applied by hand against the
  hosted project; rolling the image back does not roll the schema back. Write
  migrations so the previous image can still run against the new schema. A
  bad hand-applied migration is now recoverable from a backup rather than
  unrecoverable outright, see `docs/operations/backups.md` and
  `scripts/supabase-prod-backup.mjs` — but restoring a logical dump is still
  slower and more destructive than a forward-fixing migration, so treat it as
  the last resort it is.
- **The `:prod` tag.** It is a moving pointer at whatever the release lane last
  pushed, so it is useless for rolling back. Always name the release tag.

Announce an out-of-band redeploy so the synthetic checks it:

```sh
gh api repos/DMPResearch/flowstarter/dispatches -f event_type=prod-deploy-succeeded
```

## What blocks a release

A job that **ran and failed** blocks it. A job that **skipped** does not.
Missing Clerk credentials or an unset `STAGING_URL` warn and skip on purpose.
`deploy-prod` never skips: a missing secret **fails** it, because publishing
production is the point of a release.

## After a release: Stripe webhooks

A deploy replaces the container the Stripe webhook lands on, so some deliveries
during the switch get a connection error or a 500. That is expected and safe:
the route only answers 200 once the state is in the database, and every event
is written to `public.stripe_events` before it is processed, so Stripe's retry
finds work rather than an acknowledgement. Nothing is processed twice — an
event already stamped `processed_at` is skipped and acknowledged — and an event
that arrives out of order after the outage cannot overwrite newer state.

After a release, check for events the retries never got through:

```sql
select id, type, object_id, attempts, last_error
from stripe_events
where processed_at is null
order by received_at desc;
```

Anything listed there is a payment or subscription change that has not been
applied. `docs/billing/webhooks.md` has the whole contract, the ledger schema,
and how to reprocess one event by id.

## Secrets and variables

Depot does not read GitHub's secret store. Import with
`depot ci secrets add` / `depot ci vars add` (see `AGENTS.md` and
`docs/ci/secrets.md`).

| Name | Kind | Absent means |
| --- | --- | --- |
| `E2E_CLERK_OPERATOR_EMAIL` / `PASSWORD` | secret | authenticated journey skips |
| `CLERK_SECRET_KEY` | secret | authenticated journey skips |
| `PROD_NEXT_PUBLIC_SUPABASE_URL` | secret | `deploy-prod` fails |
| `PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY` | secret | `deploy-prod` fails |
| `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | var | `deploy-prod` fails |
| `GHCR_TOKEN` | secret | `deploy-prod` fails |
| `GHCR_USERNAME` | var | `deploy-prod` fails |
| `STAGING_SSH_HOST` / `_USER` / `_KEY` | secret | staging deploys skip; `deploy-prod` **fails** |
| `PROD_URL` | var | defaults to `https://flowstarter.net` |
| `STAGING_URL` | var | set to `https://staging.flowstarter.dev` |

`STAGING_SSH_*` are named for staging but address one box that runs both. The
`prod` slot is deployed with the same credentials.

`deploy-prod` refuses to build if `PROD_NEXT_PUBLIC_SUPABASE_URL` resolves to a
loopback host: that is a staging value, and a production image built against it
would serve a site pointed at a database nobody outside the box can reach.

## Running one by hand

```
depot ci dispatch --repo DMPResearch/flowstarter --workflow release.yml --ref main
```

Inputs: `ref` (default `main`) and `tag` (default `release-YYYY-MM-DD`).

## Journey specs

`e2e/**/*.journey.spec.ts` is the full-journey tier on staging. Name new
journey specs that way; they never run on a pull-request smoke lane.
