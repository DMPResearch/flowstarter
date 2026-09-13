#!/usr/bin/env node
/**
 * Self-check for scripts/check-migration-versions.mjs, run directly with
 * `node scripts/__tests__/check-migration-versions.test.mjs`.
 *
 * Exercises the pure grouping/collision logic against fixtures (no
 * filesystem, no supabase/migrations/), plus one end-to-end run against a
 * scratch directory through `--dir`, so the CLI wiring is covered too. This
 * is the regression test for the exact defect fixed alongside it: two
 * migrations sharing a version
 * (`20260913120000_assets_original_name.sql` /
 * `20260913120000_workspaces_cal_provisioning.sql`) going unnoticed until a
 * stack's `supabase_migrations.schema_migrations` behaved inconsistently.
 */
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { groupByVersion, findCollisions } from '../check-migration-versions.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'check-migration-versions.mjs');

let failures = 0;

function pass(desc) {
  console.log(`ok - ${desc}`);
}

function fail(desc, detail) {
  console.log(`not ok - ${desc}${detail ? ` (${detail})` : ''}`);
  failures += 1;
}

function assertEqual(desc, actual, expected) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a === e) {
    pass(desc);
  } else {
    fail(desc, `expected ${e}, got ${a}`);
  }
}

// A clean set: every version unique, no collisions.
assertEqual(
  'no collisions when every version is unique',
  findCollisions(
    groupByVersion([
      '20260912190000_ops_alerts.sql',
      '20260913120000_workspaces_cal_provisioning.sql',
      '20260913121000_assets_original_name.sql',
      '20260913123000_workspace_briefs_page_count.sql',
    ]),
  ),
  [],
);

// The exact regression this script exists to catch.
assertEqual(
  'flags two files sharing a version, sorted by filename within the group',
  findCollisions(
    groupByVersion([
      '20260913120000_workspaces_cal_provisioning.sql',
      '20260913120000_assets_original_name.sql',
    ]),
  ),
  [
    {
      version: '20260913120000',
      filenames: ['20260913120000_assets_original_name.sql', '20260913120000_workspaces_cal_provisioning.sql'],
    },
  ],
);

// Three-way collision on one version, unrelated file untouched.
assertEqual(
  'flags a three-way collision and leaves the unrelated version alone',
  findCollisions(
    groupByVersion([
      '20260913120000_a.sql',
      '20260913120000_b.sql',
      '20260913120000_c.sql',
      '20260913121000_d.sql',
    ]),
  ),
  [
    {
      version: '20260913120000',
      filenames: ['20260913120000_a.sql', '20260913120000_b.sql', '20260913120000_c.sql'],
    },
  ],
);

// Non-.sql files in the directory (README, .gitkeep) are ignored rather
// than treated as a colliding "version".
assertEqual(
  'ignores non-.sql files',
  findCollisions(groupByVersion(['README.md', '.gitkeep', '20260913120000_a.sql'])),
  [],
);

// End-to-end: the CLI exits 0 on a clean directory and non-zero, with the
// colliding filenames named on stderr, on a colliding one.
const scratch = mkdtempSync(path.join(tmpdir(), 'check-migration-versions-'));
try {
  const cleanDir = path.join(scratch, 'clean');
  const collidingDir = path.join(scratch, 'colliding');
  for (const dir of [cleanDir, collidingDir]) {
    execFileSync('mkdir', ['-p', dir]);
  }
  writeFileSync(path.join(cleanDir, '20260913120000_a.sql'), 'select 1;');
  writeFileSync(path.join(cleanDir, '20260913121000_b.sql'), 'select 1;');
  writeFileSync(path.join(collidingDir, '20260913120000_a.sql'), 'select 1;');
  writeFileSync(path.join(collidingDir, '20260913120000_b.sql'), 'select 1;');

  try {
    execFileSync('node', [scriptPath, '--dir', cleanDir], { stdio: 'pipe' });
    pass('CLI exits 0 on a directory with no collisions');
  } catch (err) {
    fail('CLI exits 0 on a directory with no collisions', `exited ${err.status}`);
  }

  try {
    execFileSync('node', [scriptPath, '--dir', collidingDir], { stdio: 'pipe' });
    fail('CLI exits non-zero on a directory with a collision', 'exited 0');
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (err.status !== 0 && stderr.includes('20260913120000_a.sql') && stderr.includes('20260913120000_b.sql')) {
      pass('CLI exits non-zero on a directory with a collision, naming both files');
    } else {
      fail('CLI exits non-zero on a directory with a collision, naming both files', `status=${err.status} stderr=${stderr}`);
    }
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
