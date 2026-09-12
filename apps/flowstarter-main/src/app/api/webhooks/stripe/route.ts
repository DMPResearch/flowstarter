/**
 * Stripe's webhook, processed durably.
 *
 * The rule this route now holds to: **a 200 means the state is in the
 * database.** Stripe treats any 2xx as final and will never redeliver that
 * event, so a handler that awaited a Supabase update without reading
 * `{ error }` — which is what this file used to do — could leave a paying
 * customer marked unpaid, with nothing but a log line and no retry. Every
 * write below is checked, every unexpected throw becomes a 500, and the only
 * things that still answer 200 are events that were genuinely dealt with or
 * genuinely have nothing to do.
 *
 * Three mechanisms, in the order the request meets them:
 *
 *   1. Signature. Unchanged, and still first: an unsigned body never reaches
 *      the ledger, so a forged event cannot even consume an event id.
 *   2. The ledger (`lib/billing/stripe-events.ts`). The event is written down
 *      before any handler runs and stamped only after one finishes. A
 *      redelivery of something already processed is skipped and acknowledged.
 *   3. Ordering. Stripe's delivery order is not the event order. Before a
 *      subscription or invoice event is applied, `orderingVerdict` compares its
 *      `created` with the newest event already applied to the same object:
 *      older is refused, newer is applied, and the same second — which Stripe
 *      cannot disambiguate, its `created` being whole seconds — makes the route
 *      re-fetch the object from Stripe and apply what Stripe says now.
 *
 * On top of that, the money-state rules in `lib/billing/money-state.ts` are
 * consulted against the workspace's current row, so even an event that passes
 * ordering cannot walk a paid deposit back to overdue or revive a cancelled
 * care plan.
 */
import { NextRequest, NextResponse } from 'next/server';
import Stripe from 'stripe';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';
import { sendEmail } from '@/lib/email';
import {
  enqueueFullBuildFromDeposit,
  enqueueFullBuildFromDepositInvoice,
} from '@/lib/flowstarter/deposit-workflow';
import { provisionGuestDeposit } from '@/lib/flowstarter/guest-deposit';
import {
  CHANGE_REQUEST_CHECKOUT_KIND,
  settleChangeRequestCheckout,
} from '@/lib/flowstarter/change-request-checkout';
import {
  carePlanTransitionAllowed,
  mapSubscriptionStatus,
  orderingVerdict,
  paymentStatusAdvances,
  periodEndIsCurrent,
} from '@/lib/billing/money-state';
import {
  claimStripeEvent,
  finishStripeEvent,
  latestAppliedCreated,
  markStripeEventFailed,
  stripeObjectId,
} from '@/lib/billing/stripe-events';

function getStripe(): Stripe {
  const key = process.env.STRIPE_SECRET_KEY;
  if (!key) throw new Error('STRIPE_SECRET_KEY not set');
  return new Stripe(key, { apiVersion: '2026-02-25.clover' });
}

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/**
 * What a handler did, which is also what the ledger records.
 *
 *   processed  — state was written (or the work was durably enqueued).
 *   ignored    — nothing to do: an event type we do not act on, or metadata
 *                that points at no workspace of ours.
 *   superseded — a newer truth is already stored; applying this would regress.
 *
 * All three are final and all three answer 200. A handler that cannot finish
 * throws instead, and the route answers 500.
 */
type HandlerOutcome = 'processed' | 'ignored' | 'superseded';

/**
 * Stripe writes to `invoice.metadata.workspaceId` (and historically projectId).
 * Read both so older invoices in flight on cutover still resolve.
 */
function workspaceIdFromMetadata(
  meta: Stripe.Metadata | null | undefined
): string | undefined {
  if (!meta) return undefined;
  const ws = meta['workspaceId'];
  if (typeof ws === 'string' && ws.length > 0) return ws;
  const pj = meta['projectId'];
  if (typeof pj === 'string' && pj.length > 0) return pj;
  return undefined;
}

