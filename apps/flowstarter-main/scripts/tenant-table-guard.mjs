#!/usr/bin/env node
/**
 * The guard that keeps tenant isolation true as tables are added.
 *
 * `scripts/verify-rls-local.mjs` proves isolation for the tables it knows
 * about. That proof is only worth what its list is worth: a table added next
 * month with a `workspace_id` on it and no entry in that list is unproven, and
 * nothing about a green CI run would say so.
 *
 * So this script asks the database instead of asking the list. It enumerates
 * every table in `public` that carries `workspace_id`, `project_id` or
 * `claimed_workspace_id` - through public.tenant_key_tables(), because
 * PostgREST does not expose information_schema - and fails unless each one is
 * either named in the verifier's TENANT_TABLES, named in its
 * SERVER_ONLY_TABLES, or listed in the ALLOW_LIST below with a reason.
 *
 * The two lists are imported from verify-rls-local.mjs rather than copied, so
 * adding a table to the proof is one line and the guard agrees automatically.
 *
 * `workspaces` never appears in the inventory: it is the tenant, so its key is
 * its own `id`, not a `workspace_id`. It is covered by the verifier by name.
 *
 * Usage:  node scripts/tenant-table-guard.mjs
 * Exits non-zero when a table is unaccounted for, or when an ALLOW_LIST entry
 * has gone stale.
 *
 * Refuses to talk to anything but 127.0.0.1/localhost.
 */
import { createHmac } from 'node:crypto';
import { TENANT_TABLES, SERVER_ONLY_TABLES } from './verify-rls-local.mjs';

/**
 * Tables that carry a tenant key and are deliberately outside both lists.
 *
 * This is the only escape hatch, and it is empty today: every table in the
 * schema with a tenant column is proved, either as tenant-scoped with
 * membership policies or as server-only with no grant for anon or
 * authenticated. An entry here is a promise that somebody looked; write the
 * reason for a reader who did not.
 *
 *   { table: 'some_table', reason: 'why this one is not proved' }
 */
const ALLOW_LIST = [];

// ─── Local stack configuration ─────────────────────────────────────────────

const API_URL = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321';
const JWT_SECRET = process.env.SUPABASE_JWT_SECRET;

const host = new URL(API_URL).hostname;
if (host !== '127.0.0.1' && host !== 'localhost' && host !== '::1') {
  console.error(`Refusing to run against non-local host: ${host}`);
  process.exit(2);
}

const b64url = (input) =>
  Buffer.from(input)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

/**
 * A service_role key for the local stack, signed here from the local JWT
 * secret. Same reasoning as the verifier: the CI stack starts with most
 * services excluded and `supabase status` reports no keys, and an HS256 token
 * carrying a role claim is the whole of what PostgREST checks.
 */
function mintServiceKey() {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const payload = b64url(
    JSON.stringify({
      iss: 'supabase-demo',
      role: 'service_role',
      iat: now,
      exp: now + 600,
    }),
  );
  const signature = createHmac('sha256', JWT_SECRET)
    .update(`${header}.${payload}`)
    .digest('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
  return `${header}.${payload}.${signature}`;
}

const SERVICE_KEY =
  process.env.SUPABASE_SERVICE_ROLE_KEY ??
  (JWT_SECRET ? mintServiceKey() : null);
if (!SERVICE_KEY) {
  console.error(
    'Missing the local JWT secret. Start the stack with `supabase start`, or set ' +
      'SUPABASE_JWT_SECRET (or SUPABASE_SERVICE_ROLE_KEY).',
  );
  process.exit(2);
}

// ─── The inventory ─────────────────────────────────────────────────────────

async function tenantKeyTables() {
  const response = await fetch(`${API_URL}/rest/v1/rpc/tenant_key_tables`, {
    method: 'POST',
    headers: {
      apikey: SERVICE_KEY,
      Authorization: `Bearer ${SERVICE_KEY}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  });
  const text = await response.text();
  if (response.status !== 200) {
    throw new Error(
      `tenant_key_tables() returned ${response.status}. Has ` +
        '20260909143500_tenant_isolation_hardening.sql been applied to this stack? ' +
        `Body: ${text.slice(0, 300)}`,
    );
  }
  return JSON.parse(text);
}

// ─── The run ───────────────────────────────────────────────────────────────

async function main() {
  console.log(`Supabase: ${API_URL}`);
  const inventory = await tenantKeyTables();
  inventory.sort((left, right) =>
    left.table_name.localeCompare(right.table_name),
  );

  const proved = new Map();
  for (const entry of TENANT_TABLES) proved.set(entry.table, 'tenant-scoped');
  for (const table of SERVER_ONLY_TABLES) {
    if (!proved.has(table)) proved.set(table, 'server-only');
  }
  const allowed = new Map(
    ALLOW_LIST.map((entry) => [entry.table, entry.reason]),
  );

  const unaccounted = [];
  console.log(`\n${inventory.length} tables in public carry a tenant key.\n`);
  for (const row of inventory) {
    const columns = row.tenant_columns.join(', ');
    if (proved.has(row.table_name)) {
      console.log(
        `  ok        ${row.table_name} (${columns}) - proved as ${proved.get(row.table_name)}`,
      );
    } else if (allowed.has(row.table_name)) {
      console.log(
        `  allowed   ${row.table_name} (${columns}) - ${allowed.get(row.table_name)}`,
      );
    } else {
      console.log(`  UNPROVED  ${row.table_name} (${columns})`);
      unaccounted.push(row.table_name);
    }
  }

  const inventoryNames = new Set(inventory.map((row) => row.table_name));
  const stale = ALLOW_LIST.filter(
    (entry) => !inventoryNames.has(entry.table) || proved.has(entry.table),
  );

  if (stale.length > 0) {
    console.error('\nStale ALLOW_LIST entries. Remove them:');
    for (const entry of stale) {
      const why = proved.has(entry.table)
        ? 'it is now proved by the verifier'
        : 'the table no longer exists';
      console.error(`  ${entry.table} - ${why}`);
    }
  }

  if (unaccounted.length > 0) {
    console.error(
      `\n${unaccounted.length} table(s) carry a tenant key and are not proved by ` +
        'apps/flowstarter-main/scripts/verify-rls-local.mjs:\n' +
        unaccounted.map((table) => `  ${table}`).join('\n') +
        '\n\nAdd each one to TENANT_TABLES (tenant-scoped, membership policies) or to ' +
        'SERVER_ONLY_TABLES (no grant for anon or authenticated) in that file, or to ' +
        "this script's ALLOW_LIST with a reason.",
    );
  }

  if (unaccounted.length > 0 || stale.length > 0) process.exit(1);
  console.log('\nEvery table with a tenant key is proved.');
}

main().catch((error) => {
  console.error(error.message ?? error);
  process.exit(1);
});
