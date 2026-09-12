/**
 * The four connect routes and the availability route.
 *
 * Almost every case in this file is a refusal, because the refusals are the
 * product. A connect flow leaves our site and comes back to a callback URL
 * anybody on the internet can request with any query string they like, so what
 * this suite is really asserting is that the callback believes the signed
 * state and nothing else: not its own `previewId` parameter, not a state
 * signed with somebody else's secret, not one minted ten minutes ago, not one
 * minted for the other provider.
 *
 * The single most load-bearing test is
 * "takes the preview from the signed state and not from the callback query
 * string": it hands the callback a state bound to one preview and a query
 * string naming a different one, and asserts the store was told about the
 * state's. That is the difference between a portrait flow and a way to put
 * your photograph in a stranger's website.
 *
 * `portrait-store.ts` is mocked: it writes rows and objects, and this suite is
 * about which arguments reach it. `fetch` is stubbed for the one test that
 * runs a token exchange, and restored from `originalFetch` afterwards the way
 * the discovery suites do it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

vi.mock('server-only', () => ({}));

const capturePortraitFromProvider = vi.fn();
vi.mock('@/lib/flowstarter/portrait-store', () => ({
  capturePortraitFromProvider: (input: unknown) =>
    capturePortraitFromProvider(input),
}));

import { DEFAULT_PORTRAIT_STATE_TTL_MS } from '@/lib/flowstarter/portrait-config';
import {
  PORTRAIT_PROVIDER_ENDPOINTS,
  PortraitConnectError,
  decodePortraitState,
  encodePortraitState,
} from '@/lib/flowstarter/portrait-connect';

import { GET as availabilityRoute } from '../availability/route';
import { GET as instagramCallback } from '../instagram/callback/route';
import { GET as instagramStart } from '../instagram/start/route';
import { GET as linkedinCallback } from '../linkedin/callback/route';
import { GET as linkedinStart } from '../linkedin/start/route';

const ORIGIN = 'https://app.flowstarter.test';

const LINKEDIN_ID = 'li-client-id-0001';
const LINKEDIN_SECRET = 'li-client-secret-0001';
const INSTAGRAM_ID = 'ig-app-id-0001';
const INSTAGRAM_SECRET = 'ig-app-secret-0001';
const STATE_SECRET = 'state-secret-0001';

/** The preview the state is bound to, and the one an attacker would rather we used. */
const STATE_PREVIEW = '11111111-1111-4111-8111-111111111111';
const QUERY_PREVIEW = '22222222-2222-4222-8222-222222222222';
const WORKSPACE = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '44444444-4444-4444-8444-444444444444';

const RETURN_TO = '/discovery/preview/abc';

/**
 * The env keys this suite owns. Saved and restored whole so a test that clears
 * a credential cannot leak that into the next file.
 */
const PORTRAIT_ENV_KEYS = [
  'LINKEDIN_CLIENT_ID',
  'LINKEDIN_CLIENT_SECRET',
  'INSTAGRAM_APP_ID',
  'INSTAGRAM_APP_SECRET',
  'FLOWSTARTER_PORTRAIT_STATE_SECRET',
  'FLOWSTARTER_PORTRAIT_REDIRECT_BASE',
] as const;

const savedEnv: Record<string, string | undefined> = {};
const originalFetch = global.fetch;

function configureBothProviders(): void {
  process.env.LINKEDIN_CLIENT_ID = LINKEDIN_ID;
  process.env.LINKEDIN_CLIENT_SECRET = LINKEDIN_SECRET;
  process.env.INSTAGRAM_APP_ID = INSTAGRAM_ID;
  process.env.INSTAGRAM_APP_SECRET = INSTAGRAM_SECRET;
  process.env.FLOWSTARTER_PORTRAIT_STATE_SECRET = STATE_SECRET;
}

/**
 * A fresh address per request unless a test pins one, so the `/start` limiter
 * (a module-level map, shared by every test in this file) only ever fires in
 * the test that is about it.
 */
