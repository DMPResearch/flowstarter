/**
 * "Your change is live", from the one place a change actually goes live.
 *
 * The sixth client notice, and the one the product owed a client who paid
 * EUR 190 on 2026-09-12 for a change it had no route to make and therefore no
 * moment at which to say anything about.
 *
 * It hangs off the deploy for the same reason `notifySiteLive` does: the
 * deploy is where a site becomes reachable, and a notice attached anywhere
 * earlier is a promise made before the thing it promises is true. It is keyed
 * on the request id, so a client hears once per thing they bought.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase, type Row } from './fake-hosting-supabase';

vi.mock('server-only', () => ({}));

const sendEmail = vi.fn();
vi.mock('@/lib/email', () => ({
  sendEmail: (...args: unknown[]) => sendEmail(...args),
}));

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => {
    throw new Error('service-role client should not be used here');
  },
}));

import { notifyChangeRequestLive } from '../change-request-live-email';

const WS = '0f4e1088-8d8f-4f18-83b1-000000000001';
const CHANGE_ID = '72fe7f79-0e83-4cf6-9b4a-2502842b9a54';
const REQUEST =
  'Please add a small gallery to the Flowstarter case study page with the ' +
  'three other screenshots I uploaded.';

function workspaceRow(overrides: Row = {}): Row {
  return {
    id: WS,
    slug: 'acme',
    name: 'Acme workspace',
    client_email: 'client@example.com',
    client_name: 'Darius',
    client_business_name: 'Acme Dental',
    ...overrides,
  };
}

let db: ReturnType<typeof createFakeHostingSupabase>;

beforeEach(() => {
  db = createFakeHostingSupabase();
  sendEmail.mockReset();
  sendEmail.mockResolvedValue({ success: true, id: 'em_1' });
  vi.spyOn(console, 'info').mockImplementation(() => undefined);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  db.seed('workspaces', [workspaceRow()]);
  db.seed('flowstarter_change_requests', [
    { id: CHANGE_ID, workspace_id: WS, request: REQUEST, status: 'done' },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
  delete process.env.NEXT_PUBLIC_SITE_URL;
});

describe('notifyChangeRequestLive', () => {
  it("quotes the client's own request back to them, with the version", async () => {
    process.env.NEXT_PUBLIC_SITE_URL = 'https://flowstarter.dev';

    const sent = await notifyChangeRequestLive({
      supabase: db.client as never,
      workspaceId: WS,
      changeRequestId: CHANGE_ID,
      version: 5,
    });

    expect(sent).toBe(true);
    const mail = sendEmail.mock.calls[0]![0] as {
      to: string;
      subject: string;
      html: string;
    };
    expect(mail.to).toBe('client@example.com');
    expect(mail.subject).toBe('Your change is live');
    // Their sentence, not ours: they wrote it and they paid against it.
    expect(mail.html).toContain('add a small gallery');
    expect(mail.html).toContain('version 5');
    expect(mail.html).toContain('Acme Dental');
    expect(mail.html).toContain(
      `https://flowstarter.dev/dashboard/projects/${WS}`
    );
  });

  it('sends once per request, however many times the deploy runs', async () => {
    await notifyChangeRequestLive({
      supabase: db.client as never,
      workspaceId: WS,
      changeRequestId: CHANGE_ID,
      version: 5,
    });
    const second = await notifyChangeRequestLive({
      supabase: db.client as never,
      workspaceId: WS,
      changeRequestId: CHANGE_ID,
      version: 5,
    });

    expect(second).toBe(false);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    // The ledger row is written only after a genuinely successful send.
    const events = db.rows('project_events') as Array<{ payload: Row }>;
    expect(events).toHaveLength(1);
    expect(events[0]!.payload).toMatchObject({
      notification: 'change_request_live',
      dedupeKey: CHANGE_ID,
      version: 5,
    });
  });

  it('says nothing about a request that is not on this workspace', async () => {
    const sent = await notifyChangeRequestLive({
      supabase: db.client as never,
      workspaceId: WS,
      changeRequestId: '11111111-1111-4111-8111-111111111111',
      version: 5,
    });

    expect(sent).toBe(false);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it('reports a refused send instead of throwing into the deploy', async () => {
    // The contract every client notice is written to: a mail problem must
    // never turn a deploy that worked into a deploy reported as failed.
    sendEmail.mockResolvedValue({
      success: false,
      error: 'API key is invalid',
    });
    vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const sent = await notifyChangeRequestLive({
      supabase: db.client as never,
      workspaceId: WS,
      changeRequestId: CHANGE_ID,
      version: 5,
    });

    expect(sent).toBe(false);
    // Nothing recorded, so the notice is still retryable once the mailer works.
    expect(db.rows('project_events')).toHaveLength(0);
  });
});
