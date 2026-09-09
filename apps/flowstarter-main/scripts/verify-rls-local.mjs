#!/usr/bin/env node
/**
 * Proves per-tenant isolation against the LOCAL Supabase stack, for real, for
 * every table that carries a tenant key.
 *
 * The shape of the proof, per tenant-scoped table:
 *
 *   service role   -> sees both workspaces' rows (it bypasses RLS by design)
 *   member of A    -> sees A's row and exactly zero of B's
 *   member of A    -> an unfiltered select returns A's row and nothing else
 *   non-member     -> a signed-in user with no membership sees zero rows
 *   anon           -> denied outright, no grant on the table at all
 *   member of A    -> an insert carrying B's tenant key is refused
 *   member of A    -> an update of B's row changes nothing
 *
 * And, per server-only table: both anon and authenticated are refused, on the
 * grant, before RLS is even consulted.
 *
 * Every one of those runs off the TABLE-DRIVEN LIST below. Adding a table to
 * the proof is one entry in TENANT_TABLES or one string in SERVER_ONLY_TABLES,
 * and `scripts/tenant-table-guard.mjs` fails CI for any table in `public` with
 * a tenant column that appears in neither.
 *
 * Also proved here:
 *   - the private `tenant-assets` storage bucket: a member of A can read and
 *     list their own `tenant/{A}/` prefix and can do neither under `tenant/{B}/`
 *   - the RLS helper functions are not executable by anon, so an anon key
 *     cannot use public.is_workspace_member() as a membership oracle
 *
 * The member's identity is a JWT minted here with the local JWT secret,
 * carrying the Clerk user id in `sub` and `role: authenticated` - the same
 * shape Clerk's session token has when it reaches PostgREST in production.
 * That is exactly what public.current_clerk_user_id() reads.
 *
 * Usage:  node scripts/verify-rls-local.mjs
 * Exits non-zero if any assertion failed. Cleans up after itself.
 *
 * Refuses to talk to anything but 127.0.0.1/localhost. Never point this at a
 * hosted project: it writes.
 */
