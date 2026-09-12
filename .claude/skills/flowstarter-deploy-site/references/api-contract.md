# Deploy API contract reference

Full request/response shapes for the two layers in the deploy path. Source files cited inline; if they diverge from this doc, trust the source.

## Layer 1 — `flowstarter-main` deploy endpoint

**Route:** `POST /api/team/projects/[id]/site/deploy`
**Source:** `apps/flowstarter-main/src/app/api/team/projects/[id]/site/deploy/route.ts`
**Auth:** `requireTeamAuth()` — Clerk session, `role` ∈ `{team, admin}`.

### Request body

```ts
{
  artifact_url: string;       // required, http(s) URL the agent will fetch
  artifact_sha256?: string;   // optional 64-char hex; agent rejects on mismatch
}
```

The route validates that `artifact_url` parses as a URL with `http:` or `https:` protocol. Other shapes (e.g. raw bytes) are not exposed via this route — `HttpDeployAgentClient.push` supports them but only when called in-process.

### Success response (HTTP 200)

```ts
{
  deployment: {
    deploymentId: string;        // uuid; matches deployments.id
    version: number;             // monotonic per workspace
    status: 'live' | 'failed';
    detail: string | null;       // failure reason if status='failed'
  },
  dryRun: boolean;               // true when DEPLOY_AGENT_DRY_RUN=true
}
```

`status: 'failed'` with HTTP 200 is intentional: the orchestrator successfully recorded a failed deploy. Check `status` before declaring success.

### Error response (HTTP 4xx/5xx)

```ts
{
  error: string;
  code?: DeployErrorCode;        // present when DeployError thrown
}
```

`DeployErrorCode` values and their HTTP mapping (`route.ts:112-122`):

| Code | HTTP |
|---|---|
| `workspace_not_found` | 404 |
| `workspace_unallocated` | 409 |
| `server_not_found` | 404 |
| `server_not_active` | 409 |
| `agent_not_configured` | 409 |
| `secret_not_configured` | 409 |
| `secret_unavailable` | 500 |
| `agent_error` | 502 |
| `db_error` | 500 |

Bad-request validation (no `DeployError`):
- 400 `artifact_url is required` — missing or empty
- 400 `artifact_url must be http(s)` — bad protocol
- 400 `artifact_url is not a valid URL` — unparseable

### Side effects (success path)

In order, executed in `deploySite()`:

1. **Insert `deployments` row** with `status='building'`, `version = max(existing)+1`.
2. **Update workspace** `deploy_status='deploying'`.
3. **Push to agent** via `HttpDeployAgentClient.push()` — returns `{sha256, sizeBytes}`. On failure, marks the deployment `failed`, workspace `failed`, returns 200 with status='failed'.
4. **Cloudflare DNS claim** (best-effort) — the site's final hostname `{slug}.{platformDomain}` → `server.ipv4`, A record, TTL 60, not proxied. `claimRecord`, not `upsertRecord`: an existing record pointing elsewhere is a refusal, never an overwrite, and a wildcard is refused outright. Skipped if `CLOUDFLARE_API_TOKEN` or `CLOUDFLARE_DEFAULT_ZONE_ID` are unset, or if `cloudflare_default_zone_id` is null. DNS errors are logged but do not fail the deploy.
5. **Update deployment** `status='live'`, `finished_at=now`, `artifact_sha256`, `artifact_bytes`.
6. **Update workspace** `deploy_status='live'`, `last_deploy_id`, `last_deployed_at=now`.

## Layer 2 — `deploy-agent` HTTP API

**Source:** `apps/deploy-agent/src/index.ts`
**Auth:** `Authorization: Bearer <DEPLOY_AGENT_SHARED_SECRET>` on every endpoint except `/health`.

### `GET /health`

No auth. Returns `{ ok: true, version: '0.1.0' }`. Use for liveness checks during bootstrap.

### `POST /sites/:slug/deploy`

Slug must match `/^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/`. Anything else returns 400 `invalid slug`.

**JSON body:**
```ts
{
  artifact_url: string;
  artifact_sha256?: string | null;
  primary_domain?: string | null;
  additional_domains?: string[];
}
```

**Bytes body** (`Content-Type: application/octet-stream`):
- Body is the raw tarball.
- `X-Site-Primary-Domain` header for primary domain.
- `X-Site-Additional-Domains` header, comma-separated.
- `X-Artifact-Sha256` header, optional digest.

The flowstarter-main route only sends JSON form. The bytes form is reserved for in-process callers (e.g. operator service, future bulk redeploy).

