import 'server-only';
/**
 * Reading and writing `workspace_bookings`.
 *
 * TENANCY. Same rule as `site-overview-data.ts`: every query here runs on the
 * service-role client, which bypasses RLS, so the `workspace_id` filter is the
 * whole of the isolation. There is no unfiltered read or write in this module
 * and there must never be one. The webhook route gets its workspace id from
 * the URL and proves it owns the signing secret before calling in here; the
 * dashboard gets its id from `requireWorkspaceAccess`.
 *
 * WRITES ARE IDEMPOTENT. `bookingWriteAction` in `cal-webhook.ts` decides
 * whether a delivery inserts, updates or does nothing, and the unique index on
 * (workspace_id, provider, external_uid) is the backstop for the case the
 * decision cannot see: two copies of the same delivery arriving at once. When
 * the index wins the race, the insert comes back as a duplicate and this
 * module reports a skip rather than an error, because a webhook that returns
 * 500 for a delivery that already landed is a webhook Cal.com will needlessly
 * send again.
 *
 * A GENUINE DATABASE FAILURE IS NOT A SKIP. Only the unique-violation race
 * above, and an exact-replay `bookingWriteAction` decision, are "nothing to
 * do". A failed read, a failed update, or an insert that failed for any other
 * reason means this delivery's booking state was never durably written, and
 * `recordCalBooking` throws rather than returning a skip — the caller (the
 * webhook route) turns that into a 500 so Cal.com retries. Swallowing it as
 * `{ kind: 'skip', reason: 'replayed' }`, as this module used to, would tell
 * Cal.com "handled" for a delivery that was actually lost.
 *
 * THE WRITE IS A COMPARE-AND-SET, NOT A READ-THEN-WRITE. Reading the row,
 * deciding an action from it, and writing unconditionally afterward leaves a
 * gap: a concurrent delivery can write between this function's read and its
 * write, and this function's write would then land on top of it with no idea
 * that had happened. The update below is conditioned on the row's
 * `event_marker` still being older than this delivery's — `bookingWriteAction`
 * decided that much was true when it read the row, but only the database
 * update itself, not that earlier read, can make it true atomically. A
 * conditioned update that matches zero rows means a concurrent write already
 * moved the marker; this function rereads and lets `bookingWriteAction`
 * decide again from what is now actually stored, rather than assuming its
 * own stale decision still applies. The same reread-and-reevaluate happens on
 * an insert's unique-violation race, which used to be treated as an
 * automatic replay even when the competing delivery represented a genuinely
 * different transition (e.g. a create losing a race against a cancellation
 * for the same brand-new uid) — that silently dropped the transition that
 * lost the race instead of applying it.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import type { BookingRow } from './bookings';
import {
  bookingWriteAction,
  type BookingSnapshot,
  type BookingStatus,
  type BookingWriteAction,
  type CalBookingEvent,
} from './cal-webhook';

type SupabaseServiceClient = SupabaseClient<Database>;

/** Postgres unique violation. The one insert error that is not a failure. */
const UNIQUE_VIOLATION = '23505';

type RawBooking = {
  id: string;
  external_uid: string;
  event_type_slug: string | null;
  title: string | null;
  start_at: string | null;
  end_at: string | null;
  attendee_name: string | null;
  attendee_email: string | null;
  status: string;
  created_at: string;
};

function toBookingRow(row: RawBooking): BookingRow {
  return {
    id: row.id,
    externalUid: row.external_uid,
    eventTypeSlug: row.event_type_slug,
    title: row.title,
    startAt: row.start_at,
    endAt: row.end_at,
    attendeeName: row.attendee_name,
    attendeeEmail: row.attendee_email,
    // The column has a check constraint, so anything else is impossible; the
    // cast is narrowing a `string` the generated types cannot narrow for us.
    status: row.status as BookingStatus,
    createdAt: row.created_at,
  };
}

/** Every booking for one workspace, newest row first, for the list page. */
export async function listWorkspaceBookings(
  supabase: SupabaseServiceClient,
  workspaceId: string,
  limit = 200
): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from('workspace_bookings')
    .select(
      'id, external_uid, event_type_slug, title, start_at, end_at, attendee_name, attendee_email, status, created_at'
    )
    .eq('workspace_id', workspaceId)
    .order('start_at', { ascending: false, nullsFirst: false })
    .limit(limit);
  if (error) {
    console.error(
      `[cal] could not list bookings for workspace ${workspaceId}: ${error.message}`
    );
    return [];
  }
  return ((data ?? []) as RawBooking[]).map(toBookingRow);
}

/**
 * The rows the tile counts.
 *
 * Narrower than the list on purpose: three numbers need a status and a start
 * time, and the dashboard already carries a client's messages and their
 * invoice without also carrying every attendee's email address.
 */
