/**
 * The money side of a change request: a Stripe Checkout session for an
 * accepted quote, and the webhook's settlement of it.
 *
 * Metadata is the whole contract between the two halves: the request id and
 * the workspace, never an amount. The amount charged is read back from the
 * request row at checkout time, and the webhook trusts Stripe's `paid`
 * status, not the metadata, for whether money moved.
 */
import 'server-only';
import Stripe from 'stripe';
import { STRIPE_API_VERSION } from '@/lib/billing/stripe';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  ChangeRequestError,
  acceptChangeRequest,
  getChangeRequest,
  markChangeRequestPaid,
  type ChangeRequestRow,
} from './change-requests';

export const CHANGE_REQUEST_CHECKOUT_KIND = 'change_request';

export async function createChangeRequestCheckout(input: {
  row: ChangeRequestRow;
  clientEmail: string | null;
  businessName: string;
  origin: string;
}): Promise<{ url: string; sessionId: string }> {
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret) {
    throw new ChangeRequestError(
      'Payments are not configured.',
      'STRIPE_UNCONFIGURED',
      503
    );
  }
  const { row } = input;
  if (row.quote_minor === null || row.quote_minor <= 0) {
    throw new ChangeRequestError(
      'This request has no amount to pay.',
      'CHANGE_REQUEST_AMOUNT',
      409
    );
  }
  const metadata: Record<string, string> = {
    kind: CHANGE_REQUEST_CHECKOUT_KIND,
    changeRequestId: row.id,
    workspaceId: row.workspace_id,
  };
  const stripe = new Stripe(secret, { apiVersion: STRIPE_API_VERSION });
  const session = await stripe.checkout.sessions.create({
    mode: 'payment',
    payment_method_types: ['card'],
    ...(input.clientEmail ? { customer_email: input.clientEmail } : {}),
    line_items: [
      {
        quantity: 1,
        price_data: {
          currency: row.currency,
          unit_amount: row.quote_minor,
          product_data: {
            name: `${input.businessName}: website change`,
            description: row.request.slice(0, 300),
          },
        },
      },
    ],
    metadata,
    payment_intent_data: { metadata },
    success_url: `${input.origin}/dashboard/projects/${row.workspace_id}/editor?change=${row.id}&paid=1`,
    cancel_url: `${input.origin}/dashboard/projects/${row.workspace_id}/editor?change=${row.id}&cancelled=1`,
  });
  if (!session.url) {
    throw new ChangeRequestError(
      'Stripe did not return a checkout link.',
      'STRIPE_NO_URL',
      502
    );
  }
  const db = createSupabaseServiceRoleClient();
  await acceptChangeRequest(db, row, session.id);
  return { url: session.url, sessionId: session.id };
}

/**
 * The webhook's half. Idempotent: a redelivered event for a request that is
 * already paid reports `already_paid` and writes nothing.
 */
export async function settleChangeRequestCheckout(
  session: Stripe.Checkout.Session
): Promise<{
  changeRequestId: string | null;
  outcome: 'paid' | 'already_paid' | 'unpaid' | 'unknown';
}> {
  const meta = session.metadata ?? {};
  const changeRequestId = meta['changeRequestId'];
  const workspaceId = meta['workspaceId'];
  if (!changeRequestId || !workspaceId) {
    return { changeRequestId: null, outcome: 'unknown' };
  }
  if (session.payment_status !== 'paid') {
    return { changeRequestId, outcome: 'unpaid' };
  }
  const db = createSupabaseServiceRoleClient();
  const row = await getChangeRequest(db, workspaceId, changeRequestId);
  if (!row) return { changeRequestId, outcome: 'unknown' };
  if (row.status === 'paid' || row.status === 'done') {
    return { changeRequestId, outcome: 'already_paid' };
  }
  const paymentIntentId =
    typeof session.payment_intent === 'string'
      ? session.payment_intent
      : session.payment_intent?.id ?? null;
  // `markChangeRequestPaid` is the money write, and it throws on both a
  // database error and a status that Stripe is not allowed to move (only an
  // `accepted` request becomes `paid`). The webhook turns that into a 500 and
  // Stripe retries.
  await markChangeRequestPaid(db, row, { paymentIntentId });

  // The timeline entry is not money state. Same contract as
  // `recordDispatchFailure` in deposit-workflow.ts: losing the note is not a
  // reason to fail a payment that has already been recorded, and failing here
  // would send Stripe back to a request that is now `paid`, where the retry
  // reports `already_paid` and writes the note no sooner.
  const { error: eventError } = await db.from('project_events').insert({
    workspace_id: workspaceId,
    kind: 'change_request_paid',
    actor: 'stripe',
    payload: {
      changeRequestId,
      amountMinor: row.quote_minor,
      currency: row.currency,
      checkoutSessionId: session.id,
    },
  });
  if (eventError) {
    console.error(
      `[Flowstarter] change request ${changeRequestId} was paid but its ` +
        `timeline entry could not be written: ${eventError.message}`
    );
  }
  return { changeRequestId, outcome: 'paid' };
}
