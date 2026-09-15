/**
 * One guardrail, not two -- asserted as a property rather than as a list.
 *
 * The 2026-09-15 defect was not that the intake's moderator decided the wrong
 * thing. It was that the intake had a moderator at all: a second detector with
 * a second taxonomy and a second set of bands, sitting in front of the real
 * gate, disagreeing with it. Writing the intake's own five-branch `switch`
 * over `AcceptableUse` would have been the same mistake in a nicer hat.
 *
 * So `intakeStopFor` asks `decideRoute` instead, and this suite pins that:
 * for every value the policy layer can produce, the intake stops exactly when
 * the scope gate stops, because the two read one answer from one function.
 */
import { describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

import {
  decideRoute,
  type AcceptableUse,
  type ScopeRoute,
} from '../scope-route';
import { acceptableUseFrom } from '../acceptable-use-verdict';
import { intakeStopFor } from '../intake-guardrail';
import {
  CLEAN_CATEGORY,
  type PolicyVerdict,
} from '@/lib/policy/acceptable-use';

/** Every value the narrowing can produce. A new one fails this suite loudly. */
const EVERY_VERDICT: readonly AcceptableUse[] = [
  'allowed',
  'review',
  'unsettled',
  'hold',
  'blocked',
];

/** What the scope gate does with this verdict, read straight off the rule. */
function scopeGateRoute(acceptableUse: AcceptableUse): ScopeRoute {
  return decideRoute({
    scope: 'standard',
    confidence: 1,
    decided: true,
    acceptableUse,
  }).route;
}

describe('intakeStopFor', () => {
  it.each(EVERY_VERDICT)(
    'agrees with the scope gate about %s, because it asks the same rule',
    (acceptableUse) => {
      const route = scopeGateRoute(acceptableUse);
      const stop = intakeStopFor(acceptableUse);

      if (route === 'refused' || route === 'hold') {
        expect(stop).toBe(route);
      } else {
        expect(stop).toBeNull();
      }
    }
  );

  it('stops a refusal and a hold, and only those two', () => {
    // Spelled out as well as derived above, so a reader does not have to run
    // `decideRoute` in their head to learn what the intake does.
    expect(intakeStopFor('blocked')).toBe('refused');
    expect(intakeStopFor('hold')).toBe('hold');
    expect(intakeStopFor('review')).toBeNull();
    expect(intakeStopFor('unsettled')).toBeNull();
    expect(intakeStopFor('allowed')).toBeNull();
  });
});

describe('acceptableUseFrom, read by both surfaces', () => {
  function verdict(over: Partial<PolicyVerdict>): PolicyVerdict {
    return {
      decision: 'allow',
      category: CLEAN_CATEGORY,
      confidence: 0.9,
      rule: 'tier_decided',
      tier: 'llm',
      needsHuman: false,
      ...over,
    } as PolicyVerdict;
  }

  it('turns a refusal into a stop at both surfaces', () => {
    const narrowed = acceptableUseFrom(verdict({ decision: 'refuse' }));
    expect(narrowed).toBe('blocked');
    expect(intakeStopFor(narrowed)).toBe('refused');
  });

  it('turns an unreadable brief into a hold, not a review', () => {
    // The ordering inside `acceptableUseFrom` that this depends on is the one
    // #193 wrote: a classifier that never answered has no category either, so
    // the unavailable check has to run before the categorised-review check or
    // every hold reads as a merely-unsure review and falls through.
    const narrowed = acceptableUseFrom(
      verdict({ decision: 'review', rule: 'classifier_unavailable' })
    );
    expect(narrowed).toBe('hold');
    expect(intakeStopFor(narrowed)).toBe('hold');
  });

  it('lets an uncategorised review through, at both surfaces', () => {
    const narrowed = acceptableUseFrom(
      verdict({ decision: 'review', rule: 'needs_human_flag' })
    );
    expect(narrowed).toBe('unsettled');
    expect(intakeStopFor(narrowed)).toBeNull();
  });
});
