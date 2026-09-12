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
  worker.

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
