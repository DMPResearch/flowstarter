/**
 * The routing endpoint: what it forwards, what it withholds, and what it does
 * when it cannot answer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const runScopeGate = vi.fn();
vi.mock('@/lib/flowstarter/scope-gate', () => ({
  runScopeGate: (...args: unknown[]) => runScopeGate(...args),
}));

/**
 * The limiter is Arcjet-backed through `routeLimiter` (#151), so it is stubbed
 * at that seam rather than by exhausting a real window: a test that limited
 * itself by sending eleven requests would pass for as long as the default
 * happened to be ten.
 */
const limited = { value: false };
vi.mock('@/lib/security/route-limits', () => ({
  routeLimiter: (name: string) => ({
    name,
    check: async () => ({
      ok: !limited.value,
      retryAfter: limited.value ? 42 : 0,
    }),
  }),
}));

import { POST } from '../route';

function post(
  body: unknown,
  extraHeaders: Record<string, string> = {},
  ip = '203.0.113.9'
) {
  return new NextRequest('https://flowstarter.net/api/discovery/scope', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': ip,
      ...extraHeaders,
    },
    body: JSON.stringify(body),
  });
}

const BRIEF = {
  fullName: 'Sarah Smith',
  email: 'sarah@example.com',
  description: 'A portal my customers log into',
  websiteUrl: 'https://acme.example.com',
};

beforeEach(() => {
  runScopeGate.mockReset();
  limited.value = false;
});

