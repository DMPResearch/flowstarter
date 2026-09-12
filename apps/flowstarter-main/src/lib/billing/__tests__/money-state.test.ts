/**
 * The money-state rules, exhaustively.
 *
 * These are pure functions with no Stripe client and no database behind them,
 * which is the whole reason they were extracted: the sequences they protect
 * against (a late `invoice.overdue` after payment, a
 * `customer.subscription.updated` delivered after the cancellation, two events
 * sharing a created second) are hard to stage against a live account and
 * trivial to state as a table.
 */
import { describe, expect, it } from 'vitest';
import {
  CARE_PLAN_STATUSES,
  PAYMENT_STATUSES,
  carePlanTransitionAllowed,
  changeRequestPaymentAllowed,
  mapSubscriptionStatus,
  orderingVerdict,
  paymentStatusAdvances,
  periodEndIsCurrent,
} from '../money-state';

describe('paymentStatusAdvances — deposit and final paid are monotonic', () => {
  it('lets an unsettled invoice reach paid from every other status', () => {
    for (const from of ['unpaid', 'sent', 'overdue', null, undefined, '']) {
      expect(paymentStatusAdvances(from, 'paid')).toBe(true);
    }
  });

  it('refuses every walk back out of paid', () => {
    for (const to of PAYMENT_STATUSES) {
      if (to === 'paid') continue;
      expect(paymentStatusAdvances('paid', to)).toBe(false);
    }
  });

  it('refuses paid -> paid, so a redelivery cannot rewrite the paid-at stamp', () => {
    expect(paymentStatusAdvances('paid', 'paid')).toBe(false);
  });

  it('refuses a write that would not change anything', () => {
    expect(paymentStatusAdvances('overdue', 'overdue')).toBe(false);
    expect(paymentStatusAdvances('sent', 'sent')).toBe(false);
  });

  it('lets an unrecognised current status through rather than losing a payment', () => {
    expect(paymentStatusAdvances('some_future_status', 'paid')).toBe(true);
  });

  it('still allows sent -> overdue, the ordinary dunning direction', () => {
    expect(paymentStatusAdvances('sent', 'overdue')).toBe(true);
  });
});

describe('mapSubscriptionStatus', () => {
  it('stores trialing as trial and canceled as cancelled', () => {
    expect(mapSubscriptionStatus('trialing')).toBe('trial');
    expect(mapSubscriptionStatus('canceled')).toBe('cancelled');
  });

  it('passes Stripe’s own word through for everything else', () => {
    expect(mapSubscriptionStatus('active')).toBe('active');
    expect(mapSubscriptionStatus('past_due')).toBe('past_due');
    expect(mapSubscriptionStatus('unpaid')).toBe('unpaid');
    expect(mapSubscriptionStatus('paused')).toBe('paused');
    expect(mapSubscriptionStatus('incomplete')).toBe('incomplete');
    expect(mapSubscriptionStatus('incomplete_expired')).toBe(
      'incomplete_expired'
    );
  });

  it('does not drop a status it has never been taught', () => {
    expect(mapSubscriptionStatus('some_new_stripe_status')).toBe(
      'some_new_stripe_status'
    );
  });
});

