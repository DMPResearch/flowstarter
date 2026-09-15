/**
 * The rules half, on hand-built traces. No encoder, no model, no I/O: if the
 * boundary needs any of those to be testable it is not a boundary.
 */

import { afterEach, describe, expect, it } from 'vitest';
import { decide, semanticSettles, type DecisionMapping, type DecisionThresholds, type DecisionTrace, type HeadTrace, type SemanticResult } from '../src/index.js';

type Label = 'red' | 'green' | 'amber';
type Action = 'stop' | 'go' | 'wait';

const MAPPING: DecisionMapping<Label, Action> = {
  decision: 'light',
  action: (label) => (label === 'red' ? 'stop' : label === 'green' ? 'go' : 'wait'),
  fallback: 'wait',
};

const THRESHOLDS: DecisionThresholds<Action> = {
  guards: {
    go: { minSimilarity: 0.4, minMargin: 0.1, semanticOnly: true },
    stop: { minSimilarity: 0.3, minMargin: 0.05, minTierConfidence: 0.9 },
  },
  failClosedInProduction: true,
};

function trace(head: Partial<HeadTrace<Label>>): DecisionTrace {
  return {
    heads: {
      light: {
        decision: 'light',
        tier: 'semantic',
        label: 'green',
        confidence: 0.5,
        semantic: {
          label: 'green',
          runnerUp: 'amber',
          similarity: 0.6,
          margin: 0.3,
          abstained: false,
          reason: 'confident',
        },
        semanticAbstained: false,
        injectedAttempted: false,
        injectedAbstained: false,
        evidence: null,
        timings: { semanticMs: 1, injectedMs: 0 },
        ...head,
      } as HeadTrace,
    },
    totalMs: 1,
    embedMs: 1,
    embedCacheHit: false,
    errors: [],
    encoder: { model: 'test', revision: 'test' },
    centroidsVersion: 'test',
    configVersion: 'test',
  };
}

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('decide', () => {
  it('maps a confident label through the platform mapping', () => {
    expect(decide<Label, Action>(trace({}), THRESHOLDS, MAPPING)).toMatchObject({
      action: 'go',
      label: 'green',
      reason: 'confident',
    });
  });

  it('falls back when the head abstained', () => {
    const outcome = decide<Label, Action>(
      trace({
        tier: 'default',
        label: null,
        semanticAbstained: true,
        semantic: {
          label: 'green',
          runnerUp: 'amber',
          similarity: 0.2,
          margin: 0.01,
          abstained: true,
          reason: 'below_margin',
        },
      }),
      THRESHOLDS,
      MAPPING,
    );
    expect(outcome).toMatchObject({ action: 'wait', reason: 'abstained' });
    expect(outcome.detail).toContain('below_margin');
  });

  it('falls back when a guarded action is under its similarity floor', () => {
    const outcome = decide<Label, Action>(
      trace({
        semantic: {
          label: 'green',
          runnerUp: 'amber',
          similarity: 0.35,
          margin: 0.3,
          abstained: false,
          reason: 'confident',
        },
      }),
      THRESHOLDS,
      MAPPING,
    );
    expect(outcome).toMatchObject({ action: 'wait', reason: 'guard_not_met' });
    expect(outcome.detail).toContain('min_similarity');
  });

  it('falls back when a guarded action is under its margin floor', () => {
    const outcome = decide<Label, Action>(
      trace({
        semantic: {
          label: 'green',
          runnerUp: 'amber',
          similarity: 0.9,
          margin: 0.02,
          abstained: false,
          reason: 'confident',
        },
      }),
      THRESHOLDS,
      MAPPING,
    );
    expect(outcome.detail).toContain('min_margin');
  });

  it('refuses to let an injected tier produce a semanticOnly action', () => {
    const outcome = decide<Label, Action>(
      trace({ tier: 'injected', label: 'green', confidence: 0.99 }),
      THRESHOLDS,
      MAPPING,
    );
    expect(outcome).toMatchObject({ action: 'wait', reason: 'guard_not_met' });
    expect(outcome.detail).toContain('semantic_only');
  });

  it('holds an injected tier to its own confidence floor', () => {
    const low = decide<Label, Action>(
      trace({ tier: 'injected', label: 'red', confidence: 0.5 }),
      THRESHOLDS,
      MAPPING,
    );
    expect(low.action).toBe('wait');
    const high = decide<Label, Action>(
      trace({ tier: 'injected', label: 'red', confidence: 0.95 }),
      THRESHOLDS,
      MAPPING,
    );
    expect(high.action).toBe('stop');
  });

  it('falls back when the mapping does not know the label', () => {
    const outcome = decide<Label, Action>(
      trace({ label: 'red' }),
      THRESHOLDS,
      { ...MAPPING, action: () => null },
    );
    expect(outcome).toMatchObject({ action: 'wait', reason: 'unmapped_label' });
  });

  it('throws outside production when the trace is malformed', () => {
    process.env.NODE_ENV = 'test';
    expect(() =>
      decide<Label, Action>(trace({}), THRESHOLDS, { ...MAPPING, decision: 'missing' }),
    ).toThrow(/no head "missing"/);
  });

  it('fails closed in production when the trace is malformed', () => {
    // The whole point of the flag: a broken artifact must not take the
    // product down, and must not be allowed to produce an action either.
    process.env.NODE_ENV = 'production';
    const outcome = decide<Label, Action>(trace({}), THRESHOLDS, {
      ...MAPPING,
      decision: 'missing',
    });
    expect(outcome).toMatchObject({ action: 'wait', reason: 'error' });
  });

  it('still throws in production when fail-closed is off', () => {
    process.env.NODE_ENV = 'production';
    expect(() =>
      decide<Label, Action>(trace({}), { ...THRESHOLDS, failClosedInProduction: false }, {
        ...MAPPING,
        decision: 'missing',
      }),
    ).toThrow();
  });
});

