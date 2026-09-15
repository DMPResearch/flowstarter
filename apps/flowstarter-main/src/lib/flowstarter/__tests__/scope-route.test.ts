/**
 * The routing table, whole.
 *
 * `decideRoute` is the one place that decides whether a visitor's brief costs a
 * generation run, and the one place that decides whether a stranger is handed a
 * prefilled link to Darius's calendar. So the test is a table rather than a
 * handful of examples: every scope, on both sides of its threshold, on both
 * passes, with every acceptable-use verdict, and with every answer the visitor
 * can give. A rule that is not in the table below is a rule that does not
 * exist.
 *
 * Every row asserts four things and not one: where the visitor goes, which rule
 * sent them, what scope the rule settled on, and whether an operator is asked
 * to read it. The version of this file that only checked the route is the
 * version that let `scope: "unclear"` reach a screen asserting the visitor had
 * described software.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideRoute,
  scopeOfferCopy,
  scopeRouteThresholds,
  spendsGenerationBudget,
  type AcceptableUse,
  type Scope,
  type ScopeAnswer,
  type ScopeRoute,
} from '../scope-route';

const ORIGINAL = { ...process.env };

afterEach(() => {
  process.env = { ...ORIGINAL };
});

interface Row {
  scope: Scope;
  confidence: number;
  alreadyClarified: boolean;
  visitorAnswer?: ScopeAnswer;
  acceptableUse?: AcceptableUse;
  route: ScopeRoute;
  rule: string;
  /** What the rule settled on, which is not always what the classifier said. */
  settled: Scope;
  /** True when a person is asked to read the brief anyway. */
  review?: boolean;
}

const { customAtOrAbove, standardAtOrAbove } = scopeRouteThresholds();

/** A hair under and a hair over, so "at or above" is tested at the boundary. */
const JUST_UNDER = (bar: number) => Number((bar - 0.01).toFixed(2));

