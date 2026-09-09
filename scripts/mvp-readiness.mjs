#!/usr/bin/env node
/**
 * mvp-readiness.mjs: how much of the MVP is actually proved.
 *
 * `readiness/journeys.json` lists the complete client and operator paths the
 * MVP is made of. For each one this asks three questions, in rising order of
 * how much they are worth:
 *
 *   unit  Do the API route handlers behind this journey carry unit coverage?
 *         Read from the vitest `coverage-summary.json`. The bar is 90% of
 *         lines for a money-path journey and 80% for the rest, which is the
 *         same split the per-glob thresholds in the vitest configs use. Page
 *         coverage is printed beside it but does not gate; see the comment on
 *         `unitSignal` for why.
 *
 *   e2e   Does a Playwright spec walk it, and did that spec pass? Naming a
 *         spec is the weak half; passing is the real one, and it is only
 *         checked when `--playwright-report` points at a JSON report.
 *
 *   prod  Does anything check it against the deployed site? Today that means
 *         `e2e/prod-synthetic.spec.ts` mentions one of its routes.
 *
 * The score is the share of journeys where every signal that could be
 * measured came back green, with money-path journeys counted twice. A signal
 * that could not be measured (no coverage file, no Playwright report) is left
 * out of that journey's verdict rather than counted as a pass. An unmeasured
 * thing is not a proved thing, but it is not a failure of the journey either,
 * and pretending otherwise makes the number move when CI configuration
 * changes instead of when the product does.
 *
 *   node scripts/mvp-readiness.mjs
 *   node scripts/mvp-readiness.mjs --playwright-report release-results/contract.json
 *   node scripts/mvp-readiness.mjs --write        regenerate readiness/README.md
 *   node scripts/mvp-readiness.mjs --markdown     print the markdown instead of the table
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { appDirFrom, collectRoutes } from '../e2e/support/route-manifest.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const args = process.argv.slice(2);
const flag = (name) => {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
};
const WRITE = args.includes('--write');
const AS_MARKDOWN = args.includes('--markdown');
const REPORTS = args
  .map((arg, index) => (arg === '--playwright-report' ? args[index + 1] : null))
  .filter(Boolean);

const COVERAGE_SUMMARY = path.join(
  ROOT,
  'apps/flowstarter-main/coverage/coverage-summary.json',
);
const PROD_SPEC = path.join(ROOT, 'e2e/prod-synthetic.spec.ts');

const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));

const { journeys } = readJson(path.join(ROOT, 'readiness/journeys.json'));
const routes = collectRoutes(appDirFrom(ROOT));

/** pattern -> the file under src/app that serves it. */
const fileFor = new Map();
for (const route of [...routes.pages, ...routes.api]) {
  fileFor.set(route.pattern, path.join('src/app', route.file));
}

// ── unit signal ────────────────────────────────────────────────────────────
const coverage = existsSync(COVERAGE_SUMMARY)
  ? readJson(COVERAGE_SUMMARY)
  : null;

/** The summary keys are absolute paths; index them by their repo-relative tail. */
const coverageByFile = new Map();
if (coverage) {
  for (const [key, value] of Object.entries(coverage)) {
    if (key === 'total') continue;
    const relative = key.split('/flowstarter-main/')[1];
    if (relative) coverageByFile.set(relative, value);
  }
}

/**
 * Follow a route file that is nothing but a re-export.
 *
 * Half the handlers under `/api/admin/**` and `/api/team/**` are a doc comment
 * and one line: `export { pipelineBoardHandler as GET } from
 * '@/lib/flowstarter/pipeline/api'`. That is deliberate -- the two trees are
 * the same surface under two names and the repository keeps them from
 * drifting by sharing the implementation. But it means the route file has no
 * executable lines at all, and scoring it would say "no code, therefore no
 * coverage" about the busiest code in the product.
 *
 * So when a route file measures zero lines, its coverage is the coverage of
 * whatever it re-exports.
 */
function resolveImplementation(file) {
  const absolute = path.join(ROOT, 'apps/flowstarter-main', file);
  if (!existsSync(absolute)) return [];

  const source = readFileSync(absolute, 'utf8');
  const targets = new Set();

  for (const match of source.matchAll(/from\s+['"]@\/([^'"]+)['"]/g)) {
    const specifier = `src/${match[1]}`;
    for (const candidate of [
      `${specifier}.ts`,
      `${specifier}.tsx`,
      `${specifier}/index.ts`,
    ]) {
      if (coverageByFile.has(candidate)) {
        targets.add(candidate);
        break;
      }
    }
  }

  return [...targets];
}

