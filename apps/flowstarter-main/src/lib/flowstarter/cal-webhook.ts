/**
 * The rules the Cal.com webhook runs on: who signed it, what it says, and
 * whether it changes anything.
 *
 * The route around this module does I/O and nothing else. Everything that can
 * be decided from the raw body and the row already in the table is decided
 * here, because all three of the interesting cases are pure:
 *
 *   - A caller with no signature, or the wrong one, must be refused without
 *     the answer depending on how long the comparison took, and without the
 *     refusal saying whether the workspace in the path exists.
 *   - The same delivery arriving twice must change nothing the second time.
 *     Cal.com retries, and a retry that double-counts a booking is worse for
 *     the client than a delivery that was lost.
 *   - A redelivered BOOKING_CREATED arriving after the BOOKING_CANCELLED for
 *     the same booking must not put a cancelled meeting back on the client's
 *     dashboard. Webhook order is not guaranteed; the table is what the client
 *     reads, so the later truth wins over the later delivery.
 *
 * SIGNATURE. Cal.com signs the exact bytes of the request body with the
 * per-workspace secret, HMAC-SHA256, hex, in `X-Cal-Signature-256`. The route
 * must hand this function `await request.text()`, never a re-serialised
 * object: `JSON.stringify(JSON.parse(body))` is a different string for the
 * same JSON and would fail every real delivery.
 */
import { createHmac, timingSafeEqual } from 'crypto';

/** The header Cal.com puts the HMAC in. */
export const CAL_SIGNATURE_HEADER = 'x-cal-signature-256';

/** The three triggers this integration subscribes to. */
export const CAL_TRIGGER_EVENTS = [
  'BOOKING_CREATED',
  'BOOKING_RESCHEDULED',
  'BOOKING_CANCELLED',
] as const;

export type CalTriggerEvent = (typeof CAL_TRIGGER_EVENTS)[number];

/** What a row in `workspace_bookings` can say about a booking. */
export type BookingStatus = 'booked' | 'rescheduled' | 'cancelled';

const STATUS_BY_TRIGGER: Record<CalTriggerEvent, BookingStatus> = {
  BOOKING_CREATED: 'booked',
  BOOKING_RESCHEDULED: 'rescheduled',
  BOOKING_CANCELLED: 'cancelled',
};

// ─── Signature ─────────────────────────────────────────────────────────────

/**
 * Constant-time compare of two hex signatures.
 *
 * `timingSafeEqual` throws on a length mismatch rather than returning false,
 * so the length is checked first. That check is not constant time, but the
 * length of a hex SHA-256 digest is public: every valid signature is 64
 * characters, and an attacker learns nothing from being told their 12
 * character guess was the wrong shape.
 */
function secureEquals(a: string, b: string): boolean {
  const left = Buffer.from(a, 'utf8');
  const right = Buffer.from(b, 'utf8');
  if (left.length !== right.length) return false;
  try {
    return timingSafeEqual(left, right);
  } catch {
    return false;
  }
}

/** The signature Cal.com should have sent for this body and secret. */
export function calSignature(rawBody: string, secret: string): string {
  return createHmac('sha256', secret).update(rawBody, 'utf8').digest('hex');
}

/**
 * True when `header` is the signature for exactly these bytes.
 *
 * A missing header, an empty secret and a wrong digest all return false. The
 * caller turns every one of them into the same 401: which of the three it was
 * is our business, not the caller's.
 */
export function verifyCalSignature(
  rawBody: string,
  header: string | null | undefined,
  secret: string | null | undefined
): boolean {
  if (!header || !secret) return false;
  const offered = header.trim().toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(offered)) return false;
  return secureEquals(offered, calSignature(rawBody, secret));
}

/**
 * A secret for a workspace to paste into Cal.com's webhook settings.
 *
 * Hex rather than base64 so it survives being copied out of a dashboard, read
 * aloud, or pasted into a form that trims punctuation. 32 bytes, which is the
 * full width of the HMAC it keys.
 */
export function generateCalWebhookSecret(
  randomBytes: (size: number) => Buffer
): string {
  return randomBytes(32).toString('hex');
}

// ─── Payload ───────────────────────────────────────────────────────────────

/** The fields this product stores, lifted out of Cal.com's much larger body. */
export interface CalBookingEvent {
  trigger: CalTriggerEvent;
  status: BookingStatus;
  /** Cal.com's booking uid. The idempotency key, with the trigger. */
  uid: string;
  eventTypeSlug: string | null;
  title: string | null;
  startAt: string | null;
  endAt: string | null;
  attendeeName: string | null;
  attendeeEmail: string | null;
}