describe('semanticSettles', () => {
  /**
   * The same guards `decide` applies, asked one step earlier so the cascade
   * can act on the answer. Clearing the band and clearing the guard for the
   * action your label maps to are two different things, and a head that does
   * the first and not the second has produced an answer nobody may act on.
   */
  function semantic(over: Partial<SemanticResult<Label>> = {}): SemanticResult<Label> {
    return {
      label: 'green',
      runnerUp: 'amber',
      similarity: 0.6,
      margin: 0.3,
      abstained: false,
      reason: 'confident',
      ...over,
    };
  }

  it('is false for an abstention, whatever the label says', () => {
    expect(semanticSettles(semantic({ abstained: true }), THRESHOLDS, MAPPING)).toBe(false);
    expect(semanticSettles(semantic({ label: null }), THRESHOLDS, MAPPING)).toBe(false);
  });

  it('is true for a confident label whose action has no guard', () => {
    // `wait` is the fallback and needs no guard: doing it wrongly costs a
    // human two minutes, which is the whole reason it is the fallback.
    expect(semanticSettles(semantic({ label: 'amber' }), THRESHOLDS, MAPPING)).toBe(true);
  });

  it('is false for a confident label that misses its action guard', () => {
    // The 2026-09-15 case, in miniature: the band said `green` and meant it,
    // and `go` needs more similarity than the band needs to answer at all.
    expect(semanticSettles(semantic({ similarity: 0.35 }), THRESHOLDS, MAPPING)).toBe(false);
    expect(semanticSettles(semantic({ margin: 0.05 }), THRESHOLDS, MAPPING)).toBe(false);
  });

  it('is false when the mapping does not know the label', () => {
    expect(semanticSettles(semantic(), THRESHOLDS, { ...MAPPING, action: () => null })).toBe(
      false,
    );
  });

  it('agrees with decide on the same verdict, every time', () => {
    // The property that matters: if these two ever disagree, the cascade
    // spends a tier it did not need to, or skips one it did.
    for (const similarity of [0.2, 0.35, 0.45, 0.9]) {
      for (const margin of [0.02, 0.09, 0.11, 0.4]) {
        const result = semantic({ similarity, margin });
        const outcome = decide<Label, Action>(
          trace({ label: 'green', semantic: result, confidence: margin }),
          THRESHOLDS,
          MAPPING,
        );
        expect(semanticSettles(result, THRESHOLDS, MAPPING)).toBe(
          outcome.reason === 'confident',
        );
      }
    }
  });
});
