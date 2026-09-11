// @vitest-environment node
/**
 * The client's own Cal.com connection, through the REAL route handlers.
 *
 * Four things are defended here:
 *
 *  1. TENANCY. Every handler queries with the service role, which bypasses
 *     RLS, so `requireWorkspaceAccess` running first is the entire boundary.
 *     The cross-tenant case asserts the 404 *and* that the other workspace's
 *     row was not read or written: a 404 that still saved a link would be a
 *     green test and a live leak.
 *  2. WHAT MAY BE STORED. The value ends up in the client's built site, so it
 *     is normalized to a cal.com link or refused. A link on somebody else's
 *     host is not "close enough"; it is a different vendor's page embedded in
 *     the client's own site.
 *  3. THE SECRET. One is minted on the first connect and survives later edits,
 *     because the client has already pasted it into Cal.com. Disconnecting
 *     clears it, and the next connect hands out a new one.
 *  4. WHOSE LINK IT IS. The point of the column is that a client's site books
 *     into the client's calendar, never a shared Flowstarter one.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and the app's tsconfig does
// not allow top-level await in tests.
import { DELETE, GET, PATCH } from '../route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';

// ── Clerk ──────────────────────────────────────────────────────────────────
// Mirrors src/lib/__tests__/workspace-access.test.ts.
const authState: { userId: string | null; role: string | undefined } = {
  userId: 'user_client_a',
  role: undefined,
};

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({
    userId: authState.userId,
    sessionClaims: { metadata: { role: authState.role } },
    getToken: async () => 'test-token',
  }),
  clerkClient: async () => ({
    users: {
      getUser: async () => ({
        publicMetadata: { role: authState.role },
        emailAddresses: [],
        primaryEmailAddressId: null,
      }),
    },
  }),
  currentUser: async () => null,
}));

// One client backs the membership lookup and the route's own queries — same
// module, same import, in production and here.
const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

function params(workspaceId: string) {
  return { params: Promise.resolve({ workspaceId }) };
}

function get(workspaceId: string): NextRequest {
  return new NextRequest(`http://localhost/api/client/booking/${workspaceId}`);
}

function del(workspaceId: string): NextRequest {
  return new NextRequest(`http://localhost/api/client/booking/${workspaceId}`, {
    method: 'DELETE',
  });
}

function patch(workspaceId: string, body: unknown, raw?: string): NextRequest {
  return new NextRequest(`http://localhost/api/client/booking/${workspaceId}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body),
  });
}

function workspaceRow(id: string, calComUrl: string | null) {
  return {
    id,
    name: 'Halden & Roe',
    slug: 'halden-roe',
    cal_com_url: calComUrl,
    cal_com_webhook_secret: null as string | null,
  };
}

function rowOf(workspaceId: string) {
  return db.rows('workspaces').find((row) => row.id === workspaceId);
}

function calUrlOf(workspaceId: string): unknown {
  return rowOf(workspaceId)?.['cal_com_url'];
}

function secretOf(workspaceId: string): unknown {
  return rowOf(workspaceId)?.['cal_com_webhook_secret'];
}

beforeEach(() => {
  db.reset();
  authState.userId = 'user_client_a';
  authState.role = undefined;
  db.seed('workspaces', [
    workspaceRow(WORKSPACE_A, null),
    workspaceRow(WORKSPACE_B, 'https://cal.com/someone-else/intro'),
  ]);
  db.seed('workspace_memberships', [
    { workspace_id: WORKSPACE_A, clerk_user_id: 'user_client_a' },
  ]);
});

describe('a booking link that is not yours', () => {
  it('is 404 on read, on write and on disconnect, and B is untouched', async () => {
    const read = await GET(get(WORKSPACE_B), params(WORKSPACE_B));
    expect(read.status).toBe(404);

    const write = await PATCH(
      patch(WORKSPACE_B, { calComUrl: 'https://cal.com/attacker/intro' }),
      params(WORKSPACE_B)
    );
    expect(write.status).toBe(404);

    const removed = await DELETE(del(WORKSPACE_B), params(WORKSPACE_B));
    expect(removed.status).toBe(404);

    // The assertion that actually matters.
    expect(calUrlOf(WORKSPACE_B)).toBe('https://cal.com/someone-else/intro');
    expect(db.rows('project_events')).toHaveLength(0);
  });

  it('asks a signed-out caller to sign in rather than pretending it is missing', async () => {
    authState.userId = null;
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(401);
  });

  it('refuses a workspace id that is not one', async () => {
    const response = await GET(get('not-a-uuid'), params('not-a-uuid'));
    expect(response.status).toBe(400);
    expect((await response.json()).code).toBe('BAD_REQUEST');
  });
});

describe('reading the connection', () => {
  it('reports not connected, with a webhook url, before anything is set', async () => {
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      connected: false,
      calComUrl: '',
      embedSrc: null,
      webhookUrl: `https://flowstarter.net/api/integrations/cal/${WORKSPACE_A}`,
      webhookSecret: null,
    });
  });

  it('returns the workspace’s own link and the embed for it', async () => {
    const workspace = rowOf(WORKSPACE_A);
    if (workspace) {
      workspace['cal_com_url'] = 'https://cal.com/halden-roe/intro';
      workspace['cal_com_webhook_secret'] = 'a'.repeat(64);
    }

    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(await response.json()).toMatchObject({
      connected: true,
      calComUrl: 'https://cal.com/halden-roe/intro',
      embedSrc:
        'https://cal.com/halden-roe/intro/embed?layout=month_view&theme=light',
      webhookSecret: 'a'.repeat(64),
    });
  });

  it('says the workspace is missing when the row has gone', async () => {
    db.tables['workspaces'] = db
      .rows('workspaces')
      .filter((row) => row.id !== WORKSPACE_A);
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(404);
    expect((await response.json()).error).toBe('Workspace not found');
  });

  it('reports a failure to read rather than an empty link', async () => {
    // An empty string here would read as "you have not set one", and the
    // client would be told to do work they have already done.
    db.failing.add('workspaces');
    const response = await GET(get(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe('Could not load booking');
  });
});

describe('connecting a calendar', () => {
  it('stores a bare handle as the full cal.com link and mints a secret', async () => {
    const response = await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body).toMatchObject({
      connected: true,
      calComUrl: 'https://cal.com/halden-roe/intro',
    });
    // 32 bytes of hex, which is the full width of the HMAC it keys.
    expect(body.webhookSecret).toMatch(/^[0-9a-f]{64}$/);
    expect(calUrlOf(WORKSPACE_A)).toBe('https://cal.com/halden-roe/intro');
    expect(secretOf(WORKSPACE_A)).toBe(body.webhookSecret);

    const [event] = db.rows('project_events');
    expect(event).toMatchObject({
      workspace_id: WORKSPACE_A,
      kind: 'booking_cal_connected',
      // From the session, never from the body.
      actor: 'user_client_a',
    });
    // The secret is never in a ledger row: those are read by operators and
    // rendered in admin screens.
    expect(JSON.stringify(event['payload'])).not.toContain(body.webhookSecret);
  });

  it('normalizes a full url down to the same stored value', async () => {
    await PATCH(
      patch(WORKSPACE_A, {
        calComUrl: 'https://app.cal.com/halden-roe/intro?month=2026-09',
      }),
      params(WORKSPACE_A)
    );
    expect(calUrlOf(WORKSPACE_A)).toBe('https://cal.com/halden-roe/intro');
  });

  // The client has already pasted the secret into Cal.com. Rotating it on a
  // link edit would break their webhook without telling them.
  it('keeps the existing secret when the link is changed', async () => {
    await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    const first = secretOf(WORKSPACE_A);

    await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/discovery' }),
      params(WORKSPACE_A)
    );
    expect(calUrlOf(WORKSPACE_A)).toBe('https://cal.com/halden-roe/discovery');
    expect(secretOf(WORKSPACE_A)).toBe(first);
  });

  it('refuses a calendar on somebody else’s host', async () => {
    // The value is embedded in the client's own site. A different vendor's
    // page is not a near miss, it is a different page.
    const response = await PATCH(
      patch(WORKSPACE_A, {
        calComUrl: 'https://calendly.com/halden-roe/intro',
      }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toMatch(/Only cal.com links work/);
    expect(calUrlOf(WORKSPACE_A)).toBeNull();
    expect(db.rows('project_events')).toHaveLength(0);
  });

  it('refuses a body that is not JSON', async () => {
    const response = await PATCH(
      patch(WORKSPACE_A, undefined, 'cal.com/halden-roe'),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe('Invalid JSON body');
  });

  it('refuses a body with no link in it, and one that is far too long', async () => {
    const missing = await PATCH(patch(WORKSPACE_A, {}), params(WORKSPACE_A));
    expect(missing.status).toBe(400);
    expect((await missing.json()).error).toBe('Invalid booking update');

    const huge = await PATCH(
      patch(WORKSPACE_A, { calComUrl: `cal.com/${'x'.repeat(500)}` }),
      params(WORKSPACE_A)
    );
    expect(huge.status).toBe(400);
    expect(calUrlOf(WORKSPACE_A)).toBeNull();
  });

  // Emptying the field used to be how you removed a calendar. It has its own
  // verb now, so a blank save is a mistake to name rather than a silent
  // disconnect a client did not ask for.
  it('treats an empty link as a mistake, not as a disconnect', async () => {
    const workspace = rowOf(WORKSPACE_A);
    if (workspace)
      workspace['cal_com_url'] = 'https://cal.com/halden-roe/intro';

    const response = await PATCH(
      patch(WORKSPACE_A, { calComUrl: '   ' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).error).toBe(
      'Paste your Cal.com link first.'
    );
    expect(calUrlOf(WORKSPACE_A)).toBe('https://cal.com/halden-roe/intro');
  });

  it('reports a failed save rather than confirming one that did not happen', async () => {
    db.failing.add('workspaces');
    const response = await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      'Could not save your booking link.'
    );
    expect(db.rows('project_events')).toHaveLength(0);
  });
});

describe('disconnecting a calendar', () => {
  it('clears the link and the secret, and says so', async () => {
    await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    expect(secretOf(WORKSPACE_A)).toMatch(/^[0-9a-f]{64}$/);

    const response = await DELETE(del(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      connected: false,
      calComUrl: '',
      embedSrc: null,
      webhookSecret: null,
    });
    expect(calUrlOf(WORKSPACE_A)).toBeNull();
    expect(secretOf(WORKSPACE_A)).toBeNull();

    expect(db.rows('project_events').map((event) => event['kind'])).toEqual([
      'booking_cal_connected',
      'booking_cal_disconnected',
    ]);
  });

  it('hands out a new secret on the next connect', async () => {
    await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    const first = secretOf(WORKSPACE_A);
    await DELETE(del(WORKSPACE_A), params(WORKSPACE_A));
    await PATCH(
      patch(WORKSPACE_A, { calComUrl: 'halden-roe/intro' }),
      params(WORKSPACE_A)
    );
    expect(secretOf(WORKSPACE_A)).toMatch(/^[0-9a-f]{64}$/);
    expect(secretOf(WORKSPACE_A)).not.toBe(first);
  });

  it('reports a failure rather than claiming a disconnect that did not happen', async () => {
    db.failing.add('workspaces');
    const response = await DELETE(del(WORKSPACE_A), params(WORKSPACE_A));
    expect(response.status).toBe(500);
    expect((await response.json()).error).toBe(
      'Could not disconnect your calendar.'
    );
  });
});
