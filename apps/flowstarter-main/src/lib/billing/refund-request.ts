/**
 * Reading an operator's refund request off the wire.
 *
 * Split from the route so both `/api/admin/...` and `/api/team/...` parse it
 * the same way, and so the parsing can be tested without a request object.
 * The amount arrives in major units, as an operator types it, and leaves in
 * minor units, because every other money value in this app is minor units and
 * the one conversion belongs in one place.
 */
import { MAX_REASON_CHARS, MIN_REASON_CHARS } from './refund-policy';

export interface ParsedRefundRequest {
  reason: string;
  overrideReason: string | null;
  requestedAmountMinor: number | null;
}

export type RefundRequestParse =
  | { ok: true; value: ParsedRefundRequest }
  | { ok: false; error: string };

/** Above any realistic refund, and the same ceiling `quote.ts` uses. */
const MAX_REFUND_MINOR = 100_000_00;

function text(raw: unknown): string {
  return typeof raw === 'string' ? raw.trim() : '';
}

export function parseRefundRequest(body: unknown): RefundRequestParse {
  const input = (body ?? {}) as Record<string, unknown>;

  const reason = text(input['reason']);
  if (reason.length < MIN_REASON_CHARS) {
    return {
      ok: false,
      error:
        `Give a reason of at least ${MIN_REASON_CHARS} characters. It is ` +
        'stored with the refund and is the only record of why money went back.',
    };
  }
  if (reason.length > MAX_REASON_CHARS) {
    return {
      ok: false,
      error: `Keep the reason under ${MAX_REASON_CHARS} characters.`,
    };
  }

  const overrideReason = text(input['overrideReason']);
  if (overrideReason.length > MAX_REASON_CHARS) {
    return {
      ok: false,
      error: `Keep the override reason under ${MAX_REASON_CHARS} characters.`,
    };
  }

  const rawAmount = input['amount'];
  let requestedAmountMinor: number | null = null;
  if (rawAmount !== undefined && rawAmount !== null && rawAmount !== '') {
    const major =
      typeof rawAmount === 'string'
        ? Number(rawAmount.trim().replace(',', '.'))
        : Number(rawAmount);
    if (!Number.isFinite(major) || major <= 0) {
      return { ok: false, error: 'Amount must be a positive number of euros.' };
    }
    requestedAmountMinor = Math.round(major * 100);
    if (requestedAmountMinor > MAX_REFUND_MINOR) {
      return { ok: false, error: 'That amount is above the allowed maximum.' };
    }
  }

  return {
    ok: true,
    value: {
      reason,
      overrideReason: overrideReason || null,
      requestedAmountMinor,
    },
  };
}
