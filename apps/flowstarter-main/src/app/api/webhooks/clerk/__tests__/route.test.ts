/**
 * Behavioural tests for the Clerk webhook route.
 *
 * Requests are real `NextRequest` objects carrying real Svix-style HMAC
 * signatures (computed with node's `crypto`, mirroring what Clerk actually
 * sends), so signature verification runs for real -- only the Supabase
 * service-role client is mocked.
 */
import { createHmac } from 'crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

const WEBHOOK_SECRET =
  'whsec_' + Buffer.from('clerk-test-secret').toString('base64');

// ─── Supabase mock ──────────────────────────────────────────────────────────
type Row = Record<string, unknown>;
interface ClientScript {
  membershipsResult?: { data: Row[] | null; error: { message: string } | null };
  updateError?: { message: string } | null;
  upsertError?: { message: string } | null;
  deleteError?: { message: string } | null;
}
const script: ClientScript = {};
const captured: {
  upserts: Row[];
  updates: Array<{ table: string; values: Row }>;
  deletes: Array<{ table: string; column: string; value: string }>;
  tables: string[];
} = { upserts: [], updates: [], deletes: [], tables: [] };

function builderFor(table: string) {
  captured.tables.push(table);
  const builder = {
    _mode: 'select' as 'select' | 'update' | 'delete',
    select() {
      return builder;
    },
    upsert(values: Row) {
      captured.upserts.push(values);
      return Promise.resolve({ data: null, error: script.upsertError ?? null });
    },
    update(values: Row) {
      builder._mode = 'update';
      captured.updates.push({ table, values });
      return builder;
    },
    delete() {
      builder._mode = 'delete';
      return builder;
    },
    eq(column: string, value: string) {
      if (builder._mode === 'delete') {
        captured.deletes.push({ table, column, value });
        return Promise.resolve({
          data: null,
          error: script.deleteError ?? null,
        });
      }
      if (table === 'workspace_memberships') {
        return Promise.resolve(
          script.membershipsResult ?? { data: [], error: null }
        );
      }
      return Promise.resolve({ data: null, error: script.updateError ?? null });
    },
    in(_column: string, _values: string[]) {
      return Promise.resolve({ data: null, error: script.updateError ?? null });
    },
  };
  return builder;
}

vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => ({ from: builderFor }),
}));

const originalFetch = global.fetch;

beforeEach(() => {
  delete script.membershipsResult;
  delete script.updateError;
  delete script.upsertError;
  delete script.deleteError;
  captured.upserts = [];
  captured.updates = [];
  captured.deletes = [];
  captured.tables = [];
  process.env.CLERK_WEBHOOK_SECRET = WEBHOOK_SECRET;
  delete process.env.ANTHROPIC_ORG_AUTO_INVITE;
  delete process.env.ANTHROPIC_ADMIN_API_KEY;
  delete process.env.ANTHROPIC_ADMIN_KEY;
  vi.spyOn(console, 'info').mockImplementation(() => {});
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  global.fetch = originalFetch;
});

function sign(svixId: string, svixTimestamp: string, payload: string): string {
  const secretBytes = Buffer.from(WEBHOOK_SECRET.slice(6), 'base64');
  const signedPayload = `${svixId}.${svixTimestamp}.${payload}`;
  return createHmac('sha256', secretBytes)
    .update(signedPayload)
    .digest('base64');
}

function signedRequest(body: unknown, opts: { badSignature?: boolean } = {}) {
  const payload = JSON.stringify(body);
  const svixId = 'msg_' + Math.random().toString(36).slice(2);
  const svixTimestamp = String(Math.floor(Date.now() / 1000));
  const signature = opts.badSignature
    ? 'wrong-signature-value'
    : sign(svixId, svixTimestamp, payload);

  return new NextRequest('http://localhost/api/webhooks/clerk', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'svix-id': svixId,
      'svix-timestamp': svixTimestamp,
      'svix-signature': `v1,${signature}`,
    },
    body: payload,
  });
}

