/**
 * The scorer, the provenance gate and the parity property, on data built in
 * the test. Pure functions; no encoder.
 */

import { describe, expect, it } from 'vitest';
import {
  expandDataset,
  parityViolations,
  releaseReady,
  scoreEvaluation,
  type CostModel,
  type EvalDataset,
  type ScoredItem,
} from '../src/index.js';

type Label = 'spam' | 'ham';
type Action = 'block' | 'pass' | 'hold';

const COSTS = { missed_spam: 100, blocked_ham: 25, held: 5, abstained: 1 };

const model: CostModel<Label, Action> = (item) => {
  const fired: string[] = [];
  if (item.abstained) fired.push('abstained');
  if (item.expectedAction === 'block' && item.actualAction === 'pass') fired.push('missed_spam');
  if (item.expectedAction === 'pass' && item.actualAction === 'block') fired.push('blocked_ham');
  if (item.actualAction === 'hold' && item.expectedAction !== 'hold') fired.push('held');
  return fired;
};

function row(over: Partial<ScoredItem<Label, Action>>): ScoredItem<Label, Action> {
  return {
    id: 'r',
    groupId: null,
    language: 'en',
    expectedLabel: 'ham',
    expectedAction: 'pass',
    actualLabel: 'ham',
    actualAction: 'pass',
    abstained: false,
    ...over,
  };
}

describe('expandDataset', () => {
  const dataset: EvalDataset = {
    provenance: {
      calibration_authors: ['a'],
      holdout_authors: ['b'],
      holdout_source: 'independent_synthetic',
      privacy_reviewed: true,
    },
    parity_groups: [
      { id: 'g1', action: 'block', prompts: { en: 'buy pills', de: 'Pillen kaufen' } },
    ],
    cases: [{ id: 'c1', prompt: 'hello mum', action: 'pass' }],
  };

  it('expands a group into one row per language', () => {
    const items = expandDataset(dataset);
    expect(items.map((item) => item.id)).toEqual(['g1:en', 'g1:de', 'c1']);
    expect(items[0]?.expectations).toEqual({ action: 'block' });
    expect(items[2]?.groupId).toBeNull();
  });

  it('refuses a group with only one language', () => {
    expect(() =>
      expandDataset({
        ...dataset,
        parity_groups: [{ id: 'g1', prompts: { en: 'only one' } }],
      }),
    ).toThrow(/fewer than two languages/);
  });

  it('refuses duplicate ids, because a silently-scored subset is meaningless', () => {
    expect(() =>
      expandDataset({ ...dataset, cases: [...dataset.cases, ...dataset.cases] }),
    ).toThrow(/duplicate eval row id/);
  });
});

describe('scoreEvaluation', () => {
  it('prices each named mistake once', () => {
    const report = scoreEvaluation(
      [
        row({ id: '1', expectedAction: 'block', actualAction: 'pass', expectedLabel: 'spam' }),
        row({ id: '2', expectedAction: 'pass', actualAction: 'block', actualLabel: 'spam' }),
        row({ id: '3' }),
      ],
      COSTS,
      model,
    );
    expect(report.weightedCost).toBe(125);
    expect(report.counters).toEqual({ missed_spam: 1, blocked_ham: 1 });
    expect(report.cases).toBe(3);
  });

  it('separates coverage from accuracy', () => {
    const report = scoreEvaluation(
      [
        row({ id: '1', abstained: true, actualLabel: null, actualAction: 'hold' }),
        row({ id: '2' }),
        row({ id: '3', actualLabel: 'spam' }),
      ],
      COSTS,
      model,
    );
    expect(report.coverage).toBeCloseTo(2 / 3);
    // Of the two covered rows, one had the right label.
    expect(report.accuracyOnCovered).toBeCloseTo(0.5);
  });

  it('excludes xfail rows from the cost but reports one that starts passing', () => {
    const report = scoreEvaluation(
      [
        row({ id: 'known-bad', expectedAction: 'block', actualAction: 'pass', xfail: 'issue 12' }),
        row({ id: 'fixed', xfail: 'issue 13' }),
      ],
      COSTS,
      model,
    );
    expect(report.weightedCost).toBe(0);
    expect(report.cases).toBe(0);
    expect(report.unexpectedPasses).toEqual(['fixed']);
  });

  it('refuses to price a counter the table does not name', () => {
    expect(() => scoreEvaluation([row({})], {}, () => ['mystery'])).toThrow(
      /no entry for "mystery"/,
    );
  });
});

describe('parityViolations', () => {
  const group = (language: string, over: Partial<ScoredItem<Label, Action>>) =>
    row({ id: `g:${language}`, groupId: 'g', language, ...over });

  it('allows one language to abstain where another decided', () => {
    const items = [
      group('en', { actualAction: 'block', actualLabel: 'spam' }),
      group('de', { abstained: true, actualLabel: null, actualAction: 'hold' }),
    ];
    expect(parityViolations(items)).toEqual([]);
    expect(parityViolations(items, { mode: 'strict' })).toHaveLength(1);
  });

  it('allows one language to fall back where another decided', () => {
    const items = [
      group('en', { actualAction: 'block', actualLabel: 'spam' }),
      // Decided a label but the guard downgraded it: not a disagreement.
      group('fr', { actualAction: 'hold', actualLabel: 'spam' }),
    ];
    expect(parityViolations(items, { fallbackAction: 'hold' })).toEqual([]);
  });

  it('catches two languages reaching opposite decisive verdicts', () => {
    const items = [
      group('en', { actualAction: 'block', actualLabel: 'spam' }),
      group('ro', { actualAction: 'pass', actualLabel: 'ham' }),
    ];
    const violations = parityViolations(items, { fallbackAction: 'hold' });
    expect(violations).toHaveLength(1);
    expect(violations[0]).toMatchObject({ groupId: 'g', language: 'ro' });
  });

  it('ignores groups marked xfail', () => {
    const items = [
      group('en', { actualAction: 'block', actualLabel: 'spam', xfail: 'known' }),
      group('ro', { actualAction: 'pass', actualLabel: 'ham', xfail: 'known' }),
    ];
    expect(parityViolations(items)).toEqual([]);
  });
});

describe('releaseReady', () => {
  const base = {
    calibration_authors: ['generator'],
    holdout_authors: ['reviewer'],
    holdout_source: 'independent_synthetic' as const,
    privacy_reviewed: false,
  };

  it('passes an independent synthetic holdout of the right size', () => {
    expect(releaseReady(base, { holdoutCases: 150 })).toEqual({ ok: true, reasons: [] });
  });

  it('fails when calibration and holdout share an author', () => {
    // The property the whole module exists for: otherwise a green score only
    // measures how well we encoded our own examples.
    const result = releaseReady({ ...base, holdout_authors: ['generator'] }, {
      holdoutCases: 150,
    });
    expect(result.ok).toBe(false);
    expect(result.reasons).toContain('calibration and holdout share an author');
  });

  it('fails on real traffic without a recorded privacy review', () => {
    const result = releaseReady(
      { ...base, holdout_source: 'redacted_real_traffic' },
      { holdoutCases: 150 },
    );
    expect(result.reasons).toContain('real traffic holdout without a recorded privacy review');
  });

  it('fails when the holdout is too small to mean anything', () => {
    expect(releaseReady(base, { holdoutCases: 12 }).ok).toBe(false);
  });
});
