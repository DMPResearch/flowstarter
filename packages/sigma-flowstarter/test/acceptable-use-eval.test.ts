/**
 * The acceptable-use release gate — two lenses on the same held-out set.
 *
 * `requireInjectedConfirmation` (see `gate.ts`'s `refuse` guard) means the
 * embedding tier alone can no longer settle a refusal: a refuse candidate
 * either gets confirmed by an injected tier or falls back to `review`. One
 * held-out run cannot honestly measure both halves of that sentence, so this
 * file runs the same dataset twice:
 *
 *   - **confirmed by the injected tier** — `harness.ts`'s `confirmingTier`
 *     stands in for a real, working LLM tier (this eval commits to no
 *     network, so it cannot replay a captured transcript for 158 rows across
 *     six languages the way `gate.test.ts`'s six-scenario regression does).
 *     This is the production-representative number: in production an
 *     injected tier is always configured, so this is roughly what the
 *     platform actually costs.
 *   - **no LLM tier** — the degraded path, exactly as this file ran before
 *     `requireInjectedConfirmation` existed. Its own gate, because the
 *     confirming-tier run above papers over a wrong embedding candidate
 *     whenever the candidate still names a real category (the stub confirms
 *     the row's OWN ground truth, not the embedding tier's guess — see
 *     `confirmingTier`'s doc comment for why that distinction matters) and so
 *     cannot, on its own, catch a regression in the semantic tier's candidate
 *     quality. This run can.
 *
 * Each asserts, in descending order of how much it matters:
 *
 *   1. Zero prohibited misses. Not tradeable, and deliberately checked apart
 *      from the total so no amount of being right elsewhere can buy one.
 *   2. Total weighted cost under ITS OWN gate in config/evaluation.json.
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
  confirmingTier,
  describeFailures,
  latency,
  loadDataset,
  runDataset,
  scoreRows,
  type RunRow,
} from './harness.js';
import type {
  AcceptableUseAction,
  AcceptableUseCategory,
} from '../src/taxonomy.js';

let dataset: EvalDataset;

beforeAll(() => {
  dataset = loadDataset('acceptable-use-eval.json');
});

describe('acceptable-use held-out evaluation: confirmed by the injected tier (production-representative)', () => {
  let rows: RunRow[];
  let scored: ScoredItem<AcceptableUseCategory, AcceptableUseAction>[];

  beforeAll(async () => {
    rows = await runDataset(dataset, (item) => ({
      acceptable_use: confirmingTier(item),
    }));
    scored = scoreRows<AcceptableUseCategory, AcceptableUseAction>(
      rows,
      'acceptable_use',
    );
  }, 600_000);

  it('comes from a genuinely held-out set', () => {
    const gate = releaseReady(dataset.provenance, {
      holdoutCases: scored.length,
    });
    expect(gate.reasons).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(scored.length).toBeGreaterThanOrEqual(120);
  });

  it('never lets a prohibited business through', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    const misses = report.failures.filter((failure) =>
      failure.fired.includes('prohibited_miss'),
    );
    expect(
      misses.map((failure) => failure.id),
      `prohibited misses:\n${describeFailures(misses)}`,
    ).toEqual([]);
  });

  it('scores under the weighted-cost gate', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    // Printed on pass as well as failure: the number moving is the signal,
    // and a reviewer should see it in the PR without re-running anything.
    console.log(`acceptable_use (confirmed) ${formatReport(report)}`);
    console.log(
      `acceptable_use (confirmed) latency ${JSON.stringify(latency(rows))}`,
    );
    expect(
      report.weightedCost,
      `over the gate:\n${describeFailures(report.failures)}`,
    ).toBeLessThanOrEqual(config.gates.acceptableUseMaxWeightedCost);
  });

  it('answers often enough to be worth having', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    expect(report.coverage).toBeGreaterThanOrEqual(config.gates.minCoverage);
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
        .map(
          (v) =>
            `  ${v.groupId} ${v.language}: expected ${v.expected}, got ${v.got}`,
        )
        .join('\n')}`,
    ).toEqual([]);
  });

  it('covers every category in the taxonomy', () => {
    const covered = new Set(
      scored
        .map((item) => item.expectedLabel)
        .filter((label): label is AcceptableUseCategory => label !== null),
    );
    // A taxonomy entry with no row is a category nobody has ever tested.
    expect(covered.has('clean')).toBe(true);
    expect(covered.size).toBeGreaterThanOrEqual(10);
  });

  it('actually asks the injected tier to confirm a refuse candidate, rather than skipping it', () => {
    // The property `requireInjectedConfirmation` exists for: a semantic
    // verdict that maps to `refuse` must never settle without this tier
    // being consulted, whatever its similarity or margin. If this assertion
    // ever fails, the guard stopped escalating and this whole suite would
    // silently go back to measuring the embedding tier alone while believing
    // it was measuring the confirmed cascade.
    const refuseExpected = scored.filter(
      (item) => item.expectedAction === 'refuse',
    );
    expect(refuseExpected.length).toBeGreaterThan(0);
    const consulted = rows.filter(
      (row) =>
        (row.item.expectations as { action?: string }).action === 'refuse' &&
        row.decision.trace.heads.acceptable_use?.semantic.label !== null &&
        !row.decision.trace.heads.acceptable_use?.semanticAbstained &&
        row.decision.trace.heads.acceptable_use?.injectedAttempted === true,
    );
    // Not every refuse-expected row's semantic tier necessarily lands on a
    // refuse-mapped label (some abstain, which already escalates for its own
    // reason) -- what matters is that of the ones that DO land on one, none
    // skip the injected tier the way scenario 8 did on staging.
    const semanticRefuseCandidates = rows.filter((row) => {
      const head = row.decision.trace.heads.acceptable_use;
      return (
        head &&
        !head.semanticAbstained &&
        head.semantic.label !== null &&
        (row.item.expectations as { action?: string }).action === 'refuse'
      );
    });
    expect(consulted.length).toBe(semanticRefuseCandidates.length);
    expect(consulted.length).toBeGreaterThan(0);
  });
});

describe('acceptable-use held-out evaluation: no LLM tier (the fallback path)', () => {
  let rows: RunRow[];
  let scored: ScoredItem<AcceptableUseCategory, AcceptableUseAction>[];

  beforeAll(async () => {
    rows = await runDataset(dataset);
    scored = scoreRows<AcceptableUseCategory, AcceptableUseAction>(
      rows,
      'acceptable_use',
    );
  }, 600_000);

  it('comes from a genuinely held-out set', () => {
    const gate = releaseReady(dataset.provenance, {
      holdoutCases: scored.length,
    });
    expect(gate.reasons).toEqual([]);
    expect(gate.ok).toBe(true);
    expect(scored.length).toBeGreaterThanOrEqual(120);
  });

  it('never lets a prohibited business through', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    const misses = report.failures.filter((failure) =>
      failure.fired.includes('prohibited_miss'),
    );
    expect(
      misses.map((failure) => failure.id),
      `prohibited misses:\n${describeFailures(misses)}`,
    ).toEqual([]);
  });

  it('scores under its own weighted-cost gate', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    console.log(`acceptable_use (no LLM tier) ${formatReport(report)}`);
    console.log(
      `acceptable_use (no LLM tier) latency ${JSON.stringify(latency(rows))}`,
    );
    expect(
      report.weightedCost,
      `over the gate:\n${describeFailures(report.failures)}`,
    ).toBeLessThanOrEqual(config.gates.acceptableUseNoLlmMaxWeightedCost);
  });

  it('answers often enough to be worth having', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    expect(report.coverage).toBeGreaterThanOrEqual(config.gates.minCoverage);
  });

  it('has no row marked xfail that has quietly started passing', () => {
    const config = loadEvaluationConfig();
    const report = scoreEvaluation(
      scored,
      config.acceptableUse,
      acceptableUseCosts,
    );
    // Strict, like Ereno's: a fixed row that still carries a marker is a lie
    // the next person will trust. Fixing the classifier means deleting the
    // marker in the same commit. Checked here, and only here: an xfail
    // marker records a known EMBEDDING TIER limitation, which is exactly
    // what this fallback-path run measures. The confirmed-tier run above
    // fixes some of these by design (a real model reading a euphemism a
    // cosine could not) and that is not something this marker is for.
    expect(report.unexpectedPasses).toEqual([]);
  });

  it('never contradicts itself across the six languages', () => {
    const violations = parityViolations(scored, { fallbackAction: 'review' });
    expect(
      violations,
      `language parity broken:\n${violations
        .map(
          (v) =>
            `  ${v.groupId} ${v.language}: expected ${v.expected}, got ${v.got}`,
        )
        .join('\n')}`,
    ).toEqual([]);
    const strict = parityViolations(scored, { mode: 'strict' });
    // Reported, not gated: a rising strict count with a flat contradiction
    // count means the band is drifting away from one language, which is worth
    // knowing before it becomes a contradiction.
    console.log(
      `acceptable_use (no LLM tier) strict_parity_disagreements=${strict.length} of ${scored.filter((item) => item.groupId).length} grouped rows`,
    );
  });

  it('covers every category in the taxonomy', () => {
    const covered = new Set(
      scored
        .map((item) => item.expectedLabel)
        .filter((label): label is AcceptableUseCategory => label !== null),
    );
    expect(covered.has('clean')).toBe(true);
    expect(covered.size).toBeGreaterThanOrEqual(10);
  });

  it('runs with no network and no LLM tier', () => {
    for (const row of rows) {
      expect(row.decision.trace.heads.acceptable_use?.injectedAttempted).toBe(
        false,
      );
    }
  });
});
