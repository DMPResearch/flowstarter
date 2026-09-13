// @vitest-environment node
/**
 * Codex audit F01: the two routes that mint a Clerk sign-in ticket used to
 * accept any destination `isSafeRedirectUrl()` liked, and that rule says yes to
 * every generated client site, because those are served at
 * `{slug}.{platformDomain}` and share the platform's root domain. A tenant
 * could therefore send a signed-in operator to
 * `…/transfer-redirect?redirect_url=https://attacker.flowstarter.net/collect`
 * and be handed their `__clerk_ticket`.
 *
 * These run the REAL handlers against every destination class the audit named,
 * on both routes, and the last block is a lint: it reads the two route files
 * off disk and fails if either one reaches for the general redirect rule again.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { GET as transferRedirect } from '../transfer-redirect/route';
import { POST as transferToken } from '../transfer-token/route';

vi.mock('server-only', () => ({}));

const authState: { userId: string | null } = { userId: 'user_operator' };
const TICKET = 'st_test_ticket_value';
const createSignInToken = vi.fn(async (_params: unknown) => ({
  token: TICKET,
}));

vi.mock('@clerk/nextjs/server', () => ({
  auth: async () => ({ userId: authState.userId, sessionClaims: {} }),
  clerkClient: async () => ({ signInTokens: { createSignInToken } }),
}));

/** The app's own origin in these tests, and the only allowed caller. */
const APP_ORIGIN = 'https://flowstarter.net';
const EDITOR_ORIGIN = 'https://code.flowstarter.net';

function asProduction() {
  vi.stubEnv('FLOWSTARTER_ENV', 'production');
  vi.stubEnv('NODE_ENV', 'production');
  vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.net');
  vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', 'flowstarter.net');
  vi.stubEnv('AUTH_TRANSFER_APP_ORIGIN', APP_ORIGIN);
  vi.stubEnv('AUTH_TRANSFER_EDITOR_ORIGIN', '');
  vi.stubEnv('AUTH_TRANSFER_LIBRARY_ORIGIN', '');
  vi.stubEnv('NEXT_PUBLIC_SITE_URL', APP_ORIGIN);
  vi.stubEnv('NEXT_PUBLIC_APP_URL', '');
  vi.stubEnv('NEXT_PUBLIC_EDITOR_URL', '');
}

function getRequest(destination: string | null): Request {
  const url = new URL(`${APP_ORIGIN}/api/auth/transfer-redirect`);
  if (destination !== null) url.searchParams.set('redirect_url', destination);
  return new Request(url.toString());
}

function postRequest(
  destination: unknown,
  origin: string | null = APP_ORIGIN
): Request {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
  };
  if (origin !== null) headers.Origin = origin;
  return new Request(`${APP_ORIGIN}/api/auth/transfer-token`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ redirectUrl: destination }),
  });
}

/** Where a 302 actually points, ticket included. */
function location(res: Response): string {
  return res.headers.get('location') ?? '';
}