/**
 * One workspace update, with its result read.
 *
 * The whole defect this file was rewritten for is the missing half of this
 * function. `await supabase.from(...).update(...)` resolves perfectly happily
 * when the write failed; the failure is in `{ error }`, and nothing was
 * reading it. Throwing here is what turns a lost payment into a 500 and a
 * Stripe retry.
 */
async function updateWorkspace(
  supabase: ServiceClient,
  workspaceId: string,
  values: Record<string, unknown>,
  what: string
): Promise<void> {
  const { error } = await supabase
    .from('workspaces')
    .update(values)
    .eq('id', workspaceId);
  if (error) {
    throw new Error(
      `[Stripe] ${what} failed for workspace ${workspaceId}: ${error.message}`
    );
  }
}

/** The workspace columns the money handlers decide on. */
interface WorkspaceMoneyState {
  deposit_status: string | null;
  final_status: string | null;
  subscription_status: string | null;
  stripe_subscription_id: string | null;
  subscription_next_billing: string | null;
}

/**
 * The workspace's current money state, or null when there is no such
 * workspace.
 *
 * A read error throws: deciding whether a payment may be applied from a row we
 * failed to load would be guessing, and guessing is what a 500 exists to
 * avoid.
 */
async function loadWorkspaceMoneyState(
  supabase: ServiceClient,
  workspaceId: string
): Promise<WorkspaceMoneyState | null> {
  const { data, error } = await supabase
    .from('workspaces')
    .select(
      'deposit_status, final_status, subscription_status, stripe_subscription_id, subscription_next_billing'
    )
    .eq('id', workspaceId)
    .maybeSingle();
  if (error) {
    throw new Error(
      `[Stripe] could not read workspace ${workspaceId}: ${error.message}`
    );
  }
  return (data as WorkspaceMoneyState | null) ?? null;
}

/**
 * Resolve the object this event should actually be applied from.
 *
 * `stale` means a newer event for the same Stripe object has already been
 * applied and this one must write nothing. `apply` hands back either the
 * event's own payload or, where `created` could not separate two events, the
 * object as Stripe reports it right now — re-fetched through the same client
 * the rest of this file uses, so the answer is the current one whatever order
 * the deliveries arrived in.
 *
 * A re-fetch that fails throws, and the event is retried. That is the right
 * trade: we would rather ask Stripe again in a minute than write a state we
 * are not sure is current.
 */
async function resolveOrdered<T extends { id?: string }>(input: {
  supabase: ServiceClient;
  event: Stripe.Event;
  object: T;
  refetch: (id: string) => Promise<T>;
}): Promise<{ verdict: 'apply' | 'stale'; object: T }> {
  const { supabase, event, object } = input;
  const objectId = stripeObjectId(event) ?? object.id ?? null;
  if (!objectId) return { verdict: 'apply', object };

  const latest = await latestAppliedCreated(supabase, {
    objectId,
    excludeEventId: event.id,
  });
  const verdict = orderingVerdict({
    eventCreated: event.created,
    latestAppliedCreated: latest,
  });

  if (verdict === 'stale') {
    console.warn(
      `[Stripe] ${event.type} ${event.id} is older than the state already ` +
        `applied to ${objectId}; refusing to regress it`
    );
    return { verdict: 'stale', object };
  }
  if (verdict === 'refetch') {
    console.info(
      `[Stripe] ${event.type} ${event.id} shares a created second with the ` +
        `last event applied to ${objectId}; re-fetching from Stripe`
    );
    return { verdict: 'apply', object: await input.refetch(objectId) };
  }
  return { verdict: 'apply', object };
}

