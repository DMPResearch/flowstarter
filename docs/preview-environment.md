# Preview environment

How a pull request gets a running copy of Flowstarter with its own database,
and what the owner has to do once to make that true.

## Topology

- **Web.** Netlify is gone. There are no Deploy Previews and no branch deploys.
  A pull request's preview is its **Hetzner slot**: `staging-pr-deploy.yml`
  builds an image from the PR head and deploys slot `pr-<n>` at
  `https://pr-<n>.staging.flowstarter.dev` on host port `3000 + n`, then posts
  the URL as a comment on the pull request. Closing the PR destroys the slot.
  Unlike a Netlify Lambda preview, a slot has a real database behind it: it
  runs on the same host as the Supabase CLI stack and reaches it over loopback.
  Production is a slot on that same box too, `prod` at `flowstarter.net`; see
  `docs/release-process.md`. Nothing on a pull request touches it.
- **Database.** There is no cloud staging Supabase project. The staging
  database is the Supabase CLI local stack running ON THE HETZNER HOST,
  bound to loopback (`http://127.0.0.1:54321`), the same `supabase start`
  developers and the quality gate use. Every Hetzner staging slot, `main`
  at `staging.flowstarter.dev` and every `pr-N` at
  `pr-N.staging.flowstarter.dev`, talks to that one stack; see
  `deploy/hetzner-staging/README.md`, "Database", for the loopback-only
  binding and the Hetzner Cloud Firewall that makes it safe. The local stack
  on a developer's own machine, `127.0.0.1:54321`, stays the only database a
  developer or an agent touches by hand; the Hetzner stack is written by CI
  and by the seed script over SSH, not from a laptop directly.
- **Auth.** Clerk runs its **development** instance for previews, shared with
  production until launch. That sharing is a launch blocker: before the first
  real customer, production must move to a Clerk production instance with its
  own `pk_live_`/`sk_live_` pair, and previews must keep the development one.
  `e2e/support/clerk-env.ts` already refuses to run the authenticated suite
  against live keys.
- **Payments.** Stripe test mode, shared with production, which is fine because
  production is not live yet. Live mode never appears in this repository.
- **Build worker.** The staging build worker runs on the Hetzner host beside
  the production one, pointed at the same local Supabase CLI stack
  (`SUPABASE_URL=http://127.0.0.1:54321` and the stack's own service role
  key) rather than a separate cloud project. There is no per-pull-request
  worker. Its build validator (`pnpm install && pnpm run build`, `dist/`
  must exist) always runs for every job kind — `FULL_SITE_BUILD`,
  `SITE_REBUILD` and `CHANGE_REQUEST_BUILD` alike. `FLOWSTARTER_BUILD_STUB_AGENT`
  (local/dev only) replaces just the Pi coding session, never the validator;
  the one switch that can is `FLOWSTARTER_BUILD_SKIP_VALIDATION`, documented
  in `apps/build-worker/.env.example` as unit-test-only, and `loadConfig`
  refuses to boot with it set once `FLOWSTARTER_ENV` resolves to staging or
  production — so this host, and any Hetzner slot's worker, can never ship
  an unbuilt Astro source tree the way a stubbed validator once did.

## One-time setup, by the owner

There is no Supabase project to create for staging anymore. The database is
the Supabase CLI stack on the Hetzner host itself.

1. Follow `deploy/hetzner-staging/README.md`, "One-time box setup": install
   Docker's loopback-only default publish address
   (`/etc/docker/daemon.json`, `{ "ip": "127.0.0.1" }`), attach a Hetzner
   Cloud Firewall allowing inbound 22/80/443 only, then run
   `supabase-stack.sh ensure`, `migrate`, `write-env`, and `check` once by
   hand to seed the stack and `/etc/flowstarter/staging.env`. After that, CI
   keeps both current on every deploy.
2. Add the two Depot secrets `staging-deploy.yml` and `staging-pr-deploy.yml`
   need to build the image against that stack, which Depot does not read
   from GitHub's secret store:

   ```sh
   depot ci vars add STAGING_SUPABASE_URL --repo DMPResearch/flowstarter    # http://127.0.0.1:54321
   depot ci secrets add STAGING_SUPABASE_ANON_KEY --repo DMPResearch/flowstarter
   ```

   `STAGING_SUPABASE_ANON_KEY` is the Supabase CLI stack's own demo anon key
   (`supabase status -o env` on the host, or `supabase-stack.sh write-env`'s
   output), not a production credential. Until it is set, both staging lanes
   warn and end green rather than build against nothing. See
   `docs/ci/secrets.md`.

