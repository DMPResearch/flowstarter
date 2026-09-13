/**
 * The one email that hands a client an account.
 *
 * Three properties are pinned, and they are the three that would hurt a real
 * client if they broke:
 *
 *   - it goes out once per workspace and never again, because the dashboard
 *     retry and a re-claimed preview both re-run provisioning and a second
 *     "here is your new booking page" reads as a second page to look after;
 *   - the password-setup link reaches them, because without it the calendar we
 *     made is one they can never open;
 *   - an unconfigured mailer is a reason on a result, not a throw, because the
 *     caller is a claim somebody has just paid for.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from './fake-supabase';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

// Covered on its own in lib/ops/__tests__/send-ops-alert.test.ts.
const sendOpsAlert = vi.fn().mockResolvedValue({ sent: true });
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: (...args: unknown[]) => sendOpsAlert(...args),
}));

import {
  CLIENT_EMAIL_EVENT,
  CLIENT_EMAIL_FAILED_EVENT,
} from '../client-notifications';
import { notifyClientBookingPageReady } from '../cal-provisioned-notice';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';
const BOOKING_URL = 'https://cal.flowstarter.dev/lumina-dental/intro-call';
const PASSWORD_URL = 'https://cal.flowstarter.dev/auth/forgot-password';

function notice(overrides: Record<string, unknown> = {}) {
  return {
    supabase: db.client as never,
    workspaceId: WORKSPACE,
    bookingUrl: BOOKING_URL,
    passwordSetupUrl: PASSWORD_URL,
    ...overrides,
  };
}

beforeEach(() => {
  db.reset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true });
  sendOpsAlert.mockClear();
  sendOpsAlert.mockResolvedValue({ sent: true });
  db.seed('workspaces', [
    {
      id: WORKSPACE,
      name: 'Lumina workspace',
      client_email: 'ana@example.com',
      client_name: 'Ana',
      client_business_name: 'Lumina Dental',
    },
  ]);
});

describe('notifyClientBookingPageReady', () => {
  it('sends the booking page notice with both links in it', async () => {
    const result = await notifyClientBookingPageReady(notice());

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const sent = sendEmail.mock.calls[0]?.[0] as {
      to: string;
      subject: string;
      html: string;
      text: string;
    };
    expect(sent.to).toBe('ana@example.com');
    expect(sent.subject).toBe('Your booking page is ready');
    expect(sent.html).toContain('Lumina Dental');
    expect(sent.html).toContain(BOOKING_URL);
    // The single button, which is the only thing they cannot do without us
    // telling them where to go.
    expect(sent.html).toContain(`class="fs-button" href="${PASSWORD_URL}"`);
    expect(sent.text).toContain(BOOKING_URL);
  });

  it('records which page it was about, for the operator', async () => {
    await notifyClientBookingPageReady(notice());

    const events = db.rows('project_events') as Array<{
      kind: string;
      payload: Record<string, unknown>;
    }>;
    expect(events).toHaveLength(1);
    expect(events[0]?.kind).toBe(CLIENT_EMAIL_EVENT);
    expect(events[0]?.payload).toMatchObject({
      notification: 'cal_provisioned',
      // No key at all: one booking page per workspace, forever.
      dedupeKey: null,
      bookingUrl: BOOKING_URL,
      passwordSetupUrl: PASSWORD_URL,
    });
  });

  it('says it once per workspace, whatever re-runs provisioning', async () => {
    await notifyClientBookingPageReady(notice());
    const second = await notifyClientBookingPageReady(notice());

    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  // Even a genuinely different link does not earn a second email: the client
  // has one booking page, and a changed URL is a repair, not news.
  it('stays silent even when the booking url has changed', async () => {
    await notifyClientBookingPageReady(notice());
    const again = await notifyClientBookingPageReady(
      notice({ bookingUrl: 'https://cal.flowstarter.dev/lumina-2/intro-call' })
    );

    expect(again).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('does not throw when RESEND_API_KEY is missing, and can still retry', async () => {
    sendEmail.mockResolvedValue({
      success: false,
      error: 'RESEND_API_KEY is not set',
    });

    await expect(notifyClientBookingPageReady(notice())).resolves.toEqual({
      sent: false,
      reason: 'send_failed',
    });
    // Nothing under the marker kind, so the dashboard retry still delivers it
    // once a key is configured.
    expect(
      db.rows('project_events').filter((row) => row.kind === CLIENT_EMAIL_EVENT)
    ).toEqual([]);
    expect(
      db
        .rows('project_events')
        .filter((row) => row.kind === CLIENT_EMAIL_FAILED_EVENT)
    ).toHaveLength(1);

    sendEmail.mockResolvedValue({ success: true });
    expect(await notifyClientBookingPageReady(notice())).toEqual({
      sent: true,
    });
  });

  it('reports a workspace with no address rather than failing the caller', async () => {
    db.tables['workspaces'] = [
      { id: WORKSPACE, name: 'Lumina workspace', client_email: null },
    ];

    await expect(notifyClientBookingPageReady(notice())).resolves.toEqual({
      sent: false,
      reason: 'no_recipient',
    });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});
