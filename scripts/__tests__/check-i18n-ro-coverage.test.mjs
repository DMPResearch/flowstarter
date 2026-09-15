#!/usr/bin/env node
/**
 * Self-check for scripts/check-i18n-ro-coverage.mjs, run directly with
 * `node scripts/__tests__/check-i18n-ro-coverage.test.mjs`.
 *
 * Exercises the pure extraction/grouping logic against fixtures (no
 * filesystem, no real locale catalogue), plus one end-to-end run against a
 * scratch `locales/` directory through `--locales`, so the CLI wiring is
 * covered too. This is the regression test for the exact defect the script
 * exists to catch: the Romanian discovery catalogue silently falling back
 * to English for every key nobody had translated yet (see PR #196's
 * finding, 2026-09-15).
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  extractKeys,
  findMissingByBlock,
  VISITOR_FACING_BLOCKS,
} from '../check-i18n-ro-coverage.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'check-i18n-ro-coverage.mjs');

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

// extractKeys reads top-level quoted keys out of a catalogue's source text,
// single-line and wrapped values alike, and ignores anything that is not a
// key assignment (a comment, a nested nav prefix used only as a value).
assertEqual(
  'extractKeys finds single-line and wrapped keys, ignores non-key lines',
  [
    ...extractKeys(`const en = {
  // a comment, not a key
  'app.name': 'Flowstarter',
  'app.description':
    'A description that wraps onto its own line',
} as const;`),
  ].sort(),
  ['app.description', 'app.name'],
);

// A clean set: every en key in a checked block has a ro counterpart.
assertEqual(
  'no missing keys when every block is fully translated',
  findMissingByBlock(
    new Set(['dashboard.title', 'dashboard.loading']),
    new Set(['dashboard.title', 'dashboard.loading']),
    ['dashboard.'],
  ),
  [],
);

// The exact regression this script exists to catch: a whole block with no
// ro translations at all.
assertEqual(
  'flags every key in an untranslated block, sorted, under its block',
  findMissingByBlock(
    new Set(['landing.discovery.chat.title', 'landing.discovery.brand.adjust']),
    new Set(),
    ['landing.discovery.'],
  ),
  [
    {
      block: 'landing.discovery.',
      missing: [
        'landing.discovery.brand.adjust',
        'landing.discovery.chat.title',
      ],
    },
  ],
);

// A prefix match, not a substring match: admin.dashboard.* and
// team.dashboard.* must not be swept up by the dashboard.* block, because
// they are staff tooling this script is not meant to cover.
assertEqual(
  'dashboard. block excludes admin.dashboard. and team.dashboard.',
  findMissingByBlock(
    new Set([
      'dashboard.title',
      'admin.dashboard.activity.title',
      'team.dashboard.revenue',
    ]),
    new Set(),
    ['dashboard.'],
  ),
  [{ block: 'dashboard.', missing: ['dashboard.title'] }],
);

// A block with nothing missing is left out of the result entirely, not
// reported with an empty list.
assertEqual(
  'a fully-translated block produces no group',
  findMissingByBlock(
    new Set(['moderation.termsOfService', 'dashboard.title']),
    new Set(['moderation.termsOfService']),
    ['moderation.', 'dashboard.'],
  ),
  [{ block: 'dashboard.', missing: ['dashboard.title'] }],
);

// VISITOR_FACING_BLOCKS is the list this script and the vitest companion
// test both check against the real catalogue -- staff-only prefixes must
// never be in it.
if (
  VISITOR_FACING_BLOCKS.some(
    (block) => block.startsWith('admin.') || block.startsWith('team.'),
  )
) {
  fail(
    'VISITOR_FACING_BLOCKS excludes staff-only prefixes',
    'found admin. or team. entry',
  );
} else {
  pass('VISITOR_FACING_BLOCKS excludes staff-only prefixes');
}

// End-to-end: the CLI exits 0 on a scratch locales/ dir with full coverage,
// and non-zero, naming the missing keys grouped by block, on a partial one.
const scratch = mkdtempSync(path.join(tmpdir(), 'check-i18n-ro-coverage-'));
try {
  const cleanDir = path.join(scratch, 'clean', 'locales');
  const partialDir = path.join(scratch, 'partial', 'locales');
  for (const dir of [cleanDir, partialDir]) {
    mkdirSync(path.join(dir, 'en'), { recursive: true });
  }

  const writeCatalogue = (dir, roHasChatTitle) => {
    writeFileSync(
      path.join(dir, 'en.ts'),
      `const en = {\n  'dashboard.title': 'Project Overview',\n} as const;\nexport default en;\n`,
    );
    writeFileSync(
      path.join(dir, 'en', 'admin.ts'),
      `export const adminKeys = {\n  'admin.dashboard.title': 'Ops',\n};\n`,
    );
    writeFileSync(
      path.join(dir, 'en', 'discovery-call.ts'),
      `export const discoveryCallKeys = {\n  'landing.discovery.scope.checking': 'Reading that back',\n};\n`,
    );
    writeFileSync(
      path.join(dir, 'ro.ts'),
      roHasChatTitle
        ? `const ro = {\n  'dashboard.title': 'Prezentare generală',\n  'landing.discovery.scope.checking': 'Verificăm ce ne-ați spus',\n};\nexport default ro;\n`
        : `const ro = {\n  'dashboard.title': 'Prezentare generală',\n};\nexport default ro;\n`,
    );
  };

  writeCatalogue(cleanDir, true);
  writeCatalogue(partialDir, false);

  try {
    execFileSync('node', [scriptPath, '--locales', cleanDir], {
      stdio: 'pipe',
    });
    pass('CLI exits 0 when every visitor-facing key is translated');
  } catch (err) {
    fail(
      'CLI exits 0 when every visitor-facing key is translated',
      `exited ${err.status}`,
    );
  }

  try {
    execFileSync('node', [scriptPath, '--locales', partialDir], {
      stdio: 'pipe',
    });
    fail('CLI exits non-zero when a visitor-facing key is missing', 'exited 0');
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (
      err.status !== 0 &&
      stderr.includes('landing.discovery.scope.checking') &&
      !stderr.includes('admin.dashboard.title')
    ) {
      pass('CLI exits non-zero, naming the missing key and excluding admin.*');
    } else {
      fail(
        'CLI exits non-zero, naming the missing key and excluding admin.*',
        `status=${err.status} stderr=${stderr}`,
      );
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