export async function loadBookingRowsForSummary(
  supabase: SupabaseServiceClient,
  workspaceId: string
): Promise<BookingRow[]> {
  const { data, error } = await supabase
    .from('workspace_bookings')
    .select('id, external_uid, status, start_at, created_at')
    .eq('workspace_id', workspaceId);
  if (error) return [];
  return (
    (data ?? []) as Array<
      Pick<
        RawBooking,
        'id' | 'external_uid' | 'status' | 'start_at' | 'created_at'
      >
    >
  ).map((row) => ({
    id: row.id,
    externalUid: row.external_uid,
    eventTypeSlug: null,
    title: null,
    startAt: row.start_at,
    endAt: null,
    attendeeName: null,
    attendeeEmail: null,
    status: row.status as BookingStatus,
    createdAt: row.created_at,
  }));
}

export interface RecordedBooking {
  action: BookingWriteAction;
  /** Cal.com's uid, echoed so the caller can key an email on it. */
  externalUid: string;
}

/**
 * Bounds the read-decide-write retry loop in `recordCalBooking`. Each retry
 * is a genuine concurrent write landing between this function's read and its
 * own write — real, but rare enough that converging in a handful of rounds
 * is the expected case, not the edge case. A delivery that cannot converge
 * in this many rounds is treated as a failure so Cal.com retries the whole
 * delivery, rather than looping indefinitely against a booking under
 * sustained concurrent write pressure.
 */
const MAX_WRITE_ATTEMPTS = 5;

/**
 * Apply one verified Cal.com delivery to the table.
 *
 * Throws on a genuine database failure (a failed read, a failed update, or an
 * insert failure that is not the expected duplicate-delivery race) so the
 * caller can turn that into a 500 and let Cal.com retry a delivery that was
 * never durably recorded. The one thing this function does swallow is the
 * unique-index race on a duplicate insert being a genuine replay after
 * rereading and reevaluating it — see the module doc comment above.
 */
export async function recordCalBooking(
  supabase: SupabaseServiceClient,
  input: {
    workspaceId: string;
    event: CalBookingEvent;
    /** The delivery body verbatim, kept for an operator to read. */
    payload: unknown;
  }
): Promise<RecordedBooking> {
  const { workspaceId, event } = input;
  const incoming: BookingSnapshot = {
    status: event.status,
    startAt: event.startAt,
    endAt: event.endAt,
    eventMarker: event.eventMarker,
  };

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const { data: existing, error: readError } = await supabase
      .from('workspace_bookings')
      .select('id, status, start_at, end_at, event_marker')
      .eq('workspace_id', workspaceId)
      .eq('provider', 'cal.com')
      .eq('external_uid', event.uid)
      .maybeSingle();
    if (readError) {
      throw new Error(
        `[cal] could not read booking ${event.uid} for workspace ${workspaceId}: ${readError.message}`
      );
    }

    const existingSnapshot: BookingSnapshot | null = existing
      ? {
          status: existing.status as BookingStatus,
          startAt: existing.start_at,
          endAt: existing.end_at,
          eventMarker: existing.event_marker,
        }
      : null;

    const action = bookingWriteAction(existingSnapshot, incoming);
    if (action.kind === 'skip') {
      return { action, externalUid: event.uid };
    }

    const values = {
      event_type_slug: event.eventTypeSlug,
      title: event.title,
      start_at: event.startAt,
      end_at: event.endAt,
      attendee_name: event.attendeeName,
      attendee_email: event.attendeeEmail,
      status: event.status,
      event_marker: event.eventMarker,
      payload: (input.payload ?? {}) as Json,
      updated_at: new Date().toISOString(),
    };

    if (action.kind === 'update' && existing) {
      // Compare-and-set: the predicate is what makes this atomic — the
      // `bookingWriteAction` decision above only used a snapshot that may
      // already be stale by the time this runs.
      const { data: updated, error } = await supabase
        .from('workspace_bookings')
        .update(values)
        .eq('id', existing.id)
        .eq('workspace_id', workspaceId)
        .lt('event_marker', event.eventMarker)
        .select('id');
      if (error) {
        throw new Error(
          `[cal] could not update booking ${event.uid} for workspace ${workspaceId}: ${error.message}`
        );
      }
      if (updated && updated.length > 0) {
        return { action, externalUid: event.uid };
      }
      // Lost the race: a concurrent delivery already moved `event_marker` to
      // (or past) this one's between the read above and this update. Reread
      // and let the loop recompute the right action against what is now
      // actually stored, instead of assuming this delivery's decision still
      // holds.
      continue;
    }

    const { error } = await supabase.from('workspace_bookings').insert({
      workspace_id: workspaceId,
      provider: 'cal.com',
      external_uid: event.uid,
      ...values,
    });
    if (error) {
      if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
        // Two copies of the same delivery, or two different deliveries for
        // the same brand-new uid, landed at once. Either way, the row that
        // exists now might not be the one `bookingWriteAction` decided
        // against above — reread and let it decide again, rather than
        // labelling this a replay just because an insert lost a race.
        continue;
      }
      throw new Error(
        `[cal] could not record booking ${event.uid} for workspace ${workspaceId}: ${error.message}`
      );
    }
    return { action, externalUid: event.uid };
  }

  throw new Error(
    `[cal] could not converge on a write for booking ${event.uid} in workspace ${workspaceId} after ${MAX_WRITE_ATTEMPTS} attempts`
  );
}
