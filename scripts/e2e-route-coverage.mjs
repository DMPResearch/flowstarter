#!/usr/bin/env node
/**
 * e2e-route-coverage.mjs: how much of the application the browser suite
 * actually reaches.
 *
 * `e2e/support/coverage-fixture.ts` writes one JSON per test into
 * `test-results/route-coverage/` naming every page it navigated to and every
 * API route it called. This merges those, compares them against every route
 * that exists under `apps/flowstarter-main/src/app`, and prints the two
 * fractions that matter: pages reached, and API routes called.
 *
 * Read the number for what it is. A route counts as covered when a test sent
 * a request to it, not when a test asserted anything about the response. It
 * answers "what does CI never touch at all". `scripts/mvp-readiness.mjs` is
 * where the stronger question gets asked.
 *
 *   node scripts/e2e-route-coverage.mjs
 *   node scripts/e2e-route-coverage.mjs --min 25        fail below 25%
 *   node scripts/e2e-route-coverage.mjs --input <dir>   default test-results/route-coverage
 *   node scripts/e2e-route-coverage.mjs --list-missing  name every uncovered route
 *
 * Writes `summary.json` and `summary.md` next to the inputs.
 */
import { readFileSync, readdirSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDirFrom, collectRoutes } from '../e2e/support/route-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};

// `--input`, then the same variable the fixture reads, then the default.
const INPUT_DIR = path.resolve(
  ROOT,
  flag('--input') ??
    process.env.ROUTE_COVERAGE_DIR ??
    'test-results/route-coverage',
);
const MIN = flag('--min') === undefined ? null : Number(flag('--min'));
const LIST_MISSING = args.includes('--list-missing');

const routes = collectRoutes(appDirFrom(ROOT));

const perTest = [];
if (existsSync(INPUT_DIR)) {
  for (const entry of readdirSync(INPUT_DIR)) {
    if (!entry.endsWith('.json') || entry === 'summary.json') continue;
    try {
      perTest.push(
        JSON.parse(readFileSync(path.join(INPUT_DIR, entry), 'utf8')),
      );
    } catch {
      // A half-written file from a killed run is not worth failing over.
    }
  }
}

const coveredPages = new Set();
const coveredApi = new Set();
const unmatched = new Set();

for (const record of perTest) {
  for (const pattern of record.pages ?? []) coveredPages.add(pattern);
  // Records are `"GET /api/..."`; the route is covered whichever method hit it.
  for (const entry of record.api ?? []) coveredApi.add(entry.split(' ').pop());
  for (const entry of record.unmatched ?? []) unmatched.add(entry);
}

const pagePatterns = routes.pages.map((route) => route.pattern);
const apiPatterns = routes.api.map((route) => route.pattern);

const missingPages = pagePatterns.filter((p) => !coveredPages.has(p));
const missingApi = apiPatterns.filter((p) => !coveredApi.has(p));

const pct = (covered, total) =>
  total === 0 ? 100 : Math.round((covered / total) * 1000) / 10;

const pagesPct = pct(
  pagePatterns.length - missingPages.length,
  pagePatterns.length,
);
const apiPct = pct(apiPatterns.length - missingApi.length, apiPatterns.length);
const totalCovered =
  pagePatterns.length -
  missingPages.length +
  (apiPatterns.length - missingApi.length);
const totalRoutes = pagePatterns.length + apiPatterns.length;
const overallPct = pct(totalCovered, totalRoutes);

const summary = {
  generated: new Date().toISOString(),
  tests: perTest.length,
  pages: {
    total: pagePatterns.length,
    covered: pagePatterns.length - missingPages.length,
    pct: pagesPct,
    missing: missingPages,
  },
  api: {
    total: apiPatterns.length,
    covered: apiPatterns.length - missingApi.length,
    pct: apiPct,
    missing: missingApi,
  },
  overall: { total: totalRoutes, covered: totalCovered, pct: overallPct },
  unmatched: [...unmatched].sort(),
};

const table = [
  '| Surface | Covered | Total | Percent |',
  '| --- | ---: | ---: | ---: |',
  `| Pages | ${summary.pages.covered} | ${summary.pages.total} | ${pagesPct}% |`,
  `| API routes | ${summary.api.covered} | ${summary.api.total} | ${apiPct}% |`,
  `| All routes | ${totalCovered} | ${totalRoutes} | ${overallPct}% |`,
].join('\n');

const markdown = [
  '## E2E route coverage',
  '',
  perTest.length === 0
    ? 'No per-test records were found, so nothing ran or the fixture did not write. The table below is the shape of the answer, not the answer.'
    : `Merged from ${perTest.length} test record${perTest.length === 1 ? '' : 's'}.`,
  '',
  table,
  '',
  'Covered means a test sent a request to the route, not that it asserted anything about the response.',
  '',
].join('\n');

if (existsSync(INPUT_DIR)) {
  writeFileSync(
    path.join(INPUT_DIR, 'summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
  writeFileSync(path.join(INPUT_DIR, 'summary.md'), markdown);
}

console.log('');
console.log(`E2E route coverage  (${perTest.length} test records)`);
console.log('');
console.log(table.replace(/\|/g, ' ').replace(/ --- | ---: /g, ''));
console.log('');

if (LIST_MISSING) {
  if (missingPages.length) {
    console.log('Pages never navigated to:');
    for (const p of missingPages) console.log(`  ${p}`);
    console.log('');
  }
  if (missingApi.length) {
    console.log('API routes never called:');
    for (const p of missingApi) console.log(`  ${p}`);
    console.log('');
  }
  if (summary.unmatched.length) {
    console.log(
      'Reached but matched no route in src/app (a rewrite, a redirect target, or a stale URL):',
    );
    for (const p of summary.unmatched) console.log(`  ${p}`);
    console.log('');
  }
}

if (MIN !== null && overallPct < MIN) {
  console.error(
    `E2E route coverage is ${overallPct}%, below the required ${MIN}%. Add a spec that walks the missing routes (\`--list-missing\` names them).`,
  );
  process.exit(1);
}