**Behavior:**
1. `ensureDirs()` — `mkdir -p` on `SITES_ROOT`, `CADDY_SITES_DIR`, `TEMP_ROOT`.
2. Fetch `artifact_url`, hash, verify against `artifact_sha256` if provided.
3. Stage tarball to `${TEMP_ROOT}/<stamp>.tar.gz`.
4. `tar -xzf <staged> -C <siteDir>.staging-<ts>` then atomic rename: existing `siteDir` → `<siteDir>.backup-<ts>`, staging → `siteDir`. Backup is best-effort cleaned up.
5. Write Caddy snippet to `${CADDY_SITES_DIR}/<slug>.caddy` (atomic via `.tmp` + rename).
6. `${CADDY_RELOAD_CMD}` — defaults to `systemctl reload caddy`.

**Caddy snippet template:**
```
# Managed by flowstarter deploy-agent — site <slug>
<host1>, <host2>, ... {
  encode gzip zstd
  root * <siteDir>
  try_files {path} {path}/ /index.html
  file_server
}
```

Hosts include: `primary_domain`, every `additional_domains` entry, the final site host (if `DEPLOY_AGENT_SITE_DOMAIN_TEMPLATE` is set) and the preview host (if `DEPLOY_AGENT_PREVIEW_DOMAIN_TEMPLATE` is set). Duplicates are dropped, because Caddy refuses a block naming one host twice. Empty host list → no snippet written, returns success but the site has no Caddy entry (intentional for migration scenarios).

**Success (200):**
```ts
{
  ok: true,
  slug: string,
  sha256: string,         // computed digest (always present)
  sizeBytes: number,
  siteDir: string,        // absolute path on disk
}
```

**Errors:**
- 400 `artifact_url required`
- 401 `unauthorized` (bad/missing bearer)
- 502 — fetch failure or sha256 mismatch
- 500 — extract failure, snippet write failure, Caddy reload failure

### `DELETE /sites/:slug`

Removes `${SITES_ROOT}/<slug>` recursively (best-effort), removes the Caddy snippet, reloads Caddy. Idempotent: 200 even if the site never existed.

## `deployments` table fields

Source: `apps/flowstarter-main/src/lib/database.types.ts` (search for `deployments`).

| Column | Type | Notes |
|---|---|---|
| `id` | uuid | PK |
| `workspace_id` | uuid | FK → workspaces |
| `version` | int | Monotonic per workspace, allocated by `deploySite()` |
| `status` | enum | `building` → `live` or `failed` |
| `status_detail` | text | Failure reason when `status='failed'` |
| `started_at` | timestamptz | Insert time |
| `finished_at` | timestamptz | Set on terminal status |
| `deployed_by` | text | Clerk user id from `auth.userId` |
| `artifact_url` | text | The URL the operator passed (null for bytes-mode) |
| `artifact_sha256` | text | Final hash (from agent on success, request hash on failure) |
| `artifact_bytes` | int | Size in bytes (set on success) |
| `rolled_back_from_id` | uuid | Set when this deploy is a rollback to a prior version |

`workspaces` updates touched by a deploy: `deploy_status` (`pending`/`deploying`/`live`/`failed`), `last_deploy_id`, `last_deployed_at`.

## Cloudflare DNS claim

Code: `deploy.ts:328-354`. Best-effort, never fails the deploy. Uses `CloudflareClient.upsertRecord` with:
- `type: 'A'`
- `name: <slug>.<platformDomain>` (from `finalHostname()` in `src/lib/hosting/site-hostnames.ts`, whose domain comes from `resolvePlatformDomain()` in `@flowstarter/platform-config`)
- `content: server.ipv4`
- `ttl: 60`, `proxied: false`
- `comment: flowstarter site <slug>`

Custom domains from `workspace_hosts` are written into the Caddy snippet but their DNS is **not** auto-upserted — operator must point the apex/CNAME at the server's IPv4 manually. This is intentional; customers control their own DNS.

## In-process callers (alternative to HTTP)

For automation that runs inside `flowstarter-main` (e.g. background jobs, admin scripts), import `deploySite()` directly and pass:
- `supabase` — service-role client.
- `agentClient` — `new HttpDeployAgentClient()` for real, `new DryRunDeployAgentClient()` for tests.
- `cloudflare` — optional; pass `null` to skip DNS.
- `resolveSharedSecret` — function that turns `deploy_agent_secret_ref` into the actual secret. The route's implementation falls back to `process.env.DEPLOY_AGENT_SHARED_SECRET`; production should resolve via Supabase Vault.

This bypasses Clerk auth entirely, so reserve it for trusted server-side contexts.
