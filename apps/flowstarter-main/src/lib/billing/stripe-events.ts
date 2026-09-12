/**
 * The Stripe event ledger: the durable half of webhook processing.
 *
 * Stripe delivers at least once, in no guaranteed order, and reads HTTP 200 as
 * "never send this again". Everything in this file exists to make those three
 * facts survivable:
 *
 *   claimStripeEvent()   writes the event down BEFORE any handler runs, and
 *                        reports whether it has already been processed.
 *   latestAppliedCreated() answers "what is the newest event we have already
 *                        applied to this Stripe object", which is what turns
 *                        an out-of-order delivery from a silent regression
 *                        into a refusal.
 *   finishStripeEvent()  stamps the outcome, and only after the handler's own
 *                        writes have succeeded.
 *
 * Every function here throws on a database error rather than returning a flag.
 * That is the point: the route's job is to answer 500 when state did not land,
 * so Stripe retries. A swallowed ledger error would put us back where we
 * started — a 200 for work that never happened.
 *
 * The table is not tenant scoped; see the migration
 * `20260912163000_stripe_events.sql` for why, and
 * `scripts/verify-rls-local.mjs` for the proof that anon and authenticated
 * cannot read it.
 */
import 'server-only';
import type Stripe from 'stripe';
import { createSupabaseServiceRoleClient } from '@/supabase-clients/server';

type ServiceClient = ReturnType<typeof createSupabaseServiceRoleClient>;

/** What a finished event says about itself. Mirrors the CHECK constraint. */
export type StripeEventOutcome =
  | 'processed'
  | 'ignored'
  | 'superseded'
  | 'failed';

export interface StripeEventClaim {
  /** True when a previous delivery already finished this event. */
  alreadyProcessed: boolean;
  /** The outcome that previous delivery recorded, for the log line. */
  previousOutcome: StripeEventOutcome | null;
  /** How many times Stripe has now delivered this event id. */
  attempts: number;
}

/** Postgres unique-violation. A redelivery races itself into this. */
const UNIQUE_VIOLATION = '23505';

/**
 * `event.data.object.id`, when the payload has one.
 *
 * This is the key ordering is compared within: all of a subscription's events
 * share its `sub_...`, all of an invoice's share its `in_...`. An event whose
 * object carries no id (Stripe has a few) simply opts out of ordering, and is
 * still deduped by event id like everything else.
 */
export function stripeObjectId(event: Stripe.Event): string | null {
  const object = event.data?.object as { id?: unknown } | undefined;
  return typeof object?.id === 'string' && object.id.length > 0
    ? object.id
    : null;
}

/**
 * `event.created` as a timestamp, falling back to now.
 *
 * Stripe always sends `created`, so the fallback is not for Stripe: it is so
 * that a payload missing it cannot throw `RangeError: Invalid time value` out
 * of the very first thing the route does and turn a real payment into a 500
 * loop. An event with no `created` simply orders as "just now", which is the
 * most recent thing it could truthfully be.
 */
function eventCreatedAt(event: Stripe.Event): string {
  const seconds = event.created;
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) {
    return new Date().toISOString();
  }
  return new Date(seconds * 1000).toISOString();
}

/**
 * Record the event, and say whether it has already been dealt with.
 *
 * Three outcomes, and the route branches on exactly one of them:
 *
 *   fresh insert                  -> process it
 *   existing row, processed_at set-> redelivery; skip, answer 200
 *   existing row, processed_at null -> a previous attempt died before it
 *                                    finished. Stripe is retrying precisely
 *                                    because we never acknowledged it, so
 *                                    process it again and count the attempt.
 *
 * Deliberately not a lease. Two truly concurrent deliveries of the same event
 * would both see `processed_at` null and both run; the handlers below are each
 * written to converge (a status write is idempotent, the build enqueue is
 * guarded by unique constraints in `deposit-workflow.ts`, and the change
 * request settles only from `accepted`). A lock here would add a stuck-lease
 * failure mode to buy protection the handlers already have.
 */
