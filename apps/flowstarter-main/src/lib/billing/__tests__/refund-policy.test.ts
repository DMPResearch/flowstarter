/**
 * The refund rule, pinned exhaustively because it is the one that decides how
 * much of somebody's money goes back.
 *
 * Two things matter most here and both are about refusal rather than
 * approval. A guarantee refund may not pay an amount other than the
 * guaranteed one, because a "no questions asked" refund that quietly pays a
 * different number than the pricing page said is not the thing that was
 * promised. And nothing, on either path, may exceed what the client actually
 * paid and has not already had back.
 */
import { describe, expect, it } from 'vitest';
import {
  MIN_REASON_CHARS,
  daysSince,
  decideRefund,
  guaranteeHeroSentence,
  guaranteeSentence,
  refundGuarantee,
} from '../refund-policy';

const NOW = new Date('2026-09-15T12:00:00.000Z');
const LAUNCHED_TODAY = '2026-09-15T09:00:00.000Z';
const LAUNCHED_40_DAYS_AGO = '2026-08-06T12:00:00.000Z';

/** A EUR 799 project, deposit and balance both settled. */
const BASE = {
  quoteMinor: 79_900,
  remainingRefundableMinor: 79_900,
  launchedAt: LAUNCHED_TODAY,
  now: NOW,
  reason: 'Client asked for the guarantee on the call today.',
};

describe('refundGuarantee', () => {
  it('defaults to the promise already published: 50% within 30 days', () => {
    expect(refundGuarantee({})).toEqual({
      windowDays: 30,
      percentOfSetupFee: 50,
    });
  });

  it('follows the server env', () => {
    expect(
      refundGuarantee({
        FLOWSTARTER_REFUND_WINDOW_DAYS: '14',
        FLOWSTARTER_REFUND_PERCENT: '100',
      })
    ).toEqual({ windowDays: 14, percentOfSetupFee: 100 });
  });

  it('falls back to the NEXT_PUBLIC twin, which is all a browser can read', () => {
    expect(
      refundGuarantee({
        NEXT_PUBLIC_FLOWSTARTER_REFUND_WINDOW_DAYS: '45',
        NEXT_PUBLIC_FLOWSTARTER_REFUND_PERCENT: '60',
      })
    ).toEqual({ windowDays: 45, percentOfSetupFee: 60 });
  });

  it('prefers the server name when both are set', () => {
    expect(
      refundGuarantee({
        FLOWSTARTER_REFUND_PERCENT: '50',
        NEXT_PUBLIC_FLOWSTARTER_REFUND_PERCENT: '90',
      }).percentOfSetupFee
    ).toBe(50);
  });

  it('clamps a percent above 100, so a typo cannot become an overpayment', () => {
    expect(
      refundGuarantee({ FLOWSTARTER_REFUND_PERCENT: '500' }).percentOfSetupFee
    ).toBe(100);
  });

  it('ignores nonsense and keeps the published promise', () => {
    expect(
      refundGuarantee({
        FLOWSTARTER_REFUND_WINDOW_DAYS: 'thirty',
        FLOWSTARTER_REFUND_PERCENT: '-5',
      })
    ).toEqual({ windowDays: 30, percentOfSetupFee: 50 });
  });
});

describe('the published sentences', () => {
  it('state the configured window and percentage', () => {
    const sentence = guaranteeSentence({
      windowDays: 14,
      percentOfSetupFee: 60,
    });
    expect(sentence).toContain('14 days');
    expect(sentence).toContain('60%');
  });

  it('say the client keeps the work, on both surfaces', () => {
    expect(guaranteeSentence()).toMatch(/keep the work/i);
    expect(guaranteeHeroSentence()).toMatch(/keep the work/i);
  });

  it('write no em dash', () => {
    expect(guaranteeSentence()).not.toContain('—');
    expect(guaranteeHeroSentence()).not.toContain('—');
  });
});

describe('daysSince', () => {
  it('floors to whole days', () => {
    expect(daysSince(new Date('2026-09-01T00:00:00Z'), NOW)).toBe(14);
    expect(daysSince(NOW, NOW)).toBe(0);
  });
});

describe('the reason', () => {
  it('is required', () => {
    const verdict = decideRefund({ ...BASE, reason: '' });
    expect(verdict).toMatchObject({ allowed: false, code: 'reason_required' });
  });

  it('has to be longer than a key press', () => {
    const verdict = decideRefund({
      ...BASE,
      reason: 'x'.repeat(MIN_REASON_CHARS - 1),
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'reason_required' });
  });

  it('is required even with an override reason present', () => {
    const verdict = decideRefund({
      ...BASE,
      reason: ' ',
      overrideReason: 'Goodwill after a bad build.',
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'reason_required' });
  });
});

