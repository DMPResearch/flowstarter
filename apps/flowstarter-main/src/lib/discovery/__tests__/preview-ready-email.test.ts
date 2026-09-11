/**
 * The one email in this set that goes out before there is a workspace, an
 * account or a payment (see preview-ready-email.ts). It cannot use
 * `project_events` as its ledger, so the guard against mailing a visitor
 * twice is a timestamp on the in-memory live job instead. These tests cover
 * that guard, the link-resolution rules that decide what gets put in the
 * email, and that a Resend outage never turns into a thrown exception on the
 * generator's happy path.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/email', () => ({
  sendEmail: vi.fn(async () => ({ success: true, id: 'email-1' })),
}));

import { sendEmail } from '@/lib/email';
import { createJob, getJob, updateJob } from '@/lib/discovery/live-jobs';
import {
  emailablePreviewUrl,
  sendPreviewReadyEmail,
} from '../preview-ready-email';

const sendEmailMock = vi.mocked(sendEmail);

type GlobalJobStore = typeof globalThis & {
  __flowstarterLiveJobs?: Map<string, unknown>;
};

function resetGlobalState(): void {
  (globalThis as GlobalJobStore).__flowstarterLiveJobs?.clear();
}

const ORIGINAL_SITE_URL = process.env.NEXT_PUBLIC_SITE_URL;

describe('emailablePreviewUrl', () => {
  afterEach(() => {
    if (ORIGINAL_SITE_URL === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
    }
  });

  it('prefers the durable hosted copy over the sandbox url', () => {
    const url = emailablePreviewUrl('demo-1', {
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
      previewUrl: 'https://abc.daytonaproxy01.net/site',
    });
    expect(url).toBe('https://p-abc123.preview.flowstarter.net');
  });

  it('falls back to an absolute sandbox previewUrl when there is no hosted copy', () => {
    const url = emailablePreviewUrl('demo-2', {
      previewUrl: 'https://abc.daytonaproxy01.net/site',
    });
    expect(url).toBe('https://abc.daytonaproxy01.net/site');
  });

  it('turns a loopback previewUrl into a public frame url once a site origin exists', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
    const url = emailablePreviewUrl('demo-3', {
      previewUrl: 'http://127.0.0.1:8910',
    });
    expect(url).toBe(
      'http://localhost:3000/api/discovery/preview/live/frame/demo-3'
    );
  });

  it('returns null for a loopback previewUrl when NEXT_PUBLIC_SITE_URL is unset', () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    const url = emailablePreviewUrl('demo-4', {
      previewUrl: 'http://127.0.0.1:8910',
    });
    expect(url).toBeNull();
  });

  it('returns null when the job has no previewUrl at all', () => {
    const url = emailablePreviewUrl('demo-5', {});
    expect(url).toBeNull();
  });

  it('rejects a non-http NEXT_PUBLIC_SITE_URL, e.g. ftp, even for a loopback preview', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'ftp://x';
    const url = emailablePreviewUrl('demo-6', {
      previewUrl: 'http://127.0.0.1:8910',
    });
    expect(url).toBeNull();
  });

  it('rejects a plain-http NEXT_PUBLIC_SITE_URL whose host is not loopback', () => {
    // http is only trusted for localhost/127.0.0.1 (dev); a real hostname
    // over http would put a mixed-content, spoofable link in the email.
    process.env.NEXT_PUBLIC_SITE_URL = 'http://example.com';
    const url = emailablePreviewUrl('demo-7', {
      previewUrl: 'http://127.0.0.1:8910',
    });
    expect(url).toBeNull();
  });
});

describe('sendPreviewReadyEmail', () => {
  beforeEach(() => {
    resetGlobalState();
    sendEmailMock.mockClear();
    sendEmailMock.mockResolvedValue({ success: true, id: 'email-1' });
    process.env.NEXT_PUBLIC_SITE_URL = 'http://localhost:3000';
  });

  afterEach(() => {
    resetGlobalState();
    if (ORIGINAL_SITE_URL === undefined) {
      delete process.env.NEXT_PUBLIC_SITE_URL;
    } else {
      process.env.NEXT_PUBLIC_SITE_URL = ORIGINAL_SITE_URL;
    }
  });

  it('returns unknown_job for a demoId with no job in the store', async () => {
    const outcome = await sendPreviewReadyEmail('does-not-exist');
    expect(outcome).toBe('unknown_job');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns no_email when the job never collected a leadEmail', async () => {
    createJob('no-email-job');
    updateJob('no-email-job', {
      hostedPreviewUrl: 'https://p-abc.preview.flowstarter.net',
    });

    const outcome = await sendPreviewReadyEmail('no-email-job');
    expect(outcome).toBe('no_email');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns no_email for a malformed address, as the last-line-of-defence regex is meant to', async () => {
    createJob('bad-email-job');
    updateJob('bad-email-job', {
      leadEmail: 'not-an-address',
      hostedPreviewUrl: 'https://p-abc.preview.flowstarter.net',
    });

    const outcome = await sendPreviewReadyEmail('bad-email-job');
    expect(outcome).toBe('no_email');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('returns no_link when the ready site has no url that works outside the browser tab', async () => {
    delete process.env.NEXT_PUBLIC_SITE_URL;
    createJob('no-link-job');
    updateJob('no-link-job', {
      leadEmail: 'client@example.com',
      previewUrl: 'http://127.0.0.1:8910', // loopback, and no public origin to rewrite it against
    });

    const outcome = await sendPreviewReadyEmail('no-link-job');
    expect(outcome).toBe('no_link');
    expect(sendEmailMock).not.toHaveBeenCalled();
  });

  it('sends the email with the resolved preview link and the business name in the html', async () => {
    createJob('sent-job');
    updateJob('sent-job', {
      leadEmail: 'client@example.com',
      leadName: 'Priya',
      businessName: 'Priya’s Bakery',
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
    });

    const outcome = await sendPreviewReadyEmail('sent-job');

    expect(outcome).toBe('sent');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
    const call = sendEmailMock.mock.calls[0][0];
    expect(call.to).toBe('client@example.com');
    expect(call.subject).toBe('Your preview is ready');
    expect(call.html).toContain('https://p-abc123.preview.flowstarter.net');
    expect(call.html).toContain('Priya’s Bakery');
  });

  it('returns already_sent on a second call for a job that already sent', async () => {
    createJob('twice-job');
    updateJob('twice-job', {
      leadEmail: 'client@example.com',
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
    });

    const first = await sendPreviewReadyEmail('twice-job');
    const second = await sendPreviewReadyEmail('twice-job');

    expect(first).toBe('sent');
    expect(second).toBe('already_sent');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });

  it('returns send_failed when the mailer resolves success: false', async () => {
    sendEmailMock.mockResolvedValueOnce({
      success: false,
      error: 'Resend rejected the request',
    });
    createJob('send-failed-job');
    updateJob('send-failed-job', {
      leadEmail: 'client@example.com',
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
    });

    const outcome = await sendPreviewReadyEmail('send-failed-job');
    expect(outcome).toBe('send_failed');
  });

  it('returns send_failed, and never throws, when the mailer itself rejects', async () => {
    sendEmailMock.mockRejectedValueOnce(new Error('network is down'));
    createJob('throwing-mailer-job');
    updateJob('throwing-mailer-job', {
      leadEmail: 'client@example.com',
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
    });

    const outcome = sendPreviewReadyEmail('throwing-mailer-job');
    await expect(outcome).resolves.toBeDefined();
    await expect(outcome).resolves.toBe('send_failed');
  });

  it('marks readyEmailAt before the send resolves, so a failed send still blocks a retry', async () => {
    // The source sets readyEmailAt ahead of `await sendEmail(...)`, on
    // purpose, because the point of the flag is to stop a second caller that
    // arrives during the seconds the send takes -- not just after a
    // successful one. A failed send therefore also leaves the job claimed,
    // which is what this asserts: a second call after a failed first call
    // reports already_sent rather than trying again.
    sendEmailMock.mockResolvedValueOnce({ success: false, error: 'down' });
    createJob('claim-before-send-job');
    updateJob('claim-before-send-job', {
      leadEmail: 'client@example.com',
      hostedPreviewUrl: 'https://p-abc123.preview.flowstarter.net',
    });

    const first = await sendPreviewReadyEmail('claim-before-send-job');
    expect(first).toBe('send_failed');
    expect(getJob('claim-before-send-job')?.readyEmailAt).toBeDefined();

    const second = await sendPreviewReadyEmail('claim-before-send-job');
    expect(second).toBe('already_sent');
    expect(sendEmailMock).toHaveBeenCalledTimes(1);
  });
});