import { createHmac, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// ─── Local stack configuration ─────────────────────────────────────────────

/**
 * A short, single-line preview of CLI output that can never carry a key.
 * Anything shaped like a JWT or a Supabase token is blanked first, then the
 * whitespace is folded so the warning stays one line.
 */
function preview(text) {
  return (text ?? '')
    .replace(/eyJ[A-Za-z0-9_.\-]{8,}/g, '[redacted]')
    .replace(/sb[a-z]*_[A-Za-z0-9_\-]{8,}/g, '[redacted]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200);
}

/**
 * The local stack's keys as `supabase status -o json` reports them.
 *
 * A failure here is not fatal, because the environment is consulted first
 * and can supply the same four values, but it must not be silent. CI spent a build
 * failing as "Missing local keys" because this swallowed a non-zero exit and
 * returned an empty object, so every miss now says why, with the exit code
 * and a redacted slice of what the CLI actually printed.
 */
function fromSupabaseStatus() {
  // CI starts the stack with most services excluded, and the CLI then prints
  // "Stopped services: [...]" instead of a payload. `SUPABASE_STATUS=off`
  // skips the call outright so the keys come from the environment.
  if (process.env.SUPABASE_STATUS === 'off') return {};
  const run = spawnSync('supabase', ['status', '-o', 'json'], {
    encoding: 'utf8',
  });
  const stdout = run.stdout ?? '';
  const stderr = run.stderr ?? '';
  const warn = (reason) =>
    console.warn(
      `[verify-rls] ${reason} (exit ${run.status ?? 'n/a'}); falling back to the environment. ` +
        `stderr: ${preview(stderr) || '(empty)'} | stdout: ${preview(stdout) || '(empty)'}`,
    );

  if (run.error) {
    warn(`could not run \`supabase status\`: ${run.error.message}`);
    return {};
  }
  if (run.status !== 0) {
    warn('`supabase status -o json` exited non-zero');
    return {};
  }
  // Some CLI versions print a human preamble before the payload, so the JSON
  // is taken from the first `{` to the last `}` rather than the whole stream.
  const start = stdout.indexOf('{');
  const end = stdout.lastIndexOf('}');
  if (start === -1 || end < start) {
    warn('`supabase status -o json` printed no JSON object');
    return {};
  }
  try {
    return JSON.parse(stdout.slice(start, end + 1));
  } catch {
    warn('`supabase status -o json` output did not parse as JSON');
    return {};
  }
}

const status = fromSupabaseStatus();
const API_URL =
  process.env.SUPABASE_URL ?? status.API_URL ?? 'http://127.0.0.1:54321';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET ?? status.JWT_SECRET;

const host = new URL(API_URL).hostname;
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.error(`Refusing to run against non-local host: ${host}`);
  process.exit(2);
}
if (!JWT_SECRET) {
  console.error(
    'Missing the local JWT secret. Start the stack with `supabase start`, or set ' +
      'SUPABASE_JWT_SECRET (and, if you have them, SUPABASE_ANON_KEY / ' +
      'SUPABASE_SERVICE_ROLE_KEY).',
  );
  process.exit(2);
}

// ─── Minimal HS256 JWT, no dependencies ────────────────────────────────────

const b64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function signJwt(claims) {
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(JSON.stringify(claims));
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

function mintClerkStyleJwt(clerkUserId) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({
    sub: clerkUserId, // Clerk user id, what current_clerk_user_id() reads
    role: 'authenticated', // selects the database role in PostgREST
    aud: 'authenticated',
    iat: now,
    exp: now + 600,
  });
}

/**
 * An `anon` or `service_role` key for the local stack, signed here.
 *
 * The stack's own keys are used when they can be read, but CI starts the
 * stack with most services excluded and `supabase status` then reports no
 * keys at all, in either output format. Those keys are nothing more than
 * HS256 tokens carrying a role claim over the local JWT secret, which is the
 * only thing PostgREST checks, so a runner holding the secret can sign its
 * own rather than depend on the CLI printing them.
 */
function mintRoleKey(role) {
  const now = Math.floor(Date.now() / 1000);
  return signJwt({ iss: 'supabase-demo', role, iat: now, exp: now + 3600 });
}

const ANON_KEY =
  process.env.SUPABASE_ANON_KEY ?? status.ANON_KEY ?? mintRoleKey('anon');
const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  status.SERVICE_ROLE_KEY ??
  mintRoleKey('service_role');

// ─── REST helpers ──────────────────────────────────────────────────────────

async function rest(path, { key, token, method = 'GET', body, prefer } = {}) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${token ?? key}`,
    'Content-Type': 'application/json',
  };
  if (prefer) headers['Prefer'] = prefer;
  const response = await fetch(`${API_URL}/rest/v1${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

const asService = (path, options = {}) =>
  rest(path, { ...options, key: SERVICE_KEY });
const asAnon = (path, options = {}) =>
  rest(path, { ...options, key: ANON_KEY });
const asMember = (path, token, options = {}) =>
  rest(path, { ...options, key: ANON_KEY, token });

// ─── The table-driven list ─────────────────────────────────────────────────
//
// One entry per tenant-scoped table. Adding a table to the proof is one entry
// here. Fields:
//
//   table        the relation name, as PostgREST addresses it
//   tenantKey    the column carrying the tenant id. `workspaces` is the tenant
//                itself, so its key is its own `id`.
//   select       columns a member is allowed to read, as a select list. Kept
//                narrow on purpose: `site_versions.manifest` is not granted,
//                and asking for it would fail for the right reason but the
//                wrong assertion.
//   seed         (workspaceId, run) => row, inserted with the service role into
//                both workspace A and workspace B. Null when the base fixture
//                already creates the row (workspaces, workspace_memberships).
//   forgedInsert (workspaceId, run) => row, the cross-tenant insert a member of
//                A attempts against B. Defaults to `seed`.
//   updatePatch  the patch a member of A attempts against B's row. Every table
//                needs one: a PATCH with no body is not a test.
//   ownInsert    optional. (workspaceId, run, clerkUserId) => row that a member
//                IS permitted to insert into their own workspace, for the two
//                tables that grant INSERT to authenticated. Asserting the
//                allowed case matters as much as the denied one: a policy that
//                denies everything is isolated and also broken.
//   ownUpdate    optional. A patch a member IS permitted to make on their own
//                row (assets: `selected`).
//   deniedColumnUpdate  optional. A patch on a column outside the column-level
//                grant, which must be refused even on the member's own row.
//   deniedColumnSelect  optional. A column the member must not be able to read
//                even on their own row (site_versions.manifest).

export const TENANT_TABLES = [
  {
    table: 'workspaces',
    tenantKey: 'id',
    select: 'id',
    seed: null,
    forgedInsert: (_workspaceId, run) => ({
      slug: `rls-forged-${run}`,
      name: `RLS forged ${run}`,
      site_kind: 'astro',
    }),
    updatePatch: { name: 'renamed by another tenant' },
  },
  {
    table: 'workspace_memberships',
    tenantKey: 'workspace_id',
    select: 'workspace_id,clerk_user_id',
    seed: null,
    // The self-promotion attempt: a member of A writing themselves a
    // membership row in B. Every policy in the schema keys on this table, so
    // this is the single most important insert in the file.
    forgedInsert: (workspaceId, run) => ({
      workspace_id: workspaceId,
      clerk_user_id: `user_rlscheck_a_${run}`,
      role: 'admin',
    }),
    updatePatch: { role: 'admin' },
  },
  {
    table: 'assets',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId, run) => ({
      workspace_id: workspaceId,
      source: 'upload',
      kind: 'image',
      sha256: `sha-${run}`,
    }),
    updatePatch: { selected: true },
    ownUpdate: { selected: true },
    deniedColumnUpdate: { caption: 'rewritten by the client' },
  },
  {
    table: 'asset_rights_confirmations',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId, run) => ({
      workspace_id: workspaceId,
      confirmed_by: `user_seed_${run}`,
    }),
    ownInsert: (workspaceId, run, clerkUserId) => ({
      workspace_id: workspaceId,
      confirmed_by: clerkUserId,
      statement_version: `v-${run}`,
    }),
    updatePatch: { confirmed_by: 'someone else' },
  },
  {
    table: 'brand_signals',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId) => ({ workspace_id: workspaceId }),
    updatePatch: { tone_notes: 'rewritten by another tenant' },
  },
  {
    table: 'intake_submissions',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId) => ({
      workspace_id: workspaceId,
      routing_decision: 'standard',
    }),
    updatePatch: { routing_decision: 'custom' },
  },
  {
    table: 'project_events',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId) => ({ workspace_id: workspaceId, kind: 'rls_check' }),
    updatePatch: { kind: 'rewritten' },
  },
  {
    table: 'project_messages',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id',
    seed: (workspaceId) => ({
      workspace_id: workspaceId,
      direction: 'outbound',
      kind: 'clarification',
      body: 'seeded by the RLS check',
    }),
    ownInsert: (workspaceId, run, clerkUserId) => ({
      workspace_id: workspaceId,
      direction: 'inbound',
      kind: 'client_reply',
      body: `client reply ${run}`,
      created_by: clerkUserId,
    }),
    updatePatch: { body: 'rewritten by another tenant' },
  },
  {
    table: 'site_versions',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id,version',
    seed: (workspaceId) => ({
      workspace_id: workspaceId,
      version: 1,
      manifest: { files: [] },
      summary: 'seeded by the RLS check',
    }),
    updatePatch: { summary: 'rewritten by another tenant' },
    // `manifest` is the site's source. It is deliberately outside the
    // column-level SELECT grant, so even the member's own row must not yield it.
    deniedColumnSelect: 'manifest',
  },
  {
    table: 'flowstarter_change_requests',
    tenantKey: 'workspace_id',
    select: 'id,workspace_id,status',
    seed: (workspaceId, run) => ({
      workspace_id: workspaceId,
      request: `please change the hero heading ${run}`,
      created_by: `user_seed_${run}`,
    }),
    updatePatch: { status: 'accepted' },
  },
];

