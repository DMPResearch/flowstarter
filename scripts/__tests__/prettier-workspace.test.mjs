#!/usr/bin/env node
/**
 * Self-check for scripts/prettier-workspace.mjs, run directly with
 * `node scripts/__tests__/prettier-workspace.test.mjs`.
 *
 * Only exercises `partitionArgs`, the pure routing logic that decides
 * whether a path gets formatted with the repo root's Prettier or
 * apps/flowstarter-main's own pinned one -- the part a regression could
 * silently break. The two spawned-process branches in `main()` are left to
 * manual verification (see docs/dev-machine.md, "Prettier version pins"),
 * same as the rest of this repo's process-spawning scripts.
 */
import { partitionArgs, relativeToAppWorkspace, APP_WORKSPACE } from '../prettier-workspace.mjs';

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

assertEqual(
  'a bare app-workspace path routes to the app bucket',
  partitionArgs([APP_WORKSPACE]),
  { flags: [], appPaths: [APP_WORKSPACE], rootPaths: [] },
);

assertEqual(
  'a path under the app workspace routes to the app bucket',
  partitionArgs([`${APP_WORKSPACE}/src/lib/foo.ts`]),
  { flags: [], appPaths: [`${APP_WORKSPACE}/src/lib/foo.ts`], rootPaths: [] },
);

assertEqual(
  'a path outside the app workspace routes to the root bucket',
  partitionArgs(['docs/dev-machine.md']),
  { flags: [], appPaths: [], rootPaths: ['docs/dev-machine.md'] },
);

assertEqual(
  'flags are collected separately from paths, in argv order',
  partitionArgs(['--check', 'docs/', '--write', `${APP_WORKSPACE}/src/x.ts`]),
  {
    flags: ['--check', '--write'],
    appPaths: [`${APP_WORKSPACE}/src/x.ts`],
    rootPaths: ['docs/'],
  },
);

assertEqual(
  'a workspace that merely shares the app workspace as a prefix is not misrouted',
  partitionArgs([`${APP_WORKSPACE}-templates/src/x.ts`]),
  { flags: [], appPaths: [], rootPaths: [`${APP_WORKSPACE}-templates/src/x.ts`] },
);

assertEqual(
  'a leading ./ is normalized before matching',
  partitionArgs([`./${APP_WORKSPACE}/src/x.ts`]),
  { flags: [], appPaths: [`./${APP_WORKSPACE}/src/x.ts`], rootPaths: [] },
);

// -- relativeToAppWorkspace ------------------------------------------------
// This is what makes the app-binary invocation's `cwd` (apps/flowstarter-main)
// correctly honor that app's own .prettierignore -- see the header comment.
assertEqual(
  'strips the app workspace prefix so the path is relative to it',
  relativeToAppWorkspace(`${APP_WORKSPACE}/src/lib/foo.ts`),
  'src/lib/foo.ts',
);

assertEqual(
  'the bare workspace path becomes "."',
  relativeToAppWorkspace(APP_WORKSPACE),
  '.',
);

assertEqual(
  'a path outside the workspace is left untouched',
  relativeToAppWorkspace('docs/dev-machine.md'),
  'docs/dev-machine.md',
);

if (failures > 0) {
  console.log(`\n${failures} check(s) failed.`);
  process.exitCode = 1;
} else {
  console.log('\nAll checks passed.');
}
