# AGENTS.md

Conventions for this repository. The advisory OpenCode reviewer in
`.github/workflows/opencode-review.yml` reads this file, and so should any
coding agent. A claim here that the code contradicts is worse than no claim.

## Layout

- `apps/flowstarter-main` is the product: Next.js 16 (App Router), Tailwind 4,
  shadcn/ui, React Query, Clerk for auth, Supabase for data. Interface copy
  lives in `src/locales`, server helpers in `src/lib`, route handlers under
  `src/app/api`.
- `apps/build-worker` is the site build worker, run with `tsx`. It talks to
  Supabase with the service role, so RLS does not protect it and every query
  filters by hand.
- `packages/agentic-codegen` holds the generation pipeline: Pi SDK agents
  (`@earendil-works/pi-ai`, `@earendil-works/pi-coding-agent`) driven through
  OpenRouter, the prompts, the template scaffolding, the preview teaser, and
  the git worktree policy.
- `apps/flowstarter-library` and `apps/flowstarter-templates` hold the Astro
  template sources and the template library MCP server.
- `supabase/migrations` is the schema, `e2e/` is Playwright, `.github/workflows` is CI.
- Out of scope for most changes: `apps/flowstarter-editor`,
  `apps/deploy-agent`, `apps/shopify-landing`, smaller `packages/*`.

## Decisions already made

Do not relitigate these in a pull request.

- Rules decide, models phrase. Deterministic code owns routing, validation,
  gating and pricing. An LLM only produces text. Moving a rule out of code and
  into a prompt is a regression, not a refactor.
- Fix the agent, the template or the gate. Never patch a built site or any
  other generated output; change the thing that generated it.
- Tenant isolation has two layers. In the app, Postgres RLS plus
  `withTenant` (`apps/flowstarter-main/src/lib/tenancy.ts`) and
  `requireWorkspaceAccess` (`apps/flowstarter-main/src/lib/api-auth.ts`). In
  the worker, which bypasses RLS, the static guard
  `apps/build-worker/test/worker-tenant-filter.test.ts` reads every `.from()`
  call on a workspace-scoped table and fails unless the statement filters by
  `workspace_id` or goes through `withTenant`. Its `ALLOW_LIST` is the only
  escape hatch and every entry carries a reason.
- Stripe runs in test mode in development and CI; live mode does not appear.
- The local Supabase stack on `127.0.0.1:54321` is the only database a
  developer or an agent touches. The hosted project is not for local work.
- Secrets are never logged. A short identifying prefix is the most that may
  reach a log line or an error message.
- User-visible copy lives in `apps/flowstarter-main/src/locales` (`en.ts`,
  `ro.ts`, `en/`). It uses no em dashes and no emojis. Hard-coding a visible
  string in a component instead of the dictionary is a defect.
- Commit messages the worker creates must match the policy in
  `packages/agentic-codegen/src/flowstarter/worktree.ts`, which accepts
  exactly two shapes and rejects everything else.

## Tooling

pnpm workspaces (`pnpm-workspace.yaml`) with Nx on top. pnpm 10.29.2, Node 22.

Formatting is split on purpose. `apps/flowstarter-main` pins its own Prettier
2 with `prettier.config.cjs`, so run it from inside that directory:
`pnpm --dir apps/flowstarter-main lint:prettier`. Everything else, the
packages and the worker, formats with the root Prettier 3 and `.prettierrc`.

Lint: `pnpm --dir apps/flowstarter-main lint` (it sets `ESLINT_USE_FLAT_CONFIG=false`).

Tests are vitest per package:

- `pnpm nx run flowstarter-main:test`
- `pnpm --dir packages/agentic-codegen test`
- `pnpm --dir apps/build-worker test`

Each package also has `test:coverage`, which is the same suite with
`--coverage`. Coverage is enforced, in two tiers:

- A global floor per package, set at the level that package has already
  reached, in the `thresholds` block of its vitest config and mirrored in
  `coverage-floors.json` at the root. `node scripts/coverage-ratchet.mjs`
  fails when a metric drops below its floor; `--update` raises the floors to
  a new measurement and never lowers them. The quality gate runs the check.
- A 90% bar (80% on branches, where a v8 branch is often an optional-chain
  arm) on every glob that handles money or another tenant's data:
  `src/lib/{flowstarter,billing,hosting}/**`, `src/lib/webhook-verification.ts`
  and `src/app/api/{webhooks,client,admin/projects,team/projects}/**` in
  flowstarter-main; `workflows.ts`, `worktree.ts` and `job-log.ts` in
  agentic-codegen; `job-store.ts`, `validator.ts` and `index.ts` in the
  worker. Below the bar the gate is red. Write the test; the bar does not
  move.

One thing to know about the flowstarter-main coverage numbers: that package
runs `vitest --root src`, so everything in `coverage.include` and
`coverage.exclude` is relative to `src`, not to the package. Written with a
`src/` prefix they resolve to `src/src/` and match nothing, which is what they
did until 2026-09-09 -- v8 then only reported the files a test happened to
import, and 414 source files were invisible. The measured global was 77.6% of
the loaded half and 41.6% of the tree.

