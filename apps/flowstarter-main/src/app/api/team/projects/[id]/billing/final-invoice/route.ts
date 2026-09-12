import { NextRequest, NextResponse } from 'next/server';
import { quoteMajorFrom } from '@/lib/flowstarter/quote';
import { requireTeamAuth } from '@/lib/api-auth';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import {
  StripeBilling,
  StripeBillingError,
  ensureBillingCustomer,
} from '@/lib/billing/stripe';
import {
  invoiceReuseVerdict,
  mapBillingError,
  resolveAmountMinor,
  sanitizeDaysUntilDue,
} from '@/lib/billing/route-helpers';
import { notifyBalanceInvoiceReady } from '@/lib/billing/balance-invoice-email';

/**
 * POST /api/team/projects/[id]/billing/final-invoice
 *
 * Creates the final 80% invoice once the site is approved by the client.
 * Refuses if deposit hasn't been paid (we don't want to send the final
 * before the deposit lands), or if final is already paid.
 *
 * Body: { amount?: number, daysUntilDue?: number }
 *   - amount defaults to projects.setup_fee × 0.5 (the remaining half)
 */
export async function POST(
  req: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const auth = await requireTeamAuth();
  if (!auth.authorized) return auth.response;

  const { id: workspaceId } = await params;
  const body = (await req.json().catch(() => ({}))) as {
    amount?: unknown;
    daysUntilDue?: unknown;
  };

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

  const supabase = createSupabaseServiceRoleClient();

  let row;
  let customerId: string;
  try {
    const ensured = await ensureBillingCustomer(supabase, billing, workspaceId);
    row = ensured.row;
    customerId = ensured.customerId;
  } catch (e) {
    return mapBillingError(e);
  }

  if (row.deposit_status !== 'paid') {
    return NextResponse.json(
      {
        error:
          'Cannot send final invoice before the deposit is paid. Send the deposit first.',
        deposit_status: row.deposit_status,
      },
      { status: 409 }
    );
  }
  if (row.final_status === 'paid') {
    return NextResponse.json(
      { error: 'Final invoice is already paid for this workspace' },
      { status: 409 }
    );
  }

  // Never a second bill for the same milestone.
  //
  // This POST has no idempotency key, so a double-clicked button, a proxy
  // retry or a second operator used to create a second real invoice for a real
  // customer: two balances owed for one engagement, and whichever the webhook
  // saw last won. The invoice already recorded on the workspace is now read
  // back from Stripe first, and only a void or absent one is replaced.
  const recorded = await billing.lookupInvoice(row.final_invoice_id);
  if (recorded) {
    const verdict = invoiceReuseVerdict(recorded.status);
    if (verdict === 'already-paid') {
      return NextResponse.json(
        {
          error:
            `Final invoice ${recorded.invoiceId} is already paid on Stripe. ` +
            'The workspace row has not caught up with its webhook yet.',
          invoiceId: recorded.invoiceId,
        },
        { status: 409 }
      );
    }
    if (verdict === 'reuse') {
      // The operator asked for the client to be sent the balance, so send it
      // — the same link, not a new bill. `notifyBalanceInvoiceReady` never
      // throws.
      const reEmailed = await notifyBalanceInvoiceReady({
        workspaceId,
        invoiceId: recorded.invoiceId,
        hostedUrl: recorded.hostedUrl,
        amountMinor: recorded.amountMinor,
        currency: billing.currency,
        daysUntilDue: sanitizeDaysUntilDue(body.daysUntilDue),
        stripeEmailed: false,
      });
      return NextResponse.json({
        invoice: {
          id: recorded.invoiceId,
          hostedUrl: recorded.hostedUrl,
          status: recorded.status,
          amountMinor: recorded.amountMinor,
          currency: billing.currency,
          stripeEmailed: false,
          clientEmailed: reEmailed,
          reused: true,
        },
      });
    }
  }

  const amountMinor = resolveAmountMinor(
    body.amount,
    quoteMajorFrom(row),
    /* percentageOfSetup */ 80
  );
  if (amountMinor <= 0) {
    return NextResponse.json(
      {
        error:
          'Cannot derive amount. Set workspaces.setup_fee, or pass an explicit amount in major units.',
      },
      { status: 400 }
    );
  }
  const daysUntilDue = sanitizeDaysUntilDue(body.daysUntilDue);

  let invoice;
  try {
    invoice = await billing.createFinalInvoice({
      project: row,
      customerId,
      amountMinor,
      daysUntilDue,
    });
  } catch (e) {
    return mapBillingError(e);
  }

  const { error: persistErr } = await supabase
    .from('workspaces')
    .update({
      final_invoice_id: invoice.invoiceId,
      final_invoice_url: invoice.hostedUrl,
      final_amount: Math.floor(amountMinor / 100),
      final_status: 'sent',
      outstanding_payment: true,
    })
    .eq('id', workspaceId);

  if (persistErr) {
    return NextResponse.json(
      {
        error: `Invoice ${invoice.invoiceId} created on Stripe but DB update failed: ${persistErr.message}`,
        invoice,
      },
      { status: 500 }
    );
  }

  // After the persist, never before: the client is told about an invoice the
  // dashboard can also show them. Never throws, so an unreachable mailer
  // cannot turn a created invoice into a 500 the operator retries.
  const emailed = await notifyBalanceInvoiceReady({
    workspaceId,
    invoiceId: invoice.invoiceId,
    hostedUrl: invoice.hostedUrl,
    amountMinor,
    currency: billing.currency,
    daysUntilDue,
    stripeEmailed: invoice.stripeEmailed,
  });

  return NextResponse.json({
    invoice: {
      id: invoice.invoiceId,
      hostedUrl: invoice.hostedUrl,
      status: invoice.status,
      amountMinor,
      currency: billing.currency,
      stripeEmailed: invoice.stripeEmailed,
      clientEmailed: emailed,
    },
  });
}