// ─── Server-only tables ────────────────────────────────────────────────────
//
// RLS on, zero policies, and no grant for anon or authenticated. Both roles
// must be refused on the grant, before RLS is consulted, so the deny does not
// depend on nobody ever adding a policy without thinking about the grants.
//
// The selfserve_* five are here because the self-serve app has no tenant model
// at all: no workspace, no membership, only a clerk_user_id on
// selfserve_projects that nothing keys on. Service-role-only is the honest
// classification for them, not an interim one.

export const SERVER_ONLY_TABLES = [
  'llm_usage',
  'flowstarter_agent_jobs',
  'flowstarter_agent_job_events',
  'flowstarter_project_artifacts',
  'funnel_previews',
  'discovery_leads',
  'custom_inquiries',
  'hosting_servers',
  'workspace_billing_profiles',
  'workspace_hosts',
  'client_constraint_profiles',
  'ai_audit_logs',
  'commerce_products',
  'contact_submissions',
  'demo_edit_counters',
  'demo_generation_costs',
  'deployments',
  'editor_sessions',
  'leads',
  'profiles',
  'setup_payment_milestones',
  'vault_encrypted_secrets',
  'selfserve_projects',
  'selfserve_builds',
  'selfserve_payments',
  'selfserve_leads',
  'selfserve_rate_limits',
];

