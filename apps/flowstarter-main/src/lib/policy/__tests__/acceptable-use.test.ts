// @vitest-environment node
/**
 * The rule layer, on its own.
 *
 * `decide()` is pure and takes a classification, so this suite needs no model,
 * no network and no database. It is the file that proves the policy is a rule
 * rather than a hope: every band, every fail-closed path, and the property
 * that no input shape produces `allow` by accident.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  ALL_CATEGORIES,
  CLEAN_CATEGORY,
  CLEAN_CATEGORY_ID,
  DEFAULT_THRESHOLDS,
  PROHIBITED_CATEGORIES,
  REVIEW_CATEGORIES,
  blocks,
  categoryById,
  decide,
  failsClosed,
  policyLimits,
  policyThresholds,
  reviewIsActionable,
  type PolicyClassification,
  type PolicyVerdict,
} from '../acceptable-use';

function classification(
  over: Partial<PolicyClassification> = {}
): PolicyClassification {
  return {
    categoryId: CLEAN_CATEGORY_ID,
    confidence: 0.95,
    evidence: 'A dental clinic in Cluj.',
    needsHuman: false,
    tier: 'llm',
    ...over,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('the category lists', () => {
  it('gives every category a stable id, a label and a reason', () => {
    for (const category of ALL_CATEGORIES) {
      expect(category.id).toMatch(/^[a-z][a-z_]*$/);
      expect(category.label.length).toBeGreaterThan(3);
      expect(category.reason.length).toBeGreaterThan(20);
    }
  });

  it('has no duplicate ids, because an id is written to the timeline', () => {
    const ids = ALL_CATEGORIES.map((category) => category.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('names the nine categories the policy refuses', () => {
    expect(PROHIBITED_CATEGORIES.map((c) => c.id)).toEqual([
      'illegal_drugs',
      'sexual_services',
      'adult_content',
      'weapons_sales',
      'unlicensed_gambling',
      'counterfeit_goods',
      'hate_or_harassment',
      'scams_impersonation',
      'unlicensed_claims',
    ]);
  });

  it('names the six lawful-but-sensitive categories', () => {
    expect(REVIEW_CATEGORIES.map((c) => c.id)).toEqual([
      'licensed_pharmacy',
      'legal_cannabis',
      'firearms_training',
      'sexual_health_clinic',
      'licensed_betting',
      'adult_adjacent_lawful',
    ]);
  });

  it('does not recognise an id it never published', () => {
    expect(categoryById('onlyfans_creator')).toBeNull();
    expect(categoryById(null)).toBeNull();
    expect(categoryById('')).toBeNull();
  });
});

describe('decide: prohibited categories', () => {
  it('refuses every prohibited category at high confidence', () => {
    for (const category of PROHIBITED_CATEGORIES) {
      const verdict = decide(
        classification({ categoryId: category.id, confidence: 0.95 })
      );
      expect(verdict.decision).toBe('refuse');
      expect(verdict.category.id).toBe(category.id);
      expect(verdict.rule).toBe('prohibited_confident');
      expect(blocks(verdict)).toBe(true);
    }
  });

  it('holds a prohibited guess for a person instead of refusing it', () => {
    // Between the review floor and the refuse bar. A machine is not confident
    // enough to tell a stranger no, and a person is the right answer.
    const verdict = decide(
      classification({ categoryId: 'illegal_drugs', confidence: 0.5 })
    );
    expect(verdict.decision).toBe('review');
    expect(verdict.rule).toBe('prohibited_uncertain');
  });

  it('ignores a prohibited guess it barely believes', () => {
    // Below the review floor the classifier has told us it is guessing. A
    // review queue full of dentists is a review queue nobody reads.
    const verdict = decide(
      classification({ categoryId: 'illegal_drugs', confidence: 0.1 })
    );
    expect(verdict.decision).toBe('allow');
    expect(verdict.rule).toBe('prohibited_below_floor');
    expect(verdict.category.id).toBe(CLEAN_CATEGORY_ID);
  });

  it('still holds a low-confidence guess when the classifier asked for help', () => {
    const verdict = decide(
      classification({
        categoryId: 'illegal_drugs',
        confidence: 0.1,
        needsHuman: true,
      })
    );
    expect(verdict.decision).toBe('review');
  });
});

describe('decide: lawful but sensitive', () => {
  it('sends every sensitive category to a person, never to a refusal', () => {
    for (const category of REVIEW_CATEGORIES) {
      const verdict = decide(
        classification({ categoryId: category.id, confidence: 0.99 })
      );
      // The point of the list: a licensed pharmacy at maximum confidence is
      // still a customer, and refusing it by machine is the expensive mistake.
      expect(verdict.decision).toBe('review');
      expect(verdict.rule).toBe('sensitive_lawful');
      expect(verdict.category.id).toBe(category.id);
    }
  });

  it('lets a sensitive guess below the floor through', () => {
    const verdict = decide(
      classification({ categoryId: 'licensed_betting', confidence: 0.05 })
    );
    expect(verdict.decision).toBe('allow');
    expect(verdict.rule).toBe('sensitive_below_floor');
  });
});

describe('decide: clean, and the abstention band', () => {
  it('allows a confident clean answer', () => {
    const verdict = decide(classification());
    expect(verdict.decision).toBe('allow');
    expect(verdict.rule).toBe('clean_confident');
    expect(blocks(verdict)).toBe(false);
  });

  it('treats an unconfident clean answer as an abstention, not an allow', () => {
    const verdict = decide(classification({ confidence: 0.2 }));
    expect(verdict.decision).toBe('review');
    expect(verdict.rule).toBe('clean_but_abstained');
  });

  it('honours needs_human even on a confident clean answer', () => {
    const verdict = decide(classification({ needsHuman: true }));
    expect(verdict.decision).toBe('review');
    expect(verdict.rule).toBe('needs_human_flag');
  });

  it('refuses to read an invented category as clean', () => {
    // A model that returned a label we never published has not read the
    // policy, and laundering that into `none` would be an allow we did not
    // mean to grant.
    const verdict = decide(
      classification({ categoryId: 'onlyfans_creator', confidence: 0.99 })
    );
    expect(verdict.decision).toBe('review');
    expect(verdict.rule).toBe('unknown_category');
  });
});

describe('decide: a broken classifier', () => {
  it('fails closed in production: review, never allow', () => {
    vi.stubEnv('NODE_ENV', 'production');
    const verdict = decide(
      classification({ tier: 'unavailable', failed: true, confidence: 0 })
    );
    expect(verdict.decision).toBe('review');
    expect(verdict.rule).toBe('classifier_unavailable');
    expect(verdict.needsHuman).toBe(true);
  });

  it('fails open outside production so a laptop without a key still works', () => {
    vi.stubEnv('NODE_ENV', 'development');
    const verdict = decide(
      classification({ tier: 'unavailable', failed: true })
    );
    expect(verdict.decision).toBe('allow');
    expect(verdict.rule).toBe('classifier_failed_open');
  });

  it('lets an env var rehearse the production rule on staging', () => {
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('ACCEPTABLE_USE_FAIL_CLOSED', 'true');
    expect(failsClosed()).toBe(true);
    expect(
      decide(classification({ tier: 'unavailable', failed: true })).decision
    ).toBe('review');
  });

  it('lets an env var open production, which is the only way to do it', () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('ACCEPTABLE_USE_FAIL_CLOSED', 'false');
    expect(failsClosed()).toBe(false);
  });
});

describe('confidence handling', () => {
  it('clamps a confidence outside 0..1 rather than trusting it', () => {
    expect(
      decide(classification({ categoryId: 'illegal_drugs', confidence: 42 }))
        .confidence
    ).toBe(1);
    expect(
      decide(classification({ categoryId: 'illegal_drugs', confidence: -3 }))
        .decision
    ).toBe('allow');
  });

  it('treats NaN as no confidence at all', () => {
    const verdict = decide(
      classification({ categoryId: 'illegal_drugs', confidence: Number.NaN })
    );
    expect(verdict.confidence).toBe(0);
    expect(verdict.decision).toBe('allow');
  });
});

describe('thresholds from config', () => {
  it('uses the documented defaults when nothing is set', () => {
    expect(policyThresholds()).toEqual(DEFAULT_THRESHOLDS);
  });

  it('reads an override', () => {
    vi.stubEnv('ACCEPTABLE_USE_REFUSE_CONFIDENCE', '0.4');
    expect(policyThresholds().refuseConfidence).toBe(0.4);
    expect(
      decide(classification({ categoryId: 'weapons_sales', confidence: 0.45 }))
        .decision
    ).toBe('refuse');
  });

  it('ignores a value that is not a probability, rather than disabling itself', () => {
    // A typo in an env var must not be a way to open the door.
    vi.stubEnv('ACCEPTABLE_USE_REFUSE_CONFIDENCE', 'yes please');
    expect(policyThresholds().refuseConfidence).toBe(
      DEFAULT_THRESHOLDS.refuseConfidence
    );
    vi.stubEnv('ACCEPTABLE_USE_REFUSE_CONFIDENCE', '95');
    expect(policyThresholds().refuseConfidence).toBe(
      DEFAULT_THRESHOLDS.refuseConfidence
    );
  });

  it('accepts explicit thresholds so a caller can reason about a band', () => {
    const verdict = decide(
      classification({ categoryId: 'adult_content', confidence: 0.4 }),
      { refuseConfidence: 0.3, reviewConfidence: 0.1, cleanConfidence: 0.5 }
    );
    expect(verdict.decision).toBe('refuse');
  });
});

describe('operational limits', () => {
  it('has defaults and reads overrides', () => {
    expect(policyLimits().maxCallsPerSubmission).toBeGreaterThan(0);
    vi.stubEnv('ACCEPTABLE_USE_MAX_CALLS_PER_SUBMISSION', '7');
    expect(policyLimits().maxCallsPerSubmission).toBe(7);
  });

  it('ignores a limit that is not a positive number', () => {
    vi.stubEnv('ACCEPTABLE_USE_MAX_INPUT_CHARS', '-1');
    expect(policyLimits().maxInputChars).toBeGreaterThan(0);
    vi.stubEnv('ACCEPTABLE_USE_SCAN_MAX_CHARS', 'lots');
    expect(policyLimits().scanMaxChars).toBeGreaterThan(0);
  });
});

describe('reviewIsActionable', () => {
  function verdict(over: Partial<PolicyVerdict> = {}): PolicyVerdict {
    return {
      decision: 'review',
      category: CLEAN_CATEGORY,
      confidence: 0,
      rule: 'needs_human_flag',
      tier: 'embedding',
      needsHuman: true,
      ...over,
    };
  }

  it('is always actionable for a refuse, whatever the rule', () => {
    expect(
      reviewIsActionable(
        verdict({ decision: 'refuse', rule: 'prohibited_confident' })
      )
    ).toBe(true);
  });

  it('is never actionable for an allow', () => {
    expect(
      reviewIsActionable(
        verdict({ decision: 'allow', rule: 'clean_confident' })
      )
    ).toBe(false);
  });

  it.each(['sensitive_lawful', 'prohibited_uncertain'] as const)(
    'is actionable for %s, which always names a category',
    (rule) => {
      expect(
        reviewIsActionable(
          verdict({ rule, category: categoryById('licensed_pharmacy')! })
        )
      ).toBe(true);
    }
  );

  it('is actionable for classifier_unavailable, even though it names no category', () => {
    expect(
      reviewIsActionable(verdict({ rule: 'classifier_unavailable' }))
    ).toBe(true);
  });

  it.each([
    'scope_visitor_disagrees_with_classifier',
    'scope_unresolved_after_question',
  ] as const)(
    'is actionable for %s, the scope gate own two rules, even though they name no category',
    (rule) => {
      expect(reviewIsActionable(verdict({ rule }))).toBe(true);
    }
  );

  it.each([
    'needs_human_flag',
    'clean_but_abstained',
    'unknown_category',
  ] as const)(
    'is NOT actionable for %s, a review that names nothing about the business',
    (rule) => {
      expect(reviewIsActionable(verdict({ rule }))).toBe(false);
    }
  );

  it('is not fooled by a categoryless verdict merely reusing an actionable rule name as a rule string', () => {
    // `sensitive_lawful` and `prohibited_uncertain` are only actionable
    // because `decide()` never produces them without a real category. This
    // guards the predicate itself, in case a future caller builds one by
    // hand (as the scope gate does for its own two rules) without one.
    expect(reviewIsActionable(verdict({ rule: 'sensitive_lawful' }))).toBe(
      false
    );
  });
});