3. Put the Clerk addresses the authenticated suite signs in as into
   `/etc/flowstarter/staging.env` on the host, where every staging slot reads
   them:

   ```sh
   E2E_CLERK_OPERATOR_EMAIL=operator+clerk_test@flowstarter.dev
   E2E_CLERK_CLIENT_EMAIL=client+clerk_test@example.com
   ```

   Do **not** put production `NEXT_PUBLIC_SUPABASE_URL` /
   `NEXT_PUBLIC_SUPABASE_ANON_KEY` / `SUPABASE_SERVICE_ROLE_KEY` in that file.
   Staging slots read the Supabase CLI stack's own keys, written there by
   `supabase-stack.sh write-env`, and `deploy-slot.sh` refuses to expose a slot
   whose `/api/health` does not say `"target":"local"`. The production values
   live in `/etc/flowstarter/prod.env` and nowhere else on the box.

   The two `E2E_CLERK_*` addresses are what the seed script links its tenants
   to, and what the authenticated Playwright projects sign in as. Add
   `E2E_CLERK_OPERATOR_PASSWORD` the same way if the suite signs in with a
   password rather than a ticket.

## Deposit to build

This section is the answer to risk 1 of
`docs/quality/codex-review-2026-09-12.md` ("The new brief does not start or
inform the paid build"), which found both halves of this flow missing: nothing
turned brief readiness back into a build, and the build that eventually ran had
never seen the brief.

The paid build is not started by the deposit alone. Between paying and being
able to build there is one more thing only the client can supply: the in-depth
brief on their own dashboard, which is where the offer, the real projects, the
photographs and the design references arrive. A build taken before that has
nothing true to build from, and a generator with nothing true to build from
invents a case study.

So the job has a waiting state of its own, and it is a status on the row rather
than an inference from silence:

```
deposit settled ──> FULL_SITE_BUILD enqueued
                      │
                      ├─ brief ready or waived ──> queued ──> running ──> succeeded
                      │                              ▲
                      └─ otherwise ──> waiting_brief ─┘
                                        (client finishes the brief, or an
                                         operator overrides it)
```

- **`waiting_brief`** is a real `flowstarter_agent_jobs.status`
  (`supabase/migrations/20260912180000_waiting_brief_job_state.sql`). It means
  the deposit is settled, the job exists, and the one thing outstanding is a
  form only the client can fill in. Before it existed such a job sat at
  `queued` and the board reported it, after fifteen minutes, as a dispatch that
  had probably been dropped — an alarm about our own system for a situation
  only the client can end.
- **The deposit path enqueues straight into it** when the brief is not ready
  (`enqueueBuildAndAdvance` in `lib/flowstarter/deposit-workflow.ts`), and the
  worker parks a `queued` job into it if it claims one whose brief is still
  outstanding (`parkOnBrief` in `apps/build-worker/src/job-store.ts`). Parking
  never spends an attempt: waiting is not a failed try.
- **Readiness is what ends the wait.** Saving a complete brief
  (`PUT /api/client/brief/[workspaceId]`) and the operator override
  (`POST /api/admin/projects/[id]/brief/override`) both call
  `enqueueBuildOnBriefReady`, which composes the build input, writes it onto
  the job payload, promotes `waiting_brief` to `queued` and nudges the worker.
  It is idempotent on two keys — the workspace, through the
  `flowstarter_agent_jobs_one_full_build` unique index, and the deposit, which
  must be `paid` — so calling it on every save is correct and cheap.
- **A worker that was not listening still finds the job.** `BuildReconciler`
  (`apps/build-worker/src/reconcile.ts`) asks the database what is runnable at
  startup and every `FLOWSTARTER_BUILD_POLL_INTERVAL_MS` (default 60s, capped
  by `FLOWSTARTER_BUILD_POLL_LIMIT` jobs per sweep): queued jobs that are due,
  and parked jobs whose workspace has since become ready. Promotion is a
  guarded compare-and-set, so two workers sweeping at once take a job once
  between them, and the claim itself is unchanged. A sweep that cannot reach
  the database logs and returns; it never takes the worker down.

**What the build is made from.** `enqueueBuildOnBriefReady` composes a
versioned `briefInput` (`lib/flowstarter/brief-build-input.ts`,
`BRIEF_INPUT_VERSION`) onto the job payload: the offer, the projects (name,
line, validated https link, screenshots), the page-count answer and the tone,
plus every rights-confirmed file with the public path it will have under
`/flowstarter-media/`, its caption and its role (`portrait`,
`project-screenshot`, `design-reference`, `photo`). `loadUsableAssets` is the
only reader used, so a file whose rights are not confirmed cannot enter a
payload; the worker re-reads `rights_confirmed_at` at claim time anyway, drops
anything it cannot deliver from both the manifest and the brief, and says so on
the job's timeline — the prompt never names a path with nothing behind it.

The worker merges that into the intake the preview was approved from
(`mergeBriefIntoIntake`) and seeds the files beside the approved preview
through the same loader the change-request build uses. That merge is what makes
the downstream rules work at all: the page-set rule counts real projects (no
projects, no work page), and the `INVENTED_PROJECT` gate finally has names to
check the built site against. When the client has answered that they have no
past work, the gate runs in its stricter mode and rejects every project-shaped
heading outside the closed generic list.

**Preview continuity is unchanged.** The worktree is still seeded from
`flowstarter_project_artifacts.preview_manifest`, the teaser is still stripped,
and the approved-edit validator still holds the build to every phrase the
client approved before paying. The brief is layered on top by the agent pass;
it never replaces the preview.

**Operator view.** A parked job shows on the pipeline board as `waitingOn:
'brief'` with a plain-language reason and is explicitly _not_ a stall; the
project-state budget still applies, so a deposit sitting in `DEPOSIT_PAID` for
days is still flagged, which is the moment to call the client or override. The
client's dashboard reads the same status as `waiting_on_brief`. A parked job
can be cancelled and can carry operator notes.

## Migrations

There is no separate migrations workflow anymore; `staging-migrate.yml` is
retired along with the cloud staging project it pushed to.
`scripts/deploy-slot.sh` (in `deploy/hetzner-staging/`) applies migrations as
part of every deploy of slot `main`:

- It runs `supabase-stack.sh migrate` (`supabase migration up`, then prints
  `supabase migration list`) against the Hetzner host's stack, before
  starting the new container, and only for slot `main`.
- `pr-N` slots do **not** migrate. They share the one schema `main` last
  applied, which is why a migration that is not backwards compatible with
  `main` will break other open PR slots until it merges.
- `staging-deploy.yml` syncs the repository's `supabase/` directory to
  `/opt/flowstarter/staging/repo` on the host before calling `deploy-slot.sh`,
  so the migration files applied always match the commit being deployed.
- There is no dry-run mode on the Hetzner host; `supabase migration list` is
  the plan, read after the fact from the deploy logs.

## Seeding and cleaning up E2E tenants

Two scripts, no package scripts (the root `package.json` is deliberately left
alone). Both read `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` from the
environment, falling back to `apps/flowstarter-main/.env.local` through
`e2e/support/local-env.mjs`.

Against a developer's own machine, that falls back to the local stack at
`127.0.0.1:54321` as always. Against the Hetzner staging database, neither
script can reach `127.0.0.1:54321` from a laptop, since that address is the
Hetzner host's own loopback, not the caller's. Run the seed either on the
host itself (`SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_SERVICE_ROLE_KEY=...
node e2e/support/seed-e2e-tenants.mjs`, service role key from
`/etc/flowstarter/staging.env`), or from a laptop through an SSH tunnel
(`ssh -L 54321:127.0.0.1:54321 <user>@<staging-host>`) and the same
`SUPABASE_URL`.

```sh
# Create or refresh the two fixed tenants. Safe to run repeatedly.
node e2e/support/seed-e2e-tenants.mjs

# Remove tenants seeded more than 24 hours ago (the default).
node e2e/support/cleanup-e2e-tenants.mjs

# Other scopes.
node e2e/support/cleanup-e2e-tenants.mjs --older-than 2
node e2e/support/cleanup-e2e-tenants.mjs --run <run-id-printed-by-the-seed>
node e2e/support/cleanup-e2e-tenants.mjs --all --dry-run
```

- The seed creates `e2e-operator-workspace` (state `AGENTS_WORKING`) and
  `e2e-client-workspace` (state `PREVIEW_READY`), each with a membership and
  one project artifact row. Every id is a UUIDv5 off one fixed namespace, so a
  second run is a no-op.
- It links each workspace to a Clerk user by looking the address up in
  `public.profiles`, the app's own Clerk mirror. It never calls Clerk. If an
  address has no profile yet, it writes a placeholder with a `user_e2e_` id and
  says so; the authenticated suite will not see those workspaces until the real
  users have signed in once and the webhook has mirrored them.
- Cleanup refuses to run unless the URL is `127.0.0.1`/`localhost` or mentions
  `staging`. A URL carrying the ref in `SUPABASE_PROJECT_REF` is refused
  outright. `E2E_ALLOW_PROD=1` lifts only the first of those two.

## How the E2E tiers use it

- **Platform smoke** (`.depot/workflows/e2e-smoke.yml`) waits up to 15 minutes
  for the pull request's slot to report `"ok":true` and `"target":"local"` on
  `/api/health`, then runs the unauthenticated Playwright project against it.
  It needs no seed. A push to `main` smokes slot `main` at `vars.STAGING_URL`
  instead; a feature-branch push has no slot of its own and skips. When the
  `STAGING_SSH_*` secrets are absent (dependabot and fork pull requests) there
  is no slot at all, so the lane warns and skips, green.
- **Authenticated suite** (`*.auth.spec.ts`, project `chromium-auth`) needs the
  seed to have run against staging first, and the `E2E_CLERK_*` addresses to
  resolve to real Clerk users. It skips rather than fails when Clerk keys are
  absent.
- **Visual check** (`.depot/workflows/visual-check.yml`) screenshots the same
  slot and compares against committed Linux baselines. A dispatched baseline
  refresh has no pull request, so it screenshots slot `main` at
  `vars.STAGING_URL`.

Run the seed before an authenticated tier and the cleanup after it, or leave
cleanup to a scheduled `--older-than 24` pass so a failed run's rows still go.
