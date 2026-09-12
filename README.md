# <img src="apps/flowstarter-main/public/logos/flowstarter-mark.svg" alt="" width="32" height="32" /> Flowstarter

**Production:** [https://flowstarter.net](https://flowstarter.net)

Flowstarter is mostly self-service. A prospect brings business details and a
public brand; specialized AI agents research, pick an approved Astro template,
personalize a free preview, and build the full site after a deposit. A small
team supervises those agents, runs QA, and steps in when something needs a
human. Managed hosting, a care plan, and an AI editor keep the site useful
afterwards.

This is an Nx + pnpm monorepo. `AGENTS.md` is the source of truth for
conventions, tooling and CI; this file is a map to get a working checkout
and the commands that actually exist.

## How the product flow works today

The pipeline is a state machine (see
`packages/agentic-codegen/src/flowstarter/types.ts`):

`INTAKE -> PREVIEW_READY -> DEPOSIT_PAID -> AGENTS_WORKING -> HUMAN_QA -> LIVE_SUBSCRIPTION`

1. **Discovery and preview.** The prospect answers the discovery funnel on
   `flowstarter-main` (`src/app/api/discovery/**`). Deterministic rules
   (`lib/flowstarter/routing-rules.ts`), not an LLM, pick the pricing tier and
   routing. A template classifier and a template-library MCP server
   (`apps/flowstarter-library`, Astro sources in `apps/flowstarter-templates`)
   pick an approved template, and an agent pipeline in
   `packages/agentic-codegen` renders a personalized live preview in a
   Daytona-isolated sandbox.
2. **Deposit starts the build.** A Stripe payment (test mode outside
   production) for 20% of the quoted price (`depositAmountMinor` in
   `packages/agentic-codegen/src/flowstarter/state-machine.ts`) moves the
   project to `DEPOSIT_PAID` and enqueues one full-build job
   (`lib/flowstarter/deposit-workflow.ts`).
3. **Agents build; the team supervises.** `apps/build-worker` drains that
   job queue and drives the same agent pipeline to produce the full site.
   The small team reviews agent output in `HUMAN_QA` before launch; they
   are not rebuilding the site by hand.
4. **Balance, care plan, launch.** The remaining 80% plus a monthly or yearly care
   plan (an allowance of AI edits; see
   `lib/flowstarter/edit-credits.ts`) puts the project into
   `LIVE_SUBSCRIPTION`. The client dashboard
   (`src/app/(dynamic-pages)/dashboard/projects/[workspaceId]`) shows
   status, payments, remaining edit credits, and the in-dashboard AI site
   editor for the content the plan allows.
5. **Hosting.** Sites are static builds served by a shared multi-tenant
   Caddy host on Hetzner. `apps/deploy-agent` is the per-host service that
   receives an artifact, extracts it, writes the Caddy site config and
   reloads Caddy (`lib/hosting/cloud-init.ts` generates the host bootstrap).
   The agent supports a legacy filesystem runtime and a Docker runtime with
   a separate static Caddy container per site. The admin UI can connect an
   existing host. See [existing-host setup](docs/existing-hetzner-host.md).
   The Docker runtime passes local deployment smoke tests. A local end-to-end
   run (2026-09-11) verified discovery live preview on Daytona, guest Stripe
   test deposit, full-site build by `build-worker`, and transition into
   `HUMAN_QA` with a recorded deployment. Funnel Caddy hosting for the
   temporary preview still failed on that run: sandbox static compilation did
   not produce a root `index.html`, so `publishFunnelPreview` refused a
   source-only archive (the Daytona `astro dev` URL remained the visitor
   preview). Client dashboard UI verification still needs a signed-in session.

## Apps and packages

| Path | What it is |
|---|---|
| `apps/flowstarter-main` | The product: Next.js 16 (App Router), Clerk auth, Supabase data, Stripe billing, the discovery funnel, team/admin dashboards, client dashboard and editor, REST APIs. |
| `apps/build-worker` | Background worker (`tsx`) that drains the full-site-build job queue. Uses the Supabase service role, so it bypasses RLS and every query must filter by `workspace_id` by hand (enforced by a static test). |
| `packages/agentic-codegen` | The generation pipeline: Pi SDK agents (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) over OpenRouter, template selection, prompts, and the git worktree policy the worker's commits must follow. |
| `apps/flowstarter-library` / `apps/flowstarter-templates/*` | Astro template sources and the MCP server that serves them to the agent pipeline. |
| `apps/deploy-agent` | Bun HTTP service running on each Hetzner Caddy host: receives a built artifact, extracts it, writes the per-site Caddy snippet, reloads Caddy. Supports filesystem and isolated Docker site runtimes (see `apps/deploy-agent/README.md`). |
| `apps/flowstarter-editor` | A separate multi-tenant editor forked from T3 Code. Out of scope for most current work; not part of the active build/edit flow above. |
| `apps/flowstarter-selfserve` | A separate, newer self-serve funnel experiment (its own pricing, Convex-backed live build state). Not the main product flow described above. |
| `apps/shopify-landing` | Small marketing app. Out of scope for most changes. |
| `packages/platform-config` | Single source of truth for domains/URLs. Never hardcode a domain; derive it from `PLATFORM_DOMAIN`/hostname, or from `resolvePlatformDomain()`'s env rule (`flowstarter.net` in production, `flowstarter.dev` in development/test/staging) when neither is available. |
| `packages/flow-design-system`, `packages/daytona-utils`, `packages/build-engine`, `packages/build-orchestrator`, `packages/idea-validation`, `packages/supabase-utils` | Shared UI kit and supporting libraries used by the apps above. |

Database: `supabase/migrations` is the schema. The local Supabase stack on
`127.0.0.1:54321` is the only database a developer or an agent touches; the
hosted project is for production only.

## Develop

Use Node 22 and pnpm 10.29.2. Copy
`apps/flowstarter-main/.env.example` to `.env.local` in that same directory
and configure the integrations needed for your flow. Development database
credentials must point to the local Supabase stack. Preview generation also
needs the template library, OpenRouter, and Daytona configured; starting the
Next.js app alone does not start those services.

```sh
pnpm install
pnpm dev                    # repo root: mprocs (needs a TTY)
```

Or run one app directly:

```sh
pnpm dev:main                # flowstarter-main, next dev on :3000
pnpm dev:build-worker         # or dev:build-worker:local for a stubbed agent
pnpm dev:deploy-agent
pnpm dev:editor
```

Local Supabase:

```sh
pnpm db:start                # starts the local stack
pnpm db:env                  # points flowstarter-main's dev server at it
pnpm db:stop
pnpm db:reset
```

`pnpm db:env` reads `supabase status` and writes
`apps/flowstarter-main/.env.development.local` (gitignored, regenerated
every time you run it) with the local stack's URL and keys. `pnpm
dev:supabase` runs both in order. Development refuses to start against a
hosted Supabase project: `src/lib/supabase-target.ts` throws unless the
target is local, or `FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1` is set explicitly.

Common Nx targets work per project too: `npx nx build <project>`,
`npx nx typecheck <project>`, `npx nx test <project>`.

## Validation commands

These are the commands CI and the pre-commit hook actually run (see
`AGENTS.md` for the full breakdown, coverage floors and CI lanes):

```sh
pnpm run ci:quality-gate      # lint + typecheck + flowstarter-main tests

pnpm --dir apps/flowstarter-main lint
pnpm nx run flowstarter-main:typecheck
pnpm nx run flowstarter-main:test
pnpm --dir packages/agentic-codegen test
pnpm --dir apps/build-worker test

pnpm run ci:smoke:platform    # Playwright, playwright.config.ts
```

Each test suite also has `test:coverage`; `node scripts/coverage-ratchet.mjs`
enforces the coverage floors in `coverage-floors.json`.

## Notes

- `pnpm dev` at the repo root runs `mprocs` and needs an interactive
  terminal; in a non-TTY context run an app's own `dev` script instead.
- Pre-commit runs the quality gate when staged files touch
  `apps/flowstarter-main/` or `packages/flow-design-system/`; it does not
  cover the worker or `agentic-codegen`, so run those suites yourself when
  you change them.
- Stripe runs in test mode in development and CI; live mode never appears
  outside production.

## More docs

- `AGENTS.md` — conventions, layout, tooling and CI lanes; the primary
  source of truth for how this repo currently works.
- `docs/` — planning notes and process docs (release process, Hetzner host
  setup, preview environment, daily QA). Some predate the current
  implementation and describe decisions that later changed; where a doc
  disagrees with the code or with `AGENTS.md`, the code wins.
- `readiness/README.md` (generated) — MVP journey coverage, from
  `node scripts/mvp-readiness.mjs`.