async function handleInvoicePaymentSucceeded(
  supabase: ServiceClient,
  event: Stripe.Event,
  incoming: Stripe.Invoice
): Promise<HandlerOutcome> {
  const ordered = await resolveOrdered({
    supabase,
    event,
    object: incoming,
    refetch: (id) => getStripe().invoices.retrieve(id),
  });
  if (ordered.verdict === 'stale') return 'superseded';
  const invoice = ordered.object;

  const workspaceId = workspaceIdFromMetadata(invoice.metadata);
  const invoiceType = invoice.metadata?.invoiceType;
  if (!workspaceId || !invoiceType) return 'ignored';

  const workspace = await loadWorkspaceMoneyState(supabase, workspaceId);
  if (!workspace) {
    console.warn(
      `[Stripe] ${invoiceType} invoice paid for unknown workspace ${workspaceId}`
    );
    return 'ignored';
  }
  const now = new Date().toISOString();

  if (invoiceType === 'deposit') {
    // Monotonic: a redelivery or a late duplicate must not rewrite the moment
    // the money landed, but it must still reach the enqueue below, which is
    // the half that was missing when the lifecycle stalled.
    if (paymentStatusAdvances(workspace.deposit_status, 'paid')) {
      await updateWorkspace(
        supabase,
        workspaceId,
        {
          deposit_status: 'paid',
          deposit_paid_at: now,
          outstanding_payment: false,
        },
        'deposit paid'
      );
    }

    // A concierge workspace also advances PREVIEW_READY -> DEPOSIT_PAID and
    // enqueues the full-site build. Marking the invoice paid without this is
    // what stalled the lifecycle: the money landed and no build was queued.
    const enqueued = await enqueueFullBuildFromDepositInvoice(event, invoice);
    if (enqueued) {
      console.info(
        `[Stripe] deposit invoice queued build ${enqueued.jobId} for workspace ${workspaceId}` +
          (enqueued.duplicate ? ' (redelivery)' : '')
      );
    }
  }
  if (invoiceType === 'final') {
    if (paymentStatusAdvances(workspace.final_status, 'paid')) {
      await updateWorkspace(
        supabase,
        workspaceId,
        {
          final_status: 'paid',
          final_paid_at: now,
          outstanding_payment: false,
        },
        'final paid'
      );
    }
  }
  console.info(
    `[Stripe] payment_succeeded -- ${invoiceType} for workspace ${workspaceId}`
  );
  return 'processed';
}

async function handleInvoiceOverdue(
  supabase: ServiceClient,
  event: Stripe.Event,
  incoming: Stripe.Invoice
): Promise<HandlerOutcome> {
  const ordered = await resolveOrdered({
    supabase,
    event,
    object: incoming,
    refetch: (id) => getStripe().invoices.retrieve(id),
  });
  if (ordered.verdict === 'stale') return 'superseded';
  const invoice = ordered.object;

  const workspaceId = workspaceIdFromMetadata(invoice.metadata);
  const invoiceType = invoice.metadata?.invoiceType;
  if (!workspaceId || !invoiceType) return 'ignored';

  const workspace = await loadWorkspaceMoneyState(supabase, workspaceId);
  if (!workspace) return 'ignored';

  const current =
    invoiceType === 'deposit'
      ? workspace.deposit_status
      : workspace.final_status;
  // The sequence this guards is real and unremarkable: Stripe marks an invoice
  // overdue, the client pays it minutes later, and the two events arrive in
  // the wrong order. Paid is terminal, so the overdue is dropped.
  if (!paymentStatusAdvances(current, 'overdue')) {
    console.info(
      `[Stripe] overdue -- ${invoiceType} for workspace ${workspaceId} is ` +
        `already ${current}; not regressing it`
    );
    return 'superseded';
  }

  await updateWorkspace(
    supabase,
    workspaceId,
    invoiceType === 'deposit'
      ? { deposit_status: 'overdue', outstanding_payment: true }
      : { final_status: 'overdue', outstanding_payment: true },
    `${invoiceType} overdue`
  );
  console.warn(
    `[Stripe] overdue -- ${invoiceType} for workspace ${workspaceId}`
  );
  return 'processed';
}

