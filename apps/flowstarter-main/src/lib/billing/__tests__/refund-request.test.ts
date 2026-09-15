/**
 * Reading an operator's refund request off the wire.
 *
 * The amount arrives in euros as somebody types them and leaves in minor
 * units, so the rounding is the thing to pin: 399.5 is 39950 and not 39949.
 */
import { describe, expect, it } from 'vitest';
import { MAX_REASON_CHARS, MIN_REASON_CHARS } from '../refund-policy';
import { parseRefundRequest } from '../refund-request';

const REASON = 'Client invoked the guarantee.';

describe('parseRefundRequest', () => {
  it('accepts a reason on its own', () => {
    expect(parseRefundRequest({ reason: REASON })).toEqual({
      ok: true,
      value: {
        reason: REASON,
        overrideReason: null,
        requestedAmountMinor: null,
      },
    });
  });

  it('trims the reason', () => {
    const parsed = parseRefundRequest({ reason: `  ${REASON}  ` });
    expect(parsed.ok && parsed.value.reason).toBe(REASON);
  });

  it('refuses a missing reason', () => {
    expect(parseRefundRequest({})).toMatchObject({ ok: false });
  });

  it('refuses a reason that is too short', () => {
    expect(
      parseRefundRequest({ reason: 'x'.repeat(MIN_REASON_CHARS - 1) })
    ).toMatchObject({ ok: false });
  });

  it('refuses a reason that is too long', () => {
    expect(
      parseRefundRequest({ reason: 'x'.repeat(MAX_REASON_CHARS + 1) })
    ).toMatchObject({ ok: false });
  });

  it('refuses a non-string reason rather than coercing it', () => {
    expect(parseRefundRequest({ reason: 12345678 })).toMatchObject({
      ok: false,
    });
  });

  it('refuses an override reason that is too long', () => {
    expect(
      parseRefundRequest({
        reason: REASON,
        overrideReason: 'x'.repeat(MAX_REASON_CHARS + 1),
      })
    ).toMatchObject({ ok: false });
  });

  it('carries an override reason through, trimmed', () => {
    const parsed = parseRefundRequest({
      reason: REASON,
      overrideReason: '  goodwill  ',
    });
    expect(parsed.ok && parsed.value.overrideReason).toBe('goodwill');
  });

  it('treats an empty override reason as absent', () => {
    const parsed = parseRefundRequest({ reason: REASON, overrideReason: '  ' });
    expect(parsed.ok && parsed.value.overrideReason).toBeNull();
  });

  it('converts euros to minor units without losing a cent', () => {
    const parsed = parseRefundRequest({ reason: REASON, amount: 399.5 });
    expect(parsed.ok && parsed.value.requestedAmountMinor).toBe(39_950);
  });

  it('accepts an amount typed as a string, with a comma decimal', () => {
    const parsed = parseRefundRequest({ reason: REASON, amount: ' 159,80 ' });
    expect(parsed.ok && parsed.value.requestedAmountMinor).toBe(15_980);
  });

  it('treats an empty amount field as "use the guarantee"', () => {
    const parsed = parseRefundRequest({ reason: REASON, amount: '' });
    expect(parsed.ok && parsed.value.requestedAmountMinor).toBeNull();
  });

  it('refuses a zero, negative or unparseable amount', () => {
    for (const amount of [0, -5, 'soon', {}]) {
      expect(parseRefundRequest({ reason: REASON, amount })).toMatchObject({
        ok: false,
      });
    }
  });

  it('refuses an absurd amount', () => {
    expect(
      parseRefundRequest({ reason: REASON, amount: 999_999 })
    ).toMatchObject({ ok: false });
  });

  it('survives a null body', () => {
    expect(parseRefundRequest(null)).toMatchObject({ ok: false });
  });
});