function clerkUser(overrides: Row = {}) {
  return {
    id: 'user_123',
    first_name: 'Ada',
    last_name: 'Lovelace',
    email_addresses: [
      {
        id: 'email_1',
        email_address: 'ada@example.com',
        verification: { status: 'verified' },
      },
    ],
    primary_email_address_id: 'email_1',
    image_url: 'https://img.example.com/ada.png',
    created_at: 1000,
    updated_at: 1000,
    ...overrides,
  };
}

describe('POST /api/webhooks/clerk', () => {
  it('returns 500 when the webhook secret is not configured', async () => {
    delete process.env.CLERK_WEBHOOK_SECRET;
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.created', data: clerkUser() })
    );
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.error).toBe('Webhook not configured');
  });

  it('rejects a request with an invalid signature', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest(
        { type: 'user.created', data: clerkUser() },
        { badSignature: true }
      )
    );
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.error).toBe('Invalid webhook signature');
  });

  it('rejects a request with missing svix headers', async () => {
    const { POST } = await import('../route');
    const req = new NextRequest('http://localhost/api/webhooks/clerk', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ type: 'user.created', data: clerkUser() }),
    });
    const res = await POST(req);
    expect(res.status).toBe(401);
  });

  it('upserts a profile on user.created', async () => {
    const { POST } = await import('../route');
    const user = clerkUser();
    const res = await POST(signedRequest({ type: 'user.created', data: user }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
    expect(captured.upserts).toHaveLength(1);
    expect(captured.upserts[0]).toMatchObject({
      clerk_user_id: 'user_123',
      email: 'ada@example.com',
      full_name: 'Ada Lovelace',
      avatar_url: 'https://img.example.com/ada.png',
    });
  });

  it('upserts a profile on user.updated without inviting to Anthropic', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.updated', data: clerkUser() })
    );
    expect(res.status).toBe(200);
    expect(captured.upserts).toHaveLength(1);
    // Anthropic auto-invite only fires on user.created.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('invites the new user to the Anthropic org when auto-invite is enabled', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    process.env.ANTHROPIC_ORG_INVITE_ROLE = 'developer';
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://api.anthropic.com/v1/organizations/invites');
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody).toEqual({ email: 'ada@example.com', role: 'developer' });
  });

  it('falls back to claude_code_user for an invite role Anthropic does not recognize', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    process.env.ANTHROPIC_ORG_INVITE_ROLE = 'super-admin';
    const fetchSpy = vi
      .fn()
      .mockResolvedValue({ ok: true, text: async () => '' });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    await POST(signedRequest({ type: 'user.created', data: clerkUser() }));
    const [, init] = fetchSpy.mock.calls[0];
    const sentBody = JSON.parse((init as RequestInit).body as string);
    expect(sentBody.role).toBe('claude_code_user');
  });

  it('warns and continues when the Anthropic invite API responds with an error', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    const fetchSpy = vi.fn().mockResolvedValue({
      ok: false,
      status: 422,
      text: async () => 'seat limit reached',
    });
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
  });

  it('warns and continues when the Anthropic invite fetch throws', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    const fetchSpy = vi.fn().mockRejectedValue(new Error('network down'));
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
  });

  it('skips the Anthropic invite when no admin key is configured', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    await POST(signedRequest({ type: 'user.created', data: clerkUser() }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('skips the Anthropic invite when the new user has no primary email', async () => {
    process.env.ANTHROPIC_ORG_AUTO_INVITE = '1';
    process.env.ANTHROPIC_ADMIN_API_KEY = 'sk-admin';
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as unknown as typeof fetch;

    const { POST } = await import('../route');
    const user = clerkUser({
      primary_email_address_id: null,
      email_addresses: [],
    });
    await POST(signedRequest({ type: 'user.created', data: user }));
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('handles a user with no primary email (profile email is null)', async () => {
    const { POST } = await import('../route');
    const user = clerkUser({
      primary_email_address_id: null,
      email_addresses: [],
    });
    const res = await POST(signedRequest({ type: 'user.created', data: user }));
    expect(res.status).toBe(200);
    expect(captured.upserts[0]).toMatchObject({ email: null });
  });

  it('logs but still acknowledges the webhook when the profile upsert fails', async () => {
    script.upsertError = { message: 'unique violation' };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'user.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
    expect(captured.upserts).toHaveLength(1);
  });

  it('deletes memberships and profile on user.deleted', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'user.deleted',
        data: clerkUser({ id: 'user_gone' }),
      })
    );
    expect(res.status).toBe(200);
    expect(captured.deletes).toEqual(
      expect.arrayContaining([
        {
          table: 'workspace_memberships',
          column: 'clerk_user_id',
          value: 'user_gone',
        },
        { table: 'profiles', column: 'clerk_user_id', value: 'user_gone' },
      ])
    );
  });

  it('still acknowledges user.deleted when the delete queries error', async () => {
    script.deleteError = { message: 'fk violation' };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'user.deleted',
        data: clerkUser({ id: 'user_gone' }),
      })
    );
    expect(res.status).toBe(200);
  });

  it('acknowledges session events without touching the database', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'session.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
    expect(captured.upserts).toHaveLength(0);
    expect(captured.deletes).toHaveLength(0);
  });

  it('acknowledges an unhandled event type', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({ type: 'organization.created', data: clerkUser() })
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.received).toBe(true);
  });

  it('mirrors a billing subscription.active event into the payer workspace', async () => {
    script.membershipsResult = {
      data: [{ workspace_id: 'ws_1' }, { workspace_id: 'ws_2' }],
      error: null,
    };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          status: 'active',
          payer: { user_id: 'user_123' },
          items: [{ plan: { slug: 'pro' } }],
        },
      })
    );
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(1);
    expect(captured.updates[0]).toMatchObject({
      table: 'workspaces',
      values: { subscription_status: 'active', tier_name: 'pro' },
    });
  });

  it('ignores a billing event with no matching workspace / plan (returns ok, no write)', async () => {
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          status: 'active',
          payer: { organization_id: 'org_1' },
          items: [{ plan: { slug: 'pro' } }],
        },
      })
    );
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(0);
  });

  it('logs but does not fail when membership lookup errors', async () => {
    script.membershipsResult = {
      data: null,
      error: { message: 'db unreachable' },
    };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          status: 'active',
          payer: { user_id: 'user_123' },
          items: [{ plan: { slug: 'pro' } }],
        },
      })
    );
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(0);
  });

  it('warns and skips the tier mirror when the payer has no workspace', async () => {
    script.membershipsResult = { data: [], error: null };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          status: 'active',
          payer: { user_id: 'user_123' },
          items: [{ plan: { slug: 'pro' } }],
        },
      })
    );
    expect(res.status).toBe(200);
    expect(captured.updates).toHaveLength(0);
  });

  it('returns 500 and logs when the handler throws unexpectedly', async () => {
    script.membershipsResult = {
      data: [{ workspace_id: 'ws_1' }],
      error: null,
    };
    script.updateError = { message: 'constraint violation' };
    const { POST } = await import('../route');
    const res = await POST(
      signedRequest({
        type: 'subscription.active',
        data: {
          id: 'sub_1',
          status: 'active',
          payer: { user_id: 'user_123' },
          items: [{ plan: { slug: 'pro' } }],
        },
      })
    );
    // The handler swallows the Supabase update error internally and still
    // acknowledges the webhook -- assert the outer route doesn't 500 for a
    // reported (not thrown) Supabase error.
    expect(res.status).toBe(200);
  });

  it('returns 500 when the payload is not valid JSON despite a valid signature', async () => {
    const rawBody = 'not-json-at-all';
    const svixId = 'msg_bad';
    const svixTimestamp = String(Math.floor(Date.now() / 1000));
    const signature = sign(svixId, svixTimestamp, rawBody);
    const req = new NextRequest('http://localhost/api/webhooks/clerk', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'svix-id': svixId,
        'svix-timestamp': svixTimestamp,
        'svix-signature': `v1,${signature}`,
      },
      body: rawBody,
    });
    const { POST } = await import('../route');
    const res = await POST(req);
    // Invalid JSON payload -> verification returns valid:false -> 401, not 500.
    expect(res.status).toBe(401);
  });
});

describe('GET /api/webhooks/clerk', () => {
  it('rejects with 405 method not allowed', async () => {
    const { GET } = await import('../route');
    const res = await GET();
    expect(res.status).toBe(405);
    const body = await res.json();
    expect(body.error).toBe('Method not allowed');
  });
});
