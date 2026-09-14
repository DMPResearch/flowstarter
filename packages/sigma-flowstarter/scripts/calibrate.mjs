#!/usr/bin/env node
/**
 * Sweep (min_sim, margin) per head on the held-out split and write the band.
 *
 *   pnpm --filter @flowstarter/sigma-flowstarter calibrate
 *
 * The holdout is TEMPLATE-disjoint from training: the same seeds phrased in
 * ways the centroids never saw. A split by row would only measure how well
 * the mean of a set predicts members of that set, which is always excellent
 * and always meaningless.
 *
 * The chosen point is NOT the cheapest under the platform's asymmetric costs
 * (config/evaluation.json). It is the point that is cheapest in the WORST CASE
 * when both thresholds are nudged by the platform-noise allowance, because
 * int8 kernels differ between ARM and x86 by a few thousandths of a cosine on
 * the SAME text, and a band chosen for its cost at exactly one pair of
 * thresholds is a band chosen for one CPU.
 *
 * The search is also constrained by calibration.minCoverage: an abstention is
 * the cheapest line in any sensible cost table, so an unconstrained sweep buys
 * safety with abstention until the classifier is useless. How often we are
 * willing to ask a human is a product decision, so it binds the search rather
 * than competing inside it.
 *
 * Writes models/semantic-config.json, including the numbers the point scored,
 * so a reviewer can see what they are being asked to accept.
 */

import { writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  CentroidScorer,
  LocalSentenceEncoder,
  grid,
  loadCentroids,
  loadEncoderConfig,
  sweepBand,
} from '@flowstarter/sigma-core';
import { buildPhrases } from '../src/training/phrases.ts';
import { acceptableUseSweepCost, scopeSweepCost } from '../src/costs.ts';
import { ACCEPTABLE_USE_HEAD, SCOPE_HEAD } from '../src/taxonomy.ts';
import { loadEvaluationConfig } from '../src/config.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CENTROIDS_PATH = join(ROOT, 'models', 'centroids.json');

/** Cosines shift by ~0.006 and margins by ~0.004 between ARM and x86 int8. */
const PLATFORM_NOISE_ALLOWANCE = 0.006;

const encoderConfig = loadEncoderConfig();
const encoder = new LocalSentenceEncoder(encoderConfig);
const centroids = loadCentroids(CENTROIDS_PATH);
const evaluation = loadEvaluationConfig();

// A wide-open band, so `rank()` sees the raw geometry and the sweep does the
// deciding. Nothing downstream reads this config; it exists for one call.
const open = {
  encoder: centroids.encoder,
  decisions: Object.fromEntries(
    Object.entries(centroids.decisions).map(([name, spec]) => [
      name,
      { labels: spec.labels, min_sim: -1, margin: 0 },
    ]),
  ),
};
const scorer = new CentroidScorer(centroids, open);

const holdout = buildPhrases('holdout');
console.log(`holdout : ${holdout.length} phrases (template-disjoint from training)`);

const byDecision = new Map();
for (const phrase of holdout) {
  const bucket = byDecision.get(phrase.decision) ?? [];
  bucket.push(phrase);
  byDecision.set(phrase.decision, bucket);
}

