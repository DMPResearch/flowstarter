/**
 * `routeLimiter(name)` — the one entry point every route-specific limiter in
 * the product now goes through. Backend priority: Arcjet, then Upstash, then
 * the in-memory limiter (development only, or the explicit
 * `FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT=1` override production is expected to
 * honour once #141's startup gate lands). See docs/security/rate-limits.md.
 *
 * The Arcjet SDK is mocked at its module boundary (`@/lib/arcjet`'s
 * `ajRouteLimit` export, and `@arcjet/next`'s `slidingWindow`) rather than
 * reimplemented — this suite is about `routeLimiter`'s own priority order,
 * characteristic wiring, and error handling, not Arcjet's rate-limit
 * algorithm.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const protectMock = vi.fn();
const withRuleMock = vi.fn((_rule: unknown) => ({ protect: protectMock }));
vi.mock('@/lib/arcjet', () => ({
  // `ajRouteLimit` and not `aj`: the route limiter runs on a client with no
  // shield and no bot rule, so a denial it sees can only ever be a rate
  // limit. See that client's doc for the 2026-09-15 defect behind the change.
  ajRouteLimit: { withRule: withRuleMock },
}));
vi.mock('@arcjet/next', () => ({
  // Identity: the real `slidingWindow` just builds the rule-config object
  // Arcjet's own SDK reads server-side; this suite only needs to see what
  // `routeLimiter` passed in.
  slidingWindow: (options: unknown) => options,
}));

const fetchMock = vi.fn();

function request(headers: Record<string, string> = {}): NextRequest {
  return new NextRequest('http://localhost/api/test', {
    method: 'POST',
    headers,
  });
}

function allowDecision() {
  return { isDenied: () => false, reason: {} };
}

function rateLimitDenyDecision(resetInMs: number) {
  return {
    isDenied: () => true,
    reason: {
      isRateLimit: () => true,
      resetTime: new Date(Date.now() + resetInMs),
    },
  };
}

function shieldDenyDecision() {
  return {
    isDenied: () => true,
    reason: { isRateLimit: () => false },
  };
}

beforeEach(async () => {
  vi.resetModules();
  protectMock.mockReset();
  withRuleMock.mockClear();
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  const { __resetRouteLimitersForTest } = await import('../route-limits');
  __resetRouteLimitersForTest();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('routeLimiter — Arcjet backend', () => {
  it('is used whenever ARCJET_KEY is set, ahead of Upstash and in-memory', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    expect(withRuleMock).toHaveBeenCalledTimes(1);
    expect(protectMock).toHaveBeenCalledTimes(1);
  });

  it('builds the sliding-window rule from the route config, not a literal', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('contact').check(request(), '1.2.3.4');

    const rule = withRuleMock.mock.calls[0]![0] as {
      mode: string;
      characteristics: string[];
      interval: number;
      max: number;
    };
    expect(rule).toEqual({
      mode: 'LIVE',
      characteristics: ['ip.src'],
      interval: 60,
      max: 5,
    });
  });

  it('honours an env override for the limit, not a hardcoded number', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    vi.stubEnv('RATE_LIMIT_CONTACT_MAX', '11');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('contact').check(request(), '1.2.3.4');

    const rule = withRuleMock.mock.calls[0]![0] as { max: number };
    expect(rule.max).toBe(11);
  });

  it('passes ip.src with no extra prop for an IP-characteristic route', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(protectMock).toHaveBeenCalledWith(
      expect.any(NextRequest),
      undefined
    );
  });

  it('passes the key as the custom characteristic prop for a token route', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('lead-capture-token').check(request(), 'tok_abc');

    expect(protectMock).toHaveBeenCalledWith(expect.any(NextRequest), {
      token: 'tok_abc',
    });
  });

  it('passes the key as the email characteristic prop for an email route', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('guest-deposit-checkout-email').check(
      request(),
      'a@example.com'
    );

    expect(protectMock).toHaveBeenCalledWith(expect.any(NextRequest), {
      email: 'a@example.com',
    });
  });

  it('maps a rate-limit deny decision to ok:false with the decision reset time', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(rateLimitDenyDecision(30_000));
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThanOrEqual(29);
    expect(result.retryAfter).toBeLessThanOrEqual(30);
  });

  it('maps a non-rate-limit deny (shield/bot) to ok:false with the window as a fallback', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(shieldDenyDecision());
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result).toEqual({ ok: false, retryAfter: 60 });
  });

  it('reuses one Arcjet client per route name across calls', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    await routeLimiter('contact').check(request(), '1.2.3.4');
    await routeLimiter('contact').check(request(), '5.6.7.8');

    expect(withRuleMock).toHaveBeenCalledTimes(1);
    expect(protectMock).toHaveBeenCalledTimes(2);
  });
});

describe('routeLimiter — Arcjet errors', () => {
  it('fails open in development with a logged warning', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    vi.stubEnv('NODE_ENV', 'development');
    protectMock.mockRejectedValue(new Error('network down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-preview-live').check(
      request(),
      '1.2.3.4'
    );

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('fails closed in production for an expensive anonymous endpoint', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    vi.stubEnv('NODE_ENV', 'production');
    protectMock.mockRejectedValue(new Error('network down'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-preview-live').check(
      request(),
      '1.2.3.4'
    );

    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBeGreaterThan(0);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('still fails open in production for a route not marked expensive', async () => {
    vi.stubEnv('ARCJET_KEY', 'test-key');
    vi.stubEnv('NODE_ENV', 'production');
    protectMock.mockRejectedValue(new Error('network down'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    warnSpy.mockRestore();
  });
});

/**
 * The showcase recorder's allowance, extended from the bot rule to the rate
 * limit.
 *
 * #178 let the recorder past `detectBot` in the middleware. It did not let it
 * past the route's own limit, and on 2026-09-15 that stopped the run: five
 * scenarios could not be filmed because `discovery-scope` answers ten per
 * minute per IP and one browser take plus its probes spends more than that
 * from a single address.
 *
 * The policy is not re-decided here -- `isRecorderRequestAllowed` is the same
 * function the middleware asks, and `packages/platform-config/test` owns its
 * own cases. What this pins is that the limiter asks it, that a hit is
 * audible, and that production is closed.
 */
