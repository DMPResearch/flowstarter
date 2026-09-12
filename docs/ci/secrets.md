# CI secrets and variables

The lanes run on Depot, from `.depot/workflows/`. **Depot does not read
GitHub's secret store**, so everything below has to be imported into Depot
directly and scoped to this repository:

```sh
depot ci secrets add <NAME> --repo DMPResearch/flowstarter
depot ci vars add <NAME> --repo DMPResearch/flowstarter
```

## Authentication and auth bypass

| Secret                              | Description                                  | Where to get it                            |
| ----------------------------------- | -------------------------------------------- | ------------------------------------------ |
| `E2E_SECRET`                        | Bypass token for `requireAuth()` in non-prod | Copy from `.env.local`, must match server  |
| `E2E_USER_ID`                       | Clerk user ID for E2E test account           | Clerk dashboard, Users, E2E test user      |
| `HANDOFF_SECRET`                    | HMAC key for signing handoff tokens          | Copy from `.env.local` `HANDOFF_SECRET`    |
| `CLERK_SECRET_KEY`                  | Clerk backend secret key                     | Clerk dashboard, API Keys                  |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key (var)                  | Clerk dashboard, API Keys                  |

## Supabase

| Secret                          | Description                                            |
| ------------------------------- | ------------------------------------------------------ |
| `NEXT_PUBLIC_SUPABASE_URL`      | Hosted project URL, read by the quality gate           |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Hosted project anon/public key                         |
| `SUPABASE_SERVICE_ROLE_KEY`     | Service role key, not used by any lane today           |

## Production (Hetzner `prod` slot)

Production is a Docker container on the Hetzner box, slot `prod`, port 3100,
published only by `.depot/workflows/release.yml` on a release tag. See
`docs/release-process.md` and `deploy/hetzner-staging/README.md`.

The `PROD_*` names exist so the production values can never be reached by a
staging lane, and the staging values can never be reached by the release lane.
Both sets of `NEXT_PUBLIC_*` are inlined into a client bundle at build time, so
one wrong value ships a site pointed at the wrong database.

| Secret / var                                  | Description                                                                                                                                  |
| --------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------- |
| `PROD_NEXT_PUBLIC_SUPABASE_URL`               | Build-time `NEXT_PUBLIC_SUPABASE_URL` for the production image: the hosted project. `deploy-prod` fails if it resolves to a loopback host.    |
| `PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY`          | Build-time `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the production image                                                                          |
| `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (var) | Build-time Clerk publishable key for production. Becomes a `pk_live_` key when production moves to its own Clerk instance.                    |
| `PROD_URL` (var)                              | `https://flowstarter.net`. Default when unset.                                                                                                |

`NEXT_PUBLIC_SITE_URL` is not a secret: the release lane hard-codes
`https://flowstarter.net`, staging hard-codes its own hostnames.

Every one of these is **required**. Unlike the staging lanes, `deploy-prod`
fails rather than warns and skips when one is missing.

## GHCR

Every slot pulls its image from GHCR, so the same credential serves staging and
production.

| Secret / var          | Description                                                                            |
| --------------------- | -------------------------------------------------------------------------------------- |
| `GHCR_TOKEN`          | Classic PAT with `write:packages` (fine-grained PATs cannot push to GHCR)               |
| `GHCR_USERNAME` (var) | GitHub login that owns `GHCR_TOKEN` (e.g. `dmihai91`), not `github.actor`               |

Images published: `ghcr.io/<owner>/flowstarter-main:<sha>` and `:main` from the
staging lane, `:pr-<n>` from the PR lane, `:<release-tag>` and `:prod` from the
release lane. `:prod` is a moving pointer at whatever is live; a rollback names
the release tag, never `:prod`.

## SSH to the Hetzner box

One box, one key, three kinds of slot. The names still say `STAGING_` for
continuity with the staging lanes that predate the production cutover.

| Secret                       | Description                                                              |
| ---------------------------- | ------------------------------------------------------------------------ |
| `STAGING_SSH_HOST`           | Hetzner host hostname or IP                                              |
| `STAGING_SSH_USER`           | SSH user with permission to run `sudo /opt/flowstarter/staging/*.sh`     |
| `STAGING_SSH_KEY`            | Private key (PEM) for that user                                          |

Absent, the two staging lanes warn and skip (the image still builds), and the
PR-preview lanes (`e2e-smoke.yml`, `visual-check.yml`, `opencode-review.yml`)
warn and skip because no slot can exist for the commit. `deploy-prod` **fails**.

## Hetzner platform staging

