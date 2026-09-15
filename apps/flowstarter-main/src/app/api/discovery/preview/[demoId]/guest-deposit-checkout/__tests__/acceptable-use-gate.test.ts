/**
 * The acceptable-use gate on the guest deposit checkout.
 *
 * This endpoint takes money from a visitor with no account. A refused
 * category cannot pay: taking a deposit and then telling the payer we will
 * not build it is a refund, an argument and a chargeback, in that order. So
 * the gate runs before a Stripe Checkout session is ever created, and the
 * property under test is exactly that ordering: no session, no charge.
 *
 * The classifier is mocked (there is no matcher, only a model behind
 * classifyAcceptableUse); the rule layer is real. The Stripe and preview
 * preamble is copied from the sibling `guest-deposit-checkout.test.ts`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
import {
  clearClaimablePreviews,
  rememberClaimablePreview,
} from '@/lib/flowstarter/claim';
import { __resetRouteLimitersForTest } from '@/lib/security/route-limits';
import { POST } from '../route';
import { _resetRateLimitFallbacksForTests } from '@/lib/rate-limit';

vi.mock('server-only', () => ({}));

const PREVIEW_ID = 'c1b2c3d4-1111-4111-8111-111111111111';

// ── Stripe ────────────────────────────────────────────────────────────────

interface CapturedSession {
  customer_email: string;
  line_items: Array<{ price_data: { unit_amount: number; currency: string } }>;
  metadata: Record<string, string>;
  payment_intent_data: { metadata: Record<string, string> };
  success_url: string;
  cancel_url: string;
}

const createSessionSpy = vi.fn(async (_params: CapturedSession) => ({
  id: 'cs_test_1',
  url: 'https://checkout.stripe.com/c/pay/cs_test_1',
}));

vi.mock('stripe', () => ({
  default: class {
    checkout = { sessions: { create: createSessionSpy } };
  },
}));

vi.mock('@/lib/hosting/funnel-previews', () => ({
  saveFunnelPreview: vi.fn(async () => undefined),
  loadFunnelPreview: vi.fn(async () => null),
  claimFunnelPreview: vi.fn(async () => null),
  copyFunnelArtifactToTenant: vi.fn(async () => undefined),
}));

// ── The acceptable-use gate ──────────────────────────────────────────────
// Mocked at the classifier, not at a matcher: there is no matcher, only a
// model behind classifyAcceptableUse. The rule layer is real.
const classify = vi.hoisted(() => vi.fn());
vi.mock('@/lib/policy/classifier', () => ({
  classifyAcceptableUse: classify,
  clearAcceptableUseCache: vi.fn(),
  evidenceHashOf: (t: string) => 'hash-' + t.length,
}));

vi.mock('@/lib/policy/review', () => ({
  recordPolicyOutcome: vi.fn(async () => ({
    reviewId: 'rev-1',
    recorded: true,
  })),
}));

import { recordPolicyOutcome } from '@/lib/policy/review';
const recordPolicyOutcomeMock = vi.mocked(recordPolicyOutcome);

function classification(
  overrides: Partial<Parameters<typeof classify>[0]> = {}
) {
  return {
    categoryId: 'none',
    confidence: 0.95,
    evidence: 'Nothing notable.',
    needsHuman: false,
    tier: 'llm' as const,
    evidenceHash: 'abc123',
    promptVersion: 'test',
    costEstimateUsd: null,
    model: null,
    cached: false,
    ...overrides,
  };
}

// ── Fixtures ──────────────────────────────────────────────────────────────

function stashPreview(previewId = PREVIEW_ID) {
  rememberClaimablePreview({
    previewId,
    intake: {
      projectId: previewId,
      business: {
        name: 'Acme Bakery',
        niche: 'Bakery',
        location: 'Dublin',
        description: 'Sourdough, daily.',
      },
      socialMedia: [],
      locale: 'en',
      submittedAt: new Date().toISOString(),
      consent: { publicProfileAnalysis: false, acceptedAt: '' },
    } as never,
    brandConfig: { schemaVersion: '1.0' } as never,
    template: {
      slug: 'astro-service',
      reason: 'best fit',
      matchedSignals: [],
      confidence: 0.9,
    },
    files: [{ path: 'package.json', content: '{}', type: 'file' }],
  });
}

function checkoutRequest(body: Record<string, unknown>, ip = '203.0.113.7') {
  return new NextRequest(
    `http://localhost:3000/api/discovery/preview/${PREVIEW_ID}/guest-deposit-checkout`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
      body: JSON.stringify(body),
    }
  );
}

const params = (demoId = PREVIEW_ID) => ({
  params: Promise.resolve({ demoId }),
});

const VALID_BODY = {
  tier: 'pro' as const,
  email: 'Ada@Example.com',
  fullName: 'Ada Baker',
  businessName: 'Acme Bakery',
};

beforeEach(() => {
  clearClaimablePreviews();
  createSessionSpy.mockClear();
  // PR #151 moved this route's limiter onto `routeLimiter(...)`, so the
  // per-route reset export is gone and every suite resets the shared
  // registry instead. Same as the sibling guest-deposit-checkout suite.
  __resetRouteLimitersForTest();
  _resetRateLimitFallbacksForTests();
  vi.stubEnv('STRIPE_SECRET_KEY', 'sk_test_fake');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', 'http://localhost:3000');
  classify.mockReset();
});

describe('POST /api/discovery/preview/[demoId]/guest-deposit-checkout — acceptable-use gate', () => {
  it('refuses a prohibited category with 451 and creates no Stripe session', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'illegal_drugs', confidence: 0.95 })
    );
    stashPreview();

    const response = await POST(checkoutRequest(VALID_BODY), params());
    const body = (await response.json()) as {
      code?: string;
      policy?: { decision?: string };
    };

    expect(response.status).toBe(451);
    expect(body.code).toBe('ACCEPTABLE_USE');
    // The property under test: a refused category cannot pay. No Checkout
    // session, no charge, no chargeback later.
    expect(createSessionSpy).not.toHaveBeenCalled();
  });

  it('quotes the visitor own description to the operator, never the composed classifier subject', async () => {
    // Same bug, same fix, on the guest-deposit route's own screen:
    // `screenAcceptableUse` is real here, only the classifier and
    // `recordPolicyOutcome` are mocked.
    classify.mockResolvedValue(
      classification({ categoryId: 'licensed_pharmacy', confidence: 0.6 })
    );
    stashPreview();

    await POST(
      checkoutRequest({
        ...VALID_BODY,
        websiteUrl: 'https://example-pharmacy.ro',
      }),
      params()
    );

    const written = recordPolicyOutcomeMock.mock.calls.at(-1)?.[0];
    expect(written?.briefText).toBe('Sourdough, daily.');
    expect(written?.briefText).not.toContain('What the business does');
    expect(written?.briefText).not.toContain('Link hostname');
    expect(written?.linkUrl).toBe('https://example-pharmacy.ro');
    expect(written?.linkLabel).toBe('Their site');
  });

  it('still opens checkout for a clean classification', async () => {
    classify.mockResolvedValue(
      classification({ categoryId: 'none', confidence: 0.95 })
    );
    stashPreview();

    const response = await POST(checkoutRequest(VALID_BODY), params());
    const body = (await response.json()) as { url: string };

    expect(response.status).toBe(200);
    expect(body.url).toContain('checkout.stripe.com');
    expect(createSessionSpy).toHaveBeenCalledTimes(1);
  });
});
