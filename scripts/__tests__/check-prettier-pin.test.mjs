#!/usr/bin/env node
/**
 * Self-check for scripts/check-prettier-pin.mjs, run directly with
 * `node scripts/__tests__/check-prettier-pin.test.mjs`.
 *
 * Exercises the pure semver/drift/documentation logic against fixtures (no
 * filesystem beyond a scratch pnpm-workspace.yaml + package.json set), plus
 * one end-to-end CLI run against a scratch repo, so the wiring that reads
 * pnpm-workspace.yaml and docs/dev-machine.md is covered too. This is the
 * regression test for the defect this script exists to catch: the repo root
 * pinning a different Prettier major than apps/flowstarter-main without
 * that being written down anywhere, which is exactly the state that let an
 * ambiguously-resolved Prettier reformat files a commit never touched.
 */
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  semverMajor,
  readWorkspacePatterns,
  expandWorkspacePatterns,
  collectPrettierPins,
  findDrift,
  isDriftDocumented,
  APP_WORKSPACE,
} from '../check-prettier-pin.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'check-prettier-pin.mjs');

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

function assert(desc, condition, detail) {
  if (condition) {
    pass(desc);
  } else {
    fail(desc, detail);
  }
}

// -- semverMajor -------------------------------------------------------
assertEqual('semverMajor reads a caret range', semverMajor('^2.8.8'), 2);
assertEqual('semverMajor reads a tilde range', semverMajor('~3.6.2'), 3);
assertEqual('semverMajor reads a bare version', semverMajor('3.6.2'), 3);
assertEqual('semverMajor returns null for garbage', semverMajor('latest'), null);

// -- findDrift -----------------------------------------------------------
assertEqual(
  'no drift when every pin shares the app major',
  findDrift([
    { workspace: APP_WORKSPACE, version: '^2.8.8' },
    { workspace: 'packages/flow-design-system', version: '^2.9.0' },
  ]).drifting,
  [],
);

assertEqual(
  'flags a workspace whose major differs from the app pin',
  findDrift([
    { workspace: APP_WORKSPACE, version: '^2.8.8' },
    { workspace: 'root', version: '~3.6.2' },
  ]).drifting,
  [{ workspace: 'root', version: '~3.6.2', major: 3 }],
);

assertEqual(
  'no drift reported when the app itself does not pin prettier',
  findDrift([{ workspace: 'root', version: '~3.6.2' }]).drifting,
  [],
);

// -- isDriftDocumented ----------------------------------------------------
const app = { workspace: APP_WORKSPACE, version: '^2.8.8', major: 2 };
const drifting = [{ workspace: 'root', version: '~3.6.2', major: 3 }];

assert(
  'undocumented drift is reported as such',
  isDriftDocumented('# dev machine\n\nnothing about prettier here.', app, drifting)
    .documented === false,
);

assert(
  'drift documented with the section header and both exact versions passes',
  isDriftDocumented(
    '## Prettier version pins\n\nroot pins ~3.6.2, apps/flowstarter-main pins ^2.8.8, on purpose.',
    app,
    drifting,
  ).documented === true,
);

assert(
  'a stale doc (old version string) is treated as undocumented',
  isDriftDocumented(
    '## Prettier version pins\n\nroot pins ~3.5.0, apps/flowstarter-main pins ^2.8.8.',
    app,
    drifting,
  ).documented === false,
  'a version bump without a doc update must re-fail this check',
);

// -- workspace pattern expansion (this repo's real pnpm-workspace.yaml) --
try {
  const patterns = readWorkspacePatterns(path.join(__dirname, '..', '..'));
  assert(
    'reads apps/* out of the real pnpm-workspace.yaml',
    patterns.includes('apps/*'),
    JSON.stringify(patterns),
  );
} catch (err) {
  fail('reads the real pnpm-workspace.yaml', err.message);
}

// -- end-to-end CLI, against a scratch repo -------------------------------
const scratch = mkdtempSync(path.join(tmpdir(), 'check-prettier-pin-'));
try {
  function scaffold(rootPrettier, docsContent) {
    rmSync(scratch, { recursive: true, force: true });
    mkdirSync(scratch, { recursive: true });
    writeFileSync(
      path.join(scratch, 'pnpm-workspace.yaml'),
      'packages:\n  - apps/*\n',
    );
    writeFileSync(
      path.join(scratch, 'package.json'),
      JSON.stringify({ name: 'root', devDependencies: { prettier: rootPrettier } }),
    );
    mkdirSync(path.join(scratch, 'apps', 'flowstarter-main'), { recursive: true });
    writeFileSync(
      path.join(scratch, 'apps', 'flowstarter-main', 'package.json'),
      JSON.stringify({ name: 'flowstarter-main', devDependencies: { prettier: '^2.8.8' } }),
    );
    mkdirSync(path.join(scratch, 'docs'), { recursive: true });
    writeFileSync(path.join(scratch, 'docs', 'dev-machine.md'), docsContent ?? '');
  }

  // Matching majors: passes regardless of docs.
  scaffold('^2.9.0', '');
  try {
    execFileSync('node', [scriptPath, '--root', scratch], { stdio: 'pipe' });
    pass('CLI exits 0 when every pin shares the app major');
  } catch (err) {
    fail('CLI exits 0 when every pin shares the app major', `exited ${err.status}: ${err.stderr}`);
  }

  // Drifting, undocumented: fails.
  scaffold('~3.6.2', '# dev machine\n');
  try {
    execFileSync('node', [scriptPath, '--root', scratch], { stdio: 'pipe' });
    fail('CLI exits non-zero on undocumented drift', 'exited 0');
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    assert(
      'CLI exits non-zero on undocumented drift, naming the root workspace',
      err.status !== 0 && stderr.includes('root') && stderr.includes('~3.6.2'),
      `status=${err.status} stderr=${stderr}`,
    );
  }

  // Drifting, documented: passes.
  scaffold(
    '~3.6.2',
    '## Prettier version pins\n\nroot pins ~3.6.2, apps/flowstarter-main pins ^2.8.8, on purpose.\n',
  );
  try {
    execFileSync('node', [scriptPath, '--root', scratch], { stdio: 'pipe' });
    pass('CLI exits 0 on documented drift');
  } catch (err) {
    fail('CLI exits 0 on documented drift', `exited ${err.status}: ${err.stderr}`);
  }

  assertEqual(
    'collectPrettierPins finds both the root and app pins on the scratch repo',
    collectPrettierPins(scratch).sort((a, b) => a.workspace.localeCompare(b.workspace)),
    [
      { workspace: APP_WORKSPACE, version: '^2.8.8' },
      { workspace: 'root', version: '~3.6.2' },
    ],
  );
} finally {
  rmSync(scratch, { recursive: true, force: true });
}

// expandWorkspacePatterns, exercised directly against a throwaway tree.
{
  const dir = mkdtempSync(path.join(tmpdir(), 'expand-patterns-'));
  try {
    mkdirSync(path.join(dir, 'apps', 'a'), { recursive: true });
    mkdirSync(path.join(dir, 'apps', 'b'), { recursive: true });
    writeFileSync(path.join(dir, 'apps', 'not-a-dir.txt'), '');
    const expanded = expandWorkspacePatterns(dir, ['apps/*']).sort();
    assertEqual('expands dir/* to its subdirectories only', expanded, ['apps/a', 'apps/b']);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
