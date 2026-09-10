# GitHub Actions — Required Secrets

Add all of these at: **Settings → Secrets and variables → Actions**.

## Authentication & Auth Bypass

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `E2E_SECRET` | Bypass token for `requireAuth()` in non-prod | Copy from `.env.local` — must match server |
| `E2E_USER_ID` | Clerk user ID for E2E test account | Clerk dashboard → Users → E2E test user |
| `HANDOFF_SECRET` | HMAC key for signing handoff tokens | Copy from `.env.local` `HANDOFF_SECRET` |
| `CLERK_SECRET_KEY` | Clerk backend secret key | Clerk dashboard → API Keys |
| `NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` | Clerk publishable key | Clerk dashboard → API Keys |

## Supabase

| Secret | Description |
|--------|-------------|
| `NEXT_PUBLIC_SUPABASE_URL` | `https://avptvzherjxymmbtbbbr.supabase.co` |
| `NEXT_PUBLIC_SUPABASE_ANON_KEY` | Supabase anon/public key |
| `SUPABASE_SERVICE_ROLE_KEY` | Service role key (used by Netlify functions, not by GH Actions today) |

## Netlify (Deploy Previews + release production)

PR Deploy Previews are still built by Netlify's GitHub App (0 credits on
credit plans). **Production** is published only by `.depot/workflows/release.yml`
via `netlify deploy --prod` on a release tag. Automatic production builds from
`main` are skipped in `netlify.toml`.

| Secret | Description | Where to get it |
|--------|-------------|-----------------|
| `NETLIFY_AUTH_TOKEN` | Personal access token with **deploy** access to the site | Netlify → User settings → Applications → Personal access tokens |
| `NETLIFY_SITE_ID` | UUID of `flowstarter-landing` | Netlify → Site settings → General → API ID (`8cd74d1b-a08a-4746-b77b-61ae37f70b12`) |

## Hetzner platform staging

Main and per-PR slots run as Docker containers on the Caddy host, separate from
client sites under `/var/www/sites`. See `deploy/hetzner-staging/README.md`.

| Secret / var | Description |
|--------------|-------------|
| `STAGING_SSH_HOST` | Hetzner host hostname or IP |
| `STAGING_SSH_USER` | SSH user with permission to run `sudo /opt/flowstarter/staging/*.sh` |
| `STAGING_SSH_KEY` | Private key (PEM) for that user |
| `STAGING_URL` (var) | `https://staging.flowstarter.dev` |

Also needed at image build time (already used by other lanes):
`NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY`,
`NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY` (var).

## Notifications

| Secret | Description |
|--------|-------------|
| `SLACK_QA_WEBHOOK_URL` | Slack incoming webhook for QA channel (optional) |

## Optional fallback URLs

| Secret | Description |
|--------|-------------|
| `E2E_BASE_URL` | Manual fallback URL for smoke tests when no Netlify Deploy Preview is available (rarely used; the wait script is the canonical path) |

---

## Workflow → Secrets map

| Workflow | Secrets needed |
|----------|----------------|
| `quality-gate.yml` | `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` |
| `e2e-smoke.yml` | `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, plus Clerk + Supabase + `E2E_SECRET`/`E2E_USER_ID`/`HANDOFF_SECRET` for any auth-gated specs |
| `staging-deploy.yml` | `STAGING_SSH_*`, GHCR via `GITHUB_TOKEN`, Supabase + Clerk publishable for image build |
| `staging-pr-deploy.yml` | same as staging-deploy |
| `release.yml` | `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, optional Clerk operator secrets; var `STAGING_URL` |
