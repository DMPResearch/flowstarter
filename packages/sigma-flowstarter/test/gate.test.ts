/**
 * The interface the acceptable-use gate consumes, and the guarantees it can
 * rely on. Mostly pure: the encoder appears only where the point is that a
 * broken one does not break the caller.
 */

import { afterEach, describe, expect, it } from 'vitest';
import type { DecisionTrace, Encoder, HeadTrace } from '@flowstarter/sigma-core';
import {
  ACCEPTABLE_USE_CATEGORIES,
  ACCEPTABLE_USE_HEAD,
  PROHIBITED_CATEGORIES,
  SCOPE_CATEGORIES,
  SCOPE_HEAD,
  SENSITIVE_CATEGORIES,
  categoryClass,
} from '../src/taxonomy.js';
import { classifyAcceptableUse, classifyScope, decide, getScorer } from '../src/gate.js';
import { loadCentroids, loadPolicy, loadProvenance, loadSemanticConfig } from '../src/config.js';
import { acceptableUseCosts, scopeCosts } from '../src/costs.js';

function head(over: Partial<HeadTrace>): HeadTrace {
  return {
    decision: 'x',
    tier: 'semantic',
    label: null,
    confidence: 0,
    semantic: {
      label: null,
      runnerUp: null,
      similarity: 0,
      margin: 0,
      abstained: true,
      reason: 'below_min_sim',
    },
    semanticAbstained: true,
    injectedAttempted: false,
    injectedAbstained: false,
    evidence: null,
    timings: { semanticMs: 0, injectedMs: 0 },
    ...over,
  };
}