describe('routeLimiter — the showcase recorder allowance', () => {
  const HEADER = 'x-flowstarter-recorder';
  const SECRET = 'recorder-secret-value';

  it('lets the recorder past the limit on staging, and says so', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    vi.stubEnv('FLOWSTARTER_RECORDER_SECRET', SECRET);
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(rateLimitDenyDecision(60_000));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-scope').check(
      request({ [HEADER]: SECRET }),
      '1.2.3.4'
    );

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    // Ahead of every backend, so Arcjet is never even asked.
    expect(protectMock).not.toHaveBeenCalled();
    // `console.warn`, not `info`: `next.config.mjs` compiles `info` out of a
    // production bundle, and staging builds with `NODE_ENV=production`. An
    // audit line that is stripped is not an audit line.
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('security.recorder_allowance')
    );
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('limit=discovery-scope')
    );
    // And never the secret itself.
    expect(warnSpy.mock.calls.flat().join(' ')).not.toContain(SECRET);
    warnSpy.mockRestore();
  });

  it('refuses the same header in production', async () => {
    // Belt: even with a secret wrongly set in a production env file.
    vi.stubEnv('FLOWSTARTER_ENV', 'production');
    vi.stubEnv('FLOWSTARTER_RECORDER_SECRET', SECRET);
    vi.stubEnv('ARCJET_KEY', 'test-key');
    vi.stubEnv('NODE_ENV', 'production');
    protectMock.mockResolvedValue(rateLimitDenyDecision(60_000));
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-scope').check(
      request({ [HEADER]: SECRET }),
      '1.2.3.4'
    );

    expect(result.ok).toBe(false);
    expect(protectMock).toHaveBeenCalled();
  });

  it('refuses a wrong header value on staging', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    vi.stubEnv('FLOWSTARTER_RECORDER_SECRET', SECRET);
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(rateLimitDenyDecision(60_000));
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-scope').check(
      request({ [HEADER]: 'not-the-secret' }),
      '1.2.3.4'
    );

    expect(result.ok).toBe(false);
  });

  it('is inert when no recorder secret is configured at all', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(rateLimitDenyDecision(60_000));
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-scope').check(
      request({ [HEADER]: SECRET }),
      '1.2.3.4'
    );

    expect(result.ok).toBe(false);
  });

  it('does not touch an ordinary visitor, who sends no header', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'staging');
    vi.stubEnv('FLOWSTARTER_RECORDER_SECRET', SECRET);
    vi.stubEnv('ARCJET_KEY', 'test-key');
    protectMock.mockResolvedValue(allowDecision());
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('discovery-scope').check(
      request(),
      '1.2.3.4'
    );

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    expect(protectMock).toHaveBeenCalled();
  });
});

describe('routeLimiter — Upstash backend', () => {
  it('is used when ARCJET_KEY is unset but Upstash is configured', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'secret');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 1 }, { result: 1 }],
    });
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result).toEqual({ ok: true, retryAfter: 0 });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(withRuleMock).not.toHaveBeenCalled();
    const [url] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://redis.example/pipeline');
  });

  it('refuses once the Upstash count passes the configured limit', async () => {
    vi.stubEnv('UPSTASH_REDIS_REST_URL', 'https://redis.example');
    vi.stubEnv('UPSTASH_REDIS_REST_TOKEN', 'secret');
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => [{ result: 6 }, { result: 1 }],
    });
    const { routeLimiter } = await import('../route-limits');

    // contact's documented default is 5/minute.
    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result.ok).toBe(false);
    expect(result.retryAfter).toBe(60);
  });
});

describe('routeLimiter — in-memory backend', () => {
  it('is used in development when neither Arcjet nor Upstash is configured', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { routeLimiter } = await import('../route-limits');
    const limiter = routeLimiter('guest-deposit-checkout-ip');

    for (let i = 0; i < 5; i += 1) {
      const result = await limiter.check(request(), '9.9.9.9');
      expect(result.ok).toBe(true);
    }
    const blocked = await limiter.check(request(), '9.9.9.9');

    expect(blocked.ok).toBe(false);
    expect(blocked.retryAfter).toBeGreaterThan(0);
    expect(withRuleMock).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('tracks keys independently', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const { routeLimiter } = await import('../route-limits');
    const limiter = routeLimiter('guest-deposit-checkout-ip');

    for (let i = 0; i < 5; i += 1) {
      await limiter.check(request(), '9.9.9.9');
    }
    const otherKey = await limiter.check(request(), '1.1.1.1');

    expect(otherKey.ok).toBe(true);
  });

  it('is also used in production when the explicit override is set', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    vi.stubEnv('FLOWSTARTER_ALLOW_LOCAL_RATE_LIMIT', '1');
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result).toEqual({ ok: true, retryAfter: 0 });
  });
});

describe('routeLimiter — nothing configured in production', () => {
  it('refuses the request rather than allowing it', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const { routeLimiter } = await import('../route-limits');

    const result = await routeLimiter('contact').check(request(), '1.2.3.4');

    expect(result.ok).toBe(false);
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
