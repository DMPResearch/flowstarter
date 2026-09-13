/**
 * POST /api/discovery/deposit — the guest booking-deposit Checkout session.
 *
 * Security audit 2026-09-13 (Claude H4 / Codex F06): "Stripe checkout
 * session creation for guests and claims gets per-IP and per-email
 * limiters." The per-IP limiter already existed; this is the regression
 * suite for the per-email dimension added alongside it, plus the existing
 * happy-path/misconfiguration behaviour this route never had a test file
 * for at all.
 *
 * Static imports throughout: vi.mock is hoisted above them.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import { POST, __resetDiscoveryDepositRateLimit } from '../route';
import { _resetRateLimitFallbacksForTests } from '@/lib/rate-limit';

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

const VALID_BODY = {
  tier: 'pro' as const,
  fullName: 'Ada Baker',
  email: 'ada@example.com',
};

function depositRequest(body: Record<string, unknown>, ip = '203.0.113.7') {
  return new NextRequest('http://localhost:3000/api/discovery/deposit', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  createSessionSpy.mockClear();
  _resetRateLimitFallbacksForTests();
  __resetDiscoveryDepositRateLimit();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
});

describe('POST /api/discovery/deposit', () => {
  it('creates a Checkout session for a valid deposit request', async () => {
    const res = await POST(depositRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.url).toBe('https://checkout.stripe.com/c/pay/cs_test_1');
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });

  it('skips rather than dead-ending when Stripe is not configured', async () => {
    vi.stubEnv('STRIPE_SECRET_KEY', '');
    const res = await POST(depositRequest(VALID_BODY));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ skip: true });
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('rejects an invalid payload before ever reaching Stripe', async () => {
    const res = await POST(
      depositRequest({ ...VALID_BODY, email: 'not-an-address' })
    );
    expect(res.status).toBe(400);
    expect(createSessionSpy).not.toHaveBeenCalled();
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

  it('rate limits one IP after five attempts a minute, across distinct emails', async () => {
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
  });
});