function traceWith(acceptableUse: Partial<HeadTrace>, scope: Partial<HeadTrace> = {}): DecisionTrace {
  return {
    heads: {
      [ACCEPTABLE_USE_HEAD]: head({ decision: ACCEPTABLE_USE_HEAD, ...acceptableUse }),
      [SCOPE_HEAD]: head({ decision: SCOPE_HEAD, ...scope }),
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

function confident(label: string, similarity: number, margin: number): Partial<HeadTrace> {
  return {
    tier: 'semantic',
    label,
    confidence: margin,
    semanticAbstained: false,
    semantic: { label, runnerUp: null, similarity, margin, abstained: false, reason: 'confident' },
  };
}

const originalEnv = process.env.NODE_ENV;
afterEach(() => {
  process.env.NODE_ENV = originalEnv;
});

describe('taxonomy', () => {
  it('is a closed set with no overlap between classes', () => {
    expect(new Set(ACCEPTABLE_USE_CATEGORIES).size).toBe(ACCEPTABLE_USE_CATEGORIES.length);
    for (const category of PROHIBITED_CATEGORIES) expect(categoryClass(category)).toBe('prohibited');
    for (const category of SENSITIVE_CATEGORIES) expect(categoryClass(category)).toBe('sensitive');
    expect(categoryClass('clean')).toBe('clean');
  });

  it('matches the committed centroids and band exactly', () => {
    // A renamed label with stale artifacts is how a calibrated band ends up
    // applied to the wrong geometry. Fail here, loudly, at load.
    const centroids = loadCentroids();
    const config = loadSemanticConfig();
    expect([...(centroids.decisions[ACCEPTABLE_USE_HEAD]?.labels ?? [])].sort()).toEqual(
      [...ACCEPTABLE_USE_CATEGORIES].sort(),
    );
    expect([...(centroids.decisions[SCOPE_HEAD]?.labels ?? [])].sort()).toEqual(
      [...SCOPE_CATEGORIES].sort(),
    );
    expect(config.decisions[ACCEPTABLE_USE_HEAD]?.labels.length).toBe(
      ACCEPTABLE_USE_CATEGORIES.length,
    );
    expect(() => getScorer()).not.toThrow();
  });

  it('ships provenance that ties the band to an encoder and a phrase count', () => {
    const provenance = loadProvenance();
    const centroids = loadCentroids();
    expect(provenance.encoder_revision).toBe(centroids.encoder_revision);
    expect(provenance.languages).toEqual(['en', 'ro', 'de', 'fr', 'es', 'it']);
    expect(provenance.splits.train.phrases).toBeGreaterThan(1000);
    expect(provenance.splits.holdout.phrases).toBeGreaterThan(200);
  });
});

describe('decide', () => {
  const policy = loadPolicy();
  const strong = policy.acceptableUse.refuseMinSimilarity + 0.1;
  const wide = policy.acceptableUse.refuseMinMargin + 0.1;

  it('refuses only a confident prohibited category', () => {
    expect(decide(traceWith(confident('illegal_drugs', strong, wide))).acceptableUse).toBe('refuse');
  });

  it('reviews a prohibited category that did not clear the guard', () => {
    const outcome = decide(
      traceWith(confident('illegal_drugs', strong, policy.acceptableUse.refuseMinMargin - 0.01)),
    );
    expect(outcome.acceptableUse).toBe('review');
    expect(outcome.reasons.acceptableUse).toContain('guard_not_met');
  });

  it('sends every sensitive category to a human, however confident', () => {
    for (const category of SENSITIVE_CATEGORIES) {
      expect(decide(traceWith(confident(category, 0.99, 0.99))).acceptableUse).toBe('review');
    }
  });

  it('allows only a confident clean', () => {
    expect(
      decide(
        traceWith(
          confident(
            'clean',
            policy.acceptableUse.allowMinSimilarity + 0.05,
            policy.acceptableUse.allowMinMargin + 0.05,
          ),
        ),
      ).acceptableUse,
    ).toBe('allow');
  });

  it('reviews an abstention', () => {
    expect(decide(traceWith({})).acceptableUse).toBe('review');
    expect(decide(traceWith({})).scope).toBe('unclear');
  });

  it('never lets an injected model hand out an allow on its own', () => {
    // The semantic tier abstaining is exactly the case where we want a human,
    // and a model saying "clean, 0.99" is not evidence of anything.
    const outcome = decide(
      traceWith({ tier: 'injected', label: 'clean', confidence: 0.99, semanticAbstained: true }),
    );
    expect(outcome.acceptableUse).toBe('review');
    expect(outcome.reasons.acceptableUse).toContain('semantic_only');
  });

  it('lets an injected model refuse, but only well above its own floor', () => {
    const low = decide(
      traceWith({
        tier: 'injected',
        label: 'scams_impersonation',
        confidence: policy.acceptableUse.refuseMinLlmConfidence - 0.1,
        semanticAbstained: true,
      }),
    );
    expect(low.acceptableUse).toBe('review');
    const high = decide(
      traceWith({
        tier: 'injected',
        label: 'scams_impersonation',
        confidence: 0.99,
        semanticAbstained: true,
      }),
    );
    expect(high.acceptableUse).toBe('refuse');
  });

  it('decides the two heads independently', () => {
    const outcome = decide(
      traceWith(
        confident('clean', policy.acceptableUse.allowMinSimilarity + 0.05, policy.acceptableUse.allowMinMargin + 0.05),
        confident('custom-work', policy.scope.customMinSimilarity + 0.1, policy.scope.customMinMargin + 0.1),
      ),
    );
    expect(outcome).toMatchObject({ acceptableUse: 'allow', scope: 'custom' });
  });

  it('fails closed in production when the trace is malformed', () => {
    process.env.NODE_ENV = 'production';
    const broken = { ...traceWith({}), heads: {} } as DecisionTrace;
    expect(decide(broken)).toMatchObject({ acceptableUse: 'review', scope: 'unclear' });
  });
});

describe('the entry points', () => {
  it('return the whole decision, with the trace attached', async () => {
    const decision = await classifyAcceptableUse('a dental clinic taking new patients');
    expect(decision.acceptableUse).toMatch(/allow|review|refuse/);
    expect(decision.scope).toMatch(/standard|custom|unclear/);
    expect(decision.trace.heads[ACCEPTABLE_USE_HEAD]).toBeDefined();
    expect(decision.trace.heads[SCOPE_HEAD]).toBeDefined();
    expect(decision.trace.embedMs).toBeGreaterThanOrEqual(0);
  });

  it('never call a tier the caller did not supply', async () => {
    const decision = await classifyScope('a portfolio for a freelance illustrator');
    expect(decision.trace.heads[ACCEPTABLE_USE_HEAD]?.injectedAttempted).toBe(false);
    expect(decision.trace.heads[SCOPE_HEAD]?.injectedAttempted).toBe(false);
  });

  it('degrade to review and unclear when the encoder is broken', async () => {
    // The property the gate depends on: there is no path through this module
    // that throws, and none that allows without a confident clean.
    const broken: Encoder = {
      embed: async () => {
        throw new Error('model cache is gone');
      },
    };
    const decision = await classifyAcceptableUse('anything at all', { encoder: broken });
    expect(decision).toMatchObject({ acceptableUse: 'review', scope: 'unclear' });
    expect(decision.trace.errors.length).toBeGreaterThan(0);
  });

  it('degrade to review when the budget cannot be met', async () => {
    const decision = await classifyAcceptableUse(
      'a coffee roaster with an unusually long and previously unseen brief about beans',
      { budgetMs: 1 },
    );
    if (decision.trace.errors.includes('encoder:encoder_timeout')) {
      expect(decision.acceptableUse).toBe('review');
    }
  });
});

describe('cost models', () => {
  const item = {
    id: 'x',
    groupId: null,
    language: 'en',
    abstained: false,
  } as const;

  it('price a prohibited miss above everything else', () => {
    expect(
      acceptableUseCosts({
        ...item,
        expectedLabel: 'illegal_drugs',
        expectedAction: 'refuse',
        actualLabel: 'clean',
        actualAction: 'allow',
      }),
    ).toContain('prohibited_miss');
  });

  it('treat allowing a SENSITIVE business as a miss too', () => {
    // A licensed pharmacy waved through unattended is the same failure as a
    // prohibited one waved through: nobody checked the licence.
    expect(
      acceptableUseCosts({
        ...item,
        expectedLabel: 'licensed_pharmacy',
        expectedAction: 'review',
        actualLabel: 'clean',
        actualAction: 'allow',
      }),
    ).toContain('prohibited_miss');
  });

  it('treat refusing a sensitive business as refusing a clean one', () => {
    expect(
      acceptableUseCosts({
        ...item,
        expectedLabel: 'licensed_betting',
        expectedAction: 'review',
        actualLabel: 'unlicensed_gambling',
        actualAction: 'refuse',
      }),
    ).toContain('refuse_clean_business');
  });

  it('charge nothing for a row that is exactly right', () => {
    expect(
      scopeCosts({
        ...item,
        expectedLabel: 'standard-site',
        expectedAction: 'standard',
        actualLabel: 'standard-site',
        actualAction: 'standard',
      }),
    ).toEqual([]);
  });

  it('price custom work slipping into the unattended funnel', () => {
    expect(
      scopeCosts({
        ...item,
        expectedLabel: 'custom-work',
        expectedAction: 'custom',
        actualLabel: 'standard-site',
        actualAction: 'standard',
      }),
    ).toContain('custom_missed_as_standard');
  });
});
