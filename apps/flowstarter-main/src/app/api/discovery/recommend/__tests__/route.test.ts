/**
 * POST /api/discovery/recommend used to compute the deterministic tier
 * first and then return whatever `recommendTierLLM` said, falling back to
 * the deterministic result only when the LLM path failed. That inverted the
 * product requirement ("no LLM decides"). This test imports the REAL route
 * handler (not a reimplementation) and proves:
 *   - the response is `source: 'rules'`
 *   - the response carries a `routing` verdict from the deterministic rules
 *   - the LLM path is never even called, so it cannot influence the answer
 *     — mocked here to return a flatly contradicting tier as proof.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';
// Static imports: vi.mock is hoisted above them, and this app's tsconfig
// does not allow top-level await in tests.
import { POST } from '../route';
import { recommendTierLLM } from '@/lib/ai/recommend-tier';
import { recommendTier } from '@/app/(dynamic-pages)/(main-pages)/components/discovery/discovery.logic';

vi.mock('server-only', () => ({}));

const recommendTierLLMMock = vi.fn();
vi.mock('@/lib/ai/recommend-tier', () => ({
  recommendTierLLM: (...args: unknown[]) => recommendTierLLMMock(...args),
  RECOMMEND_MODEL: 'mock-model',
}));

beforeEach(() => {
  recommendTierLLMMock.mockReset();
  // If the route were ever to call this again, it would contradict the
  // deterministic rules on purpose, so any regression is impossible to miss.
  recommendTierLLMMock.mockResolvedValue({
    rec: { tier: 'custom', reasonKeys: ['customIntegrations'] },
    usage: { inputTokens: 10, outputTokens: 5 },
  });
});

function request(body: unknown) {
  return new NextRequest('http://localhost/api/discovery/recommend', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: { 'content-type': 'application/json' },
  });
}

const BROCHURE_PAYLOAD = {
  businessName: 'Acme Dental',
  description: 'A boutique dental clinic offering cosmetic work',
  goal: 'leads',
  commerceMode: 'none',
  pageCount: 'lt-5',
  timeline: 'flexible',
  catalogSize: 'na',
  customIntegrations: '',
};

describe('POST /api/discovery/recommend', () => {
  it('returns source: "rules" and a routing verdict, and never calls the LLM', async () => {
    const res = await POST(request(BROCHURE_PAYLOAD));
    expect(res.status).toBe(200);
    const json = await res.json();

    expect(json.source).toBe('rules');
    expect(json.routing).toBeDefined();
    expect(['standard', 'custom']).toContain(json.routing.decision);
    expect(recommendTierLLMMock).not.toHaveBeenCalled();
  });

  it('ignores the LLM tier entirely: the response tier matches the deterministic rules, not the mock', async () => {
    const res = await POST(request(BROCHURE_PAYLOAD));
    const json = await res.json();

    // The mock is wired to return 'custom' with 'customIntegrations' as the
    // reason — a tier the deterministic rules would never pick for a plain
    // brochure site. If the route still consulted it, this would fail.
    const deterministic = recommendTier({
      fullName: '',
      email: '',
      businessName: BROCHURE_PAYLOAD.businessName,
      industry: '',
      description: BROCHURE_PAYLOAD.description,
      offer: '',
      targetAudience: '',
      instagramUrl: '',
      linkedinUrl: '',
      websiteUrl: '',
      goal: BROCHURE_PAYLOAD.goal,
      secondaryGoals: [],
      brandTone: '',
      pageCount: BROCHURE_PAYLOAD.pageCount as 'lt-5',
      timeline: BROCHURE_PAYLOAD.timeline as 'flexible',
      commerceMode: BROCHURE_PAYLOAD.commerceMode as 'none',
      catalogSize: BROCHURE_PAYLOAD.catalogSize as 'na',
      customIntegrations: BROCHURE_PAYLOAD.customIntegrations,
      calComUrl: '',
      selectedTier: '',
      subscription: '',
      billingCadence: 'monthly',
    });

    expect(json.tier).toBe(deterministic.tier);
    expect(json.tier).not.toBe('custom');
    expect(recommendTierLLMMock).not.toHaveBeenCalled();
  });

  it('rejects invalid JSON', async () => {
    const res = await POST(
      new NextRequest('http://localhost/api/discovery/recommend', {
        method: 'POST',
        body: '{not json',
        headers: { 'content-type': 'application/json' },
      })
    );
    expect(res.status).toBe(400);
  });
});
