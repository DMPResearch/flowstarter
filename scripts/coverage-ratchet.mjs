#!/usr/bin/env node
/**
 * coverage-ratchet.mjs: the floor only ever goes up.
 *
 * Vitest already fails a run that drops below the thresholds written into
 * each package's config. Those thresholds are hand-edited, so they drift: a
 * suite that climbs from 61% to 74% leaves the floor at 61 and quietly hands
 * back thirteen points of room to the next change. This script closes that
 * gap. It reads the `coverage-summary.json` each package writes and compares
 * it against `coverage-floors.json`, which is committed.
 *
 *   node scripts/coverage-ratchet.mjs
 *       Checks. Exits 1 when any metric is below its floor, naming every one.
 *       A package whose summary is missing is reported and skipped, not
 *       failed: the quality gate runs the three suites in one job, and a
 *       suite that never ran has nothing to say about coverage.
 *
 *   node scripts/coverage-ratchet.mjs --update
 *       Raises every floor that the measurement beat, writes the file back,
 *       and prints what moved. It never lowers a floor, so running it after a
 *       regression is a no-op rather than a laundering step. Use it when you
 *       have genuinely added tests and want the new level locked in.
 *
 *   node scripts/coverage-ratchet.mjs --json
 *       Machine-readable result on stdout.
 *
 *   node scripts/coverage-ratchet.mjs --markdown
 *       A markdown table for `$GITHUB_STEP_SUMMARY`. Always exits 0, because
 *       a summary that fails the step is a summary nobody reads.
 *
 * The tolerance below exists because v8 coverage of the same tree is not
 * bit-identical across Node patch releases: an inlined branch can appear or
 * disappear and move a percentage by a hundredth. A floor that fails on that
 * is noise, not a signal.
 */
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FLOORS_FILE = path.join(ROOT, 'coverage-floors.json');
const METRICS = ['lines', 'statements', 'functions', 'branches'];

/** Hundredths of a percent. See the header for why this is not zero. */
const TOLERANCE = 0.05;

const args = process.argv.slice(2);
const UPDATE = args.includes('--update');
const AS_JSON = args.includes('--json');
const AS_MARKDOWN = args.includes('--markdown');

function readJson(file) {
  return JSON.parse(readFileSync(file, 'utf8'));
}

/** `81.818...` -> `81.82`, so a floor file never carries float noise. */
const round2 = (n) => Math.round(n * 100) / 100;

const floors = readJson(FLOORS_FILE);

const results = [];
let failed = false;
let raised = false;

for (const [pkg, entry] of Object.entries(floors.packages)) {
  const summaryPath = path.join(ROOT, entry.summary);

  if (!existsSync(summaryPath)) {
    results.push({ package: pkg, status: 'missing', summary: entry.summary });
    continue;
  }

  const total = readJson(summaryPath).total;
  const metrics = {};

  for (const metric of METRICS) {
    const measured = round2(total[metric].pct);
    const floor = entry.floors[metric];
    const delta = round2(measured - floor);

    if (measured < floor - TOLERANCE) {
      failed = true;
      metrics[metric] = { measured, floor, delta, status: 'below' };
      continue;
    }

    if (UPDATE && measured > floor) {
      entry.floors[metric] = measured;
      raised = true;
      metrics[metric] = { measured, floor, delta, status: 'raised' };
      continue;
    }

    metrics[metric] = {
      measured,
      floor,
      delta,
      status: measured > floor ? 'above' : 'at',
    };
  }

  results.push({ package: pkg, status: 'measured', metrics });
}

if (UPDATE && raised) {
  floors.updated = new Date().toISOString().slice(0, 10);
  writeFileSync(FLOORS_FILE, `${JSON.stringify(floors, null, 2)}\n`);
}

if (AS_JSON) {
  console.log(
    JSON.stringify({ ok: !failed, updated: UPDATE, results }, null, 2),
  );
  process.exit(failed ? 1 : 0);
}

if (AS_MARKDOWN) {
  const cell = (m) => {
    if (m.status === 'below')
      return `**${m.measured}%** below floor ${m.floor}%`;
    if (m.delta > 0) return `${m.measured}% (floor ${m.floor}%)`;
    return `${m.measured}% (at floor)`;
  };

  console.log('| package | lines | statements | functions | branches |');
  console.log('| --- | ---: | ---: | ---: | ---: |');
  for (const result of results) {
    if (result.status === 'missing') {
      console.log(`| ${result.package} | did not run | | | |`);
      continue;
    }
    console.log(
      `| ${result.package} | ${METRICS.map((m) => cell(result.metrics[m])).join(' | ')} |`,
    );
  }
  console.log('');
  console.log(
    failed
      ? 'A metric is below its committed floor. Add the tests back; the floor does not move down.'
      : 'Every metric is at or above its floor in `coverage-floors.json`.',
  );
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
const num = (s, n) => String(s).padStart(n);

console.log('');
console.log(`Coverage floors (${FLOORS_FILE.replace(`${ROOT}/`, '')})`);
console.log('');
console.log(
  `${pad('package', 22)} ${pad('metric', 11)} ${num('measured', 9)} ${num('floor', 7)} ${num('delta', 8)}`,
);
console.log('-'.repeat(62));

for (const result of results) {
  if (result.status === 'missing') {
    console.log(
      `${pad(result.package, 22)} no coverage-summary.json at ${result.summary}, skipped`,
    );
    continue;
  }
  for (const metric of METRICS) {
    const m = result.metrics[metric];
    const mark =
      m.status === 'below' ? ' FAIL' : m.status === 'raised' ? ' raised' : '';
    console.log(
      `${pad(result.package, 22)} ${pad(metric, 11)} ${num(`${m.measured}%`, 9)} ${num(`${m.floor}%`, 7)} ${num(`${m.delta >= 0 ? '+' : ''}${m.delta}`, 8)}${mark}`,
    );
  }
}

console.log('');

if (failed) {
  console.error(
    'Coverage dropped below a committed floor. Add the tests back, or explain in the pull request why the floor should move. It does not move by itself.',
  );
  process.exit(1);
}

if (UPDATE) {
  console.log(
    raised
      ? 'Floors raised. Commit coverage-floors.json with the tests that earned it.'
      : 'Nothing to raise: no metric beat its floor.',
  );
} else {
  console.log('Every metric is at or above its floor.');
}