let addressCounter = 0;
function get(
  path: string,
  params: Record<string, string> = {},
  ip?: string
): NextRequest {
  addressCounter += 1;
  const url = new URL(`${ORIGIN}${path}`);
  for (const [key, value] of Object.entries(params)) {
    url.searchParams.set(key, value);
  }
  return new NextRequest(url, {
    headers: { 'x-forwarded-for': ip ?? `10.9.${addressCounter}.1` },
  });
}

/** A state we minted, with anything a test wants to spoil overridden. */
function signState(
  overrides: Partial<{
    provider: 'linkedin' | 'instagram';
    connectionId: string;
    previewId: string | null;
    workspaceId: string | null;
    returnTo: string;
    issuedAt: number;
  }> = {},
  secret: string = STATE_SECRET
): string {
  return encodePortraitState(
    {
      provider: 'linkedin',
      connectionId: CONNECTION,
      previewId: STATE_PREVIEW,
      workspaceId: null,
      returnTo: RETURN_TO,
      ...overrides,
    },
    secret
  );
}

function location(response: Response): URL {
  const raw = response.headers.get('location');
  expect(raw, 'every connect response redirects somewhere').toBeTruthy();
  return new URL(String(raw));
}

/** A provider that answers a token POST with a token and a profile GET with a profile. */
function stubProviderFetch(profile: Record<string, unknown>): void {
  global.fetch = vi.fn(async (_input: unknown, init?: { method?: string }) => {
    const body =
      init?.method === 'POST' ? { access_token: 'never-logged' } : profile;
    return {
      ok: true,
      status: 200,
      json: async () => body,
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const LINKEDIN_PROFILE = {
  sub: 'li-account-1',
  name: 'Ana Pop',
  picture: 'https://media.licdn.test/ana.jpg',
};

beforeEach(() => {
  for (const key of PORTRAIT_ENV_KEYS) savedEnv[key] = process.env[key];
  for (const key of PORTRAIT_ENV_KEYS) delete process.env[key];
  capturePortraitFromProvider.mockReset();
  capturePortraitFromProvider.mockResolvedValue({
    status: 'captured',
    portrait: {
      connectionId: CONNECTION,
      funnelAssetId: 'asset-1',
      assetId: null,
      width: 800,
      height: 800,
      verdict: 'portrait',
      placements: ['hero', 'about', 'avatar'],
    },
  });
  configureBothProviders();
});

afterEach(() => {
  for (const key of PORTRAIT_ENV_KEYS) {
    const value = savedEnv[key];
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// start
// ---------------------------------------------------------------------------

describe('GET /api/connect/<provider>/start', () => {
  it('answers an unconfigured deployment with 200 and the env var names, not a 500', async () => {
    delete process.env.LINKEDIN_CLIENT_ID;
    delete process.env.LINKEDIN_CLIENT_SECRET;

    const response = await linkedinStart(
      get('/api/connect/linkedin/start', { previewId: STATE_PREVIEW })
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      available: false,
      reason: 'not_configured',
      missing: ['LINKEDIN_CLIENT_ID', 'LINKEDIN_CLIENT_SECRET'],
    });
  });

  it('names the missing half only, and never leaks the half that is set', async () => {
    delete process.env.INSTAGRAM_APP_SECRET;

    const response = await instagramStart(
      get('/api/connect/instagram/start', { previewId: STATE_PREVIEW })
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body).toEqual({
      available: false,
      reason: 'not_configured',
      missing: ['INSTAGRAM_APP_SECRET'],
    });
    // The whole point of reporting names: no value may reach the browser.
    const serialised = JSON.stringify(body);
    expect(serialised).not.toContain(INSTAGRAM_ID);
    expect(serialised).not.toContain(STATE_SECRET);
  });

  it('refuses a request that names both a preview and a workspace', async () => {
    const response = await linkedinStart(
      get('/api/connect/linkedin/start', {
        previewId: STATE_PREVIEW,
        workspaceId: WORKSPACE,
      })
    );
    expect(response.status).toBe(400);
  });

  it('refuses a request that names neither', async () => {
    const response = await linkedinStart(get('/api/connect/linkedin/start'));
    expect(response.status).toBe(400);
  });

  it('refuses a previewId that is not a uuid', async () => {
    const response = await linkedinStart(
      get('/api/connect/linkedin/start', { previewId: 'not-a-uuid' })
    );
    expect(response.status).toBe(400);
  });

  it('refuses a workspaceId that is not a uuid', async () => {
    const response = await instagramStart(
      get('/api/connect/instagram/start', { workspaceId: '../../etc/passwd' })
    );
    expect(response.status).toBe(400);
  });

  it('sends the person to the provider with the client id, the scope, the redirect uri and a state we can decode', async () => {
    const response = await linkedinStart(
      get('/api/connect/linkedin/start', {
        previewId: STATE_PREVIEW,
        returnTo: RETURN_TO,
      })
    );

    expect(response.status).toBe(302);
    const target = location(response);
    expect(`${target.origin}${target.pathname}`).toBe(
      PORTRAIT_PROVIDER_ENDPOINTS.linkedin.authorize
    );
    expect(target.searchParams.get('response_type')).toBe('code');
    expect(target.searchParams.get('client_id')).toBe(LINKEDIN_ID);
    expect(target.searchParams.get('scope')).toBe(
      PORTRAIT_PROVIDER_ENDPOINTS.linkedin.scope
    );
    expect(target.searchParams.get('redirect_uri')).toBe(
      `${ORIGIN}/api/connect/linkedin/callback`
    );

    const decoded = decodePortraitState(
      String(target.searchParams.get('state')),
      {
        secret: STATE_SECRET,
        provider: 'linkedin',
        ttlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      }
    );
    expect(decoded).not.toBeNull();
    expect(decoded?.previewId).toBe(STATE_PREVIEW);
    expect(decoded?.workspaceId).toBeNull();
    expect(decoded?.returnTo).toBe(RETURN_TO);
    expect(decoded?.connectionId).toBeTruthy();
  });

  it('binds a workspace round trip to the workspace and nothing else', async () => {
    const response = await instagramStart(
      get('/api/connect/instagram/start', { workspaceId: WORKSPACE })
    );
    const decoded = decodePortraitState(
      String(location(response).searchParams.get('state')),
      {
        secret: STATE_SECRET,
        provider: 'instagram',
        ttlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      }
    );
    expect(decoded?.workspaceId).toBe(WORKSPACE);
    expect(decoded?.previewId).toBeNull();
  });

  it('refuses an absolute returnTo and falls back to the top of the funnel', async () => {
    const response = await linkedinStart(
      get('/api/connect/linkedin/start', {
        previewId: STATE_PREVIEW,
        returnTo: 'https://evil.test/collect',
      })
    );
    const decoded = decodePortraitState(
      String(location(response).searchParams.get('state')),
      {
        secret: STATE_SECRET,
        provider: 'linkedin',
        ttlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      }
    );
    expect(decoded?.returnTo).toBe('/');
  });

  it('refuses a protocol-relative returnTo, which is an absolute URL wearing a slash', async () => {
    const response = await linkedinStart(
      get('/api/connect/linkedin/start', {
        previewId: STATE_PREVIEW,
        returnTo: '//evil.test',
      })
    );
    const decoded = decodePortraitState(
      String(location(response).searchParams.get('state')),
      {
        secret: STATE_SECRET,
        provider: 'linkedin',
        ttlMs: DEFAULT_PORTRAIT_STATE_TTL_MS,
      }
    );
    expect(decoded?.returnTo).toBe('/');
  });

  it('stops minting states once one address has asked too many times', async () => {
    const address = '203.0.113.77';
    const statuses: number[] = [];
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const response = await linkedinStart(
        get(
          '/api/connect/linkedin/start',
          { previewId: STATE_PREVIEW },
          address
        )
      );
      statuses.push(response.status);
    }
    expect(statuses[0]).toBe(302);
    expect(statuses.at(-1)).toBe(429);
    expect(statuses.filter((status) => status === 429).length).toBeGreaterThan(
      0
    );
  });
});

// ---------------------------------------------------------------------------
// callback: the state is the only thing it believes
// ---------------------------------------------------------------------------

describe('GET /api/connect/<provider>/callback, unverified states', () => {
  // One real state, tampered with in the place an attacker would tamper: the
  // payload, leaving our signature attached to it.
  const [honestPayload, honestSignature] = signState().split('.');

  const cases: Array<{ name: string; state: string | null }> = [
    { name: 'a missing state', state: null },
    { name: 'a garbage state', state: 'not-a-state-at-all' },
    { name: 'a state with no signature on it', state: String(honestPayload) },
    {
      name: 'a state whose payload was edited after signing',
      state: `${honestPayload}x.${honestSignature}`,
    },
  ];

  for (const testCase of cases) {
    it(`${testCase.name} ends at ?portrait=failed and never reaches the store`, async () => {
      const response = await linkedinCallback(
        get('/api/connect/linkedin/callback', {
          code: 'a-code',
          ...(testCase.state === null ? {} : { state: testCase.state }),
        })
      );

      expect(response.status).toBe(302);
      const target = location(response);
      expect(target.origin).toBe(ORIGIN);
      expect(target.pathname).toBe('/');
      expect(target.searchParams.get('portrait')).toBe('failed');
      expect(target.searchParams.get('portraitProvider')).toBe('linkedin');
      expect(capturePortraitFromProvider).not.toHaveBeenCalled();
    });
  }

  it('a state signed with the wrong secret ends at ?portrait=failed', async () => {
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        code: 'a-code',
        state: signState({}, 'somebody-elses-secret'),
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('an expired state ends at ?portrait=failed', async () => {
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        code: 'a-code',
        state: signState({
          issuedAt: Date.now() - DEFAULT_PORTRAIT_STATE_TTL_MS - 1_000,
        }),
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('a state minted for the other provider ends at ?portrait=failed', async () => {
    // Correctly signed with the deployment's own secret. Only the provider
    // field is wrong, which is exactly the case a shared state secret makes
    // possible and the reason `decodePortraitState` checks it.
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        code: 'a-code',
        state: signState({ provider: 'instagram' }),
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('a verified state with neither a code nor an error ends at ?portrait=failed', async () => {
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', { state: signState() })
    );

    const target = location(response);
    expect(target.pathname).toBe(RETURN_TO);
    expect(target.searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// callback: the answers a person can give
// ---------------------------------------------------------------------------

describe('GET /api/connect/<provider>/callback, outcomes', () => {
  it('treats LinkedIn user_cancelled_authorize as an answer, not a failure', async () => {
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        error: 'user_cancelled_authorize',
        error_description: 'The user cancelled the request',
      })
    );

    const target = location(response);
    expect(target.pathname).toBe(RETURN_TO);
    expect(target.searchParams.get('portrait')).toBe('cancelled');
    expect(target.searchParams.get('portraitProvider')).toBe('linkedin');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('treats Instagram access_denied the same way', async () => {
    const response = await instagramCallback(
      get('/api/connect/instagram/callback', {
        state: signState({ provider: 'instagram' }),
        error: 'access_denied',
        error_reason: 'user_denied',
        error_description: 'The user denied your request',
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe('cancelled');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('reports a provider error that is not a refusal as a failure', async () => {
    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        error: 'temporarily_unavailable',
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('takes the preview from the signed state and not from the callback query string', async () => {
    stubProviderFetch(LINKEDIN_PROFILE);

    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        code: 'a-code',
        // An attacker's parameter. It must change nothing.
        previewId: QUERY_PREVIEW,
        workspaceId: WORKSPACE,
      })
    );

    expect(capturePortraitFromProvider).toHaveBeenCalledTimes(1);
    const input = capturePortraitFromProvider.mock.calls[0]?.[0];
    expect(input.previewId).toBe(STATE_PREVIEW);
    expect(input.previewId).not.toBe(QUERY_PREVIEW);
    expect(input.workspaceId).toBeNull();
    expect(input.connectionId).toBe(CONNECTION);
    expect(input.profile.accountId).toBe('li-account-1');

    const target = location(response);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe(RETURN_TO);
    expect(target.searchParams.get('portrait')).toBe('connected');
    expect(target.searchParams.get('portraitProvider')).toBe('linkedin');
  });

  it('carries a store skip back as its own reason, so the intake can print the matching sentence', async () => {
    stubProviderFetch(LINKEDIN_PROFILE);
    capturePortraitFromProvider.mockResolvedValue({
      status: 'skipped',
      reason: 'below_avatar_floor',
    });

    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        code: 'a-code',
      })
    );

    expect(location(response).searchParams.get('portrait')).toBe(
      'below_avatar_floor'
    );
  });

  it('ends a thrown PortraitConnectError at ?portrait=failed rather than throwing', async () => {
    global.fetch = vi.fn(async () => {
      throw new PortraitConnectError(
        'The provider refused.',
        'EXCHANGE_FAILED'
      );
    }) as unknown as typeof fetch;

    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        code: 'a-code',
      })
    );

    expect(response.status).toBe(302);
    expect(location(response).searchParams.get('portrait')).toBe('failed');
    expect(capturePortraitFromProvider).not.toHaveBeenCalled();
  });

  it('ends a store that throws at ?portrait=failed too, and still redirects home', async () => {
    stubProviderFetch(LINKEDIN_PROFILE);
    capturePortraitFromProvider.mockRejectedValue(new Error('storage is down'));

    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState(),
        code: 'a-code',
      })
    );

    expect(response.status).toBe(302);
    const target = location(response);
    expect(target.origin).toBe(ORIGIN);
    expect(target.searchParams.get('portrait')).toBe('failed');
  });

  it('honours the returnTo from the state and never one on the callback URL', async () => {
    stubProviderFetch(LINKEDIN_PROFILE);

    const response = await linkedinCallback(
      get('/api/connect/linkedin/callback', {
        state: signState({ returnTo: '/discovery/brief' }),
        code: 'a-code',
        returnTo: 'https://evil.test/collect',
      })
    );

    const target = location(response);
    expect(target.origin).toBe(ORIGIN);
    expect(target.pathname).toBe('/discovery/brief');
  });
});

// ---------------------------------------------------------------------------
// availability
// ---------------------------------------------------------------------------

describe('GET /api/connect/availability', () => {
  it('reports both providers when both are configured', async () => {
    const response = await availabilityRoute();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      providers: [
        { provider: 'linkedin', available: true, missing: [] },
        { provider: 'instagram', available: true, missing: [] },
      ],
    });
  });

  it('reports the one that is configured and names what the other needs', async () => {
    delete process.env.INSTAGRAM_APP_ID;
    delete process.env.INSTAGRAM_APP_SECRET;

    const response = await availabilityRoute();
    expect(await response.json()).toEqual({
      providers: [
        { provider: 'linkedin', available: true, missing: [] },
        {
          provider: 'instagram',
          available: false,
          missing: ['INSTAGRAM_APP_ID', 'INSTAGRAM_APP_SECRET'],
        },
      ],
    });
  });

  it('still answers 200 when neither is configured, because that is an answer', async () => {
    for (const key of PORTRAIT_ENV_KEYS) delete process.env[key];

    const response = await availabilityRoute();
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(
      body.providers.every((entry: { available: boolean }) => !entry.available)
    ).toBe(true);
    expect(JSON.stringify(body)).not.toContain(LINKEDIN_SECRET);
  });
});
