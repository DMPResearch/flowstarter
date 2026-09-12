---
name: flowstarter-deploy-site
description: This skill should be used when the user asks to "deploy a workspace site", "ship the site", "publish the workspace", "push a build to the deploy agent", "POST to /site/deploy", or "release this concierge build". Wraps the Flowstarter `/api/team/projects/[id]/site/deploy` endpoint that pushes a built static-site artifact to the workspace's allocated Hetzner host via the per-host deploy-agent (extracts to `/var/www/sites/{slug}/`, writes Caddy snippet, reloads Caddy, claims the site's DNS record).
---

# Flowstarter site deploy

Concierge operators (and Claude acting on their behalf) use this skill to push a built site to the Hetzner host that owns a workspace. The artifact path is: build a static directory, tarball it, host the tarball at an HTTPS URL the deploy-agent can fetch, then POST that URL to the deploy endpoint.

The deploy endpoint orchestrates: server lookup, secret resolution, agent push (extract + Caddy snippet + reload), Cloudflare DNS claim for the site's final hostname, and writes a `deployments` row + bumps `workspaces.last_deploy_id`. See `apps/flowstarter-main/src/lib/hosting/deploy.ts` for the source-of-truth implementation.

## Preconditions

Verify all four before triggering a deploy. Most failures are caused by skipping one.

1. **Workspace allocated to a hosting server.** `workspaces.hosting_server_id` must be set, and that server must be `status='active'`. If not allocated, call `POST /api/team/projects/{id}/site` first (with optional `{server_id}`; defaults to least-loaded).
2. **Server bootstrap finished.** `hosting_servers.deploy_agent_url` and `deploy_agent_secret_ref` must both be non-null. Cloud-init sets these on first boot.
3. **Shared secret resolvable.** `flowstarter-main` resolves the secret via `process.env[ref.toUpperCase()] ?? process.env.DEPLOY_AGENT_SHARED_SECRET` (`apps/flowstarter-main/src/app/api/team/projects/[id]/site/deploy/route.ts:94`). For dev, set `DEPLOY_AGENT_SHARED_SECRET=dev-secret` in `apps/flowstarter-main/.env.local`.
4. **Caller has team/admin role.** `requireTeamAuth()` checks Clerk session for `role='team'|'admin'` (`apps/flowstarter-main/src/lib/api-auth.ts:195`). Calling from curl needs the operator's Clerk session cookie.

If any precondition fails, do not retry the deploy — fix the underlying state first, since the orchestrator records a `failed` deployment row on every failed attempt.

## Procedure

### 1. Build the static artifact

Project-specific. Common cases:
- Astro: `pnpm --filter <workspace> build` → `dist/`
- Next static export: `next build && next export` → `out/`
- SvelteKit static adapter: `pnpm build` → `build/`
- Plain HTML: the directory itself

The deploy-agent expects index files at the **root** of the tarball (e.g. `./index.html`, not `./dist/index.html`).

### 2. Tarball the build output

```bash
# From the build output directory — pack contents (note the trailing dot)
tar -C <build-dir> -czf /tmp/site.tar.gz .

# Verify root layout
tar -tzf /tmp/site.tar.gz | head
# expected: ./, ./index.html, ./assets/..., etc.
```

Do not include the build dir name itself (`tar -czf site.tar.gz dist/` is wrong — extracts to `/var/www/sites/<slug>/dist/index.html`).

### 3. Compute sha256 (recommended)

```bash
shasum -a 256 /tmp/site.tar.gz | awk '{print $1}'
```

Pass the hex digest as `artifact_sha256` so the agent rejects corrupted downloads (`apps/deploy-agent/src/index.ts:122`).

### 4. Host the tarball

The deploy-agent fetches the URL from inside the Hetzner host's network. Pick one based on environment:

| Environment | Recommended host |
|---|---|
| Local Level-3 testing (agent on laptop) | `python3 -m http.server 9000` in `/tmp/`, URL `http://localhost:9000/site.tar.gz` |
| Staging/prod | Public HTTPS URL — Supabase Storage public bucket, R2, S3, or signed CDN URL |

The URL must be reachable from the agent's host, not the operator's laptop. For prod, https is required by the project's URL handling (the route allows http but production hosts will be https).

Flowstarter does not yet ship a built-in artifact upload helper. If you need one repeatedly, add it under `apps/flowstarter-main/src/app/api/team/projects/[id]/site/artifact/` rather than re-rolling per-call.

### 5. Call the deploy endpoint

```bash
curl -sS -X POST "${BASE_URL}/api/team/projects/${WORKSPACE_ID}/site/deploy" \
  -H 'Content-Type: application/json' \
  -H "Cookie: ${FLOWSTARTER_SESSION_COOKIE}" \
  -d "$(jq -nc \
        --arg url "$ARTIFACT_URL" \
        --arg sha "$ARTIFACT_SHA256" \
        '{artifact_url:$url, artifact_sha256:$sha}')"
```

