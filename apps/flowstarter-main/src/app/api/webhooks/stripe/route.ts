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
  casUpdateWorkspaceMoneyState,
  loadWorkspaceMoneyState,
} from '@/lib/billing/workspace-money-write';
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

export type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

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
export type HandlerOutcome = 'processed' | 'ignored' | 'superseded';

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
    // Monotonic: a redelivery, a late duplicate, or a concurrent write that
    // already applied this must not rewrite the moment the money landed —
    // `decide` reruns against fresh state on a version conflict and returns
    // null once that is true, rather than this call assuming its own first
    // read still holds. Either way this must still reach the enqueue below,
    // which is the half that was missing when the lifecycle stalled.
    await casUpdateWorkspaceMoneyState(
      supabase,
      workspaceId,
      'deposit paid',
      workspace,
      (state) =>
        paymentStatusAdvances(state.deposit_status, 'paid')
          ? {
              deposit_status: 'paid',
              deposit_paid_at: now,
              outstanding_payment: false,
            }
          : null
    );

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
    await casUpdateWorkspaceMoneyState(
      supabase,
      workspaceId,
      'final paid',
      workspace,
      (state) =>
        paymentStatusAdvances(state.final_status, 'paid')
          ? {
              final_status: 'paid',
              final_paid_at: now,
              outstanding_payment: false,
            }
          : null
    );
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

  // The sequence this guards is real and unremarkable: Stripe marks an invoice
  // overdue, the client pays it minutes later, and the two events arrive in
  // the wrong order — or arrive concurrently and race each other's write.
  // Paid is terminal, so the overdue is dropped whichever way that happens:
  // `decide` reads the current status fresh on every attempt, including the
  // reread after a version conflict, rather than trusting the status this
  // call originally loaded.
  const wrote = await casUpdateWorkspaceMoneyState(
    supabase,
    workspaceId,
    `${invoiceType} overdue`,
    workspace,
    (state) => {
      const current =
        invoiceType === 'deposit' ? state.deposit_status : state.final_status;
      if (!paymentStatusAdvances(current, 'overdue')) return null;
      return invoiceType === 'deposit'
        ? { deposit_status: 'overdue', outstanding_payment: true }
        : { final_status: 'overdue', outstanding_payment: true };
    }
  );
  if (!wrote) {
    console.info(
      `[Stripe] overdue -- ${invoiceType} for workspace ${workspaceId} is ` +
        `already settled or newer; not regressing it`
    );
    return 'superseded';
  }
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
  // back in the chase queue. Rechecked against fresh state on a version
  // conflict, so a payment that settled concurrently with this delivery is
  // still caught even though this call's own read predates it.
  const invoiceType = invoice.metadata?.invoiceType;
  const wrote = await casUpdateWorkspaceMoneyState(
    supabase,
    workspaceId,
    'payment failed',
    workspace,
    (state) => {
      const settled =
        (invoiceType === 'deposit' && state.deposit_status === 'paid') ||
        (invoiceType === 'final' && state.final_status === 'paid');
      return settled ? null : { outstanding_payment: true };
    }
  );
  if (!wrote) {
    console.info(
      `[Stripe] payment_failed for workspace ${workspaceId} on an already ` +
        `paid ${invoiceType} invoice; ignoring`
    );
    return 'superseded';
  }
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

  // Both transition checks below are re-run inside `decide` against
  // whatever state is current at write time — including the reread after a
  // version conflict — rather than only against `workspace` as first read.
  // That is what lets two subscription events for the same object converge
  // on the same result regardless of which one's write reaches Postgres
  // first: whichever finishes second sees the first one's already-applied
  // state here, not its own stale snapshot.
  const wrote = await casUpdateWorkspaceMoneyState(
    supabase,
    workspaceId,
    'subscription state',
    workspace,
    (state) => {
      if (
        !carePlanTransitionAllowed({
          from: state.subscription_status,
          to: status,
          storedSubscriptionId: state.stripe_subscription_id,
          eventSubscriptionId: subscription.id,
        })
      ) {
        return null;
      }

      // The second ordering signal, for the case where two events genuinely
      // share a created second and the re-fetch above was not reached (no
      // object id, or the same subscription seen through a different
      // event): a billing period never moves backwards.
      const storedPeriodEnd = state.subscription_next_billing
        ? Math.floor(new Date(state.subscription_next_billing).getTime() / 1000)
        : null;
      if (
        state.stripe_subscription_id === subscription.id &&
        !periodEndIsCurrent({
          candidatePeriodEnd: periodEnd,
          storedPeriodEnd,
        })
      ) {
        return null;
      }

      return {
        subscription_status: status,
        stripe_subscription_id: subscription.id,
        subscription_next_billing: nextBilling,
        outstanding_payment: subscription.status === 'past_due',
      };
    }
  );

  if (!wrote) {
    console.warn(
      `[Stripe] subscription ${subscription.id} -> ${status} refused for ` +
        `workspace ${workspaceId}: not a transition Stripe's lifecycle makes, ` +
        `or an older billing period than what is already stored`
    );
    return 'superseded';
  }

  console.info(
    `[Stripe] subscription ${subscription.id} -> ${status} for workspace ${workspaceId}`
  );
  return 'processed';
}

/*
 * `handleBookingDepositPaid` stood here, with the `LeadsTable` accessor it
 * needed. It settled a Checkout Session carrying `metadata.kind ===
 * 'booking_deposit'`: the pre-call deposit that `/api/discovery/deposit`
 * created. Both are gone (2026-09-14). The discovery call is free, it is
 * booked on the self-hosted Cal.com through `/discovery-call`, and no code
 * path can mint a session of that kind any more, so the handler could only
 * ever have run for a session that cannot exist.
 *
 * The 20% BUILD deposit is untouched and is a different thing entirely: it
 * arrives as `flowstarter_guest_deposit` and is settled by
 * `provisionGuestDeposit` (`lib/flowstarter/guest-deposit.ts`), reached from
 * `verifyDepositAndEnqueue` rather than from here.
 */
/**
 * The event switch, with every branch reporting what it did.
 *
 * It returns an outcome instead of returning nothing and hoping: the caller
 * writes that outcome to the ledger, and "ignored" is the only way an event
 * this app does not act on can be acknowledged. Anything that throws here has
 * already been decided to be worth retrying.
 */
/**
 * Exported so tests can drive the ordering/money-state machinery with
 * synthetic events and a fake service client directly, the way `POST`
 * itself does after signature verification and the ledger claim — without
 * needing a real Stripe signature or a real webhook secret to reach it.
 */
export async function processEvent(
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
      // Every other `checkout.session.completed` belongs to somebody else:
      // the guest build deposit is settled by `verifyDepositAndEnqueue` off
      // its own success redirect, not here. Recorded as ignored rather than
      // left to fall out of the switch, so the `stripe_events` ledger says
      // what happened instead of nothing.
      console.info(`[Stripe] checkout session not ours: ${session.id}`);
      return 'ignored';
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
