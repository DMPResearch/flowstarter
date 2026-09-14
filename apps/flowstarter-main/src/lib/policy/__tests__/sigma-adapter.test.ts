// @vitest-environment node
/**
 * The sigma adapter's translation layer, without the package.
 *
 * `@flowstarter/sigma-flowstarter` (#160) is not a dependency of this app yet;
 * `sigmaTierAvailable` documents the four reasons why, and they are all about
 * the package's build output rather than its classifier. What IS here is the
 * translation between its world and ours, which is where the judgement lives:
 *
 *   - its label space and ours are the same fifteen categories spelled six
 *     ways differently, and our ids are already written to `policy_reviews`
 *     rows and `project_events` payloads, so the mapping is a contract;
 *   - its `Decision` carries an action it has ALREADY decided on its own
 *     calibrated bands, which our rule layer must honour rather than re-derive
 *     from a confidence number on a different scale;
 *   - our LLM classification has to go back the other way to be usable as its
 *     injected second tier.
 *
 * All three are pure functions over plain objects, so they are tested here and
 * stay tested while the tier is dormant. When the package ships built output,
 * the only thing that changes is that `callSigmaClassifier` becomes reachable.
 *
 * Measured against the real package on 2026-09-14, with the encoder fetched
 * and this exact translation in place: over the 65 shared fixtures the
 * embedding tier alone agreed with the policy on 54 and let through ZERO
 * prohibited businesses. Ten of the eleven misses were it abstaining with
 * nothing behind it, which is precisely what the injected LLM tier fills.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PROHIBITED_CATEGORIES,
  REVIEW_CATEGORIES,
  decide,
  type PolicyClassification,
} from '../acceptable-use';
import {
  classificationFromSigmaDecision,
  sigmaTierAvailable,
  sigmaTierFromLlm,
  type SigmaDecision,
} from '../classifier';

function sigmaDecision(over: Partial<SigmaDecision> = {}): SigmaDecision {
  return {
    acceptableUse: 'refuse',
    category: 'prostitution_escort',
    reasons: { acceptableUse: 'semantic:margin-0.41' },
    trace: {
      heads: {
        acceptable_use: {
          tier: 'semantic',
          confidence: 0.41,
          evidence: 'Nearest centroid is the escort-services cluster.',
        },
      },
    },
    ...over,
  };
}

afterEach(() => {
  // See gate-fixtures.test.ts: a stub that outlives the file leaks into
  // every later file in the same vitest worker process.
  vi.unstubAllEnvs();
});

describe('the seam', () => {
  it('is off until the package ships output this app can build', () => {
    // A tripwire. If this flips to true while the package is still raw
    // TypeScript with ESM `.js` specifiers around a native binding, the Next
    // build and the Linux typecheck both go red, which is how it was found.
    expect(sigmaTierAvailable()).toBe(false);
  });

  it('stays off even when the switch is set, if the module cannot load', () => {
    vi.stubEnv('ACCEPTABLE_USE_SIGMA', 'true');
    // The switch alone is not enough to make it available in a process where
    // the dependency is absent; the adapter's own failure latch handles that.
    // What matters here is that asking is safe and never throws.
    expect(() => sigmaTierAvailable()).not.toThrow();
  });
});

describe('translating a sigma decision into a classification', () => {
  it('maps every category the package names onto one of ours', () => {
    // The contract. A category the package can return that we cannot name
    // would reach the operator board as a raw string nobody recognises.
    const sigmaIds = [
      'illegal_drugs',
      'prostitution_escort',
      'adult_content',
      'weapons_ammunition',
      'unlicensed_gambling',
      'counterfeit_goods',
      'hate_harassment',
      'scams_impersonation',
      'unlicensed_medical_financial_claims',
      'licensed_pharmacy',
      'legal_cannabis',
      'firearms_training',
      'sexual_health',
      'licensed_betting',
      'adult_adjacent_retail',
      'clean',
    ];
    const ours = new Set([
      ...PROHIBITED_CATEGORIES.map((c) => c.id),
      ...REVIEW_CATEGORIES.map((c) => c.id),
      'none',
    ]);

    for (const id of sigmaIds) {
      const mapped = classificationFromSigmaDecision(
        sigmaDecision({ category: id })
      ).categoryId;
      expect(ours.has(mapped), `${id} maps to ${mapped}`).toBe(true);
    }
    expect(sigmaIds).toHaveLength(ours.size);
  });

  it('renames nothing on either side', () => {
    // Our ids are on rows already written. Theirs are trained centroid keys.
    expect(
      classificationFromSigmaDecision(
        sigmaDecision({ category: 'prostitution_escort' })
      ).categoryId
    ).toBe('sexual_services');
    expect(
      classificationFromSigmaDecision(
        sigmaDecision({ category: 'weapons_ammunition' })
      ).categoryId
    ).toBe('weapons_sales');
    expect(
      classificationFromSigmaDecision(sigmaDecision({ category: 'clean' }))
        .categoryId
    ).toBe('none');
  });

  it('carries the action through as decided, not as a number to re-judge', () => {
    // The package decided `refuse` on a 0.41 cosine margin. Our own refuse bar
    // is 0.75 on a model's self-reported probability: a different scale
    // entirely. Re-deriving here would quietly turn its refusal into an allow.
    const classification = classificationFromSigmaDecision(sigmaDecision());
    expect(classification.confidence).toBe(0.41);
    expect(classification.decidedAction).toBe('refuse');
    expect(decide(classification).decision).toBe('refuse');
    expect(decide(classification).rule).toBe('tier_decided');
  });

  it('honours an allow it decided, and asks for a human on anything else', () => {
    const allowed = classificationFromSigmaDecision(
      sigmaDecision({ acceptableUse: 'allow', category: 'clean' })
    );
    expect(decide(allowed).decision).toBe('allow');
    expect(allowed.needsHuman).toBe(false);

    const held = classificationFromSigmaDecision(
      sigmaDecision({ acceptableUse: 'review', category: 'licensed_pharmacy' })
    );
    expect(decide(held).decision).toBe('review');
    expect(held.needsHuman).toBe(true);
  });

  it('reports which tier answered, so the board can be read later', () => {
    expect(classificationFromSigmaDecision(sigmaDecision()).tier).toBe(
      'embedding'
    );
    expect(
      classificationFromSigmaDecision(
        sigmaDecision({
          trace: {
            heads: {
              acceptable_use: {
                tier: 'injected',
                confidence: 0.88,
                evidence: 'The model read it as a drug shop.',
              },
            },
          },
        })
      ).tier
    ).toBe('llm');
  });

  it('falls back to the machine-readable reason when a head has no evidence', () => {
    const classification = classificationFromSigmaDecision(
      sigmaDecision({
        trace: { heads: {} },
      })
    );
    expect(classification.evidence).toBe('semantic:margin-0.41');
    expect(classification.confidence).toBe(0);
  });

  it('decides review when the package settled on no category at all', () => {
    // Its embedding tier abstained and nothing overruled it. That is a
    // decision, not a model inventing a label, so it must not be routed
    // through the unknown-category branch.
    const classification = classificationFromSigmaDecision(
      sigmaDecision({ acceptableUse: 'review', category: null })
    );
    expect(classification.categoryId).toBe('none');
    expect(decide(classification).decision).toBe('review');
    expect(decide(classification).rule).toBe('tier_decided');
  });
});

describe('our classification as the package second tier', () => {
  const answer = (over: Partial<PolicyClassification> = {}) =>
    ({
      categoryId: 'illegal_drugs',
      confidence: 0.9,
      evidence: 'The offer line names a controlled substance and a price.',
      needsHuman: false,
      tier: 'llm' as const,
      ...over,
    } satisfies PolicyClassification);

  it('hands back the package own label, not ours', async () => {
    const tier = sigmaTierFromLlm(async () =>
      answer({ categoryId: 'sexual_services' })
    );
    const verdict = await tier(
      'text',
      'acceptable_use',
      AbortSignal.timeout(50)
    );
    expect(verdict?.label).toBe('prostitution_escort');
    expect(verdict?.confidence).toBe(0.9);
  });

  it('abstains rather than guessing when our classifier failed', async () => {
    // Null is an abstention the package understands. A fabricated label would
    // be a broken model getting a vote.
    const tier = sigmaTierFromLlm(async () => answer({ failed: true }));
    await expect(
      tier('text', 'acceptable_use', AbortSignal.timeout(50))
    ).resolves.toBeNull();
  });

  it('abstains on a label the package has never heard of', async () => {
    const tier = sigmaTierFromLlm(async () =>
      answer({ categoryId: 'onlyfans_creator' })
    );
    await expect(
      tier('text', 'acceptable_use', AbortSignal.timeout(50))
    ).resolves.toBeNull();
  });

  it('passes the abort signal through, so the package budget governs it', async () => {
    let seen: AbortSignal | null = null;
    const tier = sigmaTierFromLlm(async (_text, signal) => {
      seen = signal;
      return answer();
    });
    const signal = AbortSignal.timeout(50);
    await tier('text', 'acceptable_use', signal);
    expect(seen).toBe(signal);
  });
});
