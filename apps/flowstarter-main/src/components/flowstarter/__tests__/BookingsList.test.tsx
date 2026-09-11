/**
 * The client's bookings list.
 *
 * The component decides nothing, so the cases here are about what a reader
 * ends up looking at: upcoming above earlier, soonest first inside each group,
 * cancellations present but visibly not happening, and an empty state that
 * says which kind of empty it is.
 */
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { BookingsList } from '../BookingsList';
import type { BookingRow } from '@/lib/flowstarter/bookings';

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

describe('BookingsList', () => {
  it('says nothing has been booked, rather than showing two empty headings', () => {
    render(<BookingsList bookings={[]} now={NOW} />);
    expect(screen.getByTestId('bookings-empty')).toHaveTextContent(
      /No bookings yet/
    );
    expect(screen.queryByTestId('bookings-upcoming')).toBeNull();
  });

  it('shows the attendee, the title and the time in UTC', () => {
    render(<BookingsList bookings={[row()]} now={NOW} />);
    const item = screen.getByTestId('booking-row');
    expect(item).toHaveTextContent('Intro call');
    expect(item).toHaveTextContent('15 Sep 2026 at 09:30 UTC');
    expect(item).toHaveTextContent('Ada Roe (ada@example.com)');
  });

  it('puts what is coming up above what already happened', () => {
    render(
      <BookingsList
        bookings={[
          row({ title: 'Older', startAt: '2026-09-02T09:00:00.000Z' }),
          row({ title: 'Sooner', startAt: '2026-09-12T09:00:00.000Z' }),
          row({ title: 'Later', startAt: '2026-09-20T09:00:00.000Z' }),
        ]}
        now={NOW}
      />
    );

    const upcoming = within(screen.getByTestId('bookings-upcoming'))
      .getAllByTestId('booking-row')
      .map((node) => node.textContent);
    expect(upcoming[0]).toContain('Sooner');
    expect(upcoming[1]).toContain('Later');

    const past = within(screen.getByTestId('bookings-past')).getAllByTestId(
      'booking-row'
    );
    expect(past).toHaveLength(1);
    expect(past[0]).toHaveTextContent('Older');
  });

  // Muted, not missing. A client who cannot see a cancellation cannot tell it
  // apart from a booking that never happened.
  it('shows a cancelled booking, marked as cancelled and never as upcoming', () => {
    render(
      <BookingsList
        bookings={[
          row({
            title: 'Called off',
            startAt: '2026-09-14T09:00:00.000Z',
            status: 'cancelled',
          }),
        ]}
        now={NOW}
      />
    );

    const item = screen.getByTestId('booking-row');
    expect(item).toHaveAttribute('data-status', 'cancelled');
    expect(item).toHaveTextContent('Cancelled');
    expect(
      within(screen.getByTestId('bookings-upcoming')).queryByTestId(
        'booking-row'
      )
    ).toBeNull();
  });

  it('marks a rescheduled booking as moved, and still counts it as coming up', () => {
    render(
      <BookingsList
        bookings={[
          row({ startAt: '2026-09-14T09:00:00.000Z', status: 'rescheduled' }),
        ]}
        now={NOW}
      />
    );
    const item = within(screen.getByTestId('bookings-upcoming')).getByTestId(
      'booking-row'
    );
    expect(item).toHaveTextContent('Moved');
  });

  it('says a group is empty rather than leaving a heading with nothing under it', () => {
    render(
      <BookingsList
        bookings={[row({ startAt: '2026-09-02T09:00:00.000Z' })]}
        now={NOW}
      />
    );
    expect(screen.getByTestId('bookings-upcoming')).toHaveTextContent(
      'Nothing coming up.'
    );
  });

  it('does not print an invalid date for a booking with no start time', () => {
    render(<BookingsList bookings={[row({ startAt: null })]} now={NOW} />);
    const item = screen.getByTestId('booking-row');
    expect(item).toHaveTextContent('Time not given');
    expect(item.textContent).not.toContain('Invalid');
  });
});
