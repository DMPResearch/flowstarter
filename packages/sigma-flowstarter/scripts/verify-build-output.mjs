#!/usr/bin/env node
/**
 * A Node ESM import smoke test of the BUILT output (dist/), not the source.
 * See sigma-core's scripts/verify-build-output.mjs for why this exists.
 *
 * This one additionally exercises the workspace dependency edge: dist/*.js
 * imports the bare specifier `@flowstarter/sigma-core`, which must resolve
 * through that package's own `exports` field to ITS dist, not its source —
 * so this also catches sigma-core shipping a build that only works from
 * inside its own package directory.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = dirname(fileURLToPath(import.meta.url));
const ENTRY = join(HERE, '..', 'dist', 'index.js');

const REQUIRED_EXPORTS = [
  'classifyAcceptableUse',
  'classifyScope',
  'warmSigma',
  'decide',
  'ACCEPTABLE_USE_CATEGORIES',
  'SCOPE_CATEGORIES',
  'LANGUAGES',
  'loadPolicy',
  'loadEvaluationConfig',
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
  `ok    dist/index.js resolves as plain Node ESM, including the @flowstarter/sigma-core ` +
    `edge (${REQUIRED_EXPORTS.length} exports checked)`,
);
