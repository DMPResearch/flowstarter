/**
 * The refund endpoint's body, shared by the two routes that expose it.
 *
 * `/api/admin/projects/[id]/billing/refund` and
 * `/api/team/projects/[id]/billing/refund` are the same handler behind the
 * same auth. The other four billing endpoints were copied between the two
 * trees and now differ only in a doc comment, which is a shape that works
 * right up until somebody fixes one of them. A refund is the one operation
 * here that moves money the wrong way, so the two routes share this instead.
 */
import { NextRequest, NextResponse } from 'next/server';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { StripeBilling, StripeBillingError } from './stripe';
import { mapBillingError } from './route-helpers';
import { parseRefundRequest } from './refund-request';
import { refundSetupFee } from './refund';

export async function handleRefundRequest(
  req: NextRequest,
  params: Promise<{ id: string }>
): Promise<NextResponse> {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const parsed = parseRefundRequest(await req.json().catch(() => ({})));
  if (!parsed.ok) {
    return NextResponse.json({ error: parsed.error }, { status: 400 });
  }

  if (!process.env.STRIPE_SECRET_KEY) {
    return NextResponse.json(
      { error: 'STRIPE_SECRET_KEY is not configured' },
      { status: 500 }
    );
  }

  let billing: StripeBilling;
  try {
    billing = new StripeBilling();
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof StripeBillingError ? e.message : 'Stripe init failed',
      },
      { status: 500 }
    );
  }

  let outcome;
  try {
    outcome = await refundSetupFee({
      supabase: createSupabaseServiceRoleClient(),
      billing,
      workspaceId,
      reason: parsed.value.reason,
      overrideReason: parsed.value.overrideReason,
      requestedAmountMinor: parsed.value.requestedAmountMinor,
      requestedBy: auth.userId,
    });
  } catch (e) {
    return mapBillingError(e);
  }

  if (!outcome.ok) {
    return NextResponse.json(
      { error: outcome.message, code: outcome.code },
      { status: outcome.status }
    );
  }

  return NextResponse.json({
    refund: {
      totalMinor: outcome.totalMinor,
      currency: outcome.currency,
      basis: outcome.basis,
      duplicate: outcome.duplicate,
      clientEmailed: outcome.clientEmailed,
      legs: outcome.legs,
    },
  });
}
