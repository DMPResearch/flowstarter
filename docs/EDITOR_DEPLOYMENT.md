# Flowstarter Assistant — Editor Deployment & Per-Client Loading

How the editor (forked T3 Code, branded **Flowstarter Assistant**) is
hosted and bound to a client workspace, **on the hosting stack that
already exists in this repo**.

> Supersedes an earlier draft of this file that proposed a parallel
> nginx + systemd-per-process approach. That was drafted blind to
> `lib/hosting` / `apps/deploy-agent` and has been removed
> (`deploy/editor/*` deleted). This version extends the existing stack.

Canonical architecture: [`CONCIERGE_PIVOT_PLAN.md`](./CONCIERGE_PIVOT_PLAN.md)
lines 16–30. This is the implementation runbook for it.

> **The operator path is now built and wired.** Items 2 (the router), 3
> (per-workspace code on the box) and 4 (admin → editor hand-over) below
> describe what this file predicted; what actually shipped, including the
> control plane, the session table, the `OPERATOR_EDIT_BUILD` job and the
> gates it runs, is in
> [`operations/operator-editor.md`](./operations/operator-editor.md). Two
> things landed differently from the sketch below and that document says why:
> the worktree is materialised from the workspace's published manifest rather
> than cloned from `editor_repo_url` (no such repo was ever created), and the
> hand-over goes to `<slug>.<domain>/editor/` rather than a root-mounted
> `code.<domain>`.

## The load-bearing fact

The editor server is **single-project-per-process**:
`serverRuntimeStartup.ts:169-195` bootstraps exactly one project from
`serverConfig.cwd` (`getActiveProjectByWorkspaceRoot(serverConfig.cwd)`).
`clerkGate.ts` is multitenant for **auth** (Host → slug → membership,
`parseWorkspaceSlugFromHost` 256-270, `resolveAuthorization` 336-473)
but the **files/threads a process serves are pinned to one cwd**.

⇒ One shared process cannot serve multiple clients' code. **Each client
needs its own editor process** (its own `cwd` + state). That is the
isolation boundary; the clerkGate membership check is the auth
boundary. No editor rewrite — we run it exactly as built.

## Architecture (all but the router/Dockerfile already built)

```
flowstarter-main (Netlify)
  │  HetznerClient (lib/hosting/hetzner.ts) + buildCloudInit (cloud-init.ts)
  ▼
Hetzner VPS  (Ubuntu 24.04, cpx22 default; cloud-init installs
              Caddy + Docker + Node22 + @anthropic-ai/claude-code,
              ufw 22/80/443, deploy-agent systemd unit)
  ├─ Caddy   (deploy-agent writes /etc/caddy/sites/<slug>.caddy:
  │            <slug>.../editor/*  → reverse_proxy editor:3773
  │            <slug>.../*         → /var/www/sites/<slug>)
  ├─ deploy-agent  (Bun; POST /sites/:slug/deploy, Bearer
  │                 DEPLOY_AGENT_SHARED_SECRET)
  └─ editor container  ("editor", :3773)  ← DEPLOY_AGENT_EDITOR_UPSTREAM
       ├─ router/supervisor (Bun, :3773)         ◄── NEW, the only
       │    Host → slug (reuse parseWorkspaceSlugFromHost logic)        │
       │    ensure per-slug process up; proxy HTTP+WS; idle-stop        │
       ├─ node dist/bin.mjs /workspaces/<slugA>                         │
       │    T3CODE_PORT=4001 T3CODE_HOME=/state/<slugA>                 │
       ├─ node dist/bin.mjs /workspaces/<slugB>  (T3CODE_PORT=4002 …)   │
       └─ … spawned on first request, killed after idle TTL ───────────┘
```

Caddy forwards the original `Host`, so each per-slug editor process
still runs its own `clerkGate` check and refuses non-members
(`clerkGate.ts:420-426`).

## What already exists and is reused verbatim

| Piece | File | Used for |
|---|---|---|
| Hetzner API client | `lib/hosting/hetzner.ts` (`HetznerClient`, `clientFromEnv` reads `HETZNER_API_TOKEN`) | provision the VPS |
| Cloud-init generator | `lib/hosting/cloud-init.ts` (`CLOUD_INIT_VERSION=2`) | first-boot: Caddy+Docker+Node22+claude+deploy-agent |
| Deploy agent | `apps/deploy-agent` (`POST /sites/:slug/deploy`, `DEPLOY_AGENT_EDITOR_UPSTREAM=http://editor:3773`) | site artifacts + Caddy snippet incl. `/editor/*` route |
| Deploy flow | `lib/hosting/deploy.ts` (`deploySite()`) | publish client site builds |
| Cloudflare DNS | `lib/hosting/cloudflare.ts` (`CloudflareClient.upsertRecord`, `CLOUDFLARE_API_TOKEN`) | `<slug>` DNS record |
| Schema | `hosting_servers`, `workspaces` (`hosting_server_id`, `site_directory`, `cloudflare_*`), `workspace_hosts`, `deployments` (`20260507120000_v1_extensions.sql`, `20260430000001_workspaces.sql`) | server/workspace/domain state |
| Editor auth/routing | `clerkGate.ts` (`parseWorkspaceSlugFromHost`, `resolveAuthorization`, `EDITOR_PUBLIC_DOMAIN`) | Host→workspace, membership enforcement |