const heads = {};
for (const [decision, phrases] of byDecision) {
  const samples = [];
  for (let start = 0; start < phrases.length; start += 64) {
    const batch = phrases.slice(start, start + 64);
    const vectors = await encoder.embed(batch.map((phrase) => phrase.text));
    batch.forEach((phrase, index) => {
      const ranked = scorer.rank(decision, vectors[index]);
      samples.push({
        expected: phrase.label,
        top: ranked[0].label,
        topSim: ranked[0].similarity,
        margin: ranked[0].similarity - ranked[1].similarity,
      });
    });
    process.stdout.write(`\r  ${decision}: ${Math.min(start + 64, phrases.length)}/${phrases.length}`);
  }
  process.stdout.write('\n');

  const costs = decision === ACCEPTABLE_USE_HEAD ? evaluation.acceptableUse : evaluation.scope;
  const cost = decision === ACCEPTABLE_USE_HEAD ? acceptableUseSweepCost : scopeSweepCost;
  const sims = samples.map((sample) => sample.topSim).sort((a, b) => a - b);
  const margins = samples.map((sample) => sample.margin).sort((a, b) => a - b);
  console.log(
    `  top-sim p05=${q(sims, 0.05).toFixed(3)} p50=${q(sims, 0.5).toFixed(3)} p95=${q(sims, 0.95).toFixed(3)} | ` +
      `margin p05=${q(margins, 0.05).toFixed(3)} p50=${q(margins, 0.5).toFixed(3)} p95=${q(margins, 0.95).toFixed(3)}`,
  );

  const { best, points, robustnessPenalty, rejectedForCoverage } = sweepBand(samples, {
    minSimGrid: grid(0.02, 0.75, 0.01),
    marginGrid: grid(0.0, 0.3, 0.005),
    cost,
    costs,
    noiseAllowance: PLATFORM_NOISE_ALLOWANCE,
    minCoverage:
      decision === ACCEPTABLE_USE_HEAD
        ? evaluation.calibration.minCoverage
        : evaluation.calibration.scopeMinCoverage,
  });

  const raw = samples.filter((sample) => sample.top === sample.expected).length / samples.length;
  console.log(
    `  ${decision}: argmax accuracy ${(raw * 100).toFixed(1)}% over ${samples.length} rows, ` +
      `${points.length} grid points (${rejectedForCoverage} rejected for coverage)`,
  );
  console.log(
    `  chosen : min_sim=${best.minSim} margin=${best.margin} ` +
      `coverage=${(best.coverage * 100).toFixed(1)}% ` +
      `accuracy_on_covered=${(best.accuracyOnCovered * 100).toFixed(1)}% ` +
      `cost=${best.weightedCost} robust_cost=${best.robustCost} (+${robustnessPenalty} under +-${PLATFORM_NOISE_ALLOWANCE} kernel noise)`,
  );

  heads[decision] = {
    labels: centroids.decisions[decision].labels,
    min_sim: best.minSim,
    margin: best.margin,
    held_out: {
      cases: samples.length,
      coverage: Number(best.coverage.toFixed(4)),
      accuracy_on_covered: Number(best.accuracyOnCovered.toFixed(4)),
      weighted_cost: best.weightedCost,
      robust_cost: best.robustCost,
      counts: best.counts,
    },
  };
}

const config = {
  _comment: [
    'Operating points for the two Flowstarter heads. A head is confident only',
    'when top cosine >= min_sim AND (top - second) >= margin; inside the band',
    'it abstains and the policy boundary takes the safe action.',
    '',
    'Cosines here are measured in the MEAN-CENTRED space (see `centered` in',
    'models/centroids.json), not raw e5 cosines: two unrelated business',
    'descriptions sit at ~0.8 raw, which leaves a band nothing to work with.',
    'Numbers from this file are only comparable to centroids built the same way.',
    '',
    'Written by scripts/calibrate.mjs on a template-disjoint holdout. Never',
    'hand-edit: rerun the sweep and commit what it printed. `held_out` records',
    'what the point actually scored so a reviewer can see what is being asked.',
    '',
    'int8 kernels differ between ARM (dev Macs) and x86 (CI, prod) by roughly',
    '0.006 on a cosine for the SAME text. The sweep therefore does not pick',
    'the cheapest point; it picks the point that is cheapest IN THE WORST CASE',
    'across that noise ball, which is `robust_cost` below. A band chosen for',
    'its cost at exactly one pair of thresholds is a band chosen for one CPU —',
    'Ereno shipped one of those once and spent a PR cycle finding it.',
  ],
  version: new Date().toISOString().slice(0, 10),
  encoder: centroids.encoder,
  encoder_revision: centroids.encoder_revision,
  centroids_version: centroids.version,
  calibrated_at: new Date().toISOString(),
  platform_noise_allowance: PLATFORM_NOISE_ALLOWANCE,
  decisions: {
    [ACCEPTABLE_USE_HEAD]: heads[ACCEPTABLE_USE_HEAD],
    [SCOPE_HEAD]: heads[SCOPE_HEAD],
  },
};

await writeFile(
  join(ROOT, 'models', 'semantic-config.json'),
  `${JSON.stringify(config, null, 2)}\n`,
);
console.log('wrote   : models/semantic-config.json');
console.log('next    : pnpm --filter @flowstarter/sigma-flowstarter test');

function q(sorted, fraction) {
  if (sorted.length === 0) return 0;
  const index = Math.min(sorted.length - 1, Math.floor(fraction * sorted.length));
  return sorted[index];
}