export async function claimStripeEvent(
  supabase: ServiceClient,
  event: Stripe.Event
): Promise<StripeEventClaim> {
  const row = {
    id: event.id,
    type: event.type,
    created: eventCreatedAt(event),
    object_id: stripeObjectId(event),
  };

  const insert = await supabase.from('stripe_events').insert(row);
  if (!insert.error) {
    return { alreadyProcessed: false, previousOutcome: null, attempts: 1 };
  }
  if (insert.error.code !== UNIQUE_VIOLATION) throw insert.error;

  const existing = await supabase
    .from('stripe_events')
    .select('processed_at, outcome, attempts')
    .eq('id', event.id)
    .maybeSingle();
  if (existing.error) throw existing.error;

  // The row lost a race with its own insert and then vanished: treat it as
  // fresh rather than inventing a state for it.
  if (!existing.data) {
    return { alreadyProcessed: false, previousOutcome: null, attempts: 1 };
  }

  const attempts = (existing.data.attempts ?? 1) + 1;
  const bumped = await supabase
    .from('stripe_events')
    .update({ attempts })
    .eq('id', event.id);
  if (bumped.error) throw bumped.error;

  return {
    alreadyProcessed: Boolean(existing.data.processed_at),
    previousOutcome: (existing.data.outcome as StripeEventOutcome) ?? null,
    attempts,
  };
}

/**
 * `created` (unix seconds) of the newest event already applied to this Stripe
 * object, ignoring the event being processed right now.
 *
 * Only events that actually wrote state count — an `ignored` or `superseded`
 * row applied nothing, so letting it fence out a later event would strand the
 * object in whatever state preceded it.
 */
export async function latestAppliedCreated(
  supabase: ServiceClient,
  input: { objectId: string; excludeEventId: string }
): Promise<number | null> {
  const { data, error } = await supabase
    .from('stripe_events')
    .select('created')
    .eq('object_id', input.objectId)
    .eq('outcome', 'processed')
    .neq('id', input.excludeEventId)
    .order('created', { ascending: false })
    .limit(1);
  if (error) throw error;
  const newest = data?.[0]?.created;
  if (!newest) return null;
  return Math.floor(new Date(newest).getTime() / 1000);
}

/**
 * Stamp how the event ended.
 *
 * `processed`, `ignored` and `superseded` all set `processed_at`, because all
 * three are final: the event has been dealt with and a redelivery must not
 * re-run it. `failed` leaves `processed_at` null on purpose — the route is
 * about to answer 500, and the next delivery has to find an unprocessed row.
 */
export async function finishStripeEvent(
  supabase: ServiceClient,
  input: { eventId: string; outcome: StripeEventOutcome; error?: string }
): Promise<void> {
  const { error } = await supabase
    .from('stripe_events')
    .update({
      outcome: input.outcome,
      processed_at:
        input.outcome === 'failed' ? null : new Date().toISOString(),
      last_error: input.error ? input.error.slice(0, 500) : null,
    })
    .eq('id', input.eventId);
  if (error) throw error;
}

/**
 * Best-effort variant for the failure path.
 *
 * The route is already answering 500 because something went wrong; if the
 * database is what went wrong, recording "it went wrong" in that same database
 * will fail too. Losing the note is acceptable — the row stays unprocessed,
 * which is the part that matters — but losing the original error because this
 * threw over it is not.
 */
export async function markStripeEventFailed(
  supabase: ServiceClient,
  input: { eventId: string; error: string }
): Promise<void> {
  try {
    await finishStripeEvent(supabase, {
      eventId: input.eventId,
      outcome: 'failed',
      error: input.error,
    });
  } catch (err) {
    console.error(
      `[Stripe] could not record the failure of event ${input.eventId}:`,
      err
    );
  }
}
