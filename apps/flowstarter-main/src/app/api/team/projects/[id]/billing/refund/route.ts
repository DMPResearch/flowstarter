import { NextRequest, NextResponse } from 'next/server';
import { handleRefundRequest } from '@/lib/billing/refund-route';

/**
 * POST /api/team/projects/[id]/billing/refund
 *
 * Refunds the setup fee, which is what the terms page and the landing hero
 * have promised since launch and what nothing in this product could do until
 * now.
 *
 * Body: { reason: string, overrideReason?: string, amount?: number }
 *   - `reason` is required and is stored on the ledger row. It is the only
 *     record of why the money went back.
 *   - `amount` is in euros as an operator types them. Omit it to refund the
 *     guaranteed percentage of the agreed price.
 *   - `overrideReason` is what allows anything outside the published
 *     guarantee: a different amount, a site that has not launched, or a
 *     window that has closed.
 *
 * Idempotent per Stripe payment intent: the ledger's unique index means a
 * double-clicked button or a retried request finds the refund already made
 * and answers 200 with `duplicate: true` rather than sending money twice.
 *
 * The rules, the Stripe calls and the client email all live in
 * `src/lib/billing/refund.ts`; this file exists so the route tree has the
 * endpoint. The `/api/admin/...` copy is the same handler.
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
): Promise<NextResponse> {
  return handleRefundRequest(req, params);
}
