/**
 * The scope release gate.
 *
 * Mirror of the acceptable-use suite, with the asymmetry pointing the other
 * way: the mistake that is not tradeable here is letting custom work into the
 * unattended funnel, because that produces a build that cannot work and a
 * refund. Sending a brochure site to a discovery call is only annoying, so it
 * is priced rather than gated.
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
import { scopeCosts } from '../src/costs.js';
import { loadEvaluationConfig } from '../src/config.js';
import {
  describeFailures,
  latency,
  loadDataset,
  runDataset,
  scoreRows,
  type RunRow,
} from './harness.js';
import type { ScopeAction, ScopeCategory } from '../src/taxonomy.js';

let dataset: EvalDataset;
let rows: RunRow[];
let scored: ScoredItem<ScopeCategory, ScopeAction>[];

beforeAll(async () => {
  dataset = loadDataset('scope-eval.json');
  rows = await runDataset(dataset);
  scored = scoreRows<ScopeCategory, ScopeAction>(rows, 'scope');
}, 600_000);

describe('scope held-out evaluation', () => {
  it('comes from a genuinely held-out set', () => {
    const gate = releaseReady(dataset.provenance, {
      holdoutCases: scored.length,
      minimumCases: 100,
    });
    expect(gate.reasons).toEqual([]);
    expect(scored.length).toBeGreaterThanOrEqual(100);
  });

  it('never sends custom work into the unattended funnel', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.scope, scopeCosts);
    const misses = report.failures.filter((failure) =>
      failure.fired.includes('custom_missed_as_standard'),
    );
    expect(
      misses.map((failure) => failure.id),
      `custom work called standard:\n${describeFailures(misses)}`,
    ).toEqual([]);
  });

  it('scores under the weighted-cost gate', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.scope, scopeCosts);
    console.log(`scope ${formatReport(report)}`);
    console.log(`scope latency ${JSON.stringify(latency(rows))}`);
    expect(
      report.weightedCost,
      `over the gate:\n${describeFailures(report.failures)}`,
    ).toBeLessThanOrEqual(config.gates.scopeMaxWeightedCost);
  });

  it('answers often enough to be worth having', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.scope, scopeCosts);
    expect(report.coverage).toBeGreaterThanOrEqual(config.gates.scopeMinCoverage);
  });

  it('keeps a standard site standard when it mentions a booking or a form', () => {
    // The expensive failure mode in the other direction, called out by name
    // because it is the one a classifier that learned surfaces would fail.
    const formRows = scored.filter((item) =>
      [
        'standard_dentist_appointment_form',
        'standard_photographer_calendly',
        'standard_restaurant_large_party_form',
        'standard_yoga_timetable_form',
        'standard_accountant_quote_form',
        'clinic_intro_call_booking:en',
        'coach_one_pager_form:en',
      ].includes(item.id),
    );
    expect(formRows.length).toBeGreaterThan(0);
    const escalated = formRows.filter((item) => item.actualAction === 'custom');
    expect(escalated.map((item) => item.id)).toEqual([]);
  });

  it('has no row marked xfail that has quietly started passing', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(scored, config.scope, scopeCosts);
    expect(report.unexpectedPasses).toEqual([]);
  });

  it('never contradicts itself across the six languages', () => {
    const violations = parityViolations(scored, { fallbackAction: 'unclear' });
    expect(
      violations,
      `language parity broken:\n${violations
        .map((v) => `  ${v.groupId} ${v.language}: expected ${v.expected}, got ${v.got}`)
        .join('\n')}`,
    ).toEqual([]);
    const strict = parityViolations(scored, { mode: 'strict' });
    console.log(
      `scope strict_parity_disagreements=${strict.length} of ${scored.filter((item) => item.groupId).length} grouped rows`,
    );
  });
});
