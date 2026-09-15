/**
 * The endpoint with the real gate behind it, on the exact request run 8 made.
 *
 * `route.test.ts` next door stubs `runScopeGate`, which is right for asserting
 * what the handler forwards and withholds. This file does the opposite: only
 * the classifier, the policy screen, Supabase and the mailer are stubbed, so
 * the routing rule, the copy rule and the serialisation all run for real. The
 * defect it exists for was invisible at every layer on its own -- each piece
 * did what it said, and the sentence the visitor read still contradicted the
 * data the API returned.
 *
 * The request: Darius's own portfolio brief, a classifier that fails on every
 * call (which is how it was found, at 100%), and the visitor tapping "A site
 * that presents my business".
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

vi.mock('@/lib/security/route-limits', () => ({
  routeLimiter: (name: string) => ({
    name,
    check: async () => ({ ok: true, retryAfter: 0 }),
  }),
}));

/** Clean: what is being tested is the scope decision, not the policy one. */
vi.mock('@/lib/policy/gate', () => ({
  screenAcceptableUse: async () => ({
    verdict: { decision: 'allow' },
    blocked: false,
    notice: null,
    reviewId: null,
  }),
}));

const sendEmail = vi.fn(async () => ({ success: true }));
vi.mock('@/lib/email', () => ({
  sendEmail: () => sendEmail(),
  resolveOperatorNotifyEmail: () => 'ops@flowstarter.net',
}));

const inserted: Array<{ table: string; values: Record<string, unknown> }> = [];
/* eslint-disable @typescript-eslint/no-explicit-any */
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () =>
    ({
      from: (table: string) => ({
        insert: (values: Record<string, unknown>) => {
          inserted.push({ table, values });
          return {
            select: () => ({
              single: async () => ({ data: { id: 'lead-1' }, error: null }),
              maybeSingle: async () => ({
                data: { id: 'review-1' },
                error: null,
              }),
            }),
          };
        },
        update: () => ({ eq: async () => ({ error: null }) }),
      }),
    } as any),
}));
/* eslint-enable @typescript-eslint/no-explicit-any */

/** No unit test in this tree makes a network request. */
vi.mock('@/lib/flowstarter/profile-fetch', () => ({
  fetchProfileReading: async () => ({
    status: 'unavailable',
    network: 'website',
    url: 'https://flowstarter.net',
    title: null,
    description: null,
    imageUrl: null,
  }),
}));

import {
  resetScopeClassifier,
  setScopeClassifier,
} from '@/lib/flowstarter/scope-classifier';
import { discoveryCallKeys } from '@/locales/en/discovery-call';
import { POST } from '../route';

/** The sentence the refusal screen asserted, verbatim from the locale. */
const CUSTOM_WORK_ASSERTION =
  discoveryCallKeys['landing.discovery.scope.offer.body'];

const BRIEF = {
  fullName: 'Darius Mihai Popescu',
  email: 'darius@example.com',
  description:
    'I design and build premium websites and product systems, and I want a portfolio site showing the three projects I have shipped.',
  websiteUrl: 'https://flowstarter.net',
};

function post(body: unknown) {
  return new NextRequest('https://flowstarter.net/api/discovery/scope', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': '203.0.113.9',
    },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  inserted.length = 0;
  sendEmail.mockClear();
  process.env.CAL_BASE_URL = 'https://cal.flowstarter.dev';
  // The classifier as run 8 found it: every call failing closed to `unclear`.
  setScopeClassifier(async () => ({
    scope: 'unclear',
    confidence: 0,
    evidence: [],
    classifier: 'none',
  }));
});

describe('a visitor who says it is a site, while the classifier is down', () => {
  it('reaches the preview instead of a sales call', async () => {
    const res = await POST(
      post({
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      })
    );
    const json = await res.json();
    expect(json.route).toBe('self-serve');
    // The verdict, not just the destination. `{"route":"discovery-call",
    // "scope":"unclear"}` is exactly what run 8 recorded.
    expect(json.scope).toBe('standard');
    expect(json.bookingUrl).toBeUndefined();
    resetScopeClassifier();
  });

  it('never sends back the copy that asserts they described software', async () => {
    const res = await POST(
      post({
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      })
    );
    const body = await res.text();
    expect(body).not.toContain('landing.discovery.scope.offer.body');
    expect(body).not.toContain('landing.discovery.scope.offer.title');
    expect(body).not.toContain(CUSTOM_WORK_ASSERTION);
    resetScopeClassifier();
  });

  it('is offered no calendar and files no lead', async () => {
    await POST(
      post({
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      })
    );
    expect(
      inserted.filter((row) => row.table === 'custom_work_leads')
    ).toHaveLength(0);
    expect(sendEmail).not.toHaveBeenCalled();
    resetScopeClassifier();
  });

  it('still asks the question when no answer has been given', async () => {
    const json = await (await POST(post(BRIEF))).json();
    expect(json.route).toBe('ask-one-more-question');
    expect(json.questionKey).toBe('landing.discovery.scope.question');
    resetScopeClassifier();
  });
});

describe('a visitor who says it is software, while the classifier is down', () => {
  it('is offered the call, and only then may the copy assert it', async () => {
    const res = await POST(
      post({
        ...BRIEF,
        clarification: 'Software my customers log into',
        answerKey: 'software',
      })
    );
    const json = await res.json();
    expect(json.route).toBe('discovery-call');
    expect(json.scope).toBe('custom');
    expect(json.offerCopy).toEqual({
      titleKey: 'landing.discovery.scope.offer.title',
      bodyKey: 'landing.discovery.scope.offer.body',
    });
    expect(json.bookingUrl).toContain('cal.flowstarter.dev');
    resetScopeClassifier();
  });
});

describe('a disagreement between the visitor and a confident classifier', () => {
  it('settles nothing, files a review, and lets the visitor carry on', async () => {
    setScopeClassifier(async () => ({
      scope: 'custom',
      confidence: 0.99,
      evidence: ['customers log into'],
      classifier: 'llm:test',
    }));
    const res = await POST(
      post({
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      })
    );
    const json = await res.json();
    expect(json.route).toBe('self-serve');
    expect(json.scope).toBe('unclear');
    expect(json.bookingUrl).toBeUndefined();
    expect(
      inserted.filter((row) => row.table === 'policy_reviews')
    ).toHaveLength(1);
    resetScopeClassifier();
  });
});