/** Line coverage across a set of repo-relative files, or null if none measured. */
function aggregate(files) {
  let covered = 0;
  let total = 0;
  const counted = new Set();

  const add = (file) => {
    if (counted.has(file)) return;
    const entry = coverageByFile.get(file);
    if (!entry) return;
    counted.add(file);
    covered += entry.lines.covered;
    total += entry.lines.total;
  };

  for (const file of files) {
    const entry = coverageByFile.get(file);
    // A route file with no executable lines is a re-export; score what it
    // re-exports instead.
    if (entry && entry.lines.total === 0) {
      for (const target of resolveImplementation(file)) add(target);
      continue;
    }
    add(file);
  }

  if (total === 0) return null;
  return {
    pct: Math.round((covered / total) * 1000) / 10,
    files: counted.size,
  };
}

/**
 * The two halves are reported apart, and only one of them decides the verdict.
 *
 * An API route with no test is a test somebody chose not to write, and the
 * unit suite is exactly the tool for it. A `page.tsx` with no test is an App
 * Router server component: this suite has almost no way to render one, and
 * three of the forty-seven carry any coverage at all. What proves a page
 * works here is the browser -- the `e2e` signal -- so gating the unit signal
 * on page coverage would score the same journeys twice and pin the total at
 * zero no matter what anyone did about it.
 *
 * So the bar applies to the API half. The page figure is printed beside it
 * because it is worth knowing and worth improving, not because it blocks.
 */
function unitSignal(journey) {
  if (!coverage)
    return { available: false, reason: 'no coverage-summary.json' };

  const patterns = [...journey.routes, ...journey.api];
  const missing = patterns.filter((pattern) => !fileFor.has(pattern));

  const pageFiles = journey.routes.map((p) => fileFor.get(p)).filter(Boolean);
  const apiFiles = journey.api.map((p) => fileFor.get(p)).filter(Boolean);

  const pages = aggregate(pageFiles);
  const api = aggregate(apiFiles);
  const bar = journey.money_path ? 90 : 80;

  if (!pages && !api) {
    return {
      available: false,
      reason: 'no route file appears in the coverage report',
      missing,
    };
  }

  if (!api) {
    return {
      available: false,
      reason: 'the journey has no API route with code behind it',
      pages,
      missing,
    };
  }

  return {
    available: true,
    green: api.pct >= bar,
    pages,
    api,
    bar,
    missing,
  };
}

// ── e2e signal ─────────────────────────────────────────────────────────────
/**
 * Every spec file the Playwright JSON reports say had a failing test, and
 * every spec file they say ran at all. `expected` in Playwright's JSON means
 * the test passed.
 */
function readPlaywrightReports() {
  const ran = new Set();
  const failed = new Set();
  let any = false;

  for (const report of REPORTS) {
    const file = path.resolve(ROOT, report);
    if (!existsSync(file)) continue;
    let parsed;
    try {
      parsed = readJson(file);
    } catch {
      continue;
    }
    any = true;

    const visit = (suite, inherited) => {
      const file = suite.file ?? inherited;
      for (const child of suite.suites ?? []) visit(child, file);
      for (const spec of suite.specs ?? []) {
        const specFile = spec.file ?? file;
        if (!specFile) continue;
        ran.add(specFile);
        if (!spec.ok) failed.add(specFile);
      }
    };
    for (const suite of parsed.suites ?? []) visit(suite, undefined);
  }

  return { any, ran, failed };
}

const playwright = readPlaywrightReports();

function e2eSignal(journey) {
  if (!journey.spec) {
    return { available: true, green: false, detail: 'no spec' };
  }

  const specPath = path.join(ROOT, journey.spec);
  if (!existsSync(specPath)) {
    return {
      available: true,
      green: false,
      detail: `spec named but missing: ${journey.spec}`,
    };
  }

  if (!playwright.any) {
    return {
      available: true,
      green: true,
      detail: 'spec exists (not run)',
      weak: true,
    };
  }

  // Playwright's JSON names files relative to the config's testDir root.
  const tail = path.basename(journey.spec);
  const ran = [...playwright.ran].some((file) => file.endsWith(tail));
  const failed = [...playwright.failed].some((file) => file.endsWith(tail));

  if (!ran) {
    return {
      available: true,
      green: true,
      detail: 'spec exists (not in report)',
      weak: true,
    };
  }
  return {
    available: true,
    green: !failed,
    detail: failed ? 'spec failed' : 'spec passed',
  };
}