async function handleInvoicePaymentFailed(
  supabase: ServiceClient,
  event: Stripe.Event,
  incoming: Stripe.Invoice
): Promise<HandlerOutcome> {
  const ordered = await resolveOrdered({
    supabase,
    event,
    object: incoming,
    refetch: (id) => getStripe().invoices.retrieve(id),
  });
  if (ordered.verdict === 'stale') return 'superseded';
  const invoice = ordered.object;

  const workspaceId = workspaceIdFromMetadata(invoice.metadata);
  if (!workspaceId) return 'ignored';

  const workspace = await loadWorkspaceMoneyState(supabase, workspaceId);
  if (!workspace) return 'ignored';

  // A failed attempt on an invoice that has since settled is history, not a
  // debt: flagging the workspace outstanding over it would put a paid client
  // back in the chase queue.
  const invoiceType = invoice.metadata?.invoiceType;
  const settled =
    (invoiceType === 'deposit' && workspace.deposit_status === 'paid') ||
    (invoiceType === 'final' && workspace.final_status === 'paid');
  if (settled) {
    console.info(
      `[Stripe] payment_failed for workspace ${workspaceId} on an already ` +
        `paid ${invoiceType} invoice; ignoring`
    );
    return 'superseded';
  }

  await updateWorkspace(
    supabase,
    workspaceId,
    { outstanding_payment: true },
    'payment failed'
  );
  console.warn(`[Stripe] payment_failed for workspace ${workspaceId}`);
  return 'processed';
}

async function handleSubscriptionEvent(
  supabase: ServiceClient,
  event: Stripe.Event,
  incoming: Stripe.Subscription
): Promise<HandlerOutcome> {
  const ordered = await resolveOrdered({
    supabase,
    event,
    object: incoming,
    refetch: (id) => getStripe().subscriptions.retrieve(id),
  });
  if (ordered.verdict === 'stale') return 'superseded';
  const subscription = ordered.object;

  const workspaceId = workspaceIdFromMetadata(subscription.metadata);
  if (!workspaceId) return 'ignored';

  const workspace = await loadWorkspaceMoneyState(supabase, workspaceId);
  if (!workspace) return 'ignored';

  const status = mapSubscriptionStatus(subscription.status);
  const periodEnd = subscription.items?.data?.[0]?.current_period_end ?? null;
  const nextBilling = periodEnd
    ? new Date(periodEnd * 1000).toISOString()
    : null;

  if (
    !carePlanTransitionAllowed({
      from: workspace.subscription_status,
      to: status,
      storedSubscriptionId: workspace.stripe_subscription_id,
      eventSubscriptionId: subscription.id,
    })
  ) {
    console.warn(
      `[Stripe] subscription ${subscription.id} -> ${status} refused for ` +
        `workspace ${workspaceId}: not a transition Stripe's lifecycle makes ` +
        `from ${workspace.subscription_status}`
    );
    return 'superseded';
  }

  // The second ordering signal, for the case where two events genuinely share
  // a created second and the re-fetch above was not reached (no object id, or
  // the same subscription seen through a different event): a billing period
  // never moves backwards.
  const storedPeriodEnd = workspace.subscription_next_billing
    ? Math.floor(new Date(workspace.subscription_next_billing).getTime() / 1000)
    : null;
  if (
    workspace.stripe_subscription_id === subscription.id &&
    !periodEndIsCurrent({
      candidatePeriodEnd: periodEnd,
      storedPeriodEnd,
    })
  ) {
    console.warn(
      `[Stripe] subscription ${subscription.id} carries an older billing ` +
        `period than workspace ${workspaceId} already holds; refusing`
    );
    return 'superseded';
  }

  await updateWorkspace(
    supabase,
    workspaceId,
    {
      subscription_status: status,
      stripe_subscription_id: subscription.id,
      subscription_next_billing: nextBilling,
      outstanding_payment: subscription.status === 'past_due',
    },
    'subscription state'
  );

  console.info(
    `[Stripe] subscription ${subscription.id} -> ${status} for workspace ${workspaceId}`
  );
  return 'processed';
}