describe('the guarantee path', () => {
  it('refunds the published percentage of the agreed price', () => {
    expect(decideRefund(BASE)).toEqual({
      allowed: true,
      amountMinor: 39_950,
      basis: 'guarantee',
    });
  });

  it('allows it on the last day of the window', () => {
    const verdict = decideRefund({
      ...BASE,
      launchedAt: '2026-08-16T12:00:00.000Z',
    });
    expect(verdict.allowed).toBe(true);
  });

  it('refuses the day after the window closes', () => {
    const verdict = decideRefund({
      ...BASE,
      launchedAt: '2026-08-15T11:00:00.000Z',
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'window_closed' });
  });

  it('refuses before the site has launched at all', () => {
    const verdict = decideRefund({ ...BASE, launchedAt: null });
    expect(verdict).toMatchObject({ allowed: false, code: 'not_launched' });
  });

  it('refuses an unreadable launch date rather than guessing', () => {
    const verdict = decideRefund({ ...BASE, launchedAt: 'sometime in August' });
    expect(verdict).toMatchObject({ allowed: false, code: 'not_launched' });
  });

  it('refuses when the workspace has no agreed price to take a share of', () => {
    const verdict = decideRefund({ ...BASE, quoteMinor: 0 });
    expect(verdict).toMatchObject({ allowed: false, code: 'no_quote' });
  });

  it('refuses an amount that is not the guaranteed one', () => {
    const verdict = decideRefund({ ...BASE, requestedAmountMinor: 50_000 });
    expect(verdict).toMatchObject({
      allowed: false,
      code: 'amount_not_guaranteed',
    });
    if (verdict.allowed) throw new Error('unreachable');
    expect(verdict.message).toContain('39950');
  });

  it('accepts the guaranteed amount stated explicitly', () => {
    expect(decideRefund({ ...BASE, requestedAmountMinor: 39_950 })).toEqual({
      allowed: true,
      amountMinor: 39_950,
      basis: 'guarantee',
    });
  });

  it('never exceeds what is still refundable', () => {
    const verdict = decideRefund({
      ...BASE,
      remainingRefundableMinor: 15_980,
    });
    expect(verdict).toEqual({
      allowed: true,
      amountMinor: 15_980,
      basis: 'guarantee',
    });
  });

  it('refuses when nothing has settled', () => {
    const verdict = decideRefund({ ...BASE, remainingRefundableMinor: 0 });
    expect(verdict).toMatchObject({
      allowed: false,
      code: 'nothing_refundable',
    });
  });

  it('refuses when the guaranteed share rounds away to nothing', () => {
    const verdict = decideRefund(
      { ...BASE, quoteMinor: 1, remainingRefundableMinor: 100 },
      { windowDays: 30, percentOfSetupFee: 1 }
    );
    expect(verdict).toMatchObject({
      allowed: false,
      code: 'nothing_refundable',
    });
  });

  it('follows a changed guarantee', () => {
    expect(
      decideRefund(BASE, { windowDays: 60, percentOfSetupFee: 25 })
    ).toEqual({ allowed: true, amountMinor: 19_975, basis: 'guarantee' });
  });
});

describe('the override path', () => {
  const OVERRIDE = {
    ...BASE,
    overrideReason: 'Build never delivered; refunding in full.',
  };

  it('refunds everything still refundable when no amount is given', () => {
    expect(decideRefund({ ...OVERRIDE, launchedAt: null })).toEqual({
      allowed: true,
      amountMinor: 79_900,
      basis: 'override',
    });
  });

  it('honours an explicit amount', () => {
    expect(decideRefund({ ...OVERRIDE, requestedAmountMinor: 10_000 })).toEqual(
      { allowed: true, amountMinor: 10_000, basis: 'override' }
    );
  });

  it('opens a window that has already closed', () => {
    const verdict = decideRefund({
      ...OVERRIDE,
      launchedAt: LAUNCHED_40_DAYS_AGO,
    });
    expect(verdict).toMatchObject({ allowed: true, basis: 'override' });
  });

  it('still cannot exceed what is refundable', () => {
    const verdict = decideRefund({
      ...OVERRIDE,
      requestedAmountMinor: 100_000,
    });
    expect(verdict).toMatchObject({
      allowed: false,
      code: 'amount_above_remaining',
    });
  });

  it('still cannot be zero or negative', () => {
    expect(
      decideRefund({ ...OVERRIDE, requestedAmountMinor: 0.4 })
    ).toMatchObject({ allowed: false, code: 'nothing_refundable' });
  });

  it('is not triggered by whitespace pretending to be a reason', () => {
    const verdict = decideRefund({
      ...BASE,
      overrideReason: '   ',
      launchedAt: null,
    });
    expect(verdict).toMatchObject({ allowed: false, code: 'not_launched' });
  });

  it('ignores a non-finite requested amount rather than refunding NaN', () => {
    expect(
      decideRefund({ ...OVERRIDE, requestedAmountMinor: Number.NaN })
    ).toEqual({ allowed: true, amountMinor: 79_900, basis: 'override' });
  });
});
