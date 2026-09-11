/**
 * The rules the Cal.com webhook runs on.
 *
 * Three of these are security assertions rather than behaviour assertions: a
 * body that was altered by one byte must not verify, a signature computed over
 * a re-serialised copy of the same JSON must not verify (which is the bug that
 * would make the integration work in tests and fail against the real Cal.com),
 * and a delivery that arrives twice must change nothing the second time.
 */
import { createHmac } from 'crypto';
import { describe, expect, it } from 'vitest';
import {
  bookingWriteAction,
  calSignature,
  generateCalWebhookSecret,
  parseCalBookingEvent,
  shouldNotifyClient,
  verifyCalSignature,
  type BookingStatus,
} from '../cal-webhook';

const SECRET = 'a-per-workspace-secret';

function body(overrides: Record<string, unknown> = {}): string {
  const { payload: _payload, ...envelope } = overrides;
  return JSON.stringify({
    triggerEvent: 'BOOKING_CREATED',
    createdAt: '2026-09-11T08:00:00.000Z',
    ...envelope,
    payload: {
      uid: 'bk_abc123',
      type: 'intro-30',
      title: 'Intro between Halden and Roe',
      startTime: '2026-09-15T09:30:00Z',
      endTime: '2026-09-15T10:00:00Z',
      eventType: { slug: 'intro' },
      attendees: [
        {
          name: 'Ada Roe',
          email: 'ada@example.com',
          timeZone: 'Europe/Dublin',
        },
      ],
      ...((overrides.payload as Record<string, unknown>) ?? {}),
    },
  });
}

describe('verifyCalSignature', () => {
  it('accepts the signature Cal.com computes over exactly these bytes', () => {
    const raw = body();
    expect(verifyCalSignature(raw, calSignature(raw, SECRET), SECRET)).toBe(
      true
    );
  });

  it('accepts the header whatever case it arrives in', () => {
    const raw = body();
    const upper = calSignature(raw, SECRET).toUpperCase();
    expect(verifyCalSignature(raw, ` ${upper} `, SECRET)).toBe(true);
  });

  // The bug that would pass every test and fail every real delivery: the HMAC
  // covers the bytes on the wire, not the object they parse into.
  it('refuses a signature computed over a re-serialised copy of the same JSON', () => {
    const raw = '{"triggerEvent":"BOOKING_CREATED", "payload": {"uid":"x"}}';
    const reserialised = JSON.stringify(JSON.parse(raw));
    expect(reserialised).not.toBe(raw);
    expect(
      verifyCalSignature(raw, calSignature(reserialised, SECRET), SECRET)
    ).toBe(false);
  });

  it('refuses a body altered by one byte', () => {
    const raw = body();
    const signature = calSignature(raw, SECRET);
    expect(
      verifyCalSignature(raw.replace('Ada', 'Eve'), signature, SECRET)
    ).toBe(false);
  });

  it('refuses the right body signed with the wrong workspace’s secret', () => {
    const raw = body();
    expect(
      verifyCalSignature(raw, calSignature(raw, 'another-workspace'), SECRET)
    ).toBe(false);
  });

  it('refuses a missing header, an empty secret, and junk in the header', () => {
    const raw = body();
    const good = calSignature(raw, SECRET);
    expect(verifyCalSignature(raw, null, SECRET)).toBe(false);
    expect(verifyCalSignature(raw, undefined, SECRET)).toBe(false);
    expect(verifyCalSignature(raw, '', SECRET)).toBe(false);
    expect(verifyCalSignature(raw, good, null)).toBe(false);
    expect(verifyCalSignature(raw, good, '')).toBe(false);
    // Right length, not hex.
    expect(verifyCalSignature(raw, 'z'.repeat(64), SECRET)).toBe(false);
    // Hex, wrong length: a prefix of the real signature must not pass.
    expect(verifyCalSignature(raw, good.slice(0, 32), SECRET)).toBe(false);
    expect(verifyCalSignature(raw, `${good}00`, SECRET)).toBe(false);
  });

  it('computes the same digest as a plain HMAC-SHA256 of the body', () => {
    const raw = body();
    expect(calSignature(raw, SECRET)).toBe(
      createHmac('sha256', SECRET).update(raw, 'utf8').digest('hex')
    );
  });
});

