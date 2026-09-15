/**
 * `aiModerateContent`, now that it is an adapter and not a guardrail.
 *
 * This suite used to assert the thirteen regular expressions that lived in
 * `../moderate.ts` -- that "Chat with OnlyFans models here" was caught, that
 * the match was case-insensitive, that the `services` field was searched too
 * -- and then the second LLM prompt's own risk bands on top of them. All of
 * it is gone, and none of it is what should be tested now: the product has one
 * acceptable-use guardrail, the classifier behind `screenAcceptableUse`, and
 * `packages/sigma-flowstarter/test/acceptable-use-eval.test.ts` plus
 * `src/lib/policy/__tests__` are where its detection is measured.
 *
 * What is left to test here is the adapter: that it asks the gate, that it
 * asks with a properly composed subject, and that it flattens the verdict onto
 * the old shape without losing the parts a caller needs to say the true thing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

const screenAcceptableUse = vi.fn();
vi.mock('@/lib/policy/gate', () => ({
  screenAcceptableUse: (input: unknown) => screenAcceptableUse(input),
}));

import { aiModerateContent } from '../moderate';

const CLEAN = { id: 'none', label: 'No category', disposition: 'clean' };
const DRUGS = {
  id: 'illegal_drugs',
  label: 'Illegal drugs and controlled substances',
  disposition: 'prohibited',
};
const PHARMACY = {
  id: 'licensed_pharmacy',
  label: 'Licensed pharmacy',
  disposition: 'sensitive',
};

function screening(overrides: {
  decision: 'allow' | 'review' | 'refuse';
  category?: typeof CLEAN;
  confidence?: number;
  rule?: string;
  notice?: unknown;
}) {
  return {
    verdict: {
      decision: overrides.decision,
      category: overrides.category ?? CLEAN,
      confidence: overrides.confidence ?? 0.9,
      rule: overrides.rule ?? 'tier_decided',
      tier: 'llm',
      needsHuman: overrides.decision !== 'allow',
    },
    classification: {},
    notice: overrides.notice ?? null,
    reviewId: null,
    blocked: overrides.decision !== 'allow',
  };
}

beforeEach(() => {
  screenAcceptableUse.mockReset();
});

describe('aiModerateContent', () => {
  it('asks the one gate rather than matching strings of its own', async () => {
    screenAcceptableUse.mockResolvedValue(screening({ decision: 'allow' }));

    await aiModerateContent({
      description: 'A bakery in Oradea',
      industry: 'Food',
      services: 'Bread, cakes',
      goals: 'Get more walk-ins',
    });

    expect(screenAcceptableUse).toHaveBeenCalledOnce();
    const call = screenAcceptableUse.mock.calls[0][0] as {
      text: string;
      briefText?: string;
      surface: string;
      actor: string;
    };
    expect(call.surface).toBe('preview');
    expect(call.actor).toBe('ai-moderate');
    // Composed by `intakeSubject`, labels and all, so the classifier's
    // content-hash cache is shared with the scope gate and the preview route
    // rather than being a third, differently-spelled subject.
    expect(call.text).toContain('What the business does: A bakery in Oradea');
    expect(call.text).toContain('Industry: Food');
    expect(call.text).toContain('Services: Bread, cakes');
    expect(call.text).toContain('Goal for the site: Get more walk-ins');
    // `briefText`, for the operator review email's quote, is the raw
    // description -- never `text`, the composed subject just asserted above.
    expect(call.briefText).toBe('A bakery in Oradea');
  });

  it('passes a clean verdict through as approved', async () => {
    screenAcceptableUse.mockResolvedValue(
      screening({ decision: 'allow', confidence: 0.04 })
    );

    const result = await aiModerateContent({ description: 'A bakery' });

    expect(result.isProhibited).toBe(false);
    expect(result.recommendation).toBe('APPROVED');
    expect(result.riskLevel).toBe('LOW');
    expect(result.categories).toEqual([]);
    expect(result.reasons).toEqual([]);
    expect(result.notice).toBeNull();
    expect(result.decision).toBe('allow');
  });

  it('flattens a refusal onto the shape the old callers read', async () => {
    const notice = { title: 'We cannot build this one', decision: 'refuse' };
    screenAcceptableUse.mockResolvedValue(
      screening({
        decision: 'refuse',
        category: DRUGS,
        confidence: 0.9,
        rule: 'tier_decided',
        notice,
      })
    );

    const result = await aiModerateContent({
      description: 'A shop selling recreational drugs, paid in crypto',
    });

    expect(result.isProhibited).toBe(true);
    expect(result.recommendation).toBe('REQUEST_REJECTED');
    expect(result.riskLevel).toBe('HIGH');
    expect(result.riskScore).toBe(90);
    expect(result.categories).toEqual(['illegal_drugs']);
    expect(result.categoryId).toBe('illegal_drugs');
    // The sentence a visitor reads comes back with the verdict, so a caller
    // that stops does not have to write one of its own. That invention is
    // what this module used to be.
    expect(result.notice).toBe(notice);
  });

  it('stops on a review too, as the moderator it replaced did', async () => {
    screenAcceptableUse.mockResolvedValue(
      screening({
        decision: 'review',
        category: PHARMACY,
        confidence: 0.107,
        rule: 'sensitive_lawful',
      })
    );

    const result = await aiModerateContent({ description: 'A pharmacy' });

    // `isProhibited` is one bit over a three-valued verdict, and "do not build
    // this yet" is what both blocking values mean. A caller that has to tell
    // a refusal from a review reads `decision`.
    expect(result.isProhibited).toBe(true);
    expect(result.recommendation).toBe('REVIEW_REQUIRED');
    expect(result.riskLevel).toBe('MEDIUM');
    expect(result.decision).toBe('review');
    expect(result.categoryId).toBe('licensed_pharmacy');
  });

  it('carries the visitor language through to the notice, not to the classifier', async () => {
    screenAcceptableUse.mockResolvedValue(screening({ decision: 'allow' }));

    await aiModerateContent({
      description: 'O brutărie din Oradea',
      locale: 'ro',
    });

    expect(
      (screenAcceptableUse.mock.calls[0][0] as { locale?: string }).locale
    ).toBe('ro');
  });
});