// ─── Assertions ────────────────────────────────────────────────────────────

let failures = 0;
let checks = 0;
function check(label, ok, detail) {
  checks += 1;
  console.log(
    `${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? ` - ${detail}` : ''}`,
  );
  if (!ok) failures += 1;
}

const rowCount = (response) =>
  Array.isArray(response.body)
    ? response.body.length
    : `not-an-array:${JSON.stringify(response.body)}`;

/** Denied at the grant or at the policy: 401 and 403 are the two shapes. */
const isRefused = (response) =>
  response.status === 401 || response.status === 403;

/**
 * A write that changed nothing. Either it was refused outright, or PostgREST
 * accepted it and the RLS `using` clause matched zero rows, which with
 * `return=representation` comes back as an empty array.
 */
const changedNothing = (response) =>
  isRefused(response) ||
  (response.status < 300 &&
    Array.isArray(response.body) &&
    response.body.length === 0);

// ─── Fixture ───────────────────────────────────────────────────────────────

const run = randomUUID().slice(0, 8);
const userA = `user_rlscheck_a_${run}`;
const userB = `user_rlscheck_b_${run}`;
const userOutsider = `user_rlscheck_out_${run}`;
const created = { workspaces: [], storageObjects: [] };

async function seed() {
  const workspaces = await asService('/workspaces', {
    method: 'POST',
    prefer: 'return=representation',
    body: [
      {
        slug: `rls-check-a-${run}`,
        name: `RLS check A ${run}`,
        site_kind: 'astro',
      },
      {
        slug: `rls-check-b-${run}`,
        name: `RLS check B ${run}`,
        site_kind: 'astro',
      },
    ],
  });
  if (workspaces.status >= 300) {
    throw new Error(
      `workspace insert failed: ${JSON.stringify(workspaces.body)}`,
    );
  }
  const [a, b] = workspaces.body;
  created.workspaces.push(a.id, b.id);

  // A member each. B needs one too, or "member of A reads zero of B's
  // memberships" would pass against an empty table and prove nothing.
  const memberships = await asService('/workspace_memberships', {
    method: 'POST',
    prefer: 'return=representation',
    body: [
      { workspace_id: a.id, clerk_user_id: userA, role: 'client' },
      { workspace_id: b.id, clerk_user_id: userB, role: 'client' },
    ],
  });
  if (memberships.status >= 300) {
    throw new Error(
      `membership insert failed: ${JSON.stringify(memberships.body)}`,
    );
  }

  // One row per tenant-scoped table, in each workspace.
  const rows = {};
  for (const entry of TENANT_TABLES) {
    if (!entry.seed) continue;
    const inserted = await asService(`/${entry.table}`, {
      method: 'POST',
      prefer: 'return=representation',
      body: [entry.seed(a.id, run), entry.seed(b.id, run)],
    });
    if (inserted.status >= 300) {
      throw new Error(
        `${entry.table} seed failed: ${JSON.stringify(inserted.body)}`,
      );
    }
    rows[entry.table] = { a: inserted.body[0], b: inserted.body[1] };
  }
  rows.workspaces = { a, b };
  rows.workspace_memberships = {
    a: { workspace_id: a.id, clerk_user_id: userA },
    b: { workspace_id: b.id, clerk_user_id: userB },
  };
  return { a, b, rows };
}