/**
 * The `discovery_leads` table is not in the generated types yet, so it is
 * reached through this narrow accessor rather than a blanket `any`. The shape
 * declared here is the shape the handler actually uses — and, now, includes
 * the `{ error }` that the previous loose type omitted, which is precisely why
 * a failed lead write used to be invisible.
 */
interface LeadsTable {
  update: (values: Record<string, unknown>) => {
    eq: (
      column: string,
      value: string
    ) => Promise<{ error: { message: string } | null }>;
  };
  select: (columns: string) => {
    eq: (
      column: string,
      value: string
    ) => {
      maybeSingle: () => Promise<{
        data: { project_id: string | null } | null;
        error: { message: string } | null;
      }>;
    };
  };
}

/**
 * Booking deposit paid by a prospect at the end of the discovery wizard
 * (Checkout Session, metadata.kind === 'booking_deposit'). No prospect table
 * exists — Stripe is the record of truth; we just notify the team so the
 * call can be confirmed and the deposit tracked manually.
 *
 * The lead write and the workspace auto-create used to sit inside one
 * `try/catch` that logged and carried on, so a prospect could pay €150 and
 * appear nowhere. They now throw, the route answers 500, and Stripe retries
 * until the lead is marked paid. The notification email stays best-effort and
 * still cannot fail the webhook: it runs after the writes, so a retry that
 * gets through sends exactly one.
 */