const TABLE: Row[] = [
  // ── First pass, custom ──────────────────────────────────────────────────
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: false,
    route: 'discovery-call',
    rule: 'customAboveThreshold',
    settled: 'custom',
  },
  {
    scope: 'custom',
    confidence: customAtOrAbove,
    alreadyClarified: false,
    route: 'discovery-call',
    rule: 'customAboveThreshold',
    settled: 'custom',
  },
  {
    scope: 'custom',
    confidence: JUST_UNDER(customAtOrAbove),
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'customBelowThreshold',
    settled: 'unclear',
  },
  {
    scope: 'custom',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'customBelowThreshold',
    settled: 'unclear',
  },

  // ── First pass, standard ────────────────────────────────────────────────
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    route: 'self-serve',
    rule: 'standardAboveThreshold',
    settled: 'standard',
  },
  {
    scope: 'standard',
    confidence: standardAtOrAbove,
    alreadyClarified: false,
    route: 'self-serve',
    rule: 'standardAboveThreshold',
    settled: 'standard',
  },
  {
    scope: 'standard',
    confidence: JUST_UNDER(standardAtOrAbove),
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'standardBelowThreshold',
    settled: 'unclear',
  },
  {
    scope: 'standard',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'standardBelowThreshold',
    settled: 'unclear',
  },

  // ── First pass, unclear: always the question, at any confidence ─────────
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'unclear',
    settled: 'unclear',
  },
  {
    scope: 'unclear',
    confidence: 1,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'unclear',
    settled: 'unclear',
  },

  // ── The visitor's answer, which is the strongest evidence here ──────────
  // A classifier that could not answer at all is the state this whole feature
  // was found in: 100% of calls returning `unclear`. The answer has to settle
  // it, or nobody reaches a preview.
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    visitorAnswer: 'site',
    route: 'self-serve',
    rule: 'visitorSaysSite',
    settled: 'standard',
  },
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    visitorAnswer: 'software',
    route: 'discovery-call',
    rule: 'visitorSaysSoftware',
    settled: 'custom',
  },
  // The answer beats a classifier that leans the other way without being sure.
  {
    scope: 'custom',
    confidence: JUST_UNDER(customAtOrAbove),
    alreadyClarified: true,
    visitorAnswer: 'site',
    route: 'self-serve',
    rule: 'visitorSaysSite',
    settled: 'standard',
  },
  // ...and a confident classifier saying the opposite does not beat the
  // answer either. Neither wins: the visitor carries on and a person reads it.
  {
    scope: 'custom',
    confidence: customAtOrAbove,
    alreadyClarified: true,
    visitorAnswer: 'site',
    route: 'self-serve',
    rule: 'visitorSaysSiteClassifierSaysCustom',
    settled: 'unclear',
    review: true,
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'site',
    route: 'self-serve',
    rule: 'visitorSaysSiteClassifierSaysCustom',
    settled: 'unclear',
    review: true,
  },
  // "It is software" is never second-guessed, whatever the classifier thinks.
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'software',
    route: 'discovery-call',
    rule: 'visitorSaysSoftware',
    settled: 'custom',
  },

  // ── Second pass with a typed answer: act on the verdict you have ────────
  {
    scope: 'custom',
    confidence: 0,
    alreadyClarified: true,
    visitorAnswer: 'other',
    route: 'discovery-call',
    rule: 'clarifiedCustom',
    settled: 'custom',
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: true,
    route: 'discovery-call',
    rule: 'clarifiedCustom',
    settled: 'custom',
  },
  {
    scope: 'standard',
    confidence: 0,
    alreadyClarified: true,
    route: 'self-serve',
    rule: 'clarifiedStandard',
    settled: 'standard',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'other',
    route: 'self-serve',
    rule: 'clarifiedStandard',
    settled: 'standard',
  },
  // Still nothing after the question. The visitor continues and an operator
  // reads it; this used to route to a sales call, which sold to somebody who
  // had asked for a website.
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    route: 'self-serve',
    rule: 'clarifiedStillUnclear',
    settled: 'unclear',
    review: true,
  },
  {
    scope: 'unclear',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'other',
    route: 'self-serve',
    rule: 'clarifiedStillUnclear',
    settled: 'unclear',
    review: true,
  },

  // ── The acceptable-use gate wins over every one of the above ────────────
  // `review` steps aside to the preview route, which screens again and holds.
  // It does NOT go to the discovery call: on staging the embedding tier
  // abstained on nearly every brief, and that branch handed a prefilled
  // calendar link to an escort service and to a firearms seller.
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'review',
    route: 'self-serve',
    rule: 'acceptableUseNeedsAHuman',
    settled: 'standard',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'site',
    acceptableUse: 'review',
    route: 'self-serve',
    rule: 'acceptableUseNeedsAHuman',
    settled: 'standard',
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: true,
    visitorAnswer: 'software',
    acceptableUse: 'review',
    route: 'self-serve',
    rule: 'acceptableUseNeedsAHuman',
    settled: 'custom',
  },
  // `refuse` goes nowhere near it. See the rule's own comment: this module
  // steps aside and the preview route writes the refusal.
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'blocked',
    route: 'self-serve',
    rule: 'acceptableUseRefused',
    settled: 'standard',
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'blocked',
    route: 'self-serve',
    rule: 'acceptableUseRefused',
    settled: 'custom',
  },
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    visitorAnswer: 'software',
    acceptableUse: 'blocked',
    route: 'self-serve',
    rule: 'acceptableUseRefused',
    settled: 'unclear',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'allowed',
    route: 'self-serve',
    rule: 'standardAboveThreshold',
    settled: 'standard',
  },
];