async function cleanup() {
  for (const object of created.storageObjects) {
    await storage(`/object/tenant-assets/${object}`, {
      key: SERVICE_KEY,
      method: 'DELETE',
    });
  }
  for (const id of created.workspaces) {
    await asService(`/workspaces?id=eq.${id}`, { method: 'DELETE' });
  }
}

// ─── Storage REST ──────────────────────────────────────────────────────────

async function storage(
  path,
  { key, token, method = 'GET', body, contentType } = {},
) {
  const headers = {
    apikey: key,
    Authorization: `Bearer ${token ?? key}`,
  };
  if (contentType) headers['Content-Type'] = contentType;
  let payload;
  if (body !== undefined) {
    if (contentType === 'application/json' || contentType === undefined) {
      headers['Content-Type'] = contentType ?? 'application/json';
      payload = JSON.stringify(body);
    } else {
      payload = body;
    }
  }
  const response = await fetch(`${API_URL}/storage/v1${path}`, {
    method,
    headers,
    body: payload,
  });
  const text = await response.text();
  let parsed = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }
  return { status: response.status, body: parsed };
}

// ─── Per-table proof ───────────────────────────────────────────────────────

async function proveTenantTable(entry, context) {
  const { a, b, rows, tokenA, tokenOutsider } = context;
  const { table, tenantKey, select } = entry;
  const seeded = rows[table];
  const label = (what) => `${table}: ${what}`;

  // The service role bypasses RLS and must see both. If it does not, the
  // fixture is wrong and every "member sees nothing" below would pass for the
  // wrong reason.
  const svc = await asService(
    `/${table}?${tenantKey}=in.(${a.id},${b.id})&select=${encodeURIComponent(tenantKey)}`,
  );
  check(
    label('service role sees both tenants'),
    svc.status === 200 && Array.isArray(svc.body) && svc.body.length >= 2,
    `status=${svc.status} rows=${rowCount(svc)}`,
  );

  // Member of A reads A.
  const own = await asMember(
    `/${table}?${tenantKey}=eq.${a.id}&select=${encodeURIComponent(select)}`,
    tokenA,
  );
  check(
    label("member of A reads A's rows"),
    own.status === 200 && Array.isArray(own.body) && own.body.length >= 1,
    `status=${own.status} rows=${rowCount(own)}`,
  );

  // Member of A reads zero of B.
  const cross = await asMember(
    `/${table}?${tenantKey}=eq.${b.id}&select=${encodeURIComponent(select)}`,
    tokenA,
  );
  check(
    label("member of A reads ZERO of B's rows"),
    cross.status === 200 &&
      Array.isArray(cross.body) &&
      cross.body.length === 0,
    `status=${cross.status} rows=${rowCount(cross)}`,
  );

  // An unfiltered select is the query a leak actually looks like: no client
  // filter at all, the whole table, and only RLS between the caller and it.
  const unfiltered = await asMember(
    `/${table}?${tenantKey}=in.(${a.id},${b.id})&select=${encodeURIComponent(select)}`,
    tokenA,
  );
  const unfilteredOnlyA =
    unfiltered.status === 200 &&
    Array.isArray(unfiltered.body) &&
    unfiltered.body.length >= 1 &&
    unfiltered.body.every((row) => String(row[tenantKey] ?? row.id) === a.id);
  check(
    label('unfiltered select leaks nothing across tenants'),
    unfilteredOnlyA,
    `status=${unfiltered.status} rows=${rowCount(unfiltered)}`,
  );

  // A signed-in user with no membership anywhere.
  const outsider = await asMember(
    `/${table}?${tenantKey}=in.(${a.id},${b.id})&select=${encodeURIComponent(select)}`,
    tokenOutsider,
  );
  check(
    label('authenticated non-member reads zero rows'),
    outsider.status === 200 &&
      Array.isArray(outsider.body) &&
      outsider.body.length === 0,
    `status=${outsider.status} rows=${rowCount(outsider)}`,
  );

  // Anon.
  const anon = await asAnon(
    `/${table}?${tenantKey}=in.(${a.id},${b.id})&select=${encodeURIComponent(select)}`,
  );
  check(
    label('anon is denied'),
    isRefused(anon) ||
      (anon.status === 200 &&
        Array.isArray(anon.body) &&
        anon.body.length === 0),
    `status=${anon.status}`,
  );

  // Cross-tenant insert: a row carrying B's tenant key, written by a member of A.
  const forge = entry.forgedInsert ?? entry.seed;
  const forgedInsert = await asMember(`/${table}`, tokenA, {
    method: 'POST',
    prefer: 'return=representation',
    body: forge(b.id, `forged-${run}`, userA),
  });
  check(
    label('member of A cannot insert into B'),
    isRefused(forgedInsert),
    `status=${forgedInsert.status}`,
  );

  // Cross-tenant update: B's rows, patched by a member of A.
  const crossUpdate = await asMember(
    `/${table}?${tenantKey}=eq.${b.id}`,
    tokenA,
    {
      method: 'PATCH',
      prefer: 'return=representation',
      body: entry.updatePatch,
    },
  );
  check(
    label("member of A cannot update B's rows"),
    changedNothing(crossUpdate),
    `status=${crossUpdate.status} rows=${rowCount(crossUpdate)}`,
  );

  // Cross-tenant delete.
  const crossDelete = await asMember(
    `/${table}?${tenantKey}=eq.${b.id}`,
    tokenA,
    {
      method: 'DELETE',
      prefer: 'return=representation',
    },
  );
  check(
    label("member of A cannot delete B's rows"),
    changedNothing(crossDelete),
    `status=${crossDelete.status} rows=${rowCount(crossDelete)}`,
  );

  // The permitted cases, where there are any. A policy set that denies
  // everything is isolated and also useless; these prove the feature still works.
  if (entry.ownInsert) {
    const ownInsert = await asMember(`/${table}`, tokenA, {
      method: 'POST',
      prefer: 'return=representation',
      body: entry.ownInsert(a.id, run, userA),
    });
    check(
      label('member of A may insert into their own workspace'),
      ownInsert.status < 300,
      `status=${ownInsert.status} body=${JSON.stringify(ownInsert.body)}`,
    );
  }

  if (entry.ownUpdate) {
    const ownUpdate = await asMember(
      `/${table}?${tenantKey}=eq.${a.id}`,
      tokenA,
      {
        method: 'PATCH',
        prefer: 'return=representation',
        body: entry.ownUpdate,
      },
    );
    check(
      label('member of A may update their own row'),
      ownUpdate.status === 200 &&
        Array.isArray(ownUpdate.body) &&
        ownUpdate.body.length >= 1,
      `status=${ownUpdate.status} rows=${rowCount(ownUpdate)}`,
    );
  }

  if (entry.deniedColumnUpdate) {
    const denied = await asMember(`/${table}?${tenantKey}=eq.${a.id}`, tokenA, {
      method: 'PATCH',
      body: entry.deniedColumnUpdate,
    });
    check(
      label('member cannot write a column outside the column grant'),
      isRefused(denied),
      `status=${denied.status}`,
    );
  }

  if (entry.deniedColumnSelect) {
    const denied = await asMember(
      `/${table}?${tenantKey}=eq.${a.id}&select=${encodeURIComponent(entry.deniedColumnSelect)}`,
      tokenA,
    );
    check(
      label(`member cannot read ${entry.deniedColumnSelect}, even their own`),
      isRefused(denied),
      `status=${denied.status}`,
    );
  }

  // Nothing the forged insert attempted may have landed.
  const residue = await asService(
    `/${table}?${tenantKey}=eq.${b.id}&select=${encodeURIComponent(tenantKey)}`,
  );
  check(
    label("B's row count is unchanged after the forged writes"),
    residue.status === 200 &&
      Array.isArray(residue.body) &&
      residue.body.length === 1,
    `status=${residue.status} rows=${rowCount(residue)}`,
  );
}

