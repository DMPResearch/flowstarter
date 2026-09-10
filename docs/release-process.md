# Release process

One release per week (or on demand). **`main` does not publish to Netlify.**
Merges update Hetzner staging; the release workflow tags `main`, verifies
staging, then runs `netlify deploy --prod` for that tag (15 Netlify credits).

The whole thing lives in `.depot/workflows/release.yml`. Staging continuous
deploys live in `.depot/workflows/staging-deploy.yml` (main) and
`.depot/workflows/staging-pr-deploy.yml` (per-PR slots).

## The week

| When | What happens |
| --- | --- |
| Every merge to `main` | Depot builds a Docker image and deploys slot `main` → `https://staging.flowstarter.dev` |
| Every PR | Depot deploys slot `pr-<n>` → `https://pr-<n>.staging.flowstarter.dev` (destroyed when the PR closes) |
| Monday 06:00 UTC | Release lane tags `main` as `release-YYYY-MM-DD` and opens a **draft** GitHub Release |
| Immediately after | Staging journey (when `STAGING_URL` is set), then Netlify production deploy of the tag, then production contract + synthetic (+ auth journey when credentials exist) |
| Minutes later | If verification passed, the draft is published and marked latest. If it failed, the draft stays a draft and the workflow goes red |

## The jobs

1. **prepare** creates the annotated tag, pushes it, and opens the draft release.
2. **staging-journey** runs `e2e/**/*.journey.spec.ts` against `vars.STAGING_URL`.
3. **deploy-prod** checks out the tag and runs `netlify deploy --prod --build`.
4. **full-e2e** runs contract + production synthetic (+ optional auth) against `vars.PROD_URL` (default `https://flowstarter.net`).
5. **publish** appends verification notes and publishes or holds the draft.

## What blocks a release

A job that **ran and failed** blocks it. A job that **skipped** does not.
Missing Clerk credentials or an unset `STAGING_URL` warn and skip on purpose.
Missing Netlify credentials **fail** `deploy-prod` (production publish is the point of the release).

## Secrets and variables

Depot does not read GitHub's secret store. Import with
`depot ci secrets add` / `depot ci vars add` (see `AGENTS.md` and
`docs/ci/secrets.md`).

| Name | Kind | Absent means |
| --- | --- | --- |
| `E2E_CLERK_OPERATOR_EMAIL` / `PASSWORD` | secret | authenticated journey skips |
| `CLERK_SECRET_KEY` | secret | authenticated journey skips |
| `NETLIFY_AUTH_TOKEN` / `NETLIFY_SITE_ID` | secret | `deploy-prod` fails |
| `STAGING_SSH_*` | secret | staging image builds but Hetzner deploy skips |
| `PROD_URL` | var | defaults to `https://flowstarter.net` |
| `STAGING_URL` | var | set to `https://staging.flowstarter.dev` |

## Running one by hand

```
depot ci dispatch --repo DMPResearch/flowstarter --workflow release.yml --ref main
```

Inputs: `ref` (default `main`) and `tag` (default `release-YYYY-MM-DD`).

## Netlify credits

| Event | Credits |
| --- | --- |
| PR Deploy Preview (optional, still enabled) | 0 |
| Automatic git production build | skipped (`netlify.toml` `[context.production] ignore`) |
| Release `netlify deploy --prod` | 15 |

## Journey specs

`e2e/**/*.journey.spec.ts` is the full-journey tier on staging. Name new
journey specs that way; they never run on a pull-request smoke lane.