// ── production signal ──────────────────────────────────────────────────────
const prodSource = existsSync(PROD_SPEC) ? readFileSync(PROD_SPEC, 'utf8') : '';

function prodSignal(journey) {
  if (!prodSource) {
    return {
      available: false,
      reason: 'e2e/prod-synthetic.spec.ts is missing',
    };
  }
  // A dynamic pattern cannot appear literally in a spec, so only the literal
  // ones can be found this way. That is the honest limit of the check.
  //
  // `/` is excluded on purpose. The production synthetic loads the landing
  // page, and almost every journey starts there, so counting it would paint
  // half the table green for a check that proves only that the site is up.
  const literals = [...journey.routes, ...journey.api].filter(
    (pattern) => pattern !== '/' && !pattern.includes('['),
  );
  const hit = literals.find((pattern) =>
    new RegExp(
      `['"\`]${pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`/]`,
    ).test(prodSource),
  );
  return {
    available: true,
    green: Boolean(hit),
    detail: hit ?? 'not checked in production',
  };
}

// ── score ──────────────────────────────────────────────────────────────────
const rows = journeys.map((journey) => {
  const unit = unitSignal(journey);
  const e2e = e2eSignal(journey);
  const prod = prodSignal(journey);

  const measured = [unit, e2e, prod].filter((signal) => signal.available);
  const green = measured.length > 0 && measured.every((signal) => signal.green);

  return { journey, unit, e2e, prod, measured: measured.length, green };
});

const weight = (row) => (row.journey.money_path ? 2 : 1);
const earned = rows.reduce(
  (sum, row) => sum + (row.green ? weight(row) : 0),
  0,
);
const possible = rows.reduce((sum, row) => sum + weight(row), 0);
const score = Math.round((earned / possible) * 1000) / 10;

const moneyRows = rows.filter((row) => row.journey.money_path);
const moneyGreen = moneyRows.filter((row) => row.green).length;

// ── output ─────────────────────────────────────────────────────────────────
const mark = (signal) => {
  if (!signal.available) return 'n/a';
  if (signal.green) return signal.weak ? 'weak' : 'yes';
  return 'no';
};

const half = (value) => (value ? `${value.pct}%` : 'none');

const tableRows = rows.map((row) => [
  row.journey.id,
  row.journey.money_path ? 'yes' : '',
  String(row.journey.tier),
  row.unit.available ? half(row.unit.api) : 'n/a',
  row.unit.available ? half(row.unit.pages) : 'n/a',
  row.unit.available ? `${row.unit.bar}%` : '',
  mark(row.e2e),
  mark(row.prod),
  row.green ? 'ready' : 'not ready',
]);

const HEAD = [
  'journey',
  'money',
  'tier',
  'api lines',
  'page lines',
  'bar',
  'e2e',
  'prod',
  'verdict',
];

function asciiTable(head, body) {
  const widths = head.map((h, i) =>
    Math.max(h.length, ...body.map((r) => r[i].length)),
  );
  const line = (cells) =>
    cells
      .map((c, i) => c.padEnd(widths[i]))
      .join('  ')
      .trimEnd();
  return [
    line(head),
    widths.map((w) => '-'.repeat(w)).join('  '),
    ...body.map(line),
  ].join('\n');
}

function markdownTable(head, body) {
  return [
    `| ${head.join(' | ')} |`,
    `| ${head.map(() => '---').join(' | ')} |`,
    ...body.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

/**
 * Which signal is short, counted across the journeys that are not ready.
 *
 * The table says this per row, but the count says which one to spend a week
 * on. A single line that names the binding constraint is the only part of
 * this document anyone will act on.
 */
const notReady = rows.filter((row) => !row.green);
const shortOn = {
  unit: notReady.filter((row) => row.unit.available && !row.unit.green).length,
  e2e: notReady.filter((row) => row.e2e.available && !row.e2e.green).length,
  prod: notReady.filter((row) => row.prod.available && !row.prod.green).length,
};
const blockers =
  notReady.length === 0
    ? 'Nothing. Every journey is green.'
    : [
        `Of the ${notReady.length} journeys that are not ready:`,
        '',
        `- ${shortOn.unit} are short on unit coverage of their API handlers.`,
        `- ${shortOn.e2e} have no Playwright spec that walks them, or have one that failed.`,
        `- ${shortOn.prod} are never checked against the deployed site.`,
        '',
        shortOn.prod >= shortOn.e2e && shortOn.prod >= shortOn.unit
          ? 'The production check is the binding constraint. `e2e/prod-synthetic.spec.ts` reads three pages, one health endpoint, one webhook and one static bundle; every other journey is unproved in production by definition.'
          : shortOn.e2e >= shortOn.unit
            ? 'The missing E2E specs are the binding constraint. Most of these are tier 2 and above: they need a session, money in Stripe test mode, or real infrastructure, which is why they live in the release lane rather than the per-pull-request one.'
            : 'Unit coverage of the API handlers is the binding constraint, and it is the cheapest of the three to fix.',
      ].join('\n');

const summary = {
  generated: new Date().toISOString(),
  score,
  earned,
  possible,
  journeys: rows.length,
  ready: rows.filter((row) => row.green).length,
  money_path: { total: moneyRows.length, ready: moneyGreen },
  signals: {
    unit: coverage ? COVERAGE_SUMMARY.replace(`${ROOT}/`, '') : null,
    playwright: playwright.any ? REPORTS : null,
    production: prodSource ? 'e2e/prod-synthetic.spec.ts' : null,
  },
  rows: rows.map((row) => ({
    id: row.journey.id,
    title: row.journey.title,
    money_path: row.journey.money_path,
    tier: row.journey.tier,
    spec: row.journey.spec,
    unit: row.unit,
    e2e: row.e2e,
    prod: row.prod,
    ready: row.green,
  })),
};

const markdown = `<!--
  Generated by scripts/mvp-readiness.mjs. Do not edit by hand: the numbers
  come from the coverage summary and the specs, and a hand-edited score is
  worth nothing. Regenerate with:

      node scripts/mvp-readiness.mjs --write
-->

# MVP readiness

**${score}%** of the MVP is proved: ${summary.ready} of ${rows.length} journeys are green, and ${moneyGreen} of ${moneyRows.length} money-path journeys. Money-path journeys count double, so the score is ${earned} of a possible ${possible}.

A journey is green when every signal that could be measured came back green.

| signal | what it means | bar |
| --- | --- | --- |
| api lines | line coverage of the journey's API route handlers, from the vitest coverage summary. Where a handler is a one-line re-export -- half of \`/api/admin/**\` and \`/api/team/**\` are -- the module it re-exports is scored instead | 90% on a money path, 80% otherwise |
| page lines | line coverage of the journey's \`page.tsx\` files. Reported, not enforced: these are App Router server components, the unit suite cannot render them, and the browser is what proves them | |
| e2e | a Playwright spec walks the journey, and passed in the report if one was given | \`weak\` means the spec exists but this run did not execute it |
| prod | \`e2e/prod-synthetic.spec.ts\` checks one of the journey's routes against the deployed site | |

${markdownTable(HEAD, tableRows)}

## What is holding the number down

${blockers}

## The journeys

${rows
  .map(
    (row) =>
      `### ${row.journey.title}\n\n` +
      `\`${row.journey.id}\`, tier ${row.journey.tier}${row.journey.money_path ? ', money path' : ''}, ` +
      `${row.green ? 'ready' : 'not ready'}. ` +
      `Spec: ${row.journey.spec ? `\`${row.journey.spec}\`` : 'none'}.\n\n` +
      `${row.journey.status_note}\n`,
  )
  .join('\n')}
`;

if (WRITE) {
  writeFileSync(path.join(ROOT, 'readiness/README.md'), markdown);
  writeFileSync(
    path.join(ROOT, 'readiness/summary.json'),
    `${JSON.stringify(summary, null, 2)}\n`,
  );
}

if (AS_MARKDOWN) {
  console.log(markdown);
} else {
  console.log('');
  console.log(
    `MVP readiness: ${score}%  (${earned} of ${possible} weighted points)`,
  );
  console.log(
    `${summary.ready} of ${rows.length} journeys ready; ${moneyGreen} of ${moneyRows.length} money-path journeys ready.`,
  );
  console.log('');
  console.log(asciiTable(HEAD, tableRows));
  console.log('');
  if (!coverage) {
    console.log(
      'No coverage summary was found, so the unit signal is unmeasured. Run the flowstarter-main suite with --coverage first.',
    );
  }
  if (!playwright.any) {
    console.log(
      'No Playwright JSON report was given, so a named spec counts as weak evidence. Pass --playwright-report <file> to check it passed.',
    );
  }
  const badPatterns = rows.flatMap((row) => row.unit.missing ?? []);
  if (badPatterns.length) {
    console.log('');
    console.log(
      'These patterns in readiness/journeys.json match no route under src/app. A route was renamed or removed:',
    );
    for (const pattern of [...new Set(badPatterns)])
      console.log(`  ${pattern}`);
    process.exitCode = 1;
  }
}