describe('carePlanTransitionAllowed — Stripe’s subscription lifecycle', () => {
  const sub = 'sub_1';
  const allowed = (from: string | null, to: string) =>
    carePlanTransitionAllowed({
      from,
      to,
      storedSubscriptionId: sub,
      eventSubscriptionId: sub,
    });

  it('allows the ordinary care-plan life: trial, active, past_due, recovery', () => {
    expect(allowed(null, 'trial')).toBe(true);
    expect(allowed('trial', 'active')).toBe(true);
    expect(allowed('active', 'past_due')).toBe(true);
    expect(allowed('past_due', 'active')).toBe(true);
    expect(allowed('active', 'cancelled')).toBe(true);
  });

  it('allows the incomplete opening Stripe uses for default_incomplete', () => {
    expect(allowed('incomplete', 'trial')).toBe(true);
    expect(allowed('incomplete', 'active')).toBe(true);
    expect(allowed('incomplete', 'incomplete_expired')).toBe(true);
  });

  it('treats cancelled as terminal for that subscription id', () => {
    for (const to of CARE_PLAN_STATUSES) {
      if (to === 'cancelled') continue;
      expect(allowed('cancelled', to)).toBe(false);
    }
  });

  it('treats incomplete_expired as terminal too', () => {
    expect(allowed('incomplete_expired', 'active')).toBe(false);
    expect(allowed('incomplete_expired', 'trial')).toBe(false);
  });

  it('refuses active -> trial: a live plan does not go back into its trial', () => {
    expect(allowed('active', 'trial')).toBe(false);
    expect(allowed('past_due', 'trial')).toBe(false);
  });

  it('allows a repeat of the state already held, so a refresh still writes', () => {
    expect(allowed('active', 'active')).toBe(true);
    expect(allowed('cancelled', 'cancelled')).toBe(true);
  });

  it('allows anything when the workspace has no recorded plan state', () => {
    expect(allowed(null, 'active')).toBe(true);
    expect(allowed('', 'cancelled')).toBe(true);
    expect(allowed('none', 'active')).toBe(true);
  });

  it('allows any status when the event is about a different subscription', () => {
    // The old plan was cancelled and the client has since bought a new one:
    // that is a second lifecycle starting, not a cancelled plan reviving.
    expect(
      carePlanTransitionAllowed({
        from: 'cancelled',
        to: 'trial',
        storedSubscriptionId: 'sub_old',
        eventSubscriptionId: 'sub_new',
      })
    ).toBe(true);
  });

  it('applies the lifecycle when the workspace has no subscription id yet', () => {
    expect(
      carePlanTransitionAllowed({
        from: 'cancelled',
        to: 'active',
        storedSubscriptionId: null,
        eventSubscriptionId: 'sub_1',
      })
    ).toBe(false);
  });
});

describe('changeRequestPaymentAllowed — Stripe may only pay an accepted request', () => {
  it('allows accepted', () => {
    expect(changeRequestPaymentAllowed('accepted')).toBe(true);
  });

  it('refuses every other status', () => {
    for (const status of ['requested', 'quoted', 'paid', 'declined', 'done']) {
      expect(changeRequestPaymentAllowed(status)).toBe(false);
    }
  });
});

describe('orderingVerdict', () => {
  it('applies when nothing has been applied to this object yet', () => {
    expect(
      orderingVerdict({ eventCreated: 100, latestAppliedCreated: null })
    ).toBe('apply');
    expect(
      orderingVerdict({ eventCreated: 100, latestAppliedCreated: undefined })
    ).toBe('apply');
  });

  it('applies a newer event', () => {
    expect(
      orderingVerdict({ eventCreated: 200, latestAppliedCreated: 100 })
    ).toBe('apply');
  });

  it('refuses an older event, which is the regression the review found', () => {
    expect(
      orderingVerdict({ eventCreated: 100, latestAppliedCreated: 200 })
    ).toBe('stale');
  });

  it('re-fetches when two events share Stripe’s one-second granularity', () => {
    expect(
      orderingVerdict({ eventCreated: 150, latestAppliedCreated: 150 })
    ).toBe('refetch');
  });
});

describe('periodEndIsCurrent', () => {
  it('accepts a period end that has moved forward, or held still', () => {
    expect(
      periodEndIsCurrent({ candidatePeriodEnd: 200, storedPeriodEnd: 100 })
    ).toBe(true);
    expect(
      periodEndIsCurrent({ candidatePeriodEnd: 100, storedPeriodEnd: 100 })
    ).toBe(true);
  });

  it('refuses one that has moved backwards', () => {
    expect(
      periodEndIsCurrent({ candidatePeriodEnd: 100, storedPeriodEnd: 200 })
    ).toBe(false);
  });

  it('treats an unknown period end on either side as no evidence', () => {
    expect(
      periodEndIsCurrent({ candidatePeriodEnd: null, storedPeriodEnd: 200 })
    ).toBe(true);
    expect(
      periodEndIsCurrent({ candidatePeriodEnd: 100, storedPeriodEnd: null })
    ).toBe(true);
    expect(
      periodEndIsCurrent({
        candidatePeriodEnd: undefined,
        storedPeriodEnd: undefined,
      })
    ).toBe(true);
  });
});
