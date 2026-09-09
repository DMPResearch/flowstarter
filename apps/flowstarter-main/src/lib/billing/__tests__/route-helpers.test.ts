/**
 * Unit tests for the billing route helpers.
 *
 * These three functions decide how much money we ask a client for and what
 * HTTP status a Stripe failure turns into, so every arm is pinned here rather
 * than only through the route handlers that call them.
 */
import { describe, expect, it } from 'vitest';
import {
  mapBillingError,
  resolveAmountMinor,
  sanitizeDaysUntilDue,
} from '../route-helpers';
import { StripeBillingError } from '../stripe';

describe('resolveAmountMinor', () => {
  it('converts an explicit major-unit amount to minor units', () => {
    expect(resolveAmountMinor(399.5, 799, 20)).toBe(39950);
  });

  it('rounds an explicit amount at the cent', () => {
    // 159.789 EUR is not representable in cents; we bill the nearest cent.
    expect(resolveAmountMinor(159.789, 799, 20)).toBe(15979);
  });

  it('accepts a numeric string amount', () => {
    expect(resolveAmountMinor('250', 799, 20)).toBe(25000);
  });

  it('returns 0 for an explicit zero amount', () => {
    expect(resolveAmountMinor(0, 799, 20)).toBe(0);
  });

  it('returns 0 for an explicit negative amount', () => {
    expect(resolveAmountMinor(-10, 799, 20)).toBe(0);
  });

  it('returns 0 for an unparseable explicit amount', () => {
    expect(resolveAmountMinor('not-a-number', 799, 20)).toBe(0);
    expect(resolveAmountMinor(Number.POSITIVE_INFINITY, 799, 20)).toBe(0);
  });

  it('derives the percentage of the setup fee when amount is undefined', () => {
    // 20% of EUR 799 = EUR 159.80 = 15980 minor units.
    expect(resolveAmountMinor(undefined, 799, 20)).toBe(15980);
  });

  it('derives the percentage when amount is explicitly null', () => {
    expect(resolveAmountMinor(null, 799, 80)).toBe(63920);
  });

  it('returns 0 when the setup fee is zero or negative', () => {
    expect(resolveAmountMinor(undefined, 0, 20)).toBe(0);
    expect(resolveAmountMinor(undefined, -799, 20)).toBe(0);
  });

  it('returns 0 when the setup fee is not a finite number', () => {
    expect(resolveAmountMinor(undefined, Number.NaN, 20)).toBe(0);
  });

  it('returns 0 for a percentage outside (0, 100]', () => {
    expect(resolveAmountMinor(undefined, 799, 0)).toBe(0);
    expect(resolveAmountMinor(undefined, 799, -20)).toBe(0);
    expect(resolveAmountMinor(undefined, 799, 101)).toBe(0);
    expect(resolveAmountMinor(undefined, 799, Number.NaN)).toBe(0);
  });

  it('allows a full 100% split', () => {
    expect(resolveAmountMinor(undefined, 799, 100)).toBe(79900);
  });
});

describe('sanitizeDaysUntilDue', () => {
  it('keeps a value inside the allowed window', () => {
    expect(sanitizeDaysUntilDue(30)).toBe(30);
    expect(sanitizeDaysUntilDue(1)).toBe(1);
    expect(sanitizeDaysUntilDue(90)).toBe(90);
  });

  it('floors a fractional value', () => {
    expect(sanitizeDaysUntilDue(7.9)).toBe(7);
  });

  it('falls back to 14 below the window', () => {
    expect(sanitizeDaysUntilDue(0)).toBe(14);
    expect(sanitizeDaysUntilDue(-5)).toBe(14);
  });

  it('falls back to 14 above the window', () => {
    expect(sanitizeDaysUntilDue(91)).toBe(14);
  });

  it('falls back to 14 for a missing or unparseable value', () => {
    expect(sanitizeDaysUntilDue(undefined)).toBe(14);
    expect(sanitizeDaysUntilDue('soon')).toBe(14);
    expect(sanitizeDaysUntilDue(null)).toBe(14); // Number(null) === 0, below 1
  });
});

describe('mapBillingError', () => {
  const cases: Array<[string, number]> = [
    // The code `ensureBillingCustomer` actually throws. The table used to say
    // `project_not_found`, which nothing throws, so an unknown workspace was
    // a 500 on four billing endpoints.
    ['workspace_not_found', 404],
    ['missing_client_email', 400],
    ['subscription_exists', 409],
    ['no_subscription', 404],
    ['missing_product_id', 500],
    ['missing_secret_key', 500],
    ['persist_customer_failed', 500],
    ['invalid_amount', 400],
    ['invoice_create_failed', 502],
    ['invoice_finalize_failed', 502],
    ['db_error', 500],
  ];

  it.each(cases)('maps %s to HTTP %i', async (code, status) => {
    const res = mapBillingError(new StripeBillingError(code, `boom: ${code}`));
    expect(res.status).toBe(status);
    const body = await res.json();
    expect(body).toEqual({ error: `boom: ${code}`, code });
  });

  it('falls back to 500 for a code the table does not carry', async () => {
    // The fallback still exists and still answers 500; it just no longer
    // catches the one code the product throws most.
    const res = mapBillingError(
      new StripeBillingError('teapot', 'Nobody throws this')
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.code).toBe('teapot');
  });

  it('no longer maps the dead `project_not_found` code', async () => {
    // Named so a future re-add has to argue with this test: renaming the code
    // back would silently restore the 500.
    const res = mapBillingError(
      new StripeBillingError('project_not_found', 'stale code')
    );
    expect(res.status).toBe(500);
  });

  it('maps a plain Error to 500 and keeps its message', async () => {
    const res = mapBillingError(new Error('Stripe is down'));
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Stripe is down' });
    expect(body.code).toBeUndefined();
  });

  it('maps a non-Error throw to a generic 500', async () => {
    const res = mapBillingError('something odd');
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body).toEqual({ error: 'Billing call failed' });
  });
});
