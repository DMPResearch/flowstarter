/**
 * `sendOpsAlert` is the non-pure half: it reads `alerts.ts`'s dedupe decision
 * off a real `ops_alerts` row (via the shared in-memory Postgrest stand-in,
 * for the same reason `client-notifications.test.ts` uses it rather than a
 * stub: the select-then-write IS the dedupe story), sends through Resend, and
 * writes the row back. Like `notifyClientOnce`, it must never throw.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeSupabase } from '../../flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

import { sendOpsAlert } from '../send-ops-alert';

type FakeClient = Parameters<typeof sendOpsAlert>[0]['supabase'];
const supabase = db.client as unknown as FakeClient;

let errors: string[] = [];

beforeEach(() => {
  db.reset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
  errors = [];
  vi.spyOn(console, 'error').mockImplementation((...a) =>
    errors.push(a.join(' '))
  );
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  process.env.OPERATOR_ALERT_EMAIL = 'ops@example.com';
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.OPERATOR_ALERT_EMAIL;
  delete process.env.OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES;
});

function alert(overrides: Partial<Parameters<typeof sendOpsAlert>[0]> = {}) {
  return sendOpsAlert({
    supabase,
    event: 'build_job_failed',
    discriminator: 'job-1',
    title: 'Build job job-1 failed',
    detail: { jobId: 'job-1' },
    ...overrides,
  });
}

describe('sendOpsAlert', () => {
  it('sends the first occurrence and records it', async () => {
    const result = await alert();

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        to: 'ops@example.com',
        subject: expect.stringContaining('Build job job-1 failed'),
      })
    );

    const rows = db.rows('ops_alerts');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      dedupe_key: 'build_job_failed:job-1',
      event: 'build_job_failed',
      severity: 'critical',
      occurrence_count: 1,
    });
  });

  it('suppresses a second occurrence inside the dedupe window without emailing again', async () => {
    await alert();
    sendEmail.mockClear();
    const second = await alert();

    expect(second).toEqual({ sent: false, reason: 'suppressed' });
    expect(sendEmail).not.toHaveBeenCalled();

    const rows = db.rows('ops_alerts');
    expect(rows).toHaveLength(1);
    // Still counted, even though nothing was sent.
    expect(rows[0]).toMatchObject({ occurrence_count: 2 });
  });

  it('sends again once a shortened dedupe window has elapsed', async () => {
    process.env.OPS_ALERT_BUILD_JOB_FAILED_DEDUPE_MINUTES = '5';
    const first = new Date('2026-09-12T12:00:00.000Z');
    await alert({ now: first });
    sendEmail.mockClear();

    const stillWithin = new Date(first.getTime() + 2 * 60_000);
    const suppressed = await alert({ now: stillWithin });
    expect(suppressed).toEqual({ sent: false, reason: 'suppressed' });

    const afterWindow = new Date(first.getTime() + 6 * 60_000);
    const resent = await alert({ now: afterWindow });
    expect(resent).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
  });

  it('treats a different discriminator as a different alert entirely', async () => {
    await alert({ discriminator: 'job-1' });
    const other = await alert({ discriminator: 'job-2' });

    expect(other).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(db.rows('ops_alerts')).toHaveLength(2);
  });

  it('does not send, and says so, when OPERATOR_ALERT_EMAIL is not configured', async () => {
    delete process.env.OPERATOR_ALERT_EMAIL;
    const result = await alert();

    expect(result).toEqual({ sent: false, reason: 'no_operator_email' });
    expect(sendEmail).not.toHaveBeenCalled();
    // No row either: nothing to dedupe against yet if this keeps failing to
    // configure, and the next real attempt should try again from scratch.
    expect(db.rows('ops_alerts')).toHaveLength(0);
    expect(errors.join('\n')).toContain('OPERATOR_ALERT_EMAIL is not set');
  });

  it('does not throw, and does not record, when the send fails', async () => {
    sendEmail.mockResolvedValueOnce({ success: false, error: 'rate limited' });
    const result = await alert();

    expect(result).toEqual({ sent: false, reason: 'send_failed' });
    expect(db.rows('ops_alerts')).toHaveLength(0);

    const retried = await alert();
    expect(retried).toEqual({ sent: true });
  });

  it('never throws when the lookup itself fails', async () => {
    db.failing.add('ops_alerts');
    const result = await alert();

    expect(result).toEqual({ sent: false, reason: 'error' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('carries the caller detail onto the email and the record', async () => {
    await alert({ detail: { jobId: 'job-1', errorCode: 'VALIDATION_FAILED' } });
    expect(sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        html: expect.stringContaining('VALIDATION_FAILED'),
      })
    );
    expect(db.rows('ops_alerts')[0]!.detail).toMatchObject({
      errorCode: 'VALIDATION_FAILED',
    });
  });
});
