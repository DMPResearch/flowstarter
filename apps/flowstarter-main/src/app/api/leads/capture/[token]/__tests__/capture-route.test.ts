// @vitest-environment node
/**
 * The public capture endpoint, through the REAL route handlers.
 *
 * This is the only unauthenticated write in the product that creates a tenant
 * row, so what is defended here is the order of the refusals and what each one
 * gives away:
 *
 *  1. A wrong token and a malformed token get the same 404, and neither one
 *     reads anything. An endpoint that answered differently would be a way to
 *     enumerate which tokens are real.
 *  2. A preview token gets a 403 with a sentence, before any query.
 *  3. A submission from somebody else's page gets a 403 and writes nothing,
 *     even though the token in the URL is genuine. That is the case a scraped
 *     token actually looks like.
 *  4. A honeypot submission gets the same 201 as a real one and stores
 *     nothing.
 *  5. The success response says `{ ok: true }` and no more. A lead id or a
 *     spam verdict in the body would be a fact about a tenant published to
 *     whoever asked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { OPTIONS, POST } from '../route';
import { createFakeSupabase } from '@/lib/flowstarter/__tests__/fake-supabase';

vi.mock('server-only', () => ({}));

const WORKSPACE_A = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const WORKSPACE_B = '7c2a91b4-3d5e-4a17-9f88-1b2c3d4e5f60';
const PREVIEW_ID = '3a5b7c9d-1e2f-4a3b-8c5d-6e7f8a9b0c1d';
const TOKEN_A = 'a'.repeat(43);
const TOKEN_B = 'b'.repeat(43);
const ORIGIN_A = 'https://salon-elena.flowstarter.test';

const db = createFakeSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

const notify = vi.hoisted(() => ({ notifyClientOnce: vi.fn() }));
vi.mock('@/lib/flowstarter/client-notifications', () => ({
  notifyClientOnce: notify.notifyClientOnce,
}));

// Every test starts with a fresh limiter, or the eleventh assertion in the
// file would be the one that trips it rather than the one that means to.
const limiter = vi.hoisted(() => ({ consumeRateLimit: vi.fn() }));
vi.mock('@/lib/rate-limit', () => ({
  consumeRateLimit: limiter.consumeRateLimit,
}));

const body = {
  name: 'Elena Popescu',
  email: 'elena@salon.ro',
  message: 'Doresc o programare pentru vineri',
  phone: '+40712345678',
  page: '/contact',
};

function post(
  token: string,
  payload: unknown,
  headers: Record<string, string> = { origin: ORIGIN_A },
  raw?: string
): NextRequest {
  return new NextRequest(`http://localhost/api/leads/capture/${token}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: raw ?? JSON.stringify(payload),
  });
}

const params = (token: string) => ({ params: Promise.resolve({ token }) });

beforeEach(() => {
  db.reset();
  notify.notifyClientOnce.mockReset();
  notify.notifyClientOnce.mockResolvedValue({ sent: true });
  limiter.consumeRateLimit.mockReset();
  limiter.consumeRateLimit.mockResolvedValue(false);
  process.env.PLATFORM_DOMAIN = 'flowstarter.test';
  db.seed('workspaces', [
    {
      id: WORKSPACE_A,
      slug: 'salon-elena',
      client_email: 'elena@example.com',
      claimed_preview_id: PREVIEW_ID,
      lead_capture_token: TOKEN_A,
    },
    {
      id: WORKSPACE_B,
      slug: 'halden-roe',
      client_email: null,
      claimed_preview_id: null,
      lead_capture_token: TOKEN_B,
    },
  ]);
  db.seed('workspace_hosts', [
    { workspace_id: WORKSPACE_A, hostname: 'salonelena.ro' },
  ]);
});

// ── The happy path ─────────────────────────────────────────────────────────

describe('a real enquiry', () => {
  it('stores it in the right workspace and says nothing else', async () => {
    const response = await POST(post(TOKEN_A, body), params(TOKEN_A));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_A);

    const lead = db.rows('leads')[0];
    expect(lead?.['workspace_id']).toBe(WORKSPACE_A);
    expect(lead?.['email']).toBe('elena@salon.ro');
    expect(lead?.['status']).toBe('new');
    expect(lead?.['source']).toBe('/contact');
  });

  it('accepts a custom domain on workspace_hosts', async () => {
    const response = await POST(
      post(TOKEN_A, body, { origin: 'https://salonelena.ro' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
  });

  it('accepts the workspace own preview hostname', async () => {
    const response = await POST(
      post(TOKEN_A, body, {
        origin: `https://${PREVIEW_ID}.preview.flowstarter.test`,
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
  });

  it('logs a lead_captured event against that workspace', async () => {
    await POST(post(TOKEN_A, body), params(TOKEN_A));
    const event = db.rows('project_events')[0];
    expect(event?.['kind']).toBe('lead_captured');
    expect(event?.['workspace_id']).toBe(WORKSPACE_A);
  });

  it('notifies the client once, keyed on the lead, with a reply-to', async () => {
    await POST(post(TOKEN_A, body), params(TOKEN_A));
    expect(notify.notifyClientOnce).toHaveBeenCalledTimes(1);
    const call = notify.notifyClientOnce.mock.calls[0]?.[0];
    expect(call.workspaceId).toBe(WORKSPACE_A);
    expect(call.notification).toBe('lead_captured');
    expect(call.dedupeKey).toBe(db.rows('leads')[0]?.['id']);
    expect(call.replyTo).toBe('elena@salon.ro');

    const rendered = call.render({
      workspaceId: WORKSPACE_A,
      email: 'elena@example.com',
      clientName: 'Elena',
      businessName: 'Salon Elena',
      dashboardUrl: 'https://flowstarter.test/dashboard/projects/x',
    });
    expect(rendered.subject).toBe('New enquiry from your site');
    expect(rendered.html).toContain('Doresc o programare pentru vineri');
  });

  it('stores a lead even when the notice cannot be sent', async () => {
    notify.notifyClientOnce.mockResolvedValue({
      sent: false,
      reason: 'no_recipient',
    });
    const response = await POST(post(TOKEN_A, body), params(TOKEN_A));
    expect(response.status).toBe(201);
    expect(db.rows('leads')).toHaveLength(1);
  });
});

// ── Spam ───────────────────────────────────────────────────────────────────

describe('spam', () => {
  it('is stored as spam, answered normally, and never emailed', async () => {
    const response = await POST(
      post(TOKEN_A, {
        ...body,
        name: 'Casino King',
        message: 'Buy cheap viagra now https://evil.example',
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.rows('leads')[0]?.['status']).toBe('spam');
    expect(notify.notifyClientOnce).not.toHaveBeenCalled();
  });
});

// ── The honeypot ───────────────────────────────────────────────────────────

describe('the honeypot', () => {
  it('is accepted and discarded, with nothing to tell a bot apart', async () => {
    const response = await POST(
      post(TOKEN_A, { ...body, company_website: 'http://spam.example' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({ ok: true });
    expect(db.rows('leads')).toHaveLength(0);
    expect(notify.notifyClientOnce).not.toHaveBeenCalled();
  });
});

// ── Tokens ─────────────────────────────────────────────────────────────────

describe('the token', () => {
  it('answers a preview token with a sentence, and stores nothing', async () => {
    const token = `preview.${PREVIEW_ID}`;
    const response = await POST(post(token, body), params(token));
    expect(response.status).toBe(403);
    expect((await response.json()).message).toContain('preview');
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('answers an unknown token with a 404 that leaks nothing', async () => {
    const response = await POST(
      post('z'.repeat(43), body),
      params('z'.repeat(43))
    );
    expect(response.status).toBe(404);
    const json = await response.json();
    expect(json).toEqual({
      ok: false,
      message: 'This form is not connected yet.',
    });
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('answers a malformed token exactly the same way', async () => {
    const response = await POST(post('nope', body), params('nope'));
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      ok: false,
      message: 'This form is not connected yet.',
    });
  });

  it('refuses a workspace id used as a token', async () => {
    const response = await POST(post(WORKSPACE_A, body), params(WORKSPACE_A));
    expect(response.status).toBe(404);
    expect(db.rows('leads')).toHaveLength(0);
  });
});

// ── Origin ─────────────────────────────────────────────────────────────────

describe('the origin rule', () => {
  it('refuses a genuine token submitted from somebody else page', async () => {
    const response = await POST(
      post(TOKEN_A, body, { origin: 'https://evil.example' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(403);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses another workspace own origin', async () => {
    const response = await POST(
      post(TOKEN_A, body, {
        origin: 'https://halden-roe.flowstarter.test',
      }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(403);
    expect(db.rows('leads')).toHaveLength(0);
  });

  it('refuses a request with no origin and no referer', async () => {
    const response = await POST(post(TOKEN_A, body, {}), params(TOKEN_A));
    expect(response.status).toBe(403);
  });

  it('accepts a referer when the origin header is missing', async () => {
    const response = await POST(
      post(TOKEN_A, body, { referer: `${ORIGIN_A}/contact` }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(201);
  });
});

// ── Rate limiting ──────────────────────────────────────────────────────────

describe('rate limiting', () => {
  it('counts per token and per IP', async () => {
    await POST(
      post(TOKEN_A, body, { origin: ORIGIN_A, 'x-forwarded-for': '1.2.3.4' }),
      params(TOKEN_A)
    );
    const keys = limiter.consumeRateLimit.mock.calls.map((call) => call[0]);
    expect(keys).toContain(`lead-capture:token:${TOKEN_A}`);
    expect(keys).toContain('lead-capture:ip:1.2.3.4');
  });

  it('refuses once limited, before touching the database', async () => {
    limiter.consumeRateLimit.mockResolvedValue(true);
    const response = await POST(post(TOKEN_A, body), params(TOKEN_A));
    expect(response.status).toBe(429);
    expect(db.rows('leads')).toHaveLength(0);
  });
});

// ── The body ───────────────────────────────────────────────────────────────

describe('the body', () => {
  it('refuses a missing field with a sentence a site can show', async () => {
    const response = await POST(
      post(TOKEN_A, { ...body, name: '' }),
      params(TOKEN_A)
    );
    expect(response.status).toBe(400);
    expect((await response.json()).message).toBe('Add your name.');
  });

  it('refuses a body that is not JSON', async () => {
    const response = await POST(
      post(TOKEN_A, null, { origin: ORIGIN_A }, 'not json'),
      params(TOKEN_A)
    );
    expect(response.status).toBe(400);
  });
});

// ── Preflight ──────────────────────────────────────────────────────────────

describe('the CORS preflight', () => {
  it('allows the workspace own origin', async () => {
    const request = new NextRequest(
      `http://localhost/api/leads/capture/${TOKEN_A}`,
      { method: 'OPTIONS', headers: { origin: ORIGIN_A } }
    );
    const response = await OPTIONS(request, params(TOKEN_A));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBe(ORIGIN_A);
    expect(response.headers.get('Access-Control-Allow-Methods')).toContain(
      'POST'
    );
  });

  it('allows nobody else, for a token that is genuine', async () => {
    const request = new NextRequest(
      `http://localhost/api/leads/capture/${TOKEN_A}`,
      { method: 'OPTIONS', headers: { origin: 'https://evil.example' } }
    );
    const response = await OPTIONS(request, params(TOKEN_A));
    expect(response.status).toBe(204);
    expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
  });

  it('allows nobody for a preview or unknown token', async () => {
    for (const token of [`preview.${PREVIEW_ID}`, 'z'.repeat(43)]) {
      const request = new NextRequest(
        `http://localhost/api/leads/capture/${token}`,
        { method: 'OPTIONS', headers: { origin: ORIGIN_A } }
      );
      const response = await OPTIONS(request, params(token));
      expect(response.headers.get('Access-Control-Allow-Origin')).toBeNull();
    }
  });
});

// ── Failures ───────────────────────────────────────────────────────────────

describe('when the database is unavailable', () => {
  it('refuses without pretending the enquiry landed', async () => {
    db.failing.add('workspaces');
    const response = await POST(post(TOKEN_A, body), params(TOKEN_A));
    expect(response.status).toBe(503);
    expect(db.rows('leads')).toHaveLength(0);
  });
});
