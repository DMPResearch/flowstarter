/**
 * The once-only client mailer.
 *
 * Two properties matter here and neither is visible by reading the call sites,
 * which is why they are pinned:
 *
 *   1. It never throws. Every caller is inside a Stripe webhook, a deploy or a
 *      detached generator, and in all three a thrown error is worse than a
 *      missing email: Stripe retries a 500 for days, and a deploy that worked
 *      would be reported as failed.
 *   2. It sends once. A redelivered Stripe event, a re-run deploy and an
 *      operator pressing a button twice all land here again, and a client who
 *      receives the same mail twice stops trusting any of them.
 *
 * The ledger is exercised for real against the shared in-memory Postgrest
 * stand-in rather than stubbed, because the select-then-insert IS the
 * idempotency story and a stub would prove nothing about it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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

// The operator alert is a separate module with its own tests
// (lib/ops/__tests__/send-ops-alert.test.ts). Here it is a spy: these tests
// only need to know that a failed send raises one, with the right shape, not
// re-prove its dedupe or its email content.
const sendOpsAlert = vi.fn().mockResolvedValue({ sent: true });
vi.mock('@/lib/ops/send-ops-alert', () => ({
  sendOpsAlert: (...args: unknown[]) => sendOpsAlert(...args),
}));

import {
  CLIENT_EMAIL_EVENT,
  CLIENT_EMAIL_FAILED_EVENT,
  clientDashboardUrl,
  notifyClientOnce,
} from '../client-notifications';

const WORKSPACE = '11111111-1111-4111-8111-111111111111';

type FakeClient = Parameters<typeof notifyClientOnce>[0]['supabase'];
const supabase = db.client as unknown as FakeClient;

function seedWorkspace(overrides: Record<string, unknown> = {}): void {
  db.seed('workspaces', [
    {
      id: WORKSPACE,
      name: 'Acme workspace',
      client_email: 'client@example.com',
      client_name: 'Darius',
      client_business_name: 'Acme Dental',
      ...overrides,
    },
  ]);
}

type Render = NonNullable<Parameters<typeof notifyClientOnce>[0]['render']>;
const render: Render = () => ({
  subject: 'Subject line',
  preheader: 'The line under the subject',
  html: '<p>Body</p>',
  text: 'Body',
});

async function notify(
  extra: Partial<Parameters<typeof notifyClientOnce>[0]> = {}
) {
  return notifyClientOnce({
    supabase,
    workspaceId: WORKSPACE,
    notification: 'deposit_paid',
    render,
    ...extra,
  });
}

let errors: string[] = [];
let warnings: string[] = [];

beforeEach(() => {
  db.reset();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
  sendOpsAlert.mockClear();
  sendOpsAlert.mockResolvedValue({ sent: true });
  errors = [];
  warnings = [];
  vi.spyOn(console, 'error').mockImplementation((...a) =>
    errors.push(a.join(' '))
  );
  vi.spyOn(console, 'warn').mockImplementation((...a) =>
    warnings.push(a.join(' '))
  );
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
  delete process.env.NEXT_PUBLIC_APP_URL;
});

describe('clientDashboardUrl', () => {
  it('prefers the configured site origin and trims its trailing slashes', () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://www.flowstarter.dev//';
    expect(clientDashboardUrl(WORKSPACE)).toBe(
      `https://www.flowstarter.dev/dashboard/projects/${WORKSPACE}`
    );
  });

  it('falls back to the app origin, then to production', () => {
    process.env.NEXT_PUBLIC_APP_URL = 'https://app.example';
    expect(clientDashboardUrl(WORKSPACE)).toBe(
      `https://app.example/dashboard/projects/${WORKSPACE}`
    );
    delete process.env.NEXT_PUBLIC_APP_URL;
    // Never a relative path: an email is read outside any tab we control, so
    // a relative link is not degraded, it is broken.
    expect(clientDashboardUrl(WORKSPACE)).toMatch(
      /^https:\/\/flowstarter\.net/
    );
  });
});

describe('notifyClientOnce', () => {
  it('sends to the workspace client and records it in the ledger', async () => {
    seedWorkspace();
    const result = await notify();

    expect(result).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The text part goes with it: every template renders one, and a message
    // sent without it is HTML-only to a reader that shows text.
    expect(sendEmail).toHaveBeenCalledWith({
      to: 'client@example.com',
      subject: 'Subject line',
      html: '<p>Body</p>',
      text: 'Body',
    });

    const ledger = db.rows('project_events');
    expect(ledger).toHaveLength(1);
    expect(ledger[0]).toMatchObject({
      workspace_id: WORKSPACE,
      kind: CLIENT_EMAIL_EVENT,
      actor: 'system:client_email',
    });
    expect(ledger[0]!.payload).toMatchObject({
      notification: 'deposit_paid',
      dedupeKey: null,
      subject: 'Subject line',
    });
  });

  it('hands the template the client name, business name and dashboard link', async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flowstarter.dev';
    seedWorkspace();
    const seen = vi.fn(render);
    await notify({ render: seen });

    expect(seen).toHaveBeenCalledWith({
      workspaceId: WORKSPACE,
      email: 'client@example.com',
      clientName: 'Darius',
      businessName: 'Acme Dental',
      dashboardUrl: `https://flowstarter.dev/dashboard/projects/${WORKSPACE}`,
    });
  });

  it('falls back to the workspace name when there is no business name', async () => {
    seedWorkspace({ client_business_name: null });
    const seen = vi.fn(render);
    await notify({ render: seen });
    expect(seen.mock.calls[0]![0]).toMatchObject({
      businessName: 'Acme workspace',
    });
  });

  it('does not send a second time when the event is redelivered', async () => {
    seedWorkspace();
    await notify();
    const second = await notify();

    expect(second).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(db.rows('project_events')).toHaveLength(1);
  });

  it('treats a different dedupe key as a different thing to say', async () => {
    seedWorkspace();
    await notify({ notification: 'site_live', dedupeKey: '1' });
    const nextVersion = await notify({
      notification: 'site_live',
      dedupeKey: '2',
    });
    const sameVersion = await notify({
      notification: 'site_live',
      dedupeKey: '2',
    });

    expect(nextVersion).toEqual({ sent: true });
    expect(sameVersion).toEqual({ sent: false, reason: 'already_sent' });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('does not confuse two notifications that share a workspace', async () => {
    seedWorkspace();
    await notify({ notification: 'deposit_paid' });
    const balance = await notify({
      notification: 'balance_invoice',
      dedupeKey: 'in_1',
    });
    expect(balance).toEqual({ sent: true });
    expect(sendEmail).toHaveBeenCalledTimes(2);
  });

  it('sends nothing, and says so, when the workspace has no address', async () => {
    seedWorkspace({ client_email: '   ' });
    const result = await notify();

    expect(result).toEqual({ sent: false, reason: 'no_recipient' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(db.rows('project_events')).toHaveLength(0);
    // An operator can close this gap in one edit, so it has to be findable.
    expect(warnings.join('\n')).toContain('no client_email');
  });

  it('sends nothing when the workspace is gone', async () => {
    const result = await notify();
    expect(result).toEqual({ sent: false, reason: 'workspace_missing' });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('does not consume the notice when the mailer is unconfigured', async () => {
    seedWorkspace();
    sendEmail.mockResolvedValueOnce({
      success: false,
      error: 'Email service not configured',
    });
    const failed = await notify();

    expect(failed).toEqual({ sent: false, reason: 'send_failed' });
    // Nothing recorded under CLIENT_EMAIL_EVENT, so setting RESEND_API_KEY
    // and replaying the event still reaches the client rather than being
    // permanently swallowed.
    expect(
      db.rows('project_events').filter((row) => row.kind === CLIENT_EMAIL_EVENT)
    ).toHaveLength(0);

    const retried = await notify();
    expect(retried).toEqual({ sent: true });
  });

  it('records the failed attempt under a different event, so history survives even though the retry still works', async () => {
    seedWorkspace();
    sendEmail.mockResolvedValueOnce({
      success: false,
      error: 'Email service not configured',
    });
    await notify();

    const failedRows = db
      .rows('project_events')
      .filter((row) => row.kind === CLIENT_EMAIL_FAILED_EVENT);
    expect(failedRows).toHaveLength(1);
    expect(failedRows[0]).toMatchObject({
      workspace_id: WORKSPACE,
      kind: CLIENT_EMAIL_FAILED_EVENT,
    });
    expect(failedRows[0]!.payload).toMatchObject({
      notification: 'deposit_paid',
      error: 'Email service not configured',
    });
  });

  it('raises an operator alert when a client email fails to send', async () => {
    seedWorkspace();
    sendEmail.mockResolvedValueOnce({ success: false, error: 'rate limited' });
    await notify({ notification: 'site_live', dedupeKey: 'v3' });

    expect(sendOpsAlert).toHaveBeenCalledTimes(1);
    expect(sendOpsAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        event: 'client_email_failed',
        workspaceId: WORKSPACE,
        detail: expect.objectContaining({
          workspaceId: WORKSPACE,
          notification: 'site_live',
          dedupeKey: 'v3',
          error: 'rate limited',
        }),
      })
    );
  });

  it('does not raise an operator alert when the email sends fine', async () => {
    seedWorkspace();
    await notify();
    expect(sendOpsAlert).not.toHaveBeenCalled();
  });

  it('never throws when the workspace lookup fails', async () => {
    seedWorkspace();
    db.failing.add('workspaces');
    const result = await notify();

    expect(result).toEqual({ sent: false, reason: 'lookup_failed' });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(errors.join('\n')).toContain('could not notify workspace');
  });

  it('never throws when the ledger read fails', async () => {
    seedWorkspace();
    db.failing.add('project_events');
    await expect(notify()).resolves.toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });

  it('never throws when the mailer itself throws', async () => {
    seedWorkspace();
    sendEmail.mockRejectedValueOnce(new Error('socket hang up'));
    await expect(notify()).resolves.toEqual({
      sent: false,
      reason: 'lookup_failed',
    });
  });

  it('reports the email as sent even if the marker cannot be written', async () => {
    seedWorkspace();
    const realInsert = db.client.from;
    // The mail is already gone. Failing here would turn one lost ledger row
    // into a second copy of an email the client has read.
    let reads = 0;
    vi.spyOn(db.client, 'from').mockImplementation((table: string) => {
      if (table === 'project_events') {
        reads += 1;
        if (reads > 1) db.failing.add('project_events');
      }
      return realInsert.call(db.client, table) as never;
    });

    await expect(notify()).resolves.toEqual({ sent: true });
    expect(errors.join('\n')).toContain('but could not record it');
  });

  it('writes the caller detail onto the ledger row for an operator', async () => {
    seedWorkspace();
    await notify({
      notification: 'site_live',
      dedupeKey: '3',
      detail: { version: 3, siteUrl: 'https://acme.example' },
    });
    expect(db.rows('project_events')[0]!.payload).toMatchObject({
      notification: 'site_live',
      dedupeKey: '3',
      version: 3,
      siteUrl: 'https://acme.example',
    });
  });

  it('falls back to the service-role client when none is passed', async () => {
    seedWorkspace();
    const result = await notifyClientOnce({
      workspaceId: WORKSPACE,
      notification: 'deposit_paid',
      render,
    });
    expect(result).toEqual({ sent: true });
  });
});