Main and per-PR slots run as Docker containers on the Caddy host, separate from
client sites under `/var/www/sites`. See `deploy/hetzner-staging/README.md`.

The staging database is the Supabase CLI local stack running on the Hetzner
host itself, bound to loopback. The two staging lanes never read the hosted
`NEXT_PUBLIC_SUPABASE_URL` / `NEXT_PUBLIC_SUPABASE_ANON_KEY` secrets above, and
never fall back to them.

| Secret / var                 | Description                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `STAGING_URL` (var)          | `https://staging.flowstarter.dev`                                                                                                                                                                                                                                                                                                                                                                                  |
| `STAGING_SUPABASE_URL` (var) | Build-time `NEXT_PUBLIC_SUPABASE_URL` for the staging image. Default `http://127.0.0.1:54321`. The workflow fails the build if this is ever set to anything containing `supabase.co` or that does not parse as a loopback/docker-internal host.                                                                                                                                                                    |
| `STAGING_SUPABASE_ANON_KEY`  | Build-time `NEXT_PUBLIC_SUPABASE_ANON_KEY` for the staging image: the Supabase CLI stack's demo anon key. Not a real credential (it is the same key every `supabase start` mints from the published demo JWT secret), but still kept out of the tree because secret scanners flag anything shaped like a Supabase key. When absent, the staging deploy lanes warn and skip the rest of the job instead of failing. |

Also needed at image build time: `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (var) for
staging, `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (var) for production.

## Review

| Secret / var                | Description                                                    |
| --------------------------- | -------------------------------------------------------------- |
| `OLLAMA_API_KEY`            | Required while a review tier holds an `ollama-cloud/*` model id |
| `OPENROUTER_API_KEY`        | Required when a tier holds an `openrouter/*` model id           |
| `GH_REVIEW_TOKEN`           | Optional fine-grained PAT the review comment posts under        |
| `AI_REVIEW_SMALL_MODEL` (var) | Default `ollama-cloud/glm-5.2`                                |
| `AI_REVIEW_BIG_MODEL` (var)   | Default `ollama-cloud/kimi-k3`                                |

## Notifications

| Secret                 | Description                                      |
| ---------------------- | ------------------------------------------------ |
| `SLACK_QA_WEBHOOK_URL` | Slack incoming webhook for QA channel (optional) |

## Optional fallback URLs

| Secret         | Description                                                                                                                        |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `E2E_BASE_URL` | Manual fallback URL for a local Playwright run. The CI lanes resolve their target from the Hetzner slot and do not read this.        |

---

## Workflow to secrets map

| Workflow                | Secrets needed                                                                                                                          |
| ----------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `quality-gate.yml`      | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`                                                                             |
| `e2e-smoke.yml`         | `STAGING_SSH_*` (presence only), var `STAGING_URL`, plus Clerk + Supabase + `E2E_SECRET`/`E2E_USER_ID`/`HANDOFF_SECRET` for auth-gated specs |
| `visual-check.yml`      | `STAGING_SSH_*` (presence only), var `STAGING_URL`                                                                                      |
| `opencode-review.yml`   | `OLLAMA_API_KEY` or `OPENROUTER_API_KEY`, optional `GH_REVIEW_TOKEN`, `STAGING_SSH_*` (presence only)                                    |
| `staging-deploy.yml`    | `STAGING_SSH_*`, `GHCR_TOKEN` (+ var `GHCR_USERNAME`), `STAGING_SUPABASE_ANON_KEY` (+ var `STAGING_SUPABASE_URL`), Clerk publishable for image build |
| `staging-pr-deploy.yml` | same as staging-deploy                                                                                                                  |
| `release.yml`           | `PROD_NEXT_PUBLIC_SUPABASE_URL`, `PROD_NEXT_PUBLIC_SUPABASE_ANON_KEY`, `GHCR_TOKEN`, `STAGING_SSH_*`, optional Clerk operator secrets; vars `PROD_NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY`, `GHCR_USERNAME`, `PROD_URL`, `STAGING_URL` |
| `prod-synthetic.yml`    | optional `GH_REVIEW_TOKEN` (files the `production-alert` issue under a stable identity; absent, the workflow token does it); var `PROD_URL` |

`staging-migrate.yml` is retired: the cloud staging Supabase project it applied
migrations to no longer exists. Schema now moves with the `staging-deploy.yml`
main deploy, against the local Supabase CLI stack on the Hetzner host.

The `NETLIFY_AUTH_TOKEN` and `NETLIFY_SITE_ID` secrets are retired with Netlify
itself. Remove them from Depot; nothing reads them.
