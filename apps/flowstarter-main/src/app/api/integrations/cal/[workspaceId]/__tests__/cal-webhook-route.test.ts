// @vitest-environment node
/**
 * Cal.com's inbound webhook, through the REAL route handler.
 *
 * This endpoint has no session behind it, so the HMAC is the whole of the
 * authentication and the order of the checks is the security property. Four
 * things are defended:
 *
 *  1. AN UNSIGNED CALLER LEARNS NOTHING. No signature header means 401 and no
 *     database query at all, whatever workspace id is in the path, so the
 *     endpoint cannot be used to find out which workspaces exist.
 *  2. THE SIGNATURE IS OVER THE BYTES ON THE WIRE. A body altered after
 *     signing, or signed with another workspace's secret, is refused.
 *  3. A REDELIVERY CHANGES NOTHING. Cal.com retries; a retry that double
 *     counted a booking would show a client a meeting they do not have.
 *  4. A VERIFIED DELIVERY NEVER FAILS LOUDLY. A non-2xx makes Cal.com send it
 *     again, so everything after the signature check returns 200.
 */
import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const MISSING = '11111111-2222-4333-8444-555555555555';
const SECRET_A = 'a'.repeat(64);
const SECRET_B = 'b'.repeat(64);

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

/** Only the fields this route sets; `notifyClientOnce` owns the rest. */
interface NotifyInput {
  workspaceId: string;
  notification: string;
  dedupeKey: string;
  render: (recipient: {
    dashboardUrl: string;
    clientName: string | null;
    businessName: string | null;
  }) => { subject: string; html: string };
}

const notify = vi.fn(async (_input: NotifyInput) => ({ sent: true }));
vi.mock('@/lib/flowstarter/client-notifications', () => ({
  notifyClientOnce: (input: NotifyInput) => notify(input),
}));

function params(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function sign(raw: string, secret: string): string {
  return createHmac('sha256', secret).update(raw, 'utf8').digest('hex');
}

function post(
  workspaceId: string,
  raw: string,
  signature: string | null
): NextRequest {
  return new NextRequest(
    `http://localhost/api/integrations/cal/${workspaceId}`,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(signature ? { 'x-cal-signature-256': signature } : {}),
      },
      body: raw,
    }
  );
}

function body(
  trigger = 'BOOKING_CREATED',
  payload: Record<string, unknown> = {}
): string {
  return JSON.stringify({
    triggerEvent: trigger,
    createdAt: '2026-09-11T08:00:00.000Z',
    payload: {
      uid: 'bk_abc123',
      title: 'Intro call',
      startTime: '2026-09-15T09:30:00Z',
      endTime: '2026-09-15T10:00:00Z',
      eventType: { slug: 'intro' },
      attendees: [{ name: 'Ada Roe', email: 'ada@example.com' }],
      ...payload,
    },
  });
}

async function deliver(
  workspaceId: string,
  raw: string,
  secret: string | null
) {
  return POST(
    post(workspaceId, raw, secret === null ? null : sign(raw, secret)),
    params(workspaceId)
  );
}

function bookings() {
  return db.rows('workspace_bookings');
}

beforeEach(() => {
  db.reset();
  notify.mockClear();
  delete process.env.RESEND_API_KEY;
  db.seed('workspaces', [
    { id: WORKSPACE_A, cal_com_webhook_secret: SECRET_A },
    { id: WORKSPACE_B, cal_com_webhook_secret: SECRET_B },
  ]);
});

describe('an unsigned caller', () => {
  it('is refused without a single row being read', async () => {
    const response = await POST(
      post(WORKSPACE_A, body(), null),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: 'Invalid signature' });
    expect(bookings()).toHaveLength(0);
  });

  // The oracle case. A workspace that exists and one that does not have to be
  // indistinguishable to somebody with no signature.
  it('cannot tell a real workspace from an invented one', async () => {
    const real = await POST(
      post(WORKSPACE_A, body(), null),
      params(WORKSPACE_A)
    );
    const invented = await POST(post(MISSING, body(), null), params(MISSING));
    const malformed = await POST(
      post('not-a-uuid', body(), null),
      params('not-a-uuid')
    );

    expect([real.status, invented.status, malformed.status]).toEqual([
      401, 401, 401,
    ]);
    expect(await real.json()).toEqual(await invented.json());
    expect(await malformed.json()).toEqual({ error: 'Invalid signature' });
  });
});

