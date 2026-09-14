/**
 * The routing table, whole.
 *
 * `decideRoute` is the one place that decides whether a visitor's brief costs a
 * generation run, so the test is a table rather than a handful of examples:
 * every scope, on both sides of its threshold, on both passes, and with every
 * acceptable-use verdict. A rule that is not in the table below is a rule that
 * does not exist.
 */
import { afterEach, describe, expect, it } from 'vitest';
import {
  decideRoute,
  scopeRouteThresholds,
  spendsGenerationBudget,
  type AcceptableUse,
  type Scope,
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
  acceptableUse?: AcceptableUse;
  route: ScopeRoute;
  rule: string;
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
  },
  {
    scope: 'custom',
    confidence: customAtOrAbove,
    alreadyClarified: false,
    route: 'discovery-call',
    rule: 'customAboveThreshold',
  },
  {
    scope: 'custom',
    confidence: JUST_UNDER(customAtOrAbove),
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'customBelowThreshold',
  },
  {
    scope: 'custom',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'customBelowThreshold',
  },

  // ── First pass, standard ────────────────────────────────────────────────
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    route: 'self-serve',
    rule: 'standardAboveThreshold',
  },
  {
    scope: 'standard',
    confidence: standardAtOrAbove,
    alreadyClarified: false,
    route: 'self-serve',
    rule: 'standardAboveThreshold',
  },
  {
    scope: 'standard',
    confidence: JUST_UNDER(standardAtOrAbove),
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'standardBelowThreshold',
  },
  {
    scope: 'standard',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'standardBelowThreshold',
  },

  // ── First pass, unclear: always the question, at any confidence ─────────
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'unclear',
  },
  {
    scope: 'unclear',
    confidence: 1,
    alreadyClarified: false,
    route: 'ask-one-more-question',
    rule: 'unclear',
  },

  // ── Second pass: act on the verdict you have, at any confidence ─────────
  {
    scope: 'custom',
    confidence: 0,
    alreadyClarified: true,
    route: 'discovery-call',
    rule: 'clarifiedCustom',
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: true,
    route: 'discovery-call',
    rule: 'clarifiedCustom',
  },
  {
    scope: 'standard',
    confidence: 0,
    alreadyClarified: true,
    route: 'self-serve',
    rule: 'clarifiedStandard',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: true,
    route: 'self-serve',
    rule: 'clarifiedStandard',
  },
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    route: 'discovery-call',
    rule: 'clarifiedStillUnclear',
  },
  {
    scope: 'unclear',
    confidence: 1,
    alreadyClarified: true,
    route: 'discovery-call',
    rule: 'clarifiedStillUnclear',
  },

  // ── The acceptable-use gate wins over every one of the above ────────────
  // `review` goes to a person, which is what the discovery call is.
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'review',
    route: 'discovery-call',
    rule: 'acceptableUseNeedsAHuman',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: true,
    acceptableUse: 'review',
    route: 'discovery-call',
    rule: 'acceptableUseNeedsAHuman',
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: true,
    acceptableUse: 'review',
    route: 'discovery-call',
    rule: 'acceptableUseNeedsAHuman',
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
  },
  {
    scope: 'custom',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'blocked',
    route: 'self-serve',
    rule: 'acceptableUseRefused',
  },
  {
    scope: 'unclear',
    confidence: 0,
    alreadyClarified: true,
    acceptableUse: 'blocked',
    route: 'self-serve',
    rule: 'acceptableUseRefused',
  },
  {
    scope: 'standard',
    confidence: 1,
    alreadyClarified: false,
    acceptableUse: 'allowed',
    route: 'self-serve',
    rule: 'standardAboveThreshold',
  },
];

describe('decideRoute', () => {
  for (const row of TABLE) {
    const name =
      `${row.scope} @ ${row.confidence}` +
      `${row.alreadyClarified ? ' (clarified)' : ''}` +
      `${row.acceptableUse ? ` [${row.acceptableUse}]` : ''}` +
      ` -> ${row.route}`;
    it(name, () => {
      const decision = decideRoute({
        scope: row.scope,
        confidence: row.confidence,
        alreadyClarified: row.alreadyClarified,
        ...(row.acceptableUse ? { acceptableUse: row.acceptableUse } : {}),
      });
      expect(decision.route).toBe(row.route);
      expect(decision.rule).toBe(row.rule);
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
        for (const confidence of [0, 0.5, 1]) {
          expect(
            decideRoute({
              scope,
              confidence,
              alreadyClarified: clarified,
              acceptableUse: 'blocked',
            }).route
          ).toBe('self-serve');
        }
      }
    }
  });

  it('treats an absent acceptable-use verdict as the gate not having run', () => {
    // `main` has no acceptable-use gate yet. Until it lands, the funnel must
    // behave exactly as it does today rather than sending everybody to a call.
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
});

describe('spendsGenerationBudget', () => {
  it('is true for exactly one route', () => {
    expect(spendsGenerationBudget('self-serve')).toBe(true);
    expect(spendsGenerationBudget('discovery-call')).toBe(false);
    expect(spendsGenerationBudget('ask-one-more-question')).toBe(false);
  });
});
