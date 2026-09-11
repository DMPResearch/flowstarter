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
 * 500 is a webhook Cal.com will send again.
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import type { Database, Json } from '@/lib/database.types';
import type { BookingRow } from './bookings';
import {
  bookingWriteAction,
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
 * Apply one verified Cal.com delivery to the table.
 *
 * Never throws. A webhook handler that throws makes Cal.com retry, and a retry
 * of a delivery that already landed is the failure this whole module exists to
 * avoid, so a write that fails comes back as a skip and a log line.
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

  const { data: existing, error: readError } = await supabase
    .from('workspace_bookings')
    .select('id, status')
    .eq('workspace_id', workspaceId)
    .eq('provider', 'cal.com')
    .eq('external_uid', event.uid)
    .maybeSingle();
  if (readError) {
    console.error(
      `[cal] could not read booking ${event.uid} for workspace ${workspaceId}: ${readError.message}`
    );
    return {
      action: { kind: 'skip', reason: 'replayed' },
      externalUid: event.uid,
    };
  }

  const action = bookingWriteAction(
    existing ? (existing.status as BookingStatus) : null,
    event.status
  );
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
    payload: (input.payload ?? {}) as Json,
    updated_at: new Date().toISOString(),
  };

  if (action.kind === 'update' && existing) {
    const { error } = await supabase
      .from('workspace_bookings')
      .update(values)
      .eq('id', existing.id)
      .eq('workspace_id', workspaceId);
    if (error) {
      console.error(
        `[cal] could not update booking ${event.uid} for workspace ${workspaceId}: ${error.message}`
      );
      return {
        action: { kind: 'skip', reason: 'replayed' },
        externalUid: event.uid,
      };
    }
    return { action, externalUid: event.uid };
  }

  const { error } = await supabase.from('workspace_bookings').insert({
    workspace_id: workspaceId,
    provider: 'cal.com',
    external_uid: event.uid,
    ...values,
  });
  if (error) {
    // Two copies of the same delivery, handled at once. The index did the job
    // the read could not, and the second copy is a no-op, not a failure.
    if ((error as { code?: string }).code === UNIQUE_VIOLATION) {
      return {
        action: { kind: 'skip', reason: 'replayed' },
        externalUid: event.uid,
      };
    }
    console.error(
      `[cal] could not record booking ${event.uid} for workspace ${workspaceId}: ${error.message}`
    );
    return {
      action: { kind: 'skip', reason: 'replayed' },
      externalUid: event.uid,
    };
  }

  return { action, externalUid: event.uid };
}