describe('a signed caller with the wrong signature', () => {
  it('is refused when the body was altered after signing', async () => {
    const raw = body();
    const signature = sign(raw, SECRET_A);
    const tampered = raw.replace('Ada Roe', 'Eve Roe');
    const response = await POST(
      post(WORKSPACE_A, tampered, signature),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(401);
    expect(bookings()).toHaveLength(0);
  });

  // One workspace's secret must not open another's endpoint. This is the
  // whole reason the secret is per workspace rather than per platform.
  it('is refused when it holds another workspace’s secret', async () => {
    const response = await deliver(WORKSPACE_A, body(), SECRET_B);
    expect(response.status).toBe(401);
    expect(bookings()).toHaveLength(0);
  });

  it('is refused when the workspace has no calendar connected', async () => {
    db.rows('workspaces')[0]['cal_com_webhook_secret'] = null;
    const response = await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(response.status).toBe(401);
  });

  it('is told the workspace is gone, which is what a stale webhook needs', async () => {
    const missing = await deliver(MISSING, body(), SECRET_A);
    expect(missing.status).toBe(404);

    const malformed = await deliver('not-a-uuid', body(), SECRET_A);
    expect(malformed.status).toBe(404);
  });

  it('reports a lookup failure as retryable rather than as a refusal', async () => {
    db.failing.add('workspaces');
    const response = await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(response.status).toBe(503);
  });
});

describe('a genuine delivery', () => {
  it('records the booking against the workspace in the path', async () => {
    const response = await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ok: true, action: 'insert' });

    expect(bookings()).toHaveLength(1);
    expect(bookings()[0]).toMatchObject({
      workspace_id: WORKSPACE_A,
      provider: 'cal.com',
      external_uid: 'bk_abc123',
      event_type_slug: 'intro',
      title: 'Intro call',
      start_at: '2026-09-15T09:30:00.000Z',
      attendee_name: 'Ada Roe',
      attendee_email: 'ada@example.com',
      status: 'booked',
    });
  });

  it('keeps the whole body, so an operator can read what actually arrived', async () => {
    await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(bookings()[0]['payload']).toMatchObject({
      triggerEvent: 'BOOKING_CREATED',
    });
  });

  it('changes nothing when the same delivery arrives a second time', async () => {
    const raw = body();
    await deliver(WORKSPACE_A, raw, SECRET_A);
    const replay = await deliver(WORKSPACE_A, raw, SECRET_A);

    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({
      action: 'skip',
      reason: 'replayed',
    });
    expect(bookings()).toHaveLength(1);
  });

  it('moves the booking in place when it is rescheduled', async () => {
    await deliver(WORKSPACE_A, body(), SECRET_A);
    const response = await deliver(
      WORKSPACE_A,
      body('BOOKING_RESCHEDULED', { startTime: '2026-09-16T14:00:00Z' }),
      SECRET_A
    );

    expect(await response.json()).toMatchObject({ action: 'update' });
    expect(bookings()).toHaveLength(1);
    expect(bookings()[0]).toMatchObject({
      status: 'rescheduled',
      start_at: '2026-09-16T14:00:00.000Z',
    });
  });

  it('marks a cancellation, and refuses a late create that would undo it', async () => {
    await deliver(WORKSPACE_A, body(), SECRET_A);
    await deliver(WORKSPACE_A, body('BOOKING_CANCELLED'), SECRET_A);
    expect(bookings()[0]['status']).toBe('cancelled');

    const late = await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(await late.json()).toMatchObject({
      action: 'skip',
      reason: 'superseded',
    });
    expect(bookings()[0]['status']).toBe('cancelled');
  });

  it('acknowledges a trigger it does not handle rather than making Cal.com retry forever', async () => {
    const response = await deliver(
      WORKSPACE_A,
      JSON.stringify({ triggerEvent: 'MEETING_ENDED', payload: {} }),
      SECRET_A
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      ok: true,
      ignored: 'unknown_trigger',
    });
    expect(bookings()).toHaveLength(0);
  });

  it('acknowledges a signed body that is not JSON', async () => {
    const response = await deliver(WORKSPACE_A, 'not json at all', SECRET_A);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ ignored: 'not_json' });
  });

  it('still returns 200 when the write could not be saved', async () => {
    db.failing.add('workspace_bookings');
    const response = await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(response.status).toBe(200);
  });
});

describe('telling the client', () => {
  it('stays quiet when no mailer is configured', async () => {
    await deliver(WORKSPACE_A, body(), SECRET_A);
    expect(notify).not.toHaveBeenCalled();
  });

  it('sends one email for a new booking, keyed on the Cal.com uid', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    await deliver(WORKSPACE_A, body(), SECRET_A);

    expect(notify).toHaveBeenCalledTimes(1);
    const input = notify.mock.calls[0][0];
    expect(input).toMatchObject({
      workspaceId: WORKSPACE_A,
      notification: 'booking_created',
      dedupeKey: 'bk_abc123',
    });

    const rendered = input.render({
      dashboardUrl: 'https://flowstarter.net/dashboard/projects/ws',
      clientName: 'Halden',
      businessName: 'Halden & Roe',
    });
    expect(rendered.subject).toBe('New booking on your site');
    expect(rendered.html).toContain('Ada Roe');
    expect(rendered.html).toContain('15 Sep 2026 at 09:30 UTC');
    expect(rendered.html).toContain(
      'https://flowstarter.net/dashboard/projects/ws/booking/list'
    );
    // House style, and the reason the template escapes.
    expect(rendered.html).not.toContain('—');
    expect(rendered.html).toContain('Halden &amp; Roe');
  });

  it('does not email again for a replay, a reschedule or a cancellation', async () => {
    process.env.RESEND_API_KEY = 'test-key';
    const raw = body();
    await deliver(WORKSPACE_A, raw, SECRET_A);
    await deliver(WORKSPACE_A, raw, SECRET_A);
    await deliver(WORKSPACE_A, body('BOOKING_RESCHEDULED'), SECRET_A);
    await deliver(WORKSPACE_A, body('BOOKING_CANCELLED'), SECRET_A);
    expect(notify).toHaveBeenCalledTimes(1);
  });
});