async function proveServerOnlyTable(table, tokenA) {
  const anon = await asAnon(`/${table}?select=*&limit=1`);
  check(
    `${table}: anon is denied (server-only)`,
    isRefused(anon),
    `status=${anon.status}`,
  );
  const member = await asMember(`/${table}?select=*&limit=1`, tokenA);
  check(
    `${table}: authenticated is denied (server-only)`,
    isRefused(member),
    `status=${member.status}`,
  );
}

// ─── The RLS helper functions ──────────────────────────────────────────────
//
// public.is_workspace_member() is security definer and reads
// workspace_memberships on the caller's behalf. An anon key carries no `sub`
// claim so it can never answer true, but being able to call it at all is a
// membership oracle: one probe per guessed workspace id. anon must not hold
// EXECUTE. PostgREST answers a function it cannot execute with 404 (it is not
// in that role's schema cache) or 403.

async function proveHelperFunctions(a, tokenA) {
  const unreachable = (response) =>
    response.status === 401 ||
    response.status === 403 ||
    response.status === 404;

  const anonMember = await asAnon('/rpc/is_workspace_member', {
    method: 'POST',
    body: { ws: a.id },
  });
  check(
    'anon cannot execute is_workspace_member()',
    unreachable(anonMember),
    `status=${anonMember.status}`,
  );

  const anonClerk = await asAnon('/rpc/current_clerk_user_id', {
    method: 'POST',
    body: {},
  });
  check(
    'anon cannot execute current_clerk_user_id()',
    unreachable(anonClerk),
    `status=${anonClerk.status}`,
  );

  // The authenticated side must still work, or every policy in the schema
  // would deny everything and the checks above would pass for a bad reason.
  const memberCall = await asMember('/rpc/is_workspace_member', tokenA, {
    method: 'POST',
    body: { ws: a.id },
  });
  check(
    'a member can execute is_workspace_member() and it answers true',
    memberCall.status === 200 && memberCall.body === true,
    `status=${memberCall.status} body=${JSON.stringify(memberCall.body)}`,
  );
}

