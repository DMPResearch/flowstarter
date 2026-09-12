/**
 * The rules that decide whether a Stripe event is allowed to move money state.
 *
 * Pure functions, no Stripe client and no database: what is safe to write is a
 * decision, and a decision made in a function with no I/O is one a test can
 * pin down exhaustively. The webhook handlers read current state, ask these,
 * and write only what they answer yes to.
 *
 * They exist because Stripe delivers at least once and in no particular order.
 * Every rule here is the answer to one real sequence a live account produces:
 *
 *   payment_succeeded then a late overdue for the same invoice
 *     -> `paymentStatusAdvances('paid', 'overdue')` is false. Deposit paid and
 *        final paid are monotonic: once money has landed, no later event may
 *        walk the workspace back to unpaid, sent or overdue.
 *
 *   subscription.updated(active) delivered after subscription.deleted
 *     -> `carePlanTransitionAllowed('cancelled', 'active')` is false. A care
 *        plan follows Stripe's own subscription lifecycle; a cancelled plan is
 *        terminal for that subscription id.
 *
 *   checkout.session.completed for a request that was never accepted
 *     -> `changeRequestPaymentAllowed` defers to the change-request transition
 *        table, which lets Stripe move a request to paid only from accepted.
 *
 *   two events about one object in the same wall-clock second
 *     -> `orderingVerdict` answers 'refetch', because Stripe's `created` is
 *        second-granular and cannot order them. The caller asks Stripe what the
 *        object looks like now instead of guessing from the payload it holds.
 */
import type Stripe from 'stripe';
import { canTransition } from '@/lib/flowstarter/change-requests';

// ─── Invoice payment state ──────────────────────────────────────────────────

/**
 * The four values `workspaces.deposit_status` and `workspaces.final_status`
 * take, in lifecycle order. `paid` is the absorbing state.
 */
export const PAYMENT_STATUSES = ['unpaid', 'sent', 'overdue', 'paid'] as const;
export type PaymentStatus = (typeof PAYMENT_STATUSES)[number];

/**
 * May an event move this invoice's status from `current` to `next`?
 *
 * False for `next === current`, which is not a refusal so much as "there is
 * nothing to write" — the caller skips the update rather than rewriting a
 * paid_at timestamp with a later one on a redelivery.
 *
 * False for anything out of `paid`, which is the monotonicity the review asked
 * for: an `invoice.overdue` that Stripe generated before the payment but
 * delivered after it must not mark a settled invoice overdue, and a failed
 * payment attempt on an already-settled invoice must not reopen it.
 *
 * An unrecognised `current` (null on a fresh workspace, or a value some older
 * code wrote) is treated as "not paid": the event is allowed through, because
 * refusing to record a payment is the worse of the two failures.
 */
export function paymentStatusAdvances(
  current: string | null | undefined,
  next: PaymentStatus
): boolean {
  if (current === next) return false;
  if (current === 'paid') return false;
  return true;
}

// ─── Care plan (Stripe subscription) state ──────────────────────────────────

/**
 * Stripe's subscription statuses as this app stores them.
 *
 * `trialing` is stored as `trial` and `canceled` as `cancelled` — the spelling
 * the dashboard and the client UI have always used. The rest are Stripe's own
 * words, so an unmapped status never becomes an unreadable one.
 */
export const CARE_PLAN_STATUSES = [
  'incomplete',
  'incomplete_expired',
  'trial',
  'active',
  'past_due',
  'unpaid',
  'paused',
  'cancelled',
] as const;
export type CarePlanStatus = (typeof CARE_PLAN_STATUSES)[number];

const STRIPE_STATUS_MAP: Record<Stripe.Subscription.Status, CarePlanStatus> = {
  incomplete: 'incomplete',
  incomplete_expired: 'incomplete_expired',
  trialing: 'trial',
  active: 'active',
  past_due: 'past_due',
  unpaid: 'unpaid',
  paused: 'paused',
  canceled: 'cancelled',
};

/**
 * Stripe's word for a subscription's state, in this app's vocabulary.
 *
 * Anything Stripe adds later that is not in the map is passed through
 * unchanged rather than dropped or coerced: an operator reading
 * `subscription_status` should see what Stripe said, even when this code has
 * not been taught about it yet.
 */
export function mapSubscriptionStatus(status: string): string {
  return STRIPE_STATUS_MAP[status as Stripe.Subscription.Status] ?? status;
}

/**
 * Stripe's documented subscription lifecycle, in stored vocabulary.
 *
 * Read as "from -> the states Stripe can move it to next". A status missing
 * from the map is terminal, which is why `cancelled` and `incomplete_expired`
 * have no entry: Stripe never revives a subscription id out of either, so an
 * event claiming otherwise is a stale delivery, not news.
 */
