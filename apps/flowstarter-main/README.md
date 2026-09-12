# Flowstarter — `flowstarter-main`

The platform app for Flowstarter: marketing site, team admin dashboard, REST APIs, and the public-facing pages. Hosted on the **Hetzner** box as the `prod` slot at `flowstarter.net` (see `deploy/hetzner-staging/README.md`). Heavy compute (per-client Docker sandboxes, the multitenant editor, deploy/operator services) lives on **Hetzner** and is called from this app over an authenticated API.

For the strategic pivot context, see [`docs/CONCIERGE_PIVOT_PLAN.md`](../../docs/CONCIERGE_PIVOT_PLAN.md). Plan for the active build is in `~/.claude/plans/merry-jingling-bengio.md`.

## What this app is

Flowstarter is a **concierge-first managed web service**. Founding team handles client setup via discovery calls. The platform app is what the team and (later) clients log into:

- **Public landing** — marketing for the concierge offering.
- **Team admin** (`/team/dashboard/*`) — projects list + detail, concierge stage, client editor management, commerce config, products, hosting (Slice 2+).
- **Client dashboard + editor entry** (Slice 3) — clients log in to request changes and (eventually) edit their own sites.
- **REST APIs** — auth-protected endpoints called by the team UI and by Hetzner-side services.

What this app **doesn't** do:
- Run the per-client site sandboxes (Hetzner Docker).
- Host the editor itself (Hetzner container, multitenant).
- Provision Hetzner servers (Hetzner-side operator service).
- Build/deploy client sites (deploy-agent on the Caddy host).

It enqueues those jobs and reads their state.

## Stack

- **Next.js 16** (App Router), `output: 'standalone'`, in Docker on Hetzner
- **Clerk** for auth (team members + client magic-link sessions)
- **Supabase** (Postgres + RLS) — projects, commerce_products, leads, hosting state (Slice 2)
- **TanStack Query** for client data
- **Tailwind + shadcn** UI primitives + a glass design system
- **Vitest** for unit tests, **Playwright** for e2e (`apps/flowstarter-main/e2e`)

Cross-app shared code:
- `@flowstarter/platform-config` — domain/URL helpers (no hardcoded domains)
- `@flowstarter/flow-design-system` — design tokens
- `apps/flowstarter-templates/*` — client site templates (`dorin-portfolio` is the canonical demo)

## Setup

```bash
pnpm install
cp env.example .env.local   # fill in values, see "Environment" below
pnpm nx run flowstarter-main:dev
```

Common scripts:

```bash
pnpm nx run flowstarter-main:typecheck
pnpm nx run flowstarter-main:lint
pnpm nx run flowstarter-main:test           # vitest
pnpm nx run flowstarter-main:e2e            # playwright
pnpm nx run flowstarter-main:build
```

## Environment

Required:

```bash
# Auth + DB
NEXT_PUBLIC_SUPABASE_URL=...
NEXT_PUBLIC_SUPABASE_ANON_KEY=...
SUPABASE_SERVICE_ROLE_KEY=...
NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY=...
CLERK_SECRET_KEY=...

# AI providers (used by team-internal generation flows)
OPENROUTER_API_KEY=...
OPENAI_API_KEY=...

# Audit log encryption
AI_AUDIT_ENC_KEY=<32-byte hex>
```

Optional / per-feature:

```bash
# Domain registrar (used for client domain handoff)
GODADDY_API_KEY=...
GODADDY_API_SECRET=...

# File uploads
UPLOADTHING_SECRET=...
UPLOADTHING_APP_ID=...

# Rate limiting / abuse
ARCJET_KEY=...

# Analytics
GOOGLE_ANALYTICS_PROPERTY_ID=...
```

Slice 2 will add (Hetzner + Cloudflare):

```bash
HETZNER_API_TOKEN=...
HETZNER_SSH_KEY_ID=...
CLOUDFLARE_API_TOKEN=...
CLOUDFLARE_DEFAULT_ZONE_ID=...
HETZNER_OPERATOR_URL=https://operator.flowstarter.app
HETZNER_OPERATOR_SECRET=...   # shared bearer between this app and the Hetzner operator
```

`DAYTONA_API_KEY` is currently used by the **team-internal** generation flow (not client-facing). It will be removed when the per-client Docker pipeline replaces the current sandbox-based generation.

## Architecture (high level)

```
Browser
   │
   ├── Hetzner `prod` slot (this app: flowstarter-main)
   │     • Marketing pages, team admin, client dashboard
   │     • REST APIs (Clerk-authed)
   │     • Calls operator on Hetzner for long-running ops
   │
   └── Hetzner
         • Operator service: provisioning, container lifecycle, deploy
         • Caddy host: TLS + reverse proxy
         • Editor container: multitenant stripped T3 fork
         • Per-client Docker sandboxes: dev server + file-ops agent
```

Client traffic (`<platform-domain>` is resolved from `@flowstarter/platform-config`, never hardcoded; `resolvePlatformDomain()` mints `flowstarter.net` in production and `flowstarter.dev` in development, test and staging):
- `acme.<platform-domain>/edit` → editor container (Hetzner) authenticated via magic-link or Clerk
- `acme.preview.<platform-domain>` → that client's dev-server container (live preview)
- `acme-customdomain.com` → that client's production output

DNS via Cloudflare API, called from the Hetzner operator rather than from this app.

## Project layout (high level)

```
src/
├── app/                      # Next.js App Router
│   ├── (dynamic-pages)/      # Marketing, team dashboard, client routes
│   ├── api/                  # REST API handlers
│   └── ...
├── components/               # Shared UI
├── hooks/                    # React Query hooks (useTeamProjects, etc.)
├── lib/                      # Domain logic (commerce, commerce-products, api-auth, ...)
├── supabase-clients/         # Service-role + user-scoped Supabase clients
├── locales/                  # i18n (en.ts populated; ro.ts stubbed for future)
└── ...
```

## Conventions

- **No hardcoded domain strings** — use `@flowstarter/platform-config` (`getMainUrl`, `getSubdomainUrl`, etc.).
- **Team API routes** under `/api/team/*` use `requireTeamAuth()` from `lib/api-auth.ts`.
- **Service-role Supabase** access via `createSupabaseServiceRoleClient()` from `supabase-clients/server.ts`.
- **Validation at API boundaries**: see `lib/commerce.ts`, `lib/commerce-products.ts` for the normalizer pattern.
- **Tests** live next to source in `__tests__/` directories.