// ─── The private storage bucket ────────────────────────────────────────────
//
// Every tenant-owned object is `tenant/{workspaceId}/...` in the private
// `tenant-assets` bucket, and storage.objects carries one policy: select, for
// authenticated, where the workspace id in the path is one the caller is a
// member of. Proved here through the storage REST API with the same minted
// JWTs, because that is the surface a leaked member token would actually hit.

async function proveStorageBucket(a, b, tokenA) {
  const objectA = `tenant/${a.id}/assets/rls-check-${run}.json`;
  const objectB = `tenant/${b.id}/assets/rls-check-${run}.json`;

  for (const [name, workspaceId] of [
    [objectA, a.id],
    [objectB, b.id],
  ]) {
    const upload = await storage(`/object/tenant-assets/${name}`, {
      key: SERVICE_KEY,
      method: 'POST',
      contentType: 'application/json',
      body: { workspace: workspaceId, run },
    });
    if (upload.status >= 300) {
      check(
        `storage: seed ${name}`,
        false,
        `status=${upload.status} body=${JSON.stringify(upload.body)}`,
      );
      return;
    }
    created.storageObjects.push(name);
  }

  const readOwn = await storage(
    `/object/authenticated/tenant-assets/${objectA}`,
    {
      key: ANON_KEY,
      token: tokenA,
    },
  );
  check(
    "storage: member of A reads A's object",
    readOwn.status === 200,
    `status=${readOwn.status}`,
  );

  const readCross = await storage(
    `/object/authenticated/tenant-assets/${objectB}`,
    {
      key: ANON_KEY,
      token: tokenA,
    },
  );
  check(
    "storage: member of A cannot read B's object",
    readCross.status >= 400,
    `status=${readCross.status}`,
  );

  const listOwn = await storage('/object/list/tenant-assets', {
    key: ANON_KEY,
    token: tokenA,
    method: 'POST',
    contentType: 'application/json',
    body: { prefix: `tenant/${a.id}/assets`, limit: 100 },
  });
  check(
    "storage: member of A lists A's prefix",
    listOwn.status === 200 &&
      Array.isArray(listOwn.body) &&
      listOwn.body.length >= 1,
    `status=${listOwn.status} rows=${rowCount(listOwn)}`,
  );

  const listCross = await storage('/object/list/tenant-assets', {
    key: ANON_KEY,
    token: tokenA,
    method: 'POST',
    contentType: 'application/json',
    body: { prefix: `tenant/${b.id}/assets`, limit: 100 },
  });
  check(
    "storage: member of A lists ZERO of B's prefix",
    listCross.status >= 400 ||
      (Array.isArray(listCross.body) && listCross.body.length === 0),
    `status=${listCross.status} rows=${rowCount(listCross)}`,
  );

  const listAnon = await storage('/object/list/tenant-assets', {
    key: ANON_KEY,
    method: 'POST',
    contentType: 'application/json',
    body: { prefix: `tenant/${a.id}/assets`, limit: 100 },
  });
  check(
    'storage: anon lists nothing',
    listAnon.status >= 400 ||
      (Array.isArray(listAnon.body) && listAnon.body.length === 0),
    `status=${listAnon.status} rows=${rowCount(listAnon)}`,
  );

  // Writes are the service role's alone: there is no insert policy on
  // storage.objects, not even for the member's own prefix.
  const writeOwn = await storage(
    `/object/tenant-assets/tenant/${a.id}/assets/forged-${run}.json`,
    {
      key: ANON_KEY,
      token: tokenA,
      method: 'POST',
      contentType: 'application/json',
      body: { forged: true },
    },
  );
  check(
    'storage: member cannot upload, even into their own prefix',
    writeOwn.status >= 400,
    `status=${writeOwn.status}`,
  );
}

