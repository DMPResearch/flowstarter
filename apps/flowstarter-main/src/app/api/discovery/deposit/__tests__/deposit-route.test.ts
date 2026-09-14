/**
 * POST /api/discovery/deposit — the booking-call deposit. Unauthenticated
 * and it creates a Stripe Checkout session, so (mirroring
 * guest-deposit-checkout's own suite) the case that matters is how many
 * sessions one caller may mint: by IP, and — security audit 2026-09-13
 * (Claude H4 / Codex F06) — by email too, so the same address spread across
 * many IPs is still caught. The per-IP limiter already existed before this
 * file; this is also the regression suite for the happy-path and
 * misconfiguration behaviour the route never had a test for at all.
 *
 * Static imports throughout: vi.mock is hoisted above them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST } from '../route';
import { __resetRouteLimitersForTest } from '@/lib/security/route-limits';

vi.mock('server-only', () => ({}));

const createSessionSpy = vi.fn(async () => ({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: createSessionSpy } };
  },
}));

function depositRequest(
  body: Record<string, unknown>,
  ip = '203.0.113.7'
): NextRequest {
  return new NextRequest('http://localhost:3000/api/discovery/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

const VALID_BODY = {
  tier: 'pro' as const,
  fullName: 'Ada Baker',
  email: 'ada@example.com',
  businessName: 'Acme Bakery',
};

beforeEach(() => {
  createSessionSpy.mockClear();
  __resetRouteLimitersForTest();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
});

describe('POST /api/discovery/deposit', () => {
  it('creates a checkout session for a valid request', async () => {
    const res = await POST(depositRequest(VALID_BODY));
    const body = (await res.json()) as { url: string };

    expect(res.status).toBe(200);
    expect(body.url).toContain('checkout.stripe.com');
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('skips rather than dead-ending when Stripe is not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const res = await POST(depositRequest(VALID_BODY, '203.0.113.50'));
    const body = (await res.json()) as { skip: boolean };

    expect(res.status).toBe(200);
    expect(body.skip).toBe(true);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload with 400, before touching Stripe', async () => {
    const res = await POST(
      depositRequest({ ...VALID_BODY, email: 'not-an-email' }, '203.0.113.51')
    );

    expect(res.status).toBe(400);
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('rate limits one IP after five attempts a minute, across distinct emails', async () => {
    // A distinct email per attempt isolates the IP limiter under test from
    // the per-email limiter added alongside it (security audit 2026-09-13,
    // H4/F06) — that one gets its own dedicated test below.
    for (let attempt = 0; attempt < 5; attempt++) {
      const ok = await POST(
        depositRequest({
          ...VALID_BODY,
          email: `visitor-${attempt}@example.com`,
        })
      );
      expect(ok.status).toBe(200);
    }

    const blocked = await POST(
      depositRequest({ ...VALID_BODY, email: 'visitor-blocked@example.com' })
    );
    expect(blocked.status).toBe(429);
    expect(createSessionSpy).toHaveBeenCalledTimes(5);

    // A different visitor — different IP *and* different email, so this
    // isolates the IP limiter from the email limiter below — is unaffected.
    const other = await POST(
      depositRequest(
        { ...VALID_BODY, email: 'other-visitor@example.com' },
        '198.51.100.11'
      )
    );
    expect(other.status).toBe(200);
  });

  it('rate limits one email after three attempts a minute, across any IP', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      const ok = await POST(
        depositRequest(VALID_BODY, `203.0.113.${attempt + 10}`)
      );
      expect(ok.status).toBe(200);
    }

    // A fourth attempt with the same email, from yet another IP, is refused
    // — the per-IP limiter alone would have let this through.
    const blocked = await POST(depositRequest(VALID_BODY, '203.0.113.99'));
    expect(blocked.status).toBe(429);
    expect(createSessionSpy).toHaveBeenCalledTimes(3);
  });

  it('a different email from the same IP is unaffected by the email limit', async () => {
    for (let attempt = 0; attempt < 3; attempt++) {
      await POST(depositRequest(VALID_BODY, '203.0.113.50'));
    }
    const other = await POST(
      depositRequest(
        { ...VALID_BODY, email: 'someone-else@example.com' },
        '203.0.113.50'
      )
    );
    expect(other.status).toBe(200);
  });

  it('fails open — the prospect can still book the call — when Stripe errors', async () => {
    createSessionSpy.mockRejectedValueOnce(new Error('stripe down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    const res = await POST(depositRequest(VALID_BODY, '198.51.100.60'));
    const body = (await res.json()) as { skip: boolean };

    expect(res.status).toBe(200);
    expect(body.skip).toBe(true);
    errorSpy.mockRestore();
  });
});