beforeEach(() => {
  authState.userId = 'user_operator';
  createSignInToken.mockClear();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  asProduction();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// The destination classes, on both routes
// ---------------------------------------------------------------------------

/**
 * Every row is a destination the audit named. `allowed` is what a ticket-
 * minting route may do with it, and it is asserted identically on the GET and
 * the POST so the two cannot drift apart.
 */
const DESTINATIONS: ReadonlyArray<{
  name: string;
  url: string;
  allowed: boolean;
}> = [
  {
    name: 'the editor origin',
    url: `${EDITOR_ORIGIN}/projects/abc`,
    allowed: true,
  },
  {
    name: 'the other editor host',
    url: 'https://editor.flowstarter.net/settings',
    allowed: true,
  },
  {
    name: 'the library',
    url: 'https://library.flowstarter.net/agency-portfolio',
    allowed: true,
  },
  {
    name: 'an authenticated page of the app itself',
    url: `${APP_ORIGIN}/admin/dashboard`,
    allowed: true,
  },
  {
    name: 'a tenant site on the platform domain',
    url: 'https://attacker.flowstarter.net/collect',
    allowed: false,
  },
  {
    name: 'a hosted preview',
    url: 'https://p-4f2a9c1d8b3e.preview.flowstarter.net/',
    allowed: false,
  },
  {
    name: 'a PR staging slot',
    url: 'https://pr-73.staging.flowstarter.dev/',
    allowed: false,
  },
  {
    name: 'http on an allowed host',
    url: 'http://code.flowstarter.net/projects/abc',
    allowed: false,
  },
  {
    name: 'localhost outside development',
    url: 'http://localhost:5733/projects/abc',
    allowed: false,
  },
  {
    name: 'a path outside the app allow-list',
    url: `${APP_ORIGIN}/pricing`,
    allowed: false,
  },
  {
    name: 'an API path on an allowed origin',
    url: `${EDITOR_ORIGIN}/api/clerk/me`,
    allowed: false,
  },
  {
    name: 'a protocol-relative URL',
    url: '//attacker.flowstarter.net/collect',
    allowed: false,
  },
  {
    name: 'an authority behind userinfo',
    url: `${EDITOR_ORIGIN}@attacker.example/collect`,
    allowed: false,
  },
  {
    name: 'a backslash authority',
    url: `${EDITOR_ORIGIN}\\@attacker.example`,
    allowed: false,
  },
  {
    name: 'an encoded separator',
    url: `${EDITOR_ORIGIN}/%2f%2fattacker.example`,
    allowed: false,
  },
  {
    name: 'a unicode homograph of an allowed host',
    // Cyrillic "с" in place of the ASCII "c".
    url: 'https://сode.flowstarter.net/projects/abc',
    allowed: false,
  },
  { name: 'a javascript: URL', url: 'javascript:alert(1)', allowed: false },
];

describe('GET /api/auth/transfer-redirect', () => {
  for (const { name, url, allowed } of DESTINATIONS) {
    it(`${allowed ? 'forwards a ticket to' : 'refuses'} ${name}`, async () => {
      const res = await transferRedirect(getRequest(url));

      if (allowed) {
        expect(createSignInToken).toHaveBeenCalledTimes(1);
        const target = new URL(location(res));
        expect(target.origin).toBe(new URL(url).origin);
        expect(target.searchParams.get('__clerk_ticket')).toBe(TICKET);
      } else {
        expect(createSignInToken).not.toHaveBeenCalled();
        expect(location(res)).toBe(`${APP_ORIGIN}/admin/dashboard`);
        expect(location(res)).not.toContain('__clerk_ticket');
      }
    });
  }

  it('refuses a missing redirect_url', async () => {
    const res = await transferRedirect(getRequest(null));
    expect(createSignInToken).not.toHaveBeenCalled();
    expect(location(res)).toBe(`${APP_ORIGIN}/admin/dashboard`);
  });

  it('logs the refused origin and the reason', async () => {
    const warn = vi.spyOn(console, 'warn');
    await transferRedirect(
      getRequest('https://attacker.flowstarter.net/collect')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('origin=https://attacker.flowstarter.net')
    );
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('reason=untrusted-origin')
    );
  });

  it('sends a signed-out visitor to login carrying the allowed destination', async () => {
    authState.userId = null;
    const res = await transferRedirect(
      getRequest(`${EDITOR_ORIGIN}/projects/abc`)
    );
    const target = new URL(location(res));
    expect(target.pathname).toBe('/admin/login');
    expect(target.searchParams.get('redirect_url')).toBe(
      `${EDITOR_ORIGIN}/projects/abc`
    );
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it('does not forward when the mint fails', async () => {
    createSignInToken.mockRejectedValueOnce(new Error('clerk down'));
    const res = await transferRedirect(
      getRequest(`${EDITOR_ORIGIN}/projects/abc`)
    );
    expect(location(res)).toBe(`${APP_ORIGIN}/admin/dashboard`);
  });

  it('forbids caching or refererring the ticket onward', async () => {
    const res = await transferRedirect(
      getRequest(`${EDITOR_ORIGIN}/projects/abc`)
    );
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('allows a configured localhost editor in development', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'development');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.dev');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', 'flowstarter.dev');
    vi.stubEnv('AUTH_TRANSFER_EDITOR_ORIGIN', 'http://localhost:5733');

    const res = await transferRedirect(
      getRequest('http://localhost:5733/projects/abc')
    );
    expect(new URL(location(res)).searchParams.get('__clerk_ticket')).toBe(
      TICKET
    );
  });
});

describe('POST /api/auth/transfer-token', () => {
  for (const { name, url, allowed } of DESTINATIONS) {
    it(`${allowed ? 'mints a ticket for' : 'refuses'} ${name}`, async () => {
      const res = await transferToken(postRequest(url));

      if (allowed) {
        expect(res.status).toBe(200);
        const body = (await res.json()) as { url: string };
        const target = new URL(body.url);
        expect(target.origin).toBe(new URL(url).origin);
        expect(target.searchParams.get('__clerk_ticket')).toBe(TICKET);
      } else {
        expect(res.status).toBe(403);
        expect(createSignInToken).not.toHaveBeenCalled();
        expect(await res.text()).not.toContain(TICKET);
      }
    });
  }

  it('refuses a caller on a tenant origin before it looks at anything else', async () => {
    const res = await transferToken(
      postRequest(
        `${EDITOR_ORIGIN}/projects/abc`,
        'https://attacker.flowstarter.net'
      )
    );
    expect(res.status).toBe(403);
    expect(createSignInToken).not.toHaveBeenCalled();
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining('caller origin=https://attacker.flowstarter.net')
    );
  });

  it('refuses a caller with no Origin header at all', async () => {
    const res = await transferToken(
      postRequest(`${EDITOR_ORIGIN}/projects/abc`, null)
    );
    expect(res.status).toBe(403);
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it('accepts the editor as a caller', async () => {
    const res = await transferToken(
      postRequest(`${EDITOR_ORIGIN}/projects/abc`, EDITOR_ORIGIN)
    );
    expect(res.status).toBe(200);
  });

  it('refuses a signed-out caller', async () => {
    authState.userId = null;
    const res = await transferToken(postRequest(`${EDITOR_ORIGIN}/projects/a`));
    expect(res.status).toBe(401);
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it('refuses a non-JSON body', async () => {
    const res = await transferToken(
      new Request(`${APP_ORIGIN}/api/auth/transfer-token`, {
        method: 'POST',
        headers: { Origin: APP_ORIGIN, 'Content-Type': 'application/json' },
        body: 'not json',
      })
    );
    expect(res.status).toBe(400);
    expect(createSignInToken).not.toHaveBeenCalled();
  });

  it('refuses a redirectUrl that is not a string', async () => {
    for (const value of [undefined, null, 42, { href: EDITOR_ORIGIN }]) {
      createSignInToken.mockClear();
      const res = await transferToken(postRequest(value));
      expect(res.status).toBe(403);
      expect(createSignInToken).not.toHaveBeenCalled();
    }
  });

  it('logs the refused destination with its origin and reason', async () => {
    await transferToken(
      postRequest('https://attacker.flowstarter.net/collect')
    );
    expect(console.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        'origin=https://attacker.flowstarter.net reason=untrusted-origin'
      )
    );
  });

  it('reports a mint failure rather than a destination', async () => {
    createSignInToken.mockRejectedValueOnce(new Error('clerk down'));
    const res = await transferToken(postRequest(`${EDITOR_ORIGIN}/projects/a`));
    expect(res.status).toBe(500);
  });

  it('forbids caching or refererring the ticket onward', async () => {
    const res = await transferToken(postRequest(`${EDITOR_ORIGIN}/projects/a`));
    expect(res.headers.get('cache-control')).toContain('no-store');
    expect(res.headers.get('referrer-policy')).toBe('no-referrer');
  });

  it('allows a configured localhost editor in development', async () => {
    vi.stubEnv('FLOWSTARTER_ENV', 'development');
    vi.stubEnv('NODE_ENV', 'development');
    vi.stubEnv('PLATFORM_DOMAIN', 'flowstarter.dev');
    vi.stubEnv('NEXT_PUBLIC_PLATFORM_DOMAIN', 'flowstarter.dev');
    vi.stubEnv('AUTH_TRANSFER_APP_ORIGIN', 'http://localhost:3000');
    vi.stubEnv('AUTH_TRANSFER_EDITOR_ORIGIN', 'http://localhost:5733');

    const res = await transferToken(
      postRequest('http://localhost:5733/projects/abc', 'http://localhost:3000')
    );
    expect(res.status).toBe(200);
  });
});

// ---------------------------------------------------------------------------
// The lint: neither route may reach for the general redirect rule again
// ---------------------------------------------------------------------------

describe('the transfer routes use the credential policy, not the redirect rule', () => {
  const HERE = path.dirname(fileURLToPath(import.meta.url));
  const ROUTES = ['transfer-redirect', 'transfer-token'].map((name) => ({
    name,
    file: path.resolve(HERE, '..', name, 'route.ts'),
  }));

  /**
   * The route with its comments removed. The prose in these files names
   * `isSafeRedirectUrl` on purpose — to say why it is the wrong rule — and a
   * lint that cannot tell an explanation from a call would push that
   * explanation out of the file.
   */
  function code(file: string): string {
    return readFileSync(file, 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^\s*\/\/.*$/gm, '');
  }

  for (const { name, file } of ROUTES) {
    it(`${name} calls decideAuthTransferDestination`, () => {
      expect(code(file)).toMatch(/\bdecideAuthTransferDestination\b/);
    });

    it(`${name} never reaches for the general redirect rule`, () => {
      // `isSafeRedirectUrl` answers "is this a page on our platform?" and says
      // yes to every tenant site, because they are served at
      // `{slug}.{platformDomain}`. Fine for navigation, never for a
      // credential: that is the whole of Codex F01.
      const source = code(file);
      expect(source).not.toMatch(/\bisSafeRedirectUrl\b/);
      expect(source).not.toMatch(/\bisTrustedHost\b/);
      expect(source).not.toMatch(/\bgetAllowedRedirectOrigins\b/);
      expect(source).not.toMatch(/\bgetRootDomain\b/);
    });
  }
});
