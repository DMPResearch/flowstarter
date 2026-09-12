# The dev machine

Darius develops on a Mac mini: a full dev server plus a local Supabase
stack, nothing hosted. `scripts/dev-bootstrap.sh` makes that reproducible on
a fresh Mac or a fresh clone; `scripts/dev-doctor.sh` reports the same
health summary any time after that. This doc says what runs there, what
never does, how the guard enforces the split, the commands you actually
type day to day, the gotchas specific to working in an isolated worktree on
this machine, and how staging and production on Hetzner relate to it.

## What runs on the dev machine

- **Main** (`apps/flowstarter-main`), Next.js dev server, port 3000.
- **Local Supabase**, the Supabase CLI stack (`supabase/config.toml`), API
  on 54321, Postgres on 54322, Studio on 54323. This is the only database a
  developer touches by hand; see "Never runs locally" below.
- **Stripe CLI webhook listener** (`stripe listen`), forwarding Stripe test
  events to `localhost:3000/api/webhooks/stripe`.
- **Deploy agent emulation** (`apps/deploy-agent`, `pnpm dev:deploy-agent`):
  a local stand-in for the per-host Bun service that a real Hetzner box
  runs on 8443. Locally it serves extracted sites by path at
  `http://localhost:8788/{slug}/` (`DEPLOY_AGENT_STATIC_PORT`), since a
  laptop has no wildcard DNS and the Caddy reload step is a no-op here.
- **Optional**: the build worker (`pnpm dev:build-worker:local`, off by
  default in `mprocs.yaml` since it touches real workspace rows) and the
  editor (`pnpm dev:editor`, a forked T3 Code app on its own port).

## Never runs locally

- **Production Supabase.** `src/lib/supabase-target.ts` throws in
  development (and staging) unless the target is the local stack, or
  `FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1` is set explicitly. There is no
  cloud staging Supabase project either; staging on Hetzner runs its own
  copy of the same local CLI stack, bound to loopback on that host. See
  `docs/preview-environment.md`.
- **Live Stripe.** Development and CI always run Stripe in test mode. Live
  mode never appears outside production.

## How the guard enforces it

`src/lib/supabase-target.ts` inspects the configured Supabase URL against
the current environment. In development or staging, a URL that is not the
local loopback stack fails fast at startup instead of quietly talking to a
real project. The one escape hatch, `FLOWSTARTER_ALLOW_REMOTE_SUPABASE=1`,
exists for the rare case that genuinely needs a hosted project from a
dev/staging process, and is meant to be set deliberately, not left on.

## Daily commands

```sh
pnpm dev                                  # mprocs: Main, Supabase, Stripe, deploy agent, editor
pnpm db:env                               # re-point Main's dev server at the local stack
pnpm nx run flowstarter-main:test         # flowstarter-main's vitest suite
pnpm --dir apps/flowstarter-main dev      # Main alone, next dev on :3000
```

Other Supabase commands worth knowing: `pnpm db:start`, `pnpm db:stop`,
`pnpm db:reset`, and `supabase migration up --local` to apply new
migrations without a full reset. `pnpm dev` needs an interactive terminal
(mprocs uses one); in a non-TTY context run an app's own `dev` script
instead, as above.

Run the bootstrap script's report mode any time to see what's set up and
what needs attention, without changing anything:

```sh
bash scripts/dev-bootstrap.sh --check
bash scripts/dev-doctor.sh
```

## Worktree gotchas on this machine

These bit us enough times to write down. They apply whenever the dev
machine is running an isolated git worktree (an agent's own checkout, or a
throwaway branch you set up by hand) rather than the main checkout:

- **A fresh worktree needs its own install and its own env files.**
  `node_modules` and `apps/flowstarter-main/.env*` are not shared across
  worktrees. Run `pnpm install --frozen-lockfile` once, then copy
  `apps/flowstarter-main/.env` and `.env.local` over from an existing
  checkout (or run `scripts/dev-bootstrap.sh`, which creates them from
  `.env.example` if they are missing) before anything will boot.
- **`next dev` needs `-H ::` on this machine.** The app's middleware
  self-fetches `localhost`, which resolves to `::1` (IPv6) before `127.0.0.1`
  here. A dev server bound only to an IPv4 address never answers that
  self-fetch and every request hangs. If `next dev` seems to hang on this
  Mac mini specifically, check the bind address first.
- **macOS has no `timeout`.** Scripts that need a deadline on this machine
  use a manual background-process-plus-poll loop (see
  `scripts/dev-bootstrap.sh`'s Stripe webhook secret step) instead of
  assuming GNU coreutils' `timeout` or `gtimeout` is installed.
- **Playwright's browser download stalls here.** The default Chromium CDN
  fetch hangs on this network. Screenshots and Playwright runs on this
  machine use `channel: 'chrome'` to drive the already-installed system
  Chrome instead of downloading Playwright's own browser build.

## Staging and production on Hetzner

Both run on the same Hetzner box as Docker containers, published over SSH
by `deploy/hetzner-staging/scripts/deploy-slot.sh`. Neither is something
the dev machine talks to directly except through a pull request or a
release.

- **Staging** (`staging.flowstarter.dev`, slot `main`) deploys automatically
  on every merge to `main` (`.depot/workflows/staging-deploy.yml`). Every
  open pull request also gets its own slot,
  `pr-<n>.staging.flowstarter.dev` (`staging-pr-deploy.yml`), destroyed when
  the PR closes. Staging's database is the Supabase CLI stack running on
  the Hetzner host itself, not a cloud project -- the same kind of local
  stack this doc describes, just running on that box instead of the dev
  machine. See `docs/preview-environment.md`.
- **Production** (`flowstarter.net`, slot `prod`) does not deploy from
  every merge. A weekly (or on-demand) release workflow tags `main`,
  verifies staging, builds the image for that tag, and deploys it to the
  `prod` slot. Production's database is the hosted Supabase project, the
  only place that project is used. See `docs/release-process.md`.

Nothing on the dev machine reaches either slot's database directly; the
local Supabase stack on `127.0.0.1:54321` is the only database a developer
or an agent touches by hand.
