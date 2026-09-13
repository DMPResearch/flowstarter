#!/usr/bin/env node
// Unit test for classifyInventory(), the pure rule at the heart of
// tenant-table-guard.mjs.
//
//   node apps/flowstarter-main/scripts/tenant-table-guard.classify.test.mjs
//
// This is deliberately NOT a vitest test: the app's `pnpm test` runs
// `vitest --root src`, and this script lives under scripts/, outside that
// root, the same reason backup.sh's tests live in a plain bash file next to
// it rather than in the vitest suite. What this proves is the classification
// side of the guard (given an inventory, are the right tables flagged
// unaccounted or stale); the CI "Tenant Isolation" job proves the other
// half — that public.tenant_key_tables() really does enumerate every table
// with a tenant or personal-data key column — against a live local stack
// (see supabase/migrations/20260913100000_tenant_table_guard_widen_inventory.sql
// and the security audit's M4 finding this fixes).
//
// Sets SUPABASE_JWT_SECRET before importing so the module's top-level
// "do we have a service key" guard does not process.exit(2) on import; the
// entry-point guard at the bottom of tenant-table-guard.mjs keeps the
// import from also starting a real network call.
//
// Static `import` statements are hoisted above every other top-level
// statement in an ES module regardless of where they are written, so
// setting the env var textually "before" a static import of
// tenant-table-guard.mjs would not actually run first. A dynamic
// `await import(...)` is used instead, which evaluates in the order
// written.
process.env.SUPABASE_JWT_SECRET ??=
  'test-only-secret-at-least-32-characters-long';

import assert from 'node:assert/strict';
import test from 'node:test';
const { classifyInventory } = await import('./tenant-table-guard.mjs');

const TENANT_TABLES = [{ table: 'workspaces' }, { table: 'assets' }];
const SERVER_ONLY_TABLES = ['profiles', 'leads'];

function row(table_name, ...tenant_columns) {
  return { table_name, tenant_columns };
}

test('a table named in TENANT_TABLES is proved as tenant-scoped', () => {
  const { rows, unaccounted } = classifyInventory(
    [row('assets', 'workspace_id')],
    {
      tenantTables: TENANT_TABLES,
      serverOnlyTables: SERVER_ONLY_TABLES,
      allowList: [],
    }
  );
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].detail, 'tenant-scoped');
  assert.deepEqual(unaccounted, []);
});

test('a table named in SERVER_ONLY_TABLES is proved as server-only', () => {
  const { rows, unaccounted } = classifyInventory(
    [row('profiles', 'clerk_user_id', 'email')],
    {
      tenantTables: TENANT_TABLES,
      serverOnlyTables: SERVER_ONLY_TABLES,
      allowList: [],
    }
  );
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].detail, 'server-only');
  assert.deepEqual(unaccounted, []);
});

test('TENANT_TABLES wins when a table is (incorrectly) listed in both', () => {
  const { rows } = classifyInventory([row('assets', 'workspace_id')], {
    tenantTables: TENANT_TABLES,
    serverOnlyTables: ['assets', ...SERVER_ONLY_TABLES],
    allowList: [],
  });
  assert.equal(rows[0].detail, 'tenant-scoped');
});

test('a table in neither list, and not in ALLOW_LIST, is unaccounted', () => {
  const { rows, unaccounted } = classifyInventory(
    [row('mystery_bookings', 'booking_id')],
    {
      tenantTables: TENANT_TABLES,
      serverOnlyTables: SERVER_ONLY_TABLES,
      allowList: [],
    }
  );
  assert.equal(rows[0].status, 'unproved');
  assert.deepEqual(unaccounted, ['mystery_bookings']);
});

test('this is exactly the M4 regression: a clerk_user_id/email/preview_id-keyed table the old 3-column inventory would never have surfaced still gets classified once surfaced', () => {
  const { rows, unaccounted } = classifyInventory(
    [
      row('new_feature_signups', 'email'),
      row('new_feature_sessions', 'clerk_user_id'),
      row('new_feature_previews', 'preview_id'),
    ],
    {
      tenantTables: TENANT_TABLES,
      serverOnlyTables: SERVER_ONLY_TABLES,
      allowList: [],
    }
  );
  assert.equal(rows.length, 3);
  assert.ok(rows.every((r) => r.status === 'unproved'));
  assert.deepEqual(unaccounted.sort(), [
    'new_feature_previews',
    'new_feature_sessions',
    'new_feature_signups',
  ]);
});

test('an ALLOW_LIST entry with a reason is accepted, not unaccounted', () => {
  const { rows, unaccounted } = classifyInventory(
    [row('scratch_table', 'user_id')],
    {
      tenantTables: TENANT_TABLES,
      serverOnlyTables: SERVER_ONLY_TABLES,
      allowList: [{ table: 'scratch_table', reason: 'test fixture' }],
    }
  );
  assert.equal(rows[0].status, 'allowed');
  assert.equal(rows[0].detail, 'test fixture');
  assert.deepEqual(unaccounted, []);
});

test('an ALLOW_LIST entry for a table that is now proved is reported stale', () => {
  const { stale } = classifyInventory([row('assets', 'workspace_id')], {
    tenantTables: TENANT_TABLES,
    serverOnlyTables: SERVER_ONLY_TABLES,
    allowList: [{ table: 'assets', reason: 'stale — assets is proved now' }],
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].table, 'assets');
  assert.match(stale[0].why, /now proved/);
});

test('an ALLOW_LIST entry for a table that no longer exists in the inventory is reported stale', () => {
  const { stale } = classifyInventory([], {
    tenantTables: TENANT_TABLES,
    serverOnlyTables: SERVER_ONLY_TABLES,
    allowList: [{ table: 'deleted_table', reason: 'used to exist' }],
  });
  assert.equal(stale.length, 1);
  assert.equal(stale[0].table, 'deleted_table');
  assert.match(stale[0].why, /no longer exists/);
});

test('an empty inventory is fully accounted for and not stale', () => {
  const { rows, unaccounted, stale } = classifyInventory([], {
    tenantTables: TENANT_TABLES,
    serverOnlyTables: SERVER_ONLY_TABLES,
    allowList: [],
  });
  assert.deepEqual(rows, []);
  assert.deepEqual(unaccounted, []);
  assert.deepEqual(stale, []);
});