Provisioning a host is already a solved path: `HetznerClient.createServer({ image:'ubuntu-24.04', server_type:'cpx22', ssh_keys, user_data: buildCloudInit({...}) })` → row in `hosting_servers` → cloud-init brings up Caddy + deploy-agent.

## What must be built (the actual work)

1. **Editor Dockerfile** (`apps/flowstarter-editor`). Multi-stage:
   build `@flowstarter/editor-web` + `@flowstarter/editor-server`
   (`node dist/bin.mjs`), include the `claude` CLI, expose `:3773`,
   entrypoint = the router/supervisor (below). Image referenced by the
   Caddy snippet as `editor:3773`.
2. **In-container router/supervisor** (small Bun service, the core new
   component). Responsibilities:
   - parse workspace slug from `Host` (same rule as
     `parseWorkspaceSlugFromHost`);
   - ensure a per-slug child: `node dist/bin.mjs /workspaces/<slug>`
     with `T3CODE_PORT=<assigned>`, `T3CODE_HOME=/state/<slug>`,
     `T3CODE_AUTO_BOOTSTRAP_PROJECT_FROM_CWD=true`;
   - reverse-proxy HTTP **and websockets** to that child;
   - idle-stop a child after an inactivity TTL; respawn on next hit
     (state in `/state/<slug>` persists across restarts);
   - concurrency cap + memory ceiling per child (bound blast radius).
3. **Per-workspace code on the box.** `/workspaces/<slug>` is a git
   checkout of the client's repo, on a Docker volume. Needs a canonical
   repo location — **no Supabase column for it today**
   (`workspaces.site_directory` is the *deployed* path, not the editable
   source). Add `workspaces.editor_repo_url` / `editor_repo_ref`
   (migration, idempotent, per the Supabase rule), and a checkout step
   at onboarding (clone) the router can `git pull` on spawn.
4. **Admin acceptance → provision → operator redirect** (Task 8): in
   flowstarter-main admin, when a client project is accepted —
   - create/confirm Supabase `workspaces` row + `slug` + membership;
   - pick an `active` `hosting_servers` row with capacity (or provision
     one via `HetznerClient`);
   - ensure the repo is checked out into that host's editor volume;
   - `CloudflareClient.upsertRecord` for `<slug>.<EDITOR_PUBLIC_DOMAIN>`
     (A → server ipv4, proxied);
   - redirect the operator to `https://<slug>.<domain>/editor/`.
5. **Operator service** — *architected, not built* (CONCIERGE_PIVOT_PLAN).
   Today DNS/provisioning would run inline in a Netlify function
   (10–26 s limit) while real provisioning is 60–120 s. v1 mitigation:
   do only the **fast** steps inline (DNS upsert, redirect — the host
   is pre-provisioned and warm); defer host creation to a pre-warmed
   pool. A proper Bun operator service on Hetzner (job queue, Hetzner
   API, Docker lifecycle, DNS) is the durable fix and the next infra
   milestone.

## v1 scope vs deferred (stated honestly)

**v1 delivers:** single editor container + router (per-slug process,
on-demand, idle-stop) on a pre-provisioned Hetzner host via the
existing cloud-init/Caddy/deploy-agent; admin-accept → DNS upsert →
operator redirect; per-process+per-cwd isolation; clerkGate auth.

**Deferred (do before paying clients at volume):** the operator
service (so provisioning isn't on a Netlify function); pre-publish
snapshots + one-click rollback for the editor path; per-client
sessions/month quota enforcement; multi-host capacity autoscaling.

## Operations gotchas (learned in prod)

- **`IS_SANDBOX=1` is required on every per-client editor container.**
  The container runs as root, and "Full access" runtime mode makes the
  Claude Agent SDK pass `--dangerously-skip-permissions`, which Claude
  Code refuses under root ("cannot be used with root/sudo privileges")
  → the agent turn dies with *"Claude Code process exited with code 1 /
  Runtime error"*. Each tenant is already isolated in its own
  container, so it genuinely is a sandbox: set `IS_SANDBOX=1` (it lives
  in the deploy-composed `/etc/flowstarter/editor.env`). Without it,
  default-permission threads work but full-access ones fail. Note
  `docker restart` does not re-read `--env-file`; recreate the
  container (`docker rm -f` + `docker run`) to apply env changes.
- **The editor SPA fetches root-absolute paths** that must be routed to
  the editor container, not the static landing fallback:
  `/.well-known/t3/*`, `/api/*`, `/attachments/*`, and the `/ws`
  websocket. Missing any of these returns the landing `index.html` and
  the SPA throws *"Unexpected token '<' … is not valid JSON"*.
- A thread whose first turn failed records a Claude session id that was
  never persisted; reopening it resumes a dead id (*"No conversation
  found with session ID …"*). Start a new thread rather than retrying a
  poisoned one.

## Open items to confirm

- `EDITOR_PUBLIC_DOMAIN` and the exact editor hostname pattern
  (`<slug>.flowstarter.app` vs `<slug>.editor.flowstarter.app`) — read
  from env / `@flowstarter/platform-config`, never hardcoded.
- Canonical client **source repo** location (GitHub org? bare repo on
  the host?) → drives the new `workspaces.editor_repo_url` column.
- Prod env on Netlify: confirm `HETZNER_SSH_KEY_ID`,
  `DEPLOY_AGENT_SHARED_SECRET`, `CLOUDFLARE_API_TOKEN`,
  `caddyAcmeEmail` are set there (only `HETZNER_API_TOKEN` is in local
  `.env.local`).