async function handleBookingDepositPaid(
  supabase: ServiceClient,
  session: Stripe.Checkout.Session
): Promise<HandlerOutcome> {
  const m = session.metadata ?? {};
  if (m['kind'] !== 'booking_deposit') return 'ignored';

  const leadId = m['leadId'];
  if (leadId) {
    const leads = (
      supabase as unknown as { from: (table: string) => LeadsTable }
    ).from('discovery_leads');

    const amountEur =
      typeof session.amount_total === 'number'
        ? Math.round(session.amount_total / 100)
        : m['amountEur']
        ? Number(m['amountEur'])
        : null;

    const paid = await leads
      .update({
        deposit_status: 'paid',
        deposit_amount_eur: amountEur,
        stripe_session_id: session.id,
        deposit_paid_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      })
      .eq('id', leadId);
    if (paid.error) {
      throw new Error(
        `[Stripe] could not mark lead ${leadId} paid: ${paid.error.message}`
      );
    }

    // Auto-create the project on deposit paid — idempotent: only if this
    // lead has no linked workspace yet (Stripe redelivers events). Lands
    // at concierge_stage 'intake' (pre-discovery), same as the manual
    // team draft flow; the team advances it after the call.
    const existing = await leads
      .select('project_id')
      .eq('id', leadId)
      .maybeSingle();
    if (existing.error) {
      throw new Error(
        `[Stripe] could not read lead ${leadId}: ${existing.error.message}`
      );
    }
    if (!existing.data?.project_id) {
      const tier = m['tier'] || '';
      const businessName = m['businessName'] || '';
      const name =
        businessName ||
        (m['name'] ? `${m['name']}'s Project` : 'Untitled Project');
      const slug =
        (name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, '-')
          .replace(/^-+|-+$/g, '')
          .slice(0, 40) || 'workspace') +
        '-' +
        Math.random().toString(36).slice(2, 8);

      const { data: ws, error: wsErr } = await supabase
        .from('workspaces')
        .insert({
          slug,
          name,
          site_kind: tier === 'commerce' ? 'shopify_liquid' : 'astro',
          client_name: m['name'] || null,
          client_email: m['email'] || null,
          client_business_name: businessName || null,
          concierge_stage: 'intake',
        })
        .select('id')
        .single();

      if (wsErr || !ws?.id) {
        throw new Error(
          `[Stripe] could not auto-create the workspace for lead ${leadId}: ` +
            (wsErr?.message ?? 'no row returned')
        );
      }
      const linked = await leads
        .update({ project_id: ws.id, updated_at: new Date().toISOString() })
        .eq('id', leadId);
      if (linked.error) {
        throw new Error(
          `[Stripe] workspace ${ws.id} was created for lead ${leadId} but the ` +
            `lead could not be linked to it: ${linked.error.message}`
        );
      }
      console.info(
        `[Stripe] deposit lead ${leadId} → workspace ${ws.id} (intake)`
      );
    }
  }

  const notifyTo =
    process.env.DISCOVERY_LEAD_NOTIFY_EMAIL || 'hello@flowstarter.net';
  const amount =
    typeof session.amount_total === 'number'
      ? `€${(session.amount_total / 100).toFixed(0)}`
      : m['amountEur']
      ? `€${m['amountEur']}`
      : 'unknown';

  try {
    await sendEmail({
      to: notifyTo,
      subject: `Deposit paid: ${m['name'] || 'prospect'} (${
        m['tier']
      }) ${amount}`,
      replyTo: m['email'] || undefined,
      html: `
<div style="font-family:system-ui,sans-serif;max-width:560px;margin:0 auto;padding:20px;">
  <h2 style="font-size:17px;margin:0 0 12px;">Booking deposit paid</h2>
  <p style="font-size:14px;color:#374151;margin:0 0 4px;">
    <strong>${
      m['name'] || ''
    }</strong> paid <strong>${amount}</strong> to hold a discovery call.
  </p>
  <table style="border-collapse:collapse;font-size:13px;color:#111827;margin-top:12px;">
    <tr><td style="padding:3px 10px;color:#6b7280;">Email</td><td style="padding:3px 10px;">${
      m['email'] || ''
    }</td></tr>
    <tr><td style="padding:3px 10px;color:#6b7280;">Business</td><td style="padding:3px 10px;">${
      m['businessName'] || ''
    }</td></tr>
    <tr><td style="padding:3px 10px;color:#6b7280;">Build tier</td><td style="padding:3px 10px;">${
      m['tier'] || ''
    }</td></tr>
    <tr><td style="padding:3px 10px;color:#6b7280;">Monthly plan</td><td style="padding:3px 10px;">${
      m['subscription'] || '–'
    }</td></tr>
    <tr><td style="padding:3px 10px;color:#6b7280;">Source</td><td style="padding:3px 10px;">${
      m['source'] || ''
    }</td></tr>
    <tr><td style="padding:3px 10px;color:#6b7280;">Stripe session</td><td style="padding:3px 10px;">${
      session.id
    }</td></tr>
  </table>
  <p style="font-size:12px;color:#6b7280;margin-top:14px;">
    Refundable after the call, before any build work starts. Refund from the Stripe dashboard if they don't proceed.
  </p>
</div>`,
    });
  } catch (err) {
    console.error('[Stripe] booking-deposit notify failed', err);
  }

  console.info(
    `[Stripe] booking deposit paid: ${m['email']} ${m['tier']} ${amount} (${session.id})`
  );
  return 'processed';
}

/**
 * The event switch, with every branch reporting what it did.
 *
 * It returns an outcome instead of returning nothing and hoping: the caller
 * writes that outcome to the ledger, and "ignored" is the only way an event
 * this app does not act on can be acknowledged. Anything that throws here has
 * already been decided to be worth retrying.
 */
