/**
 * What a pile of booking rows means.
 *
 * The case that matters most is the cancelled one, in both directions: a
 * cancelled meeting must never be counted, and must never be dropped from the
 * list. A client who sees eight bookings and greets six people has been told
 * something false; a client whose cancellations vanish cannot tell the
 * difference between a meeting that was called off and one that never existed.
 */
import { describe, expect, it } from 'vitest';
import {
  bookingAttendee,
  bookingHeadline,
  formatBookingWhen,
  orderBookingsForClient,
  summariseBookings,
  type BookingRow,
} from '../bookings';

const NOW = new Date('2026-09-11T12:00:00.000Z');

let counter = 0;
function row(overrides: Partial<BookingRow> = {}): BookingRow {
  counter += 1;
  return {
    id: `row-${counter}`,
    externalUid: `bk_${counter}`,
    eventTypeSlug: 'intro',
    title: 'Intro call',
    startAt: '2026-09-15T09:30:00.000Z',
    endAt: '2026-09-15T10:00:00.000Z',
    attendeeName: 'Ada Roe',
    attendeeEmail: 'ada@example.com',
    status: 'booked',
    createdAt: '2026-09-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('summariseBookings', () => {
  it('reports nothing at all for a workspace with no bookings', () => {
    expect(summariseBookings([], NOW)).toEqual({
      upcoming: 0,
      nextAt: null,
      last30Days: 0,
      total: 0,
    });
  });

  it('counts what is ahead, what was recent, and the soonest one', () => {
    const summary = summariseBookings(
      [
        row({ startAt: '2026-09-20T09:00:00.000Z' }),
        row({ startAt: '2026-09-13T09:00:00.000Z' }),
        row({ startAt: '2026-09-05T09:00:00.000Z' }),
        row({ startAt: '2026-07-05T09:00:00.000Z' }),
      ],
      NOW
    );
    expect(summary).toEqual({
      upcoming: 2,
      nextAt: '2026-09-13T09:00:00.000Z',
      last30Days: 1,
      total: 4,
    });
  });

  it('leaves cancellations out of every count but the total', () => {
    const summary = summariseBookings(
      [
        row({ startAt: '2026-09-13T09:00:00.000Z' }),
        row({ startAt: '2026-09-12T09:00:00.000Z', status: 'cancelled' }),
        row({ startAt: '2026-09-05T09:00:00.000Z', status: 'cancelled' }),
      ],
      NOW
    );
    expect(summary).toMatchObject({
      upcoming: 1,
      nextAt: '2026-09-13T09:00:00.000Z',
      last30Days: 0,
      total: 3,
    });
  });

  it('counts a rescheduled booking, because it is still happening', () => {
    expect(
      summariseBookings(
        [row({ startAt: '2026-09-13T09:00:00.000Z', status: 'rescheduled' })],
        NOW
      ).upcoming
    ).toBe(1);
  });

  it('treats a booking starting exactly now as upcoming, not past', () => {
    const summary = summariseBookings(
      [row({ startAt: NOW.toISOString() })],
      NOW
    );
    expect(summary.upcoming).toBe(1);
    expect(summary.last30Days).toBe(1);
  });

  it('excludes a booking that fell out of the 30 day window by an hour', () => {
    expect(
      summariseBookings([row({ startAt: '2026-08-12T11:00:00.000Z' })], NOW)
        .last30Days
    ).toBe(0);
  });

  // A row with no start is real, so it is in the total, but it cannot be
  // upcoming or recent when nothing knows when it is.
  it('keeps a booking with no start time in the total and nowhere else', () => {
    expect(summariseBookings([row({ startAt: null })], NOW)).toEqual({
      upcoming: 0,
      nextAt: null,
      last30Days: 0,
      total: 1,
    });
    expect(
      summariseBookings([row({ startAt: 'not a date' })], NOW).upcoming
    ).toBe(0);
  });
});

describe('orderBookingsForClient', () => {
  it('puts the soonest first ahead, and the most recent first behind', () => {
    const far = row({ startAt: '2026-09-25T09:00:00.000Z' });
    const soon = row({ startAt: '2026-09-12T09:00:00.000Z' });
    const yesterday = row({ startAt: '2026-09-10T09:00:00.000Z' });
    const lastMonth = row({ startAt: '2026-08-10T09:00:00.000Z' });

    const { upcoming, past } = orderBookingsForClient(
      [lastMonth, far, yesterday, soon],
      NOW
    );
    expect(upcoming.map((one) => one.id)).toEqual([soon.id, far.id]);
    expect(past.map((one) => one.id)).toEqual([yesterday.id, lastMonth.id]);
  });

  it('never puts a cancelled booking in the upcoming list, but does show it', () => {
    const cancelled = row({
      startAt: '2026-09-12T09:00:00.000Z',
      status: 'cancelled',
    });
    const { upcoming, past } = orderBookingsForClient([cancelled], NOW);
    expect(upcoming).toEqual([]);
    expect(past.map((one) => one.id)).toEqual([cancelled.id]);
  });

  it('sorts a booking with no start time to the end of the past list', () => {
    const dated = row({ startAt: '2026-09-10T09:00:00.000Z' });
    const undated = row({ startAt: null });
    const alsoUndated = row({ startAt: null });
    const { past } = orderBookingsForClient([undated, dated, alsoUndated], NOW);
    expect(past[0].id).toBe(dated.id);
    expect(past.slice(1).map((one) => one.startAt)).toEqual([null, null]);
  });

  it('loses nothing: every row lands in exactly one of the two lists', () => {
    const rows = [
      row({ startAt: '2026-09-20T09:00:00.000Z' }),
      row({ startAt: '2026-09-01T09:00:00.000Z', status: 'cancelled' }),
      row({ startAt: null }),
      row({ startAt: '2026-09-13T09:00:00.000Z', status: 'rescheduled' }),
    ];
    const { upcoming, past } = orderBookingsForClient(rows, NOW);
    expect(upcoming.length + past.length).toBe(rows.length);
  });
});

describe('the words on a row', () => {
  // Intl's month abbreviations move with the ICU build. This has to say the
  // same thing on every machine, so it is written out rather than formatted.
  it('writes a time in UTC, the same way everywhere', () => {
    expect(formatBookingWhen('2026-09-15T09:05:00.000Z')).toBe(
      '15 Sep 2026 at 09:05 UTC'
    );
    expect(formatBookingWhen('2026-01-01T23:59:00.000Z')).toBe(
      '1 Jan 2026 at 23:59 UTC'
    );
  });

  it('says the time is missing rather than printing an invalid date', () => {
    expect(formatBookingWhen(null)).toBe('Time not given');
    expect(formatBookingWhen('whenever')).toBe('Time not given');
  });

  it('prefers the title, falls back to the event type, then to a plain word', () => {
    expect(bookingHeadline(row())).toBe('Intro call');
    expect(bookingHeadline(row({ title: '  ' }))).toBe('intro');
    expect(bookingHeadline(row({ title: null, eventTypeSlug: null }))).toBe(
      'Booking'
    );
  });

  it('names the attendee, or says plainly that there is no name', () => {
    expect(bookingAttendee(row())).toBe('Ada Roe (ada@example.com)');
    expect(bookingAttendee(row({ attendeeEmail: null }))).toBe('Ada Roe');
    expect(bookingAttendee(row({ attendeeName: null }))).toBe(
      'ada@example.com'
    );
    expect(
      bookingAttendee(row({ attendeeName: null, attendeeEmail: null }))
    ).toBe('No name given');
  });
});