describe('POST /api/discovery/scope', () => {
  it('forwards the answers to the gate and returns its route', async () => {
    runScopeGate.mockResolvedValue({
      route: 'discovery-call',
      scope: 'custom',
      confidence: 0.9,
      evidence: ['log into'],
      rule: 'customAboveThreshold',
      bookingUrl: 'https://cal.flowstarter.dev/darius/discovery-call',
      leadId: 'lead-1',
    });

    const res = await POST(post(BRIEF));
    expect(res.status).toBe(200);
    const json = await res.json();
    expect(json.route).toBe('discovery-call');
    expect(json.bookingUrl).toContain('cal.flowstarter.dev');

    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({
        fullName: 'Sarah Smith',
        description: 'A portal my customers log into',
        websiteUrl: 'https://acme.example.com',
      })
    );
  });

  it('keeps the evidence and the lead id on the server', async () => {
    runScopeGate.mockResolvedValue({
      route: 'discovery-call',
      scope: 'custom',
      confidence: 0.9,
      evidence: ['a fragment of the visitor’s own brief'],
      rule: 'customAboveThreshold',
      bookingUrl: null,
      leadId: 'lead-1',
    });
    const json = await (await POST(post(BRIEF))).json();
    expect(json).not.toHaveProperty('evidence');
    expect(json).not.toHaveProperty('leadId');
    expect(json).not.toHaveProperty('rule');
  });

  it('defaults locale to en when the intake does not send one', async () => {
    runScopeGate.mockResolvedValue({
      route: 'self-serve',
      scope: 'standard',
      confidence: 0.9,
      evidence: [],
      rule: 'standardAboveThreshold',
    });
    await POST(post(BRIEF));
    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'en' })
    );
  });

  it('forwards a ro locale to the gate for the acceptable-use notice', async () => {
    runScopeGate.mockResolvedValue({
      route: 'self-serve',
      scope: 'standard',
      confidence: 0.9,
      evidence: [],
      rule: 'standardAboveThreshold',
    });
    await POST(post({ ...BRIEF, locale: 'ro' }));
    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({ locale: 'ro' })
    );
  });

  it('passes the clarifying answer through on the second pass', async () => {
    runScopeGate.mockResolvedValue({
      route: 'self-serve',
      scope: 'standard',
      confidence: 0.4,
      evidence: [],
      rule: 'clarifiedStandard',
    });
    await POST(post({ ...BRIEF, clarification: 'A site for my bakery' }));
    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({ clarification: 'A site for my bakery' })
    );
  });

  it('passes the answer key, which is what the rule decides on', async () => {
    runScopeGate.mockResolvedValue({
      route: 'self-serve',
      scope: 'standard',
      confidence: 0,
      evidence: [],
      rule: 'visitorSaysSite',
      operatorReview: false,
    });
    await POST(
      post({
        ...BRIEF,
        clarification: 'A site that presents my business',
        answerKey: 'site',
      })
    );
    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({ answerKey: 'site' })
    );
  });

  it('drops an answer key it does not recognise rather than refusing', async () => {
    // A stale tab posting an older shape must still reach a preview. Dropping
    // it degrades to exactly the behaviour of a typed answer.
    runScopeGate.mockResolvedValue({
      route: 'ask-one-more-question',
      scope: 'unclear',
      confidence: 0,
      evidence: [],
      rule: 'unclear',
      operatorReview: false,
      questionKey: 'landing.discovery.scope.question',
    });
    const res = await POST(post({ ...BRIEF, answerKey: 'maybe' }));
    expect(res.status).toBe(200);
    expect(runScopeGate).toHaveBeenCalledWith(
      expect.objectContaining({ answerKey: undefined })
    );
  });

  it('returns the question key when the gate wants one more answer', async () => {
    runScopeGate.mockResolvedValue({
      route: 'ask-one-more-question',
      scope: 'unclear',
      confidence: 0,
      evidence: [],
      rule: 'unclear',
      questionKey: 'landing.discovery.scope.question',
    });
    const json = await (await POST(post(BRIEF))).json();
    expect(json.route).toBe('ask-one-more-question');
    expect(json.questionKey).toBe('landing.discovery.scope.question');
  });

  it('holds rather than generating when the gate itself threw', async () => {
    runScopeGate.mockRejectedValue(new Error('everything is on fire'));
    const res = await POST(post(BRIEF));
    expect(res.status).toBe(200);
    const json = await res.json();
    // Not `self-serve`. Nothing classified this brief, so nobody may act on
    // it -- the same rule #193 wrote for an unavailable classifier.
    expect(json.route).toBe('hold');
    expect(json.reason).toBe('unavailable');
    expect(json.bookingUrl).toBeUndefined();
    expect(json.policy.decision).toBe('review');
  });

  it('does not run the gate for a body with nothing to classify', async () => {
    const res = await POST(post({ fullName: 'Sarah', email: 'x@y.z' }));
    const json = await res.json();
    // The one branch that is still `self-serve`, and it carries its own
    // reason: there is no brief to hold, so telling the visitor a person is
    // reading one would be a lie.
    expect(json.route).toBe('self-serve');
    expect(json.reason).toBe('no-brief');
    expect(runScopeGate).not.toHaveBeenCalled();
  });

  it('holds on a rate limit instead of handing out a generation', async () => {
    limited.value = true;
    const res = await POST(post(BRIEF));
    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBe('42');
    // This is finding 2 from the 2026-09-15 showcase run, as a test. The body
    // used to say `self-serve`, the wizard believed it, and a client-portal
    // brief got a generated preview and a deposit offer out of a rate limit.
    const json = await res.json();
    expect(json.route).toBe('hold');
    expect(json.reason).toBe('unavailable');
    expect(json.bookingUrl).toBeUndefined();
    // The hold copy and the hold notice travel with it, so the screen says
    // the true thing rather than guessing at one.
    expect(json.offerCopy.titleKey).toBe('landing.discovery.scope.hold.title');
    expect(json.policy.title).toBe('We are still checking this one');
    expect(runScopeGate).not.toHaveBeenCalled();
  });

  it('writes the hold notice in the language the request asked in', async () => {
    limited.value = true;
    const res = await POST(
      post(BRIEF, { 'accept-language': 'ro-RO,ro;q=0.9' })
    );
    expect(res.status).toBe(429);
    const json = await res.json();
    expect(json.policy.locale).toBe('ro');
    expect(json.policy.title).toBe('Încă verificăm');
  });

  it('never caches a routing decision at the edge', async () => {
    runScopeGate.mockResolvedValue({
      route: 'self-serve',
      scope: 'standard',
      confidence: 1,
      evidence: [],
      rule: 'standardAboveThreshold',
    });
    const res = await POST(post(BRIEF));
    expect(res.headers.get('Cache-Control')).toBe('private, no-store');
  });
});