const CARE_PLAN_LIFECYCLE: Partial<Record<CarePlanStatus, CarePlanStatus[]>> = {
  incomplete: ['trial', 'active', 'incomplete_expired', 'cancelled'],
  trial: ['active', 'past_due', 'unpaid', 'paused', 'cancelled'],
  active: ['past_due', 'unpaid', 'paused', 'cancelled'],
  past_due: ['active', 'unpaid', 'paused', 'cancelled'],
  unpaid: ['active', 'past_due', 'paused', 'cancelled'],
  paused: ['active', 'past_due', 'unpaid', 'cancelled'],
};

/**
 * May this workspace's care plan move from `from` to `to`?
 *
 * The rule is per subscription id, and the caller supplies both: a workspace
 * whose old plan was cancelled and which has since been sold a NEW
 * subscription is not making a lifecycle transition at all, it is starting a
 * second lifecycle, so any status is allowed when the ids differ. Only when
 * the event is about the subscription already on the workspace does the
 * lifecycle table apply.
 *
 * `from` unknown (null, empty, `none`, or a status this code has never stored)
 * means the workspace has no recorded plan state to contradict — allowed.
 *
 * `from === to` is allowed: a repeat of the state we already hold writes the
 * same row, and the refreshed `subscription_next_billing` that comes with it
 * is worth having.
 */
export function carePlanTransitionAllowed(input: {
  from: string | null | undefined;
  to: string;
  /** `workspaces.stripe_subscription_id` as currently stored. */
  storedSubscriptionId?: string | null;
  /** The subscription id the incoming event is about. */
  eventSubscriptionId?: string | null;
}): boolean {
  const { from, to, storedSubscriptionId, eventSubscriptionId } = input;
  if (
    storedSubscriptionId &&
    eventSubscriptionId &&
    storedSubscriptionId !== eventSubscriptionId
  ) {
    return true;
  }
  if (from === to) return true;
  const known = (CARE_PLAN_STATUSES as readonly string[]).includes(from ?? '');
  if (!known) return true;
  const next = CARE_PLAN_LIFECYCLE[from as CarePlanStatus];
  if (!next) return false;
  return next.includes(to as CarePlanStatus);
}

// ─── Change requests ────────────────────────────────────────────────────────

/**
 * May Stripe mark this change request paid?
 *
 * Deliberately delegates to the change-request transition table rather than
 * restating it: there is one list of who may move a request where, in
 * `lib/flowstarter/change-requests.ts`, and it already says that only an
 * `accepted` request may be moved to `paid`, and only by `stripe`. A second
 * copy of that fact here would be a second thing to keep true.
 */
export function changeRequestPaymentAllowed(status: string): boolean {
  return canTransition(status, 'paid', 'stripe');
}

// ─── Event ordering ─────────────────────────────────────────────────────────

/**
 * What to do with an event, given the newest event already applied to the same
 * Stripe object.
 *
 *   apply    — nothing newer has been applied; the payload in hand is current.
 *   stale    — something newer has been applied; applying this would regress.
 *   refetch  — the two are indistinguishable by `created`, which Stripe emits
 *              in whole seconds. Ask Stripe for the object's current state and
 *              apply that instead of picking one of two payloads at random.
 */
export type OrderingVerdict = 'apply' | 'stale' | 'refetch';

export function orderingVerdict(input: {
  /** `event.created`, unix seconds. */
  eventCreated: number;
  /** `created` of the newest processed event for this object, unix seconds. */
  latestAppliedCreated: number | null | undefined;
}): OrderingVerdict {
  const latest = input.latestAppliedCreated;
  if (latest === null || latest === undefined) return 'apply';
  if (input.eventCreated > latest) return 'apply';
  if (input.eventCreated < latest) return 'stale';
  return 'refetch';
}

/**
 * The second ordering signal for subscriptions, used when the object has been
 * re-fetched or when two payloads have to be compared directly.
 *
 * A subscription's billing period only ever moves forward, so a payload whose
 * `current_period_end` is behind the one already stored is behind, whatever
 * its event said. Returns true when `candidate` is at least as current as
 * `stored` — including when either is unknown, since an absent period end is
 * not evidence of staleness.
 */
export function periodEndIsCurrent(input: {
  candidatePeriodEnd: number | null | undefined;
  storedPeriodEnd: number | null | undefined;
}): boolean {
  const { candidatePeriodEnd, storedPeriodEnd } = input;
  if (candidatePeriodEnd === null || candidatePeriodEnd === undefined)
    return true;
  if (storedPeriodEnd === null || storedPeriodEnd === undefined) return true;
  return candidatePeriodEnd >= storedPeriodEnd;
}