export type CalPayloadRejection =
  | 'not_json'
  | 'unknown_trigger'
  | 'missing_uid';

export type CalPayloadResult =
  | { ok: true; event: CalBookingEvent }
  | { ok: false; reason: CalPayloadRejection };

function str(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed ? trimmed.slice(0, 500) : null;
}

/**
 * ISO 8601 or nothing.
 *
 * Cal.com sends `2026-09-12T10:00:00Z`, but a malformed date reaching a
 * `timestamptz` column fails the insert and turns a cosmetic problem into a
 * lost booking. Parsing here means a bad date costs the time on the row, not
 * the row.
 */
function timestamp(value: unknown): string | null {
  const raw = str(value);
  if (!raw) return null;
  const parsed = Date.parse(raw);
  if (Number.isNaN(parsed)) return null;
  return new Date(parsed).toISOString();
}

function isTrigger(value: unknown): value is CalTriggerEvent {
  return (
    typeof value === 'string' &&
    (CAL_TRIGGER_EVENTS as readonly string[]).includes(value)
  );
}

/**
 * Read a Cal.com webhook body into the handful of fields the dashboard shows.
 *
 * Everything else is kept verbatim in the row's `payload` column by the route,
 * so nothing is lost by this being narrow, and a field Cal.com renames later
 * degrades to null rather than throwing inside a webhook.
 */
export function parseCalBookingEvent(rawBody: string): CalPayloadResult {
  let body: unknown;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return { ok: false, reason: 'not_json' };
  }
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'not_json' };
  }

  const envelope = body as Record<string, unknown>;
  const trigger = envelope.triggerEvent;
  if (!isTrigger(trigger)) return { ok: false, reason: 'unknown_trigger' };

  const payload = (
    envelope.payload && typeof envelope.payload === 'object'
      ? envelope.payload
      : {}
  ) as Record<string, unknown>;

  const uid = str(payload.uid);
  if (!uid) return { ok: false, reason: 'missing_uid' };

  const eventType = (
    payload.eventType && typeof payload.eventType === 'object'
      ? payload.eventType
      : {}
  ) as Record<string, unknown>;

  const attendees = Array.isArray(payload.attendees) ? payload.attendees : [];
  const first = (
    attendees[0] && typeof attendees[0] === 'object' ? attendees[0] : {}
  ) as Record<string, unknown>;

  return {
    ok: true,
    event: {
      trigger,
      status: STATUS_BY_TRIGGER[trigger],
      uid,
      // `payload.type` is the slug on most triggers; `eventType.slug` is the
      // one the cancellation body carries. Take whichever is present.
      eventTypeSlug: str(eventType.slug) ?? str(payload.type),
      title: str(payload.title),
      startAt: timestamp(payload.startTime),
      endAt: timestamp(payload.endTime),
      attendeeName: str(first.name),
      attendeeEmail: str(first.email),
    },
  };
}

// ─── Idempotency ───────────────────────────────────────────────────────────

export type BookingWriteAction =
  | { kind: 'insert' }
  | { kind: 'update' }
  | { kind: 'skip'; reason: 'replayed' | 'superseded' };

/**
 * What a delivery should do to the row already in the table.
 *
 * `existing` is the status on the stored row for this workspace and uid, or
 * null when there is none.
 *
 *   nothing stored            insert, and this is the only case that emails
 *   same status stored        replayed delivery, change nothing
 *   cancelled, now booked     a retry that arrived late, change nothing
 *   anything else             update, the booking moved
 */
export function bookingWriteAction(
  existing: BookingStatus | null,
  incoming: BookingStatus
): BookingWriteAction {
  if (existing === null) return { kind: 'insert' };
  if (existing === incoming) return { kind: 'skip', reason: 'replayed' };
  if (existing === 'cancelled') return { kind: 'skip', reason: 'superseded' };
  return { kind: 'update' };
}

/**
 * Whether this delivery is the one that tells the client.
 *
 * Only a booking that was not in the table before is news. A reschedule is a
 * change to something they were already told about, and `notifyClientOnce`
 * would dedupe it anyway; saying so here keeps the rule next to the others.
 */
export function shouldNotifyClient(
  action: BookingWriteAction,
  trigger: CalTriggerEvent
): boolean {
  return action.kind === 'insert' && trigger === 'BOOKING_CREATED';
}
