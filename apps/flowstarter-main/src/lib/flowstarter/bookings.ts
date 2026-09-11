/**
 * What a pile of booking rows means, decided before anything renders it.
 *
 * Two consumers need the same arithmetic: the "Bookings" tile on the client's
 * project page wants three numbers, and the bookings list wants the same rows
 * in the order a person reads them. Doing that twice would be two chances to
 * disagree about whether a cancelled meeting counts, which is exactly the kind
 * of number a client would act on.
 *
 * So it happens once, here, from rows and a clock. Pure: no Supabase, no
 * `new Date()` without being handed one, so every rule below can be asserted
 * without a database and without waiting for a date to pass.
 *
 * THE ONE JUDGEMENT CALL. A cancelled booking is not upcoming and is not
 * counted, but it is still shown. A client who sees eight bookings and then
 * six people arrive has been told something false; a client who sees the two
 * cancellations greyed out under the list has been told the truth. Counting
 * and showing are different questions and this module answers them separately.
 */
import type { BookingStatus } from './cal-webhook';

export interface BookingRow {
  id: string;
  externalUid: string;
  eventTypeSlug: string | null;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
  status: BookingStatus;
  createdAt: string;
}

export interface BookingSummary {
  /** Not cancelled, and starting at or after now. */
  upcoming: number;
  /** The start of the soonest upcoming booking, ISO, or null. */
  nextAt: string | null;
  /** Not cancelled, and starting inside the last 30 days. */
  last30Days: number;
  /** Every booking ever recorded, cancellations included. */
  total: number;
}

const THIRTY_DAYS_MS = 30 * 24 * 60 * 60 * 1000;

/** Milliseconds since the epoch, or null when the row has no usable start. */
function startMs(row: BookingRow): number | null {
  if (!row.startAt) return null;
  const parsed = Date.parse(row.startAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * The three numbers the tile shows, plus the total under them.
 *
 * A booking with no start time is counted in `total` and nowhere else. It is a
 * real row, so hiding it from the total would make the ledger lie, but it
 * cannot be upcoming or recent when nothing knows when it is.
 */
export function summariseBookings(
  rows: readonly BookingRow[],
  now: Date
): BookingSummary {
  const nowMs = now.getTime();
  const windowStart = nowMs - THIRTY_DAYS_MS;

  let upcoming = 0;
  let last30Days = 0;
  let nextMs: number | null = null;
  let nextAt: string | null = null;

  for (const row of rows) {
    if (row.status === 'cancelled') continue;
    const start = startMs(row);
    if (start === null) continue;

    if (start >= nowMs) {
      upcoming += 1;
      if (nextMs === null || start < nextMs) {
        nextMs = start;
        nextAt = row.startAt;
      }
    }
    if (start >= windowStart && start <= nowMs) last30Days += 1;
  }

  return { upcoming, nextAt, last30Days, total: rows.length };
}

export interface OrderedBookings {
  /** Soonest first: this is the list someone is about to act on. */
  upcoming: BookingRow[];
  /** Most recent first, and everything cancelled, however it sorts. */
  past: BookingRow[];
}

/**
 * Split the rows the way the page reads them.
 *
 * Upcoming ascending and past descending is not a stylistic choice: both
 * orders put the booking nearest to now at the top of its own group, which is
 * the one a person came to the page for. A booking with no start time sorts to
 * the end of `past`, since it cannot be placed on a timeline and is not
 * something to plan around.
 */
export function orderBookingsForClient(
  rows: readonly BookingRow[],
  now: Date
): OrderedBookings {
  const nowMs = now.getTime();
  const upcoming: BookingRow[] = [];
  const past: BookingRow[] = [];

  for (const row of rows) {
    const start = startMs(row);
    // Cancelled never sits in the upcoming list, whatever its clock says.
    if (row.status !== 'cancelled' && start !== null && start >= nowMs) {
      upcoming.push(row);
    } else {
      past.push(row);
    }
  }

  upcoming.sort((a, b) => (startMs(a) ?? 0) - (startMs(b) ?? 0));
  past.sort((a, b) => {
    const left = startMs(a);
    const right = startMs(b);
    if (left === null && right === null) return 0;
    if (left === null) return 1;
    if (right === null) return -1;
    return right - left;
  });

  return { upcoming, past };
}

const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

/**
 * A booking's when, as a sentence.
 *
 * Written out by hand and fixed to UTC rather than handed to `Intl`. This
 * string is produced on the server, where there is no reader whose locale it
 * could follow, and `Intl`'s month abbreviations move with the ICU build, so
 * the same code prints "Sep" on one Node and "Sept" on the next. UTC is named
 * in the output because a time with no zone on it is a time a client will get
 * wrong, and this product does not know where they are.
 */
export function formatBookingWhen(startAt: string | null): string {
  if (!startAt) return 'Time not given';
  const parsed = Date.parse(startAt);
  if (Number.isNaN(parsed)) return 'Time not given';
  const date = new Date(parsed);
  const hh = String(date.getUTCHours()).padStart(2, '0');
  const mm = String(date.getUTCMinutes()).padStart(2, '0');
  return (
    `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ` +
    `${date.getUTCFullYear()} at ${hh}:${mm} UTC`
  );
}

/** The name to put on a booking row when Cal.com gave us more than one clue. */
export function bookingHeadline(row: BookingRow): string {
  return row.title?.trim() || row.eventTypeSlug?.trim() || 'Booking';
}

/** What the person who booked is called, or the honest absence of a name. */
export function bookingAttendee(row: BookingRow): string {
  const name = row.attendeeName?.trim();
  const email = row.attendeeEmail?.trim();
  if (name && email) return `${name} (${email})`;
  return name || email || 'No name given';
}