Typecheck: `pnpm nx run flowstarter-main:typecheck`, and `typecheck` in
`apps/build-worker` and `packages/agentic-codegen`. `pnpm run ci:quality-gate`
at the root chains lint, typecheck and the flowstarter-main tests.

The husky hook `.husky/pre-commit` is scoped: it runs `ci:quality-gate` only
when the staged files touch `apps/flowstarter-main/` or
`packages/flow-design-system/`, and skips otherwise. It does not run the
worker or agentic-codegen suites, so run those yourself when you change them.

## CI

All four lanes below run on Depot (`depot-ubuntu-latest`) from
`.depot/workflows/`, the way DMPResearch/ereno runs its CI. Depot's Code
Access GitHub App (`depot-code-access`) posts the checks on the pull
request. The `.github/workflows/` copies of the same four files were removed
on 2026-09-09, once the Depot-posted contexts were confirmed green on a pull
request; Depot is now the only place these lanes run.

Depot secrets and variables are separate from GitHub repository secrets:
Depot does not read GitHub's secret store, so anything a workflow needs has
to be imported into Depot directly (`depot ci secrets add` / `depot ci vars
add`), scoped to this repo. The names in use:

- secrets: `OLLAMA_API_KEY`, `NETLIFY_AUTH_TOKEN`, `NETLIFY_SITE_ID`, and
  optionally `GH_REVIEW_TOKEN`
- vars: `AI_REVIEW_SMALL_MODEL`, `AI_REVIEW_BIG_MODEL`

- Quality Gate (`.depot/workflows/quality-gate.yml`): lint, typecheck, unit
  tests with coverage for all three suites, the coverage ratchet, and tenant
  isolation proved against a throwaway local Supabase stack with all
  migrations applied. This is the blocking lane. Lint is currently advisory
  inside it (`continue-on-error`); coverage is not. The job's step summary
  carries the coverage table and the MVP readiness scorecard.
- E2E smoke (`.depot/workflows/e2e-smoke.yml`): waits for this commit's
  Netlify Deploy Preview, then runs the Playwright platform smoke against it.
  Skips with a warning when the Netlify secrets are absent. Afterwards
  `scripts/e2e-route-coverage.mjs` reports how many of the routes under
  `src/app` the run reached, from the records
  `e2e/support/coverage-fixture.ts` writes. Every spec imports `test` from
  that fixture rather than from `@playwright/test`; a spec that imports the
  bare one records nothing. There is no minimum on the number yet.
- OpenCode review (`.depot/workflows/opencode-review.yml`): the default
  reviewer, advisory only, never a required check and never in another job's
  `needs`. It runs in two tiers, decided from the diff size: small and medium
  changes on GLM 5.2, big ones (more than 8 changed files or more than 300
  changed lines) on Kimi K3, both on the flat-rate Ollama Cloud subscription.
  The tier is posted on the head commit as a `Review classification` status.
  The `Review` step runs with `continue-on-error`, so a model provider error
  never turns the check red; when that happens the lane posts a "no verdict"
  comment naming the model and the reason instead of staying silent, and a
  rerun of the workflow replaces it with either a real review or a fresh
  no-verdict comment.
- Greptile (`greptile.json`): `skipReview` is `AUTOMATIC`, so Greptile does
  not review on its own and no pull request spends a credit by default. To
  request the paid reviewer, mention the bot in a comment on the pull
  request. That is a human decision, never a workflow step.
- UI visual check (`.depot/workflows/visual-check.yml`): Playwright
  screenshots compared against committed Linux baselines.

## Readiness

`readiness/journeys.json` lists the MVP journeys -- intake through to
cancellation -- with the routes and the spec behind each. The daily QA lane
(`e2e/qa/journeys.qa.spec.ts`) walks several of them against a live
deployment; it records route coverage like every other spec, because it
imports `test` from `e2e/support/coverage-fixture.ts`. `node
scripts/mvp-readiness.mjs` scores every one on unit coverage of its API
handlers, whether a Playwright spec walks it, and whether the production
synthetic checks it, and writes the generated `readiness/README.md`.
Money-path journeys count double. Renaming a route makes the script name the
pattern that no longer resolves and exit non-zero, so the file cannot go
stale quietly.

## Review focus

Flag these, with a line to point at:

- Correctness bugs. Say what breaks and under what input.
- A tenant isolation leak: a query on a workspace-scoped table with no
  workspace filter, no `withTenant`, and no RLS behind it.
- A documented fail-open path changed to fail closed.
- User-visible copy with em dashes or emojis, or hard-coded outside `src/locales`.
- A rule moved out of deterministic code and into a model prompt.
- A built output patched instead of its generator.
- A secret printed to logs beyond a short prefix.
- Stripe live mode, or the hosted Supabase project, referenced anywhere.

If a change looks correct, say so in one line. Do not restate the diff or
propose stylistic rewrites.
