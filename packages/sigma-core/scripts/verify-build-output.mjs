#!/usr/bin/env node
/**
 * A Node ESM import smoke test of the BUILT output (dist/), not the source.
 *
 * This is the regression test for the packaging defect fixed 2026-09-14:
 * the package used to ship raw TypeScript as `main`/`exports`, with internal
 * relative imports written the Node-ESM way (`from './artifacts.js'`) that
 * pointed at a `.js` file which did not exist — only `artifacts.ts` did.
 * `tsc` type-checks that fine (moduleResolution "Bundler" does not demand the
 * file exist), `vitest` and `tsx` run the `.ts` source directly so they never
 * notice either, but a bundler that traces real files on disk (Next's
 * `next build`, via `@vercel/nft`) cannot follow a specifier to a file that
 * is not there. That is what actually broke: see PR #158.
 *
 * Run after `tsc -p tsconfig.lib.json` (wired into the `build` script), so a
 * change that reintroduces an unresolvable specifier fails the build, not a
 * downstream app three PRs later.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'dist', 'index.js');

const REQUIRED_EXPORTS = [
  'LocalSentenceEncoder',
  'CentroidScorer',
  'trainCentroids',
  'sweepBand',
  'grid',
  'loadEncoderConfig',
  'loadCentroids',
  'readJsonFile',
  'scoreEvaluation',
  'releaseReady',
];

let mod;
try {
  mod = await import(ENTRY);
} catch (error) {
  console.error(`FAIL  could not import the built entry point at ${ENTRY}`);
  console.error(error);
  process.exit(1);
}

const missing = REQUIRED_EXPORTS.filter((name) => typeof mod[name] === 'undefined');
if (missing.length > 0) {
  console.error(`FAIL  dist/index.js imported, but missing exports: ${missing.join(', ')}`);
  process.exit(1);
}

console.log(
  `ok    dist/index.js resolves as plain Node ESM (${REQUIRED_EXPORTS.length} exports checked)`,
);