async function processEvent(
  supabase: ServiceClient,
  event: Stripe.Event
): Promise<HandlerOutcome> {
  switch (event.type) {
    case 'payment_intent.succeeded': {
      const paymentIntent = event.data.object as Stripe.PaymentIntent;
      // Two deposit shapes, told apart by metadata.kind. Each handler returns
      // null for the other's events, so both can run without either seeing
      // payments that are not its own.
      const deposit = await enqueueFullBuildFromDeposit(event, paymentIntent);
      const guest = await provisionGuestDeposit(event, paymentIntent);
      if (guest) {
        // No email address and no password: this line goes to a log an
        // operator reads over somebody's shoulder.
        console.info(
          `[Stripe] guest deposit provisioned workspace ${guest.workspaceId} ` +
            `(account ${guest.accountKind}, build ${guest.jobId})` +
            (guest.alreadyProvisioned ? ' (redelivery)' : '') +
            (guest.emailed || guest.alreadyProvisioned
              ? ''
              : ' -- WELCOME EMAIL FAILED, client cannot sign in')
        );
      }
      return deposit || guest ? 'processed' : 'ignored';
    }
    case 'invoice.payment_succeeded':
      return handleInvoicePaymentSucceeded(
        supabase,
        event,
        event.data.object as Stripe.Invoice
      );
    case 'invoice.payment_failed':
      return handleInvoicePaymentFailed(
        supabase,
        event,
        event.data.object as Stripe.Invoice
      );
    case 'invoice.overdue':
      return handleInvoiceOverdue(
        supabase,
        event,
        event.data.object as Stripe.Invoice
      );
    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted':
      return handleSubscriptionEvent(
        supabase,
        event,
        event.data.object as Stripe.Subscription
      );
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      if (session.metadata?.['kind'] === CHANGE_REQUEST_CHECKOUT_KIND) {
        const settled = await settleChangeRequestCheckout(session);
        console.info(
          `[Stripe] change request ${settled.changeRequestId} ${settled.outcome} (${session.id})`
        );
        // `already_paid` is a redelivery the request row itself caught, and
        // `unpaid` / `unknown` are sessions there is nothing to do for. Only a
        // settlement that moved the row is a state write.
        return settled.outcome === 'paid' ? 'processed' : 'ignored';
      }
      return handleBookingDepositPaid(supabase, session);
    }
    default:
      return 'ignored';
  }
}

export async function POST(request: NextRequest): Promise<NextResponse> {
  const webhookSecret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!webhookSecret)
    return NextResponse.json(
      { error: 'Webhook not configured' },
      { status: 500 }
    );

  const payload = await request.text();
  const signature = request.headers.get('stripe-signature') ?? '';

  let event: Stripe.Event;
  try {
    event = getStripe().webhooks.constructEvent(
      payload,
      signature,
      webhookSecret
    );
  } catch {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 });
  }

  const supabase = createSupabaseServiceRoleClient();

  // Before anything is processed. If the ledger is unreachable we cannot
  // promise this event will not be processed twice, so we do not process it at
  // all and let Stripe bring it back.
  let claim;
  try {
    claim = await claimStripeEvent(supabase, event);
  } catch (err) {
    console.error(
      `[Stripe Webhook] could not record event ${event.id} (${event.type}):`,
      err
    );
    return NextResponse.json(
      { error: 'Event ledger unavailable' },
      { status: 500 }
    );
  }

  if (claim.alreadyProcessed) {
    console.info(
      `[Stripe] ${event.type} ${event.id} was already processed ` +
        `(${claim.previousOutcome}); acknowledging delivery ${claim.attempts}`
    );
    return NextResponse.json({ received: true, duplicate: true });
  }

  let outcome: HandlerOutcome;
  try {
    outcome = await processEvent(supabase, event);
  } catch (err) {
    console.error(`[Stripe Webhook] Error handling ${event.type}:`, err);
    await markStripeEventFailed(supabase, {
      eventId: event.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return NextResponse.json({ error: 'Handler failed' }, { status: 500 });
  }

  try {
    await finishStripeEvent(supabase, { eventId: event.id, outcome });
  } catch (err) {
    // The handler's state did land; only the acknowledgement did not. 500 is
    // still right: Stripe redelivers, the row is still unprocessed, and every
    // handler above converges on a second run rather than double-charging or
    // double-building.
    console.error(
      `[Stripe Webhook] ${event.type} ${event.id} was processed but could ` +
        'not be marked processed:',
      err
    );
    return NextResponse.json(
      { error: 'Event ledger unavailable' },
      { status: 500 }
    );
  }

  return NextResponse.json({ received: true });
}

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ error: 'Method not allowed' }, { status: 405 });
}