describe('generateCalWebhookSecret', () => {
  it('is 32 bytes of hex', () => {
    const secret = generateCalWebhookSecret((size) => Buffer.alloc(size, 0xab));
    expect(secret).toBe('ab'.repeat(32));
    expect(secret).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe('parseCalBookingEvent', () => {
  it('lifts the fields the dashboard shows out of Cal.com’s larger body', () => {
    const result = parseCalBookingEvent(body());
    expect(result.ok && result.event).toMatchObject({
      trigger: 'BOOKING_CREATED',
      status: 'booked',
      uid: 'bk_abc123',
      eventTypeSlug: 'intro',
      title: 'Intro between Halden and Roe',
      startAt: '2026-09-15T09:30:00.000Z',
      endAt: '2026-09-15T10:00:00.000Z',
      attendeeName: 'Ada Roe',
      attendeeEmail: 'ada@example.com',
    });
  });

  it('maps each trigger to the status the table stores', () => {
    const cases: Array<[string, BookingStatus]> = [
      ['BOOKING_CREATED', 'booked'],
      ['BOOKING_RESCHEDULED', 'rescheduled'],
      ['BOOKING_CANCELLED', 'cancelled'],
    ];
    for (const [trigger, status] of cases) {
      const result = parseCalBookingEvent(body({ triggerEvent: trigger }));
      expect(result.ok && result.event.status).toBe(status);
    }
  });

  it('falls back to payload.type when the body has no eventType object', () => {
    const result = parseCalBookingEvent(
      body({ payload: { eventType: undefined } })
    );
    expect(result.ok && result.event.eventTypeSlug).toBe('intro-30');
  });

  it('refuses a body that is not JSON, or is not an object', () => {
    expect(parseCalBookingEvent('not json')).toEqual({
      ok: false,
      reason: 'not_json',
    });
    expect(parseCalBookingEvent('null')).toEqual({
      ok: false,
      reason: 'not_json',
    });
    expect(parseCalBookingEvent('"a string"')).toEqual({
      ok: false,
      reason: 'not_json',
    });
  });

  it('ignores a trigger this integration does not subscribe to', () => {
    expect(
      parseCalBookingEvent(body({ triggerEvent: 'MEETING_ENDED' }))
    ).toEqual({ ok: false, reason: 'unknown_trigger' });
    expect(parseCalBookingEvent('{}')).toEqual({
      ok: false,
      reason: 'unknown_trigger',
    });
  });

  it('refuses a booking with no uid, because the uid is the idempotency key', () => {
    expect(parseCalBookingEvent(body({ payload: { uid: '' } }))).toEqual({
      ok: false,
      reason: 'missing_uid',
    });
    expect(
      parseCalBookingEvent(
        JSON.stringify({ triggerEvent: 'BOOKING_CREATED', payload: {} })
      )
    ).toEqual({ ok: false, reason: 'missing_uid' });
  });

  // A bad date must cost the time on the row, not the row: a malformed value
  // reaching a timestamptz column would fail the insert and lose the booking.
  it('drops an unparseable time rather than carrying it to the database', () => {
    const result = parseCalBookingEvent(
      body({ payload: { startTime: 'soon', endTime: 42 } })
    );
    expect(result.ok && result.event.startAt).toBeNull();
    expect(result.ok && result.event.endAt).toBeNull();
  });

  it('survives a body with no attendees and no title', () => {
    const result = parseCalBookingEvent(
      body({ payload: { attendees: [], title: '   ' } })
    );
    expect(result.ok && result.event).toMatchObject({
      attendeeName: null,
      attendeeEmail: null,
      title: null,
    });
  });

  it('caps a field long enough to be an attack rather than a name', () => {
    const result = parseCalBookingEvent(
      body({ payload: { title: 'x'.repeat(5000) } })
    );
    expect(result.ok && result.event.title).toHaveLength(500);
  });
});

describe('bookingWriteAction', () => {
  it('inserts when nothing is stored', () => {
    expect(bookingWriteAction(null, 'booked')).toEqual({ kind: 'insert' });
  });

  it('does nothing when the same delivery arrives again', () => {
    expect(bookingWriteAction('booked', 'booked')).toEqual({
      kind: 'skip',
      reason: 'replayed',
    });
    expect(bookingWriteAction('cancelled', 'cancelled')).toEqual({
      kind: 'skip',
      reason: 'replayed',
    });
  });

  // Webhook order is not guaranteed. The table is what the client reads, so a
  // late BOOKING_CREATED must not put a cancelled meeting back on it.
  it('refuses to resurrect a cancelled booking', () => {
    expect(bookingWriteAction('cancelled', 'booked')).toEqual({
      kind: 'skip',
      reason: 'superseded',
    });
    expect(bookingWriteAction('cancelled', 'rescheduled')).toEqual({
      kind: 'skip',
      reason: 'superseded',
    });
  });

  it('updates when the booking genuinely moved', () => {
    expect(bookingWriteAction('booked', 'rescheduled')).toEqual({
      kind: 'update',
    });
    expect(bookingWriteAction('booked', 'cancelled')).toEqual({
      kind: 'update',
    });
    expect(bookingWriteAction('rescheduled', 'cancelled')).toEqual({
      kind: 'update',
    });
  });
});

describe('shouldNotifyClient', () => {
  it('emails only for a booking that was not in the table before', () => {
    expect(shouldNotifyClient({ kind: 'insert' }, 'BOOKING_CREATED')).toBe(
      true
    );
  });

  it('stays quiet for a replay, an update, and a reschedule', () => {
    expect(
      shouldNotifyClient(
        { kind: 'skip', reason: 'replayed' },
        'BOOKING_CREATED'
      )
    ).toBe(false);
    expect(shouldNotifyClient({ kind: 'update' }, 'BOOKING_CREATED')).toBe(
      false
    );
    expect(shouldNotifyClient({ kind: 'insert' }, 'BOOKING_RESCHEDULED')).toBe(
      false
    );
    expect(shouldNotifyClient({ kind: 'insert' }, 'BOOKING_CANCELLED')).toBe(
      false
    );
  });
});
