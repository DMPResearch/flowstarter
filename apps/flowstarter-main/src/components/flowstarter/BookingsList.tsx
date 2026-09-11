/**
 * The client's bookings, as two lists.
 *
 * Presentation only. What is upcoming, what is past and what order each goes
 * in was decided by `orderBookingsForClient`, and the words on a row come from
 * `bookingHeadline`, `bookingAttendee` and `formatBookingWhen`. Nothing here
 * chooses anything, which is what makes the ordering assertable without
 * rendering and the rendering assertable without a database.
 *
 * Cancelled rows are muted rather than hidden. A meeting that was called off
 * is still something the client may need to see, and a list that silently
 * drops rows is a list they cannot trust.
 */
import {
  bookingAttendee,
  bookingHeadline,
  formatBookingWhen,
  orderBookingsForClient,
  type BookingRow,
} from '@/lib/flowstarter/bookings';

export function BookingsList({
  bookings,
  now,
}: {
  bookings: readonly BookingRow[];
  now: Date;
}) {
  const { upcoming, past } = orderBookingsForClient(bookings, now);

  if (bookings.length === 0) {
    return (
      <p
        className="rounded-2xl border border-[var(--fs-glass-edge)] bg-white/60 px-5 py-6 text-sm text-[var(--fs-ink)]/70"
        data-testid="bookings-empty"
      >
        No bookings yet. When somebody books time through the calendar on your
        site, it will show up here.
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-8">
      <Group
        title="Coming up"
        rows={upcoming}
        testId="bookings-upcoming"
        emptyNote="Nothing coming up."
      />
      <Group
        title="Earlier"
        rows={past}
        testId="bookings-past"
        emptyNote="Nothing earlier."
      />
    </div>
  );
}

function Group({
  title,
  rows,
  testId,
  emptyNote,
}: {
  title: string;
  rows: readonly BookingRow[];
  testId: string;
  emptyNote: string;
}) {
  return (
    <section className="flex flex-col gap-3" data-testid={testId}>
      <h2 className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink)]/50">
        {title}
      </h2>
      {rows.length === 0 ? (
        <p className="text-sm text-[var(--fs-ink)]/60">{emptyNote}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((row) => (
            <BookingItem key={row.id} row={row} />
          ))}
        </ul>
      )}
    </section>
  );
}

function BookingItem({ row }: { row: BookingRow }) {
  const cancelled = row.status === 'cancelled';
  return (
    <li
      data-testid="booking-row"
      data-status={row.status}
      className={`flex flex-col gap-1 rounded-2xl border border-[var(--fs-glass-edge)] px-5 py-4 ${
        cancelled ? 'bg-white/40 opacity-60' : 'bg-white/70'
      }`}
    >
      <p
        className={`text-sm font-semibold text-[var(--fs-ink)] ${
          cancelled ? 'line-through' : ''
        }`}
      >
        {bookingHeadline(row)}
      </p>
      <p className="text-sm text-[var(--fs-ink)]/70">
        {formatBookingWhen(row.startAt)}
      </p>
      <p className="text-sm text-[var(--fs-ink)]/70">{bookingAttendee(row)}</p>
      {row.status !== 'booked' ? (
        <p className="text-xs font-semibold uppercase tracking-widest text-[var(--fs-ink)]/50">
          {cancelled ? 'Cancelled' : 'Moved'}
        </p>
      ) : null}
    </li>
  );
}
