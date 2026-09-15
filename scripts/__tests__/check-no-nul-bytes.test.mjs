#!/usr/bin/env node
/**
 * Self-check for scripts/check-no-nul-bytes.mjs, run directly with
 * `node scripts/__tests__/check-no-nul-bytes.test.mjs`.
 *
 * Exercises the pure `isScannedFile` / `hasNulByte` logic against fixtures
 * (no filesystem beyond a scratch dir, no scan of the real repo), plus one
 * end-to-end run against a scratch git repo through `--dir`, so the CLI
 * wiring is covered too. This is the regression test for the exact defect
 * fixed alongside it: `useScopeRoute.ts` carried a literal NUL byte inside
 * `.join('\0')`, which made git render every diff of that file as
 * `Binary files differ` and hide the change from review.
 */
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { hasNulByte, isScannedFile } from '../check-no-nul-bytes.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(__dirname, '..', 'check-no-nul-bytes.mjs');

let failures = 0;

function pass(desc) {
  console.log(`ok - ${desc}`);
}

function fail(desc, detail) {
  console.log(`not ok - ${desc}${detail ? ` (${detail})` : ''}`);
  failures += 1;
}

function assertEqual(desc, actual, expected) {
  if (actual === expected) {
    pass(desc);
  } else {
    fail(
      desc,
      `expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`,
    );
  }
}

// ── isScannedFile ───────────────────────────────────────────────────────
assertEqual('scans a .ts file', isScannedFile('useScopeRoute.ts'), true);
assertEqual('scans a .tsx file', isScannedFile('Component.tsx'), true);
assertEqual(
  'scans a .sql migration',
  isScannedFile('20260915120000_x.sql'),
  true,
);
assertEqual('does not scan a .png', isScannedFile('logo.png'), false);
assertEqual('does not scan a .svg', isScannedFile('icon.svg'), false);
assertEqual(
  'does not scan an extensionless file',
  isScannedFile('Dockerfile'),
  false,
);

// ── hasNulByte ──────────────────────────────────────────────────────────
assertEqual(
  'a clean buffer has no NUL byte',
  hasNulByte(Buffer.from("join(',')", 'utf8')),
  false,
);
assertEqual(
  'the escape sequence text is not a NUL byte',
  hasNulByte(Buffer.from("join('\\x00')", 'utf8')),
  false,
);
assertEqual(
  'a literal NUL byte is caught, wherever it sits in the buffer',
  hasNulByte(Buffer.from([0x61, 0x00, 0x62])),
  true,
);

// ── End to end: the CLI over a scratch directory ───────────────────────
const scratch = mkdtempSync(path.join(tmpdir(), 'check-no-nul-bytes-'));
try {
  const cleanDir = path.join(scratch, 'clean');
  const dirtyDir = path.join(scratch, 'dirty');
  for (const dir of [cleanDir, dirtyDir]) {
    execFileSync('mkdir', ['-p', dir]);
    execFileSync('git', ['init', '-q'], { cwd: dir });
  }

  writeFileSync(path.join(cleanDir, 'a.ts'), "export const sep = '\\x00';\n");
  writeFileSync(
    path.join(cleanDir, 'logo.png'),
    Buffer.from([0x89, 0x50, 0x00, 0x47]),
  );
  execFileSync('git', ['add', '-A'], { cwd: cleanDir });

  writeFileSync(
    path.join(dirtyDir, 'a.ts'),
    Buffer.from("export const sep = '\x00';\n", 'binary'),
  );
  execFileSync('git', ['add', '-A'], { cwd: dirtyDir });

  try {
    execFileSync('node', [scriptPath, '--dir', cleanDir], { stdio: 'pipe' });
    pass(
      'CLI exits 0 on a directory with no NUL bytes in a scanned file (a binary asset is ignored)',
    );
  } catch (err) {
    fail(
      'CLI exits 0 on a directory with no NUL bytes in a scanned file',
      `exited ${err.status}`,
    );
  }

  try {
    execFileSync('node', [scriptPath, '--dir', dirtyDir], { stdio: 'pipe' });
    fail(
      'CLI exits non-zero on a directory with a NUL byte in a scanned file',
      'exited 0',
    );
  } catch (err) {
    const stderr = err.stderr ? err.stderr.toString() : '';
    if (err.status !== 0 && stderr.includes('a.ts')) {
      pass(
        'CLI exits non-zero on a directory with a NUL byte in a scanned file, naming it',
      );
    } else {
      fail(
        'CLI exits non-zero on a directory with a NUL byte in a scanned file, naming it',
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