// ─── The run ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Supabase: ${API_URL}`);
  const { a, b, rows } = await seed();
  console.log(`workspace A = ${a.id}\nworkspace B = ${b.id}\n`);

  const tokenA = mintClerkStyleJwt(userA);
  const tokenOutsider = mintClerkStyleJwt(userOutsider);
  const context = { a, b, rows, tokenA, tokenOutsider };

  console.log(
    `── ${TENANT_TABLES.length} tenant-scoped tables ───────────────────────────────────`,
  );
  for (const entry of TENANT_TABLES) {
    await proveTenantTable(entry, context);
  }

  console.log(
    `\n── ${SERVER_ONLY_TABLES.length} server-only tables ──────────────────────────────────────`,
  );
  for (const table of SERVER_ONLY_TABLES) {
    await proveServerOnlyTable(table, tokenA);
  }

  console.log(
    '\n── RLS helper functions ───────────────────────────────────────',
  );
  await proveHelperFunctions(a, tokenA);

  console.log(
    '\n── storage bucket tenant-assets ───────────────────────────────',
  );
  await proveStorageBucket(a, b, tokenA);
}

/**
 * Run the suite only when this file is the entry point.
 *
 * `scripts/tenant-table-guard.mjs` imports TENANT_TABLES and
 * SERVER_ONLY_TABLES from here, so that the guard and the proof can never
 * drift apart: there is one list, at the top of this file, and adding a table
 * to it is the single line that both a new proof and a passing guard need.
 * Importing must therefore not seed two workspaces and start writing.
 */
const invokedDirectly =
  process.argv[1] &&
  realpathSync(process.argv[1]) ===
    realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) {
  main()
    .then(cleanup, async (error) => {
      await cleanup();
      throw error;
    })
    .then(() => {
      console.log(
        `\n${checks} checks run. ${failures === 0 ? 'All checks passed.' : `${failures} check(s) failed.`}`,
      );
      process.exit(failures === 0 ? 0 : 1);
    })
    .catch((error) => {
      console.error(error);
      process.exit(1);
    });
}