describe('decideRoute', () => {
  for (const row of TABLE) {
    const name =
      `${row.scope} @ ${row.confidence}` +
      `${row.alreadyClarified ? ' (clarified)' : ''}` +
      `${row.visitorAnswer ? ` <${row.visitorAnswer}>` : ''}` +
      `${row.acceptableUse ? ` [${row.acceptableUse}]` : ''}` +
      ` -> ${row.route} as ${row.settled}`;
    it(name, () => {
      const decision = decideRoute({
        scope: row.scope,
        confidence: row.confidence,
        alreadyClarified: row.alreadyClarified,
        ...(row.visitorAnswer ? { visitorAnswer: row.visitorAnswer } : {}),
        ...(row.acceptableUse ? { acceptableUse: row.acceptableUse } : {}),
      });
      expect(decision.route).toBe(row.route);
      expect(decision.rule).toBe(row.rule);
      expect(decision.scope).toBe(row.settled);
      expect(decision.operatorReview).toBe(row.review === true);
      expect(decision.reason.length).toBeGreaterThan(0);
    });
  }

  it('never offers a refused brief a discovery call', () => {
    // The property, stated once on its own rather than only as table rows: a
    // business the policy gate refuses must not be filed as a custom-work lead
    // and must not be emailed a calendar invitation to Darius's studio, which
    // is what any route but `self-serve` would do here.
    for (const scope of ['standard', 'custom', 'unclear'] as const) {
      for (const clarified of [false, true]) {
        for (const answer of [
          undefined,
          'site',
          'software',
          'other',
        ] as const) {
          for (const confidence of [0, 0.5, 1]) {
            expect(
              decideRoute({
                scope,
                confidence,
                alreadyClarified: clarified,
                visitorAnswer: answer,
                acceptableUse: 'blocked',
              }).route
            ).toBe('self-serve');
          }
        }
      }
    }
  });

  it('never offers a held brief a discovery call either', () => {
    // The staging defect, as a property. A `review` verdict means nobody has
    // read this yet, and "nobody has read it" is not a reason to put it in
    // front of Darius's calendar with the visitor's name already filled in.
    for (const scope of ['standard', 'custom', 'unclear'] as const) {
      for (const answer of [undefined, 'site', 'software', 'other'] as const) {
        for (const confidence of [0, 0.5, 1]) {
          const decision = decideRoute({
            scope,
            confidence,
            alreadyClarified: true,
            visitorAnswer: answer,
            acceptableUse: 'review',
          });
          expect(decision.route).toBe('self-serve');
          expect(decision.rule).toBe('acceptableUseNeedsAHuman');
        }
      }
    }
  });

  it('lets an explicit answer settle the scope when the classifier is down', () => {
    // The run-8 blocker, as one assertion. Every call was returning `unclear`
    // at confidence 0, and the answer changed only the route: `scope` stayed
    // `unclear` and no visitor could reach a preview.
    const decision = decideRoute({
      scope: 'unclear',
      confidence: 0,
      alreadyClarified: true,
      visitorAnswer: 'site',
    });
    expect(decision.scope).toBe('standard');
    expect(decision.route).toBe('self-serve');
    expect(spendsGenerationBudget(decision.route)).toBe(true);
  });

  it('treats an absent acceptable-use verdict as the gate not having run', () => {
    expect(decideRoute({ scope: 'standard', confidence: 1 }).route).toBe(
      'self-serve'
    );
  });

  it('clamps a confidence outside 0..1 instead of trusting it', () => {
    expect(decideRoute({ scope: 'standard', confidence: 42 }).route).toBe(
      'self-serve'
    );
    expect(decideRoute({ scope: 'custom', confidence: -5 }).route).toBe(
      'ask-one-more-question'
    );
    expect(
      decideRoute({ scope: 'standard', confidence: Number.NaN }).route
    ).toBe('ask-one-more-question');
  });

  it('holds custom to a higher bar than standard', () => {
    // The asymmetry is deliberate and documented; a change that equalises them
    // should have to change this line and explain itself.
    expect(customAtOrAbove).toBeGreaterThan(standardAtOrAbove);
  });
});

describe('scopeRouteThresholds', () => {
  it('reads an ops override from the environment', () => {
    process.env.SCOPE_CUSTOM_CONFIDENCE = '0.4';
    process.env.SCOPE_STANDARD_CONFIDENCE = '0.2';
    expect(scopeRouteThresholds()).toEqual({
      customAtOrAbove: 0.4,
      standardAtOrAbove: 0.2,
    });
    expect(decideRoute({ scope: 'custom', confidence: 0.5 }).route).toBe(
      'discovery-call'
    );
  });

  it('ignores a value that is not a confidence', () => {
    for (const bad of ['0', '-1', '1.5', 'soon', '']) {
      process.env.SCOPE_CUSTOM_CONFIDENCE = bad;
      expect(scopeRouteThresholds().customAtOrAbove).toBe(customAtOrAbove);
    }
  });

  it('decides the disagreement at the same bar it routes custom work at', () => {
    // One threshold, not two: the confidence that would have sent this brief
    // to a call on its own is the confidence that makes the visitor's answer
    // a disagreement rather than the last word.
    process.env.SCOPE_CUSTOM_CONFIDENCE = '0.9';
    expect(
      decideRoute({
        scope: 'custom',
        confidence: 0.89,
        visitorAnswer: 'site',
        alreadyClarified: true,
      }).rule
    ).toBe('visitorSaysSite');
    expect(
      decideRoute({
        scope: 'custom',
        confidence: 0.9,
        visitorAnswer: 'site',
        alreadyClarified: true,
      }).rule
    ).toBe('visitorSaysSiteClassifierSaysCustom');
  });
});

describe('scopeOfferCopy', () => {
  it('only lets the custom scope assert that this is software', () => {
    expect(scopeOfferCopy('custom').bodyKey).toBe(
      'landing.discovery.scope.offer.body'
    );
    for (const scope of ['unclear', 'standard'] as const) {
      expect(scopeOfferCopy(scope).bodyKey).toBe(
        'landing.discovery.scope.review.body'
      );
      expect(scopeOfferCopy(scope).titleKey).toBe(
        'landing.discovery.scope.review.title'
      );
    }
  });
});

describe('spendsGenerationBudget', () => {
  it('is true for exactly one route', () => {
    expect(spendsGenerationBudget('self-serve')).toBe(true);
    expect(spendsGenerationBudget('discovery-call')).toBe(false);
    expect(spendsGenerationBudget('ask-one-more-question')).toBe(false);
  });
});
