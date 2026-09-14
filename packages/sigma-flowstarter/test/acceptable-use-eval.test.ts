/**
 * The acceptable-use release gate.
 *
 * Runs the real semantic tier over test/data/acceptable-use-eval.json and
 * asserts three things, in descending order of how much they matter:
 *
 *   1. Zero prohibited misses. Not tradeable, and deliberately checked apart
 *      from the total so no amount of being right elsewhere can buy one.
 *   2. Total weighted cost under the gate in config/evaluation.json.
 *   3. Coverage over the floor — a classifier that abstains on everything
 *      is safe, useless, and would otherwise pass (1) and (2) trivially.
 *
 * Plus the language-parity property, asserted directly rather than inferred
 * from per-row expectations: whatever English gets, the other five get.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import {
  formatReport,
  parityViolations,
  releaseReady,
  scoreEvaluation,
  type EvalDataset,
  type ScoredItem,
} from '@flowstarter/sigma-core';
import { acceptableUseCosts } from '../src/costs.js';
import { loadEvaluationConfig } from '../src/config.js';
import {
  describeFailures,
  latency,
  loadDataset,
  runDataset,
  scoreRows,
  type RunRow,
} from './harness.js';
import type { AcceptableUseAction, AcceptableUseCategory } from '../src/taxonomy.js';

let dataset: EvalDataset;
let rows: RunRow[];
let scored: ScoredItem<AcceptableUseCategory, AcceptableUseAction>[];

beforeAll(async () => {
  dataset = loadDataset('acceptable-use-eval.json');
  rows = await runDataset(dataset);
  scored = scoreRows<AcceptableUseCategory, AcceptableUseAction>(rows, 'acceptable_use');
}, 600_000);

describe('acceptable-use held-out evaluation', () => {
  it('comes from a genuinely held-out set', () => {
    const gate = releaseReady(dataset.provenance, { holdoutCases: scored.length });
    expect(gate.reasons).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(scored.length).toBeGreaterThanOrEqual(120);
  });

  it('never lets a prohibited business through', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.acceptableUse, acceptableUseCosts);
    const misses = report.failures.filter((failure) => failure.fired.includes('prohibited_miss'));
    expect(
      misses.map((failure) => failure.id),
      `prohibited misses:\n${describeFailures(misses)}`,
    ).toEqual([]);
  });

  it('scores under the weighted-cost gate', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.acceptableUse, acceptableUseCosts);
    // Printed on pass as well as failure: the number moving is the signal,
    // and a reviewer should see it in the PR without re-running anything.
    console.log(`acceptable_use ${formatReport(report)}`);
    console.log(`acceptable_use latency ${JSON.stringify(latency(rows))}`);
    expect(
      report.weightedCost,
      `over the gate:\n${describeFailures(report.failures)}`,
    ).toBeLessThanOrEqual(config.gates.acceptableUseMaxWeightedCost);
  });

  it('answers often enough to be worth having', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.acceptableUse, acceptableUseCosts);
    expect(report.coverage).toBeGreaterThanOrEqual(config.gates.minCoverage);
  });

  it('has no row marked xfail that has quietly started passing', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.acceptableUse, acceptableUseCosts);
    // Strict, like Ereno's: a fixed row that still carries a marker is a lie
    // the next person will trust. Fixing the classifier means deleting the
    // marker in the same commit.
    expect(report.unexpectedPasses).toEqual([]);
  });

  it('never contradicts itself across the six languages', () => {
    // The property that matters: language may change whether we are confident
    // enough to decide, never WHAT we decide. A brief refused in English and
    // allowed in Romanian is a defect; one refused in English and sent to a
    // human in Romanian is the abstention machinery working.
    const violations = parityViolations(scored, { fallbackAction: 'review' });
    expect(
      violations,
      `language parity broken:\n${violations
        .map((v) => `  ${v.groupId} ${v.language}: expected ${v.expected}, got ${v.got}`)
        .join('\n')}`,
    ).toEqual([]);
    const strict = parityViolations(scored, { mode: 'strict' });
    // Reported, not gated: a rising strict count with a flat contradiction
    // count means the band is drifting away from one language, which is worth
    // knowing before it becomes a contradiction.
    console.log(
      `acceptable_use strict_parity_disagreements=${strict.length} of ${scored.filter((item) => item.groupId).length} grouped rows`,
    );
  });

  it('covers every category in the taxonomy', () => {
    const covered = new Set(
      scored.map((item) => item.expectedLabel).filter((label): label is AcceptableUseCategory => label !== null),
    );
    // A taxonomy entry with no row is a category nobody has ever tested.
    expect(covered.has('clean')).toBe(true);
    expect(covered.size).toBeGreaterThanOrEqual(10);
  });

  it('runs with no network and no LLM tier', () => {
    for (const row of rows) {
      expect(row.decision.trace.heads.acceptable_use?.injectedAttempted).toBe(false);
    }
  });
});
