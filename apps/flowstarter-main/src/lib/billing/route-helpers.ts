import { NextResponse } from 'next/server';
import { StripeBillingError } from './stripe';

/**
 * Convert a request-body amount field into the smallest currency unit (e.g.
 * "minor" — cents for EUR/USD). Two paths:
 *   1. Caller passed an explicit `amount` in major units (e.g. 399.5 → 39950)
 *   2. Caller passed nothing → derive the requested percentage of `setupFeeMajor`
 *
 * Returns 0 when no valid amount can be derived. Caller decides 400 vs 0.
 */
export function resolveAmountMinor(
  raw: unknown,
  setupFeeMajor: number,
  percentageOfSetup: number
): number {
  if (raw !== undefined && raw !== null) {
    const n = Number(raw);
    if (Number.isFinite(n) && n > 0) {
      return Math.round(n * 100);
    }
    return 0;
  }
  if (!Number.isFinite(setupFeeMajor) || setupFeeMajor <= 0) return 0;
  if (
    !Number.isFinite(percentageOfSetup) ||
    percentageOfSetup <= 0 ||
    percentageOfSetup > 100
  ) {
    return 0;
  }
  return Math.round(setupFeeMajor * percentageOfSetup);
}

/** Clamps days_until_due to [1, 90]; defaults to 14. */
export function sanitizeDaysUntilDue(raw: unknown): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 1 || n > 90) return 14;
  return Math.floor(n);
}

/** Maps StripeBillingError codes to HTTP status codes. */
export function mapBillingError(e: unknown): NextResponse {
  if (e instanceof StripeBillingError) {
    const statusByCode: Record<string, number> = {
      // `workspace_not_found`, not `project_not_found`: that is the code
      // `ensureBillingCustomer` throws, and nothing throws the old one. While
      // the key was stale every request for a workspace that does not exist
      // fell through to `?? 500` and answered 500 instead of 404, on
      // deposit-invoice, final-invoice, activate-subscription and portal-link.
      workspace_not_found: 404,
      missing_client_email: 400,
      subscription_exists: 409,
      no_subscription: 404,
      missing_product_id: 500,
      missing_secret_key: 500,
      persist_customer_failed: 500,
      invalid_amount: 400,
      invoice_create_failed: 502,
      invoice_finalize_failed: 502,
      db_error: 500,
    };
    const status = statusByCode[e.code] ?? 500;
    return NextResponse.json({ error: e.message, code: e.code }, { status });
  }
  return NextResponse.json(
    { error: e instanceof Error ? e.message : 'Billing call failed' },
    { status: 500 }
  );
}