Inputs the operator must supply (do not invent):
- `BASE_URL` — `http://localhost:3000` for dev, the project's prod origin otherwise.
- `WORKSPACE_ID` — the `workspaces.id` UUID. Get from `GET /api/team/projects/{id}/site` or the admin UI.
- `FLOWSTARTER_SESSION_COOKIE` — operator's Clerk session cookie. Ask the user for it; never hardcode. Format: `__session=...`.
- `ARTIFACT_URL`, `ARTIFACT_SHA256` — from steps 2-4.

### 6. Interpret the response

Success (200):
```json
{
  "deployment": {
    "deploymentId": "uuid",
    "version": 7,
    "status": "live",
    "detail": null
  },
  "dryRun": false
}
```

`status: 'failed'` with HTTP 200 means the orchestrator recorded a failed deployment row — read `detail` for the agent error. HTTP non-200 means the orchestrator itself rejected the call before pushing — see error codes below.

After a successful deploy, surface to the operator:
- `deploymentId` and `version` (for rollback reference).
- Site URL: `<slug>.<platformDomain>` — the final hostname, from `src/lib/hosting/site-hostnames.ts` (the route returns this as `siteDomain` on `GET /site`). Never a `preview.` name: that namespace belongs to the temporary funnel previews, which expire and get reaped.
- Any custom domains from `workspace_hosts` are now live in Caddy; DNS for those is operator-managed, not auto-upserted.

## Error code map

`DeployError.code` → HTTP status (`route.ts:112`). Each maps to a specific recovery action.

| Code | HTTP | Cause | Recovery |
|---|---|---|---|
| `workspace_not_found` | 404 | Bad workspace id | Verify the UUID |
| `workspace_unallocated` | 409 | `hosting_server_id` is null | `POST /site` to allocate first |
| `server_not_found` | 404 | Server row deleted | Re-allocate workspace |
| `server_not_active` | 409 | Server `status != 'active'` | Wait, or migrate workspace |
| `agent_not_configured` | 409 | `deploy_agent_url` null | Finish cloud-init bootstrap |
| `secret_not_configured` | 409 | `deploy_agent_secret_ref` null | Set the ref on the server row |
| `secret_unavailable` | 500 | Env var with that ref name not set | Set in `.env.local` or Vault |
| `agent_error` | 502 | Agent returned non-2xx (network, sha mismatch, tar fail, Caddy reload fail) | Check agent logs |
| `db_error` | 500 | Supabase write failed | Check Supabase logs |

For `agent_error`, the agent's response body is in `DeployError.cause` — if visible, prefer it over the wrapped message for debugging. Common causes: artifact URL unreachable from the host (firewall, wrong scheme, expired signed URL), `tar` failure (malformed tarball), Caddy reload failed (broken snippet — but the agent writes atomically so this is rare).

## Local testing

Three tiers, in increasing setup cost. Pick the smallest that exercises what was changed.

**Level 1 — Agent only (no DB, no Next):** Start `📦 Deploy Agent` in mprocs (`s` to start), then curl `:8443` directly per `apps/deploy-agent/README.md:54`. Use this when changing the agent itself.

**Level 2 — Orchestrator only (dry-run agent):** `DEPLOY_AGENT_DRY_RUN=true pnpm dev:main`. The route uses `DryRunDeployAgentClient` and skips the network call. Workspace still needs `hosting_server_id`; server row needs `deploy_agent_url` + `deploy_agent_secret_ref` (any non-null values). Use this when changing `deploySite()` or the route.

**Level 3 — Full round-trip:** Start Docker → Supabase up → Deploy Agent up → set `DEPLOY_AGENT_SHARED_SECRET=dev-secret` in `apps/flowstarter-main/.env.local` → seed a `hosting_servers` row pointing at `http://localhost:8443` → allocate workspace → serve a tarball with `python3 -m http.server` → call the endpoint with the operator's session cookie. Use this only when validating the wire format end-to-end.

Unit suite (no agent, no DB): `pnpm --filter @flowstarter/flowstarter-main test src/lib/hosting/__tests__/deploy.test.ts`.

## Safety rules

- **Never invent a workspace id, server id, or session cookie.** Ask the operator if not provided.
- **Never run a real deploy against prod from local dev** without explicit confirmation. The deploy is reversible (rollback via re-deploy of an older artifact), but DNS changes propagate.
- **Inspect the response before declaring success.** `status: 'failed'` returns HTTP 200; checking only the status code will mislead.
- **Do not delete a workspace's `hosting_server_id`** to "reset" a stuck deploy — that orphans the live site dir on the host. Use the agent's DELETE endpoint or re-deploy a known-good artifact instead.

## Additional resources

- **`references/api-contract.md`** — Full request/response schemas, every field on the `deployments` table, the agent's HTTP contract, and the Cloudflare DNS step.
- **`apps/deploy-agent/README.md`** — Agent-side endpoints, env vars, and direct-call examples.
- **`apps/flowstarter-main/src/lib/hosting/deploy.ts`** — Source-of-truth orchestrator. Read before changing the contract.
