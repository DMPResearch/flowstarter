/**
 * The two connect flows, and the state parameter that makes them safe.
 *
 * A connect flow leaves our site, spends time on a provider's, and comes back
 * to a callback URL that anybody on the internet can request. The only thing
 * standing between that and an attacker's photograph landing in a stranger's
 * preview is the state: an HMAC over a payload that names the provider, the
 * connection and the preview it belongs to, with an issue time so a stolen one
 * stops working. Every way that check can be got wrong is a way somebody else's
 * face ends up on a paying client's website, so every one of them is a test
 * below: a wrong secret, a tampered payload, a tampered signature, a signature
 * of the wrong length, a state minted for the other provider, one that has
 * expired, and one issued in a future our clock does not believe.
 *
 * The wrong-length signature deserves naming. `timingSafeEqual` throws on a
 * length mismatch rather than returning false, so the length comparison in
 * front of it is not an optimisation, it is the thing that stops a malformed
 * state from becoming a 500 that tells an attacker they found an edge. It is
 * pinned here so nobody deletes it as redundant.
 *
 * The other half of the file is what a provider says back. The measurements in
 * the module header are what the assertions are written against: LinkedIn's
 * OpenID Connect claims, where a headline is not standard and is usually
 * missing, and Instagram's `me`, where business and creator are the only
 * account types that can be read at all. Both readers refuse a payload with no
 * account id, because a connection row we cannot key is worse than no row.
 *
 * Everything here runs with an injected `fetch` and an injected environment.
 * No test in this file touches a network or needs a provider account.
 */
import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR,
  type EnvLike,
} from '../portrait-config';
import {
  DEFAULT_PORTRAIT_RETURN_TO,
  MAX_PROFILE_HEADLINE_CHARS,
  MAX_PROFILE_NAME_CHARS,
  MAX_PROFILE_URL_CHARS,
  MAX_RETURN_TO_CHARS,
  PORTRAIT_PROVIDER_ENDPOINTS,
  PORTRAIT_REDIRECT_BASE_ENV_VAR,
  PortraitConnectError,
  cleanAuthorizationCode,
  decodePortraitState,
  encodePortraitState,
  exchangePortraitCode,
  isSafeReturnTo,
  portraitAuthorizeUrl,
  portraitRedirectUri,
  readInstagramProfile,
  readLinkedinProfile,
  safeReturnTo,
  type ConnectFetch,
} from '../portrait-connect';

/** A deployment with both providers wired up. */
const ENV: EnvLike = {
  LINKEDIN_CLIENT_ID: 'li-client-id',
  LINKEDIN_CLIENT_SECRET: 'li-client-secret',
  INSTAGRAM_APP_ID: 'ig-app-id',
  INSTAGRAM_APP_SECRET: 'ig-app-secret',
};

const SECRET = 'a-state-signing-secret';
const CONNECTION_ID = 'c0ffee00-0000-4000-8000-000000000001';
const PREVIEW_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const TTL_MS = 10 * 60 * 1000;
const NOW = 1_757_700_000_000;

function base64url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Signs an arbitrary payload the way the module does, so a test can hand
 * `decodePortraitState` a well-signed state whose contents the encoder would
 * never produce. That is the only way to reach the shape checks behind the
 * signature check.
 */
function signedState(payload: unknown, secret: string = SECRET): string {
  const encoded = base64url(Buffer.from(JSON.stringify(payload), 'utf8'));
  return `${encoded}.${base64url(
    createHmac('sha256', secret).update(encoded).digest()
  )}`;
}

/** The same, for a payload that is not JSON at all. */
function signedRaw(payload: string, secret: string = SECRET): string {
  const encoded = base64url(Buffer.from(payload, 'utf8'));
  return `${encoded}.${base64url(
    createHmac('sha256', secret).update(encoded).digest()
  )}`;
}

interface StubResponse {
  ok: boolean;
  body?: unknown;
}

interface RecordedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * A `fetch` that answers from a queue and records what it was asked. Plain
 * objects rather than a `Response`, because the module only ever reads `.ok`
 * and `.json()`.
 */
function stubFetch(responses: StubResponse[]) {
  const calls: RecordedCall[] = [];
  const queue = [...responses];
  const impl = (async (input: unknown, init?: RequestInit) => {
    calls.push({
      url: String(input),
      method: String(init?.method ?? 'GET'),
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: typeof init?.body === 'string' ? init.body : '',
    });
    const next = queue.shift();
    if (!next) throw new Error('the module made an unexpected request');
    return {
      ok: next.ok,
      json: async () => next.body,
    } as unknown as Response;
  }) as unknown as ConnectFetch;
  return { impl, calls };
}

/** A LinkedIn userinfo payload of the shape the endpoint really returns. */
function linkedinUserinfo(overrides: Record<string, unknown> = {}) {
  return {
    sub: 'urn:li:person:AbC123',
    name: 'Darius Popescu',
    given_name: 'Darius',
    family_name: 'Popescu',
    email: 'darius@example.com',
    picture: 'https://media.licdn.com/dms/image/v2/headshot.jpg',
    ...overrides,
  };
}

/** An Instagram `me` payload of the shape the endpoint really returns. */
function instagramMe(overrides: Record<string, unknown> = {}) {
  return {
    user_id: '17841400000000000',
    username: 'flowstarter',
    name: 'Flowstarter',
    account_type: 'BUSINESS',
    profile_picture_url: 'https://scontent.cdninstagram.com/v/t51/p.jpg',
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('portraitRedirectUri', () => {
  // Staging and production are different apps with different registered
  // callback URLs, so the pinned base has to win over whatever host header
  // reached us.
  it('prefers the pinned base over the request origin', () => {
    expect(
      portraitRedirectUri('linkedin', 'https://whatever.example.com', {
        [PORTRAIT_REDIRECT_BASE_ENV_VAR]: 'https://app.flowstarter.dev',
      })
    ).toBe('https://app.flowstarter.dev/api/connect/linkedin/callback');
  });

  // The URL must match the provider's registration byte for byte, and a base
  // copied out of a browser bar carries a trailing slash.
  it('strips a trailing slash rather than sending a doubled path', () => {
    expect(
      portraitRedirectUri('instagram', 'https://ignored.example.com', {
        [PORTRAIT_REDIRECT_BASE_ENV_VAR]: 'https://app.flowstarter.dev///',
      })
    ).toBe('https://app.flowstarter.dev/api/connect/instagram/callback');
  });

  // A developer on a tunnel should not have to set anything to try the flow.
  it('falls back to the request origin when nothing is pinned', () => {
    expect(
      portraitRedirectUri('linkedin', 'https://abc123.ngrok.app', {})
    ).toBe('https://abc123.ngrok.app/api/connect/linkedin/callback');
    expect(
      portraitRedirectUri('instagram', 'https://abc123.ngrok.app/', {})
    ).toBe('https://abc123.ngrok.app/api/connect/instagram/callback');
  });

  // A base set to spaces is not a base, and the origin still has to work.
  it('treats a whitespace-only pinned base as unset', () => {
    expect(
      portraitRedirectUri('linkedin', 'https://abc123.ngrok.app', {
        [PORTRAIT_REDIRECT_BASE_ENV_VAR]: '   ',
      })
    ).toBe('https://abc123.ngrok.app/api/connect/linkedin/callback');
  });

  // The route calls this with no environment argument.
  it('reads the live environment when no environment is passed', () => {
    vi.stubEnv(PORTRAIT_REDIRECT_BASE_ENV_VAR, 'https://app.flowstarter.dev/');
    expect(portraitRedirectUri('linkedin', 'https://ignored.example.com')).toBe(
      'https://app.flowstarter.dev/api/connect/linkedin/callback'
    );
  });
});

describe('portraitAuthorizeUrl', () => {
  // The scope list is the reason LinkedIn is the first source: these three
  // claims need no app review, so the flow works the day it is deployed.
  it('sends LinkedIn every parameter the OpenID Connect flow needs', () => {
    const redirectUri =
      'https://app.flowstarter.dev/api/connect/linkedin/callback';
    const url = new URL(
      portraitAuthorizeUrl({
        provider: 'linkedin',
        clientId: 'li-client-id',
        redirectUri,
        state: 'the-signed-state',
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      PORTRAIT_PROVIDER_ENDPOINTS.linkedin.authorize
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('li-client-id');
    expect(url.searchParams.get('scope')).toBe('openid profile email');
    expect(url.searchParams.get('state')).toBe('the-signed-state');
    // The redirect URI is a URL inside a URL. It has to survive the round trip
    // through the query string exactly, or the provider rejects the request.
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
  });

  // Instagram's scope is the one that reads business and creator accounts.
  // Basic Display, which used to read personal ones, is retired.
  it('sends Instagram the business-basic scope and nothing else', () => {
    const redirectUri =
      'https://app.flowstarter.dev/api/connect/instagram/callback';
    const url = new URL(
      portraitAuthorizeUrl({
        provider: 'instagram',
        clientId: 'ig-app-id',
        redirectUri,
        state: 'another-signed-state',
      })
    );
    expect(`${url.origin}${url.pathname}`).toBe(
      PORTRAIT_PROVIDER_ENDPOINTS.instagram.authorize
    );
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('client_id')).toBe('ig-app-id');
    expect(url.searchParams.get('scope')).toBe('instagram_business_basic');
    expect(url.searchParams.get('state')).toBe('another-signed-state');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    // `forEach` rather than spreading the iterator: the test tsconfig targets
    // a version tsc will not downlevel the iterator protocol for, so
    // `[...searchParams.keys()]` is a typecheck error rather than a style.
    const keys: string[] = [];
    url.searchParams.forEach((_value, key) => keys.push(key));
    expect(keys.sort()).toEqual([
      'client_id',
      'redirect_uri',
      'response_type',
      'scope',
      'state',
    ]);
  });

  // A state is base64url and a redirect URI has a colon and slashes in it.
  // Hand-rolled escaping of either is how an open redirect gets built by
  // accident, so the encoding is asserted on the raw string too.
  it('escapes the redirect uri in the query string rather than inlining it', () => {
    const raw = portraitAuthorizeUrl({
      provider: 'linkedin',
      clientId: 'li-client-id',
      redirectUri: 'https://app.flowstarter.dev/api/connect/linkedin/callback',
      state: 'a state with spaces & an ampersand',
    });
    expect(raw).toContain(
      'redirect_uri=https%3A%2F%2Fapp.flowstarter.dev%2Fapi%2Fconnect%2Flinkedin%2Fcallback'
    );
    expect(new URL(raw).searchParams.get('state')).toBe(
      'a state with spaces & an ampersand'
    );
  });
});

describe('isSafeReturnTo', () => {
  // An ordinary path back into the funnel, which is the whole of what this is
  // allowed to be.
  it('accepts a path on our own origin', () => {
    expect(isSafeReturnTo('/')).toBe(true);
    expect(isSafeReturnTo('/start')).toBe(true);
    expect(isSafeReturnTo('/start?step=portrait&preview=abc')).toBe(true);
    expect(isSafeReturnTo('/start#section')).toBe(true);
  });

  // Written as an allow list rather than a block list, because the ways to
  // write "somewhere else" are open ended and a block list only ever catches
  // the ones somebody thought of.
  it('refuses anything a browser would read as another origin', () => {
    // Protocol-relative: resolves to https://evil.test.
    expect(isSafeReturnTo('//evil.test')).toBe(false);
    // The same thing with a backslash, which several browsers normalise to a
    // forward slash before they parse the authority.
    expect(isSafeReturnTo('/\\evil.test')).toBe(false);
    expect(isSafeReturnTo('https://evil.test/steal')).toBe(false);
    expect(isSafeReturnTo('javascript:alert(1)')).toBe(false);
    // Not a path at all, so there is nothing to send anybody to.
    expect(isSafeReturnTo('start')).toBe(false);
    expect(isSafeReturnTo('')).toBe(false);
  });

  // A newline in a `Location` header is a response-splitting attempt rather
  // than a path anybody meant to visit.
  it('refuses a control character anywhere in the path', () => {
    expect(isSafeReturnTo('/ok\nLocation: https://evil.test')).toBe(false);
    expect(isSafeReturnTo('/ok\r\n')).toBe(false);
    expect(isSafeReturnTo('/ok ')).toBe(false);
    expect(isSafeReturnTo('/ok')).toBe(false);
  });

  // A cap, because a signed state is not a place to park data.
  it('refuses a path longer than the cap, and accepts one exactly on it', () => {
    expect(isSafeReturnTo(`/${'a'.repeat(MAX_RETURN_TO_CHARS - 1)}`)).toBe(
      true
    );
    expect(isSafeReturnTo(`/${'a'.repeat(MAX_RETURN_TO_CHARS)}`)).toBe(false);
  });
});

describe('safeReturnTo', () => {
  // Total on purpose. A return path we do not like is not worth a 400 to
  // somebody halfway through authorising a photograph; it is worth sending them
  // somewhere that works.
  it('keeps a safe path and trims it', () => {
    expect(safeReturnTo('/start?step=portrait')).toBe('/start?step=portrait');
    expect(safeReturnTo('  /start  ')).toBe('/start');
  });

  // Everything else lands at the top of the funnel rather than failing.
  it('degrades anything unsafe or absent to the top of the funnel', () => {
    expect(safeReturnTo('https://evil.test')).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    expect(safeReturnTo('//evil.test')).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    expect(safeReturnTo(null)).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    expect(safeReturnTo(undefined)).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    expect(safeReturnTo('   ')).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    expect(DEFAULT_PORTRAIT_RETURN_TO).toBe('/');
  });
});

describe('encodePortraitState and decodePortraitState', () => {
  // The ordinary round trip: what we minted is what the callback reads back,
  // field for field, including the binding to the preview.
  it('reads back exactly what it signed', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
        nonce: 'a-fixed-nonce',
      },
      SECRET
    );
    expect(raw.split('.')).toHaveLength(2);
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toEqual({
      v: 1,
      provider: 'linkedin',
      connectionId: CONNECTION_ID,
      previewId: PREVIEW_ID,
      workspaceId: null,
      // Not supplied above, so it is the default the encoder normalises to.
      returnTo: '/',
      issuedAt: NOW,
      nonce: 'a-fixed-nonce',
    });
  });

  // Two states minted in the same millisecond have to be different strings, or
  // one person's state is another person's state.
  it('mints a different string every time when no nonce is supplied', () => {
    const one = encodePortraitState(
      {
        provider: 'instagram',
        connectionId: CONNECTION_ID,
        previewId: null,
        workspaceId: 'w1',
      },
      SECRET
    );
    const two = encodePortraitState(
      {
        provider: 'instagram',
        connectionId: CONNECTION_ID,
        previewId: null,
        workspaceId: 'w1',
      },
      SECRET
    );
    expect(one).not.toBe(two);
    const decoded = decodePortraitState(one, {
      secret: SECRET,
      provider: 'instagram',
      ttlMs: TTL_MS,
    });
    expect(decoded?.workspaceId).toBe('w1');
    expect(decoded?.previewId).toBeNull();
    expect(decoded?.nonce.length).toBeGreaterThan(0);
    expect(decoded?.issuedAt).toBeGreaterThan(0);
  });

  // A connect flow that cannot be made safe does not run. Minting an unsigned
  // state would be handing anybody a state generator.
  it('refuses to sign with an empty secret', () => {
    expect(() =>
      encodePortraitState(
        {
          provider: 'linkedin',
          connectionId: CONNECTION_ID,
          previewId: PREVIEW_ID,
          workspaceId: null,
        },
        ''
      )
    ).toThrow(PortraitConnectError);
    try {
      encodePortraitState(
        {
          provider: 'linkedin',
          connectionId: CONNECTION_ID,
          previewId: PREVIEW_ID,
          workspaceId: null,
        },
        ''
      );
      expect.unreachable('an unsigned state must never be minted');
    } catch (error) {
      expect((error as PortraitConnectError).code).toBe('NOT_CONFIGURED');
      expect((error as Error).name).toBe('PortraitConnectError');
    }
  });

  // A deployment with no secret cannot verify anything either, so it must not
  // accept everything by accident.
  it('refuses to decode with an empty secret', () => {
    const raw = signedState({
      v: 1,
      provider: 'linkedin',
      connectionId: CONNECTION_ID,
      previewId: null,
      workspaceId: null,
      issuedAt: NOW,
      nonce: 'n',
    });
    expect(
      decodePortraitState(raw, {
        secret: '',
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // A state signed with something else is a state we did not mint.
  it('rejects a state signed with a different secret', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      'some-other-secret'
    );
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // Swapping the payload for somebody else's connection is the attack the
  // signature exists to stop.
  it('rejects a tampered payload', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      SECRET
    );
    const [, signature] = raw.split('.') as [string, string];
    const forged = base64url(
      Buffer.from(
        JSON.stringify({
          v: 1,
          provider: 'linkedin',
          connectionId: 'somebody-elses-connection',
          previewId: PREVIEW_ID,
          workspaceId: null,
          issuedAt: NOW,
          nonce: 'n',
        }),
        'utf8'
      )
    );
    expect(
      decodePortraitState(`${forged}.${signature}`, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // Guessing at the signature, one character at a time, is the other half of
  // the same attack.
  it('rejects a tampered signature of the right length', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      SECRET
    );
    const [payload, signature] = raw.split('.') as [string, string];
    const flipped = (signature[0] === 'A' ? 'B' : 'A') + signature.slice(1);
    expect(flipped).toHaveLength(signature.length);
    expect(
      decodePortraitState(`${payload}.${flipped}`, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // The branch that guards `timingSafeEqual`, which throws rather than
  // returning false when the two buffers differ in length. Without the length
  // check in front of it, a two-character signature is a 500 instead of a
  // redirect, and a 500 is an oracle.
  it('rejects a signature of the wrong length without throwing', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      SECRET
    );
    const [payload] = raw.split('.') as [string, string];
    for (const signature of ['x', 'short', `${payload}-far-too-long`]) {
      expect(() =>
        decodePortraitState(`${payload}.${signature}`, {
          secret: SECRET,
          provider: 'linkedin',
          ttlMs: TTL_MS,
          now: NOW,
        })
      ).not.toThrow();
      expect(
        decodePortraitState(`${payload}.${signature}`, {
          secret: SECRET,
          provider: 'linkedin',
          ttlMs: TTL_MS,
          now: NOW,
        })
      ).toBeNull();
    }
  });

  // A LinkedIn state replayed against the Instagram callback would write the
  // wrong row, so the provider is part of what is signed and part of what is
  // checked.
  it('rejects a state minted for the other provider', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      SECRET
    );
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'instagram',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // Ten minutes of attention. After that a state found in a log or a browser
  // history is no longer a way in.
  it('rejects a state older than the ttl, and accepts one right on it', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW,
      },
      SECRET
    );
    const options = {
      secret: SECRET,
      provider: 'linkedin' as const,
      ttlMs: TTL_MS,
    };
    expect(
      decodePortraitState(raw, { ...options, now: NOW + TTL_MS })
    ).not.toBeNull();
    expect(
      decodePortraitState(raw, { ...options, now: NOW + TTL_MS + 1 })
    ).toBeNull();
  });

  // A state from the future is a clock we cannot trust to expire anything, so
  // it is refused rather than believed. A minute of skew is allowed, because
  // two servers are never exactly in step.
  it('rejects a state issued further into the future than clock skew explains', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW + 5 * 60_000,
      },
      SECRET
    );
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
    // Half a minute ahead is ordinary skew and still works.
    const nearlyNow = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        issuedAt: NOW + 30_000,
      },
      SECRET
    );
    expect(
      decodePortraitState(nearlyNow, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).not.toBeNull();
  });

  // The callback reads whatever arrived on the query string, so the shape
  // checks have to survive junk without an exception.
  it('rejects a string that is not two dot-separated parts', () => {
    const options = {
      secret: SECRET,
      provider: 'linkedin' as const,
      ttlMs: TTL_MS,
      now: NOW,
    };
    expect(decodePortraitState('', options)).toBeNull();
    expect(decodePortraitState('no-dot-at-all', options)).toBeNull();
    expect(decodePortraitState('a.b.c', options)).toBeNull();
    expect(decodePortraitState('.signature', options)).toBeNull();
    expect(decodePortraitState('payload.', options)).toBeNull();
  });

  // A correctly signed payload that is not JSON. Signed by us is not the same
  // as meaning anything.
  it('rejects a correctly signed payload that is not JSON', () => {
    expect(
      decodePortraitState(signedRaw('this is not json'), {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })
    ).toBeNull();
  });

  // JSON that is not an object cannot carry a provider or a connection.
  it('rejects a signed payload that is not an object', () => {
    const options = {
      secret: SECRET,
      provider: 'linkedin' as const,
      ttlMs: TTL_MS,
      now: NOW,
    };
    expect(decodePortraitState(signedRaw('null'), options)).toBeNull();
    expect(decodePortraitState(signedRaw('42'), options)).toBeNull();
    expect(decodePortraitState(signedRaw('"a string"'), options)).toBeNull();
  });

  // The version exists so an old state is rejected rather than misread by a
  // newer reader.
  it('rejects a state whose version is not 1', () => {
    const options = {
      secret: SECRET,
      provider: 'linkedin' as const,
      ttlMs: TTL_MS,
      now: NOW,
    };
    for (const v of [2, '1', undefined]) {
      expect(
        decodePortraitState(
          signedState({
            v,
            provider: 'linkedin',
            connectionId: CONNECTION_ID,
            previewId: null,
            workspaceId: null,
            issuedAt: NOW,
            nonce: 'n',
          }),
          options
        )
      ).toBeNull();
    }
  });

  // The connection id is the row the round trip will write. Without it there is
  // nothing to write to, so there is nothing to accept.
  it('rejects a state with no usable connection id', () => {
    const options = {
      secret: SECRET,
      provider: 'linkedin' as const,
      ttlMs: TTL_MS,
      now: NOW,
    };
    for (const connectionId of [undefined, '', 42, null]) {
      expect(
        decodePortraitState(
          signedState({
            v: 1,
            provider: 'linkedin',
            connectionId,
            previewId: null,
            workspaceId: null,
            issuedAt: NOW,
            nonce: 'n',
          }),
          options
        )
      ).toBeNull();
    }
  });

  // Without a numeric issue time nothing can expire, which is the same as never
  // expiring.
  it('rejects a state with no numeric issue time', () => {
    expect(
      decodePortraitState(
        signedState({
          v: 1,
          provider: 'linkedin',
          connectionId: CONNECTION_ID,
          previewId: null,
          workspaceId: null,
          issuedAt: String(NOW),
          nonce: 'n',
        }),
        { secret: SECRET, provider: 'linkedin', ttlMs: TTL_MS, now: NOW }
      )
    ).toBeNull();
  });

  // The optional fields are normalised rather than trusted, so a caller never
  // has to guard against a number where a preview id should be.
  it('normalises a non-string binding or nonce instead of trusting it', () => {
    const decoded = decodePortraitState(
      signedState({
        v: 1,
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: 7,
        workspaceId: { id: 'w1' },
        issuedAt: NOW,
      }),
      { secret: SECRET, provider: 'linkedin', ttlMs: TTL_MS, now: NOW }
    );
    expect(decoded).toEqual({
      v: 1,
      provider: 'linkedin',
      connectionId: CONNECTION_ID,
      previewId: null,
      workspaceId: null,
      // Absent from the payload entirely, and normalised the same way: an
      // unsafe or missing return path degrades to the top of the funnel
      // rather than voiding a state whose binding is still good.
      returnTo: '/',
      issuedAt: NOW,
      nonce: '',
    });
  });

  // The path the person was on when they pressed the button rides inside the
  // signature rather than on the callback's query string, for the same reason
  // the preview id does: the callback is a URL anybody can request, and a
  // redirect target read off its own query string is an open redirect with our
  // domain in front of it.
  it('carries a safe return path through the round trip', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        returnTo: '/start?step=portrait&preview=abc',
        issuedAt: NOW,
      },
      SECRET
    );
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })?.returnTo
    ).toBe('/start?step=portrait&preview=abc');
  });

  // Normalised before it is signed, so an unsafe path never becomes a signed
  // one and there is less for the callback's own check to catch.
  it('normalises an unsafe return path before it signs it', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
        returnTo: 'https://evil.test/steal',
        issuedAt: NOW,
      },
      SECRET
    );
    expect(
      Buffer.from(
        (raw.split('.')[0] ?? '').replace(/-/g, '+').replace(/_/g, '/'),
        'base64'
      ).toString('utf8')
    ).not.toContain('evil.test');
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
        now: NOW,
      })?.returnTo
    ).toBe(DEFAULT_PORTRAIT_RETURN_TO);
  });

  // And checked again on the way out. The signature proves we minted the state,
  // not that the path inside it is still one we are willing to send a browser
  // to, so a state minted before the check existed cannot become an open
  // redirect with a valid signature on it. It degrades rather than voiding the
  // state, because the binding to the preview is the part that matters.
  it('re-checks the return path on the way out instead of trusting the signature', () => {
    for (const hostile of [
      '//evil.test',
      '/\\evil.test',
      'https://evil.test/steal',
      '/ok\nLocation: https://evil.test',
    ]) {
      const decoded = decodePortraitState(
        signedState({
          v: 1,
          provider: 'linkedin',
          connectionId: CONNECTION_ID,
          previewId: PREVIEW_ID,
          workspaceId: null,
          returnTo: hostile,
          issuedAt: NOW,
          nonce: 'n',
        }),
        { secret: SECRET, provider: 'linkedin', ttlMs: TTL_MS, now: NOW }
      );
      // Not null: the state is still ours and the preview binding is still good.
      expect(decoded?.connectionId).toBe(CONNECTION_ID);
      expect(decoded?.returnTo).toBe(DEFAULT_PORTRAIT_RETURN_TO);
    }
  });

  // The callback with no `now` supplied is the production path.
  it('uses the wall clock when no now is supplied', () => {
    const raw = encodePortraitState(
      {
        provider: 'linkedin',
        connectionId: CONNECTION_ID,
        previewId: PREVIEW_ID,
        workspaceId: null,
      },
      SECRET
    );
    expect(
      decodePortraitState(raw, {
        secret: SECRET,
        provider: 'linkedin',
        ttlMs: TTL_MS,
      })
    ).not.toBeNull();
  });
});

describe('cleanAuthorizationCode', () => {
  // An ordinary code has to come through untouched.
  it('leaves an ordinary code alone', () => {
    expect(cleanAuthorizationCode('AQT1abcDEF-_123')).toBe('AQT1abcDEF-_123');
  });

  // Instagram's redirect carries a `#_` fragment, and some clients hand it to
  // us glued to the code. Left on, the exchange fails with a message nobody can
  // act on.
  it("strips Instagram's trailing fragment", () => {
    expect(cleanAuthorizationCode('AQT1abcDEF#_')).toBe('AQT1abcDEF');
    expect(cleanAuthorizationCode('AQT1abcDEF#anything-else')).toBe(
      'AQT1abcDEF'
    );
  });

  // A code copied by hand arrives with whitespace on it.
  it('trims surrounding whitespace', () => {
    expect(cleanAuthorizationCode('  AQT1abcDEF \n')).toBe('AQT1abcDEF');
    expect(cleanAuthorizationCode(' AQT1abcDEF #_')).toBe('AQT1abcDEF');
  });

  // Nothing in means nothing out, and the caller turns that into NO_CODE.
  it('is empty for an empty or fragment-only input', () => {
    expect(cleanAuthorizationCode('')).toBe('');
    expect(cleanAuthorizationCode('   ')).toBe('');
    expect(cleanAuthorizationCode('#_')).toBe('');
  });
});

describe('readLinkedinProfile', () => {
  // The standard OpenID Connect claims, read into our shape.
  it('reads a full userinfo payload', () => {
    expect(readLinkedinProfile(linkedinUserinfo())).toEqual({
      provider: 'linkedin',
      accountId: 'urn:li:person:AbC123',
      name: 'Darius Popescu',
      headline: '',
      pictureUrl: 'https://media.licdn.com/dms/image/v2/headshot.jpg',
      accountType: 'unknown',
    });
  });

  // A headline is not a standard claim and is absent from most responses, so
  // nothing downstream may treat it as required. When it is there we keep it.
  it('keeps a headline when the provider happened to send one', () => {
    const profile = readLinkedinProfile(
      linkedinUserinfo({ headline: 'Builder of small useful things' })
    );
    expect(profile?.headline).toBe('Builder of small useful things');
  });

  // Some responses carry the two halves of the name and no `name` claim, and a
  // site that greets somebody by half their name reads as broken.
  it('joins the given and family names when there is no name claim', () => {
    const profile = readLinkedinProfile(linkedinUserinfo({ name: undefined }));
    expect(profile?.name).toBe('Darius Popescu');
  });

  // Only one half present is still better than nothing, and must not leave a
  // stray space behind.
  it('joins cleanly when only one half of the name is present', () => {
    expect(
      readLinkedinProfile(
        linkedinUserinfo({ name: '', family_name: undefined })
      )?.name
    ).toBe('Darius');
    expect(
      readLinkedinProfile(
        linkedinUserinfo({ name: '   ', given_name: undefined })
      )?.name
    ).toBe('Popescu');
  });

  // An account with no picture is a normal outcome, not a failure.
  it('reports an empty picture url when the account has no picture', () => {
    const profile = readLinkedinProfile(linkedinUserinfo({ picture: null }));
    expect(profile?.pictureUrl).toBe('');
  });

  // Without the provider's own id we cannot tell a reconnect from a second
  // person, and a connection row we cannot key is worse than no row.
  it('refuses a payload with no sub', () => {
    expect(
      readLinkedinProfile(linkedinUserinfo({ sub: undefined }))
    ).toBeNull();
    expect(readLinkedinProfile(linkedinUserinfo({ sub: '  ' }))).toBeNull();
    expect(readLinkedinProfile(linkedinUserinfo({ sub: 12345 }))).toBeNull();
  });

  // A provider that answers with something that is not an object is a provider
  // we cannot read, and that is a null rather than a crash in a route.
  it('refuses anything that is not an object', () => {
    expect(readLinkedinProfile(null)).toBeNull();
    expect(readLinkedinProfile(undefined)).toBeNull();
    expect(readLinkedinProfile('a string')).toBeNull();
    expect(readLinkedinProfile(42)).toBeNull();
  });

  // Caps, so a hostile or broken provider cannot write an essay into a column
  // sized for a name.
  it('truncates a name, a headline and a url to the documented caps', () => {
    const profile = readLinkedinProfile(
      linkedinUserinfo({
        name: 'n'.repeat(500),
        headline: 'h'.repeat(1000),
        picture: `https://media.licdn.com/${'p'.repeat(2000)}`,
      })
    );
    expect(profile?.name).toHaveLength(MAX_PROFILE_NAME_CHARS);
    expect(profile?.headline).toHaveLength(MAX_PROFILE_HEADLINE_CHARS);
    expect(profile?.pictureUrl).toHaveLength(MAX_PROFILE_URL_CHARS);
  });
});

describe('readInstagramProfile', () => {
  // A business account is one of the two the scope can read at all.
  it('reads a business account', () => {
    expect(readInstagramProfile(instagramMe())).toEqual({
      provider: 'instagram',
      accountId: '17841400000000000',
      name: 'Flowstarter',
      headline: '',
      pictureUrl: 'https://scontent.cdninstagram.com/v/t51/p.jpg',
      accountType: 'business',
    });
  });

  // A creator account is the other, and must not be mistaken for personal.
  it('reads a creator account', () => {
    expect(
      readInstagramProfile(instagramMe({ account_type: 'CREATOR' }))
        ?.accountType
    ).toBe('creator');
  });

  // A personal account is the terminal case the rule needs to name, so it has
  // to survive the read rather than being flattened into unknown.
  it('reads a personal account as personal, because the rule depends on it', () => {
    expect(
      readInstagramProfile(instagramMe({ account_type: 'PERSONAL' }))
        ?.accountType
    ).toBe('personal');
  });

  // Anything we do not recognise is unknown, which lets the rule judge the
  // picture on its merits instead of refusing outright.
  it('reads an unrecognised account type as unknown', () => {
    expect(
      readInstagramProfile(instagramMe({ account_type: 'MEDIA_CREATOR' }))
        ?.accountType
    ).toBe('unknown');
    expect(
      readInstagramProfile(instagramMe({ account_type: undefined }))
        ?.accountType
    ).toBe('unknown');
  });

  // `user_id` is what the current endpoint returns and `id` is what older
  // responses carry, so both are accepted and the newer one wins.
  it('prefers user_id and accepts id', () => {
    expect(
      readInstagramProfile(instagramMe({ id: 'legacy-id' }))?.accountId
    ).toBe('17841400000000000');
    expect(
      readInstagramProfile(instagramMe({ user_id: undefined, id: 'legacy-id' }))
        ?.accountId
    ).toBe('legacy-id');
  });

  // Same argument as LinkedIn: no id, no row we can key.
  it('refuses a payload with no id of either kind', () => {
    expect(
      readInstagramProfile(instagramMe({ user_id: undefined, id: undefined }))
    ).toBeNull();
    expect(readInstagramProfile(null)).toBeNull();
    expect(readInstagramProfile('a string')).toBeNull();
  });

  // The handle is a better label than nothing when the account has no name set.
  it('falls back to the username when there is no name', () => {
    expect(readInstagramProfile(instagramMe({ name: undefined }))?.name).toBe(
      'flowstarter'
    );
    expect(
      readInstagramProfile(
        instagramMe({ name: undefined, username: undefined })
      )?.name
    ).toBe('');
  });

  // Instagram has no equivalent of a headline, so an empty one is the contract
  // rather than a gap somebody should try to fill.
  it('always reports an empty headline', () => {
    expect(
      readInstagramProfile(instagramMe({ headline: 'ignored' }))?.headline
    ).toBe('');
  });
});

describe('exchangePortraitCode', () => {
  const REDIRECT_URI =
    'https://app.flowstarter.dev/api/connect/linkedin/callback';
  const TOKEN = 'ACCESS-TOKEN-THAT-MUST-NOT-ESCAPE';

  async function codeFor(
    input: Parameters<typeof exchangePortraitCode>[0]
  ): Promise<PortraitConnectError> {
    try {
      await exchangePortraitCode(input);
    } catch (error) {
      return error as PortraitConnectError;
    }
    throw new Error('the exchange was expected to fail and did not');
  }

  // A deployment with no credentials cannot complete an exchange, and finding
  // that out before any request is made is the cheapest possible failure.
  it('refuses before it makes a request when the provider is not configured', async () => {
    const fetchImpl = stubFetch([]);
    const error = await codeFor({
      provider: 'linkedin',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
      env: {},
      fetchImpl: fetchImpl.impl,
    });
    expect(error).toBeInstanceOf(PortraitConnectError);
    expect(error.code).toBe('NOT_CONFIGURED');
    expect(fetchImpl.calls).toHaveLength(0);
  });

  // A callback with no code is a person who declined, or a redirect that went
  // wrong. Either way there is nothing to exchange.
  it('refuses an empty code, including one that was only a fragment', async () => {
    const fetchImpl = stubFetch([]);
    for (const code of ['', '   ', '#_']) {
      const error = await codeFor({
        provider: 'linkedin',
        code,
        redirectUri: REDIRECT_URI,
        env: ENV,
        fetchImpl: fetchImpl.impl,
      });
      expect(error.code).toBe('NO_CODE');
    }
    expect(fetchImpl.calls).toHaveLength(0);
  });

  // The provider refusing the exchange is its own failure, distinct from the
  // profile read, because the two lead to different next steps.
  it('reports EXCHANGE_FAILED when the token endpoint refuses', async () => {
    const fetchImpl = stubFetch([{ ok: false }]);
    const error = await codeFor({
      provider: 'linkedin',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });
    expect(error.code).toBe('EXCHANGE_FAILED');
    expect(fetchImpl.calls).toHaveLength(1);
  });

  // A 200 with no token in it is the same failure as a refusal, and must not be
  // read as a token of empty string.
  it('reports EXCHANGE_FAILED when the token response carries no token', async () => {
    for (const body of [{}, { access_token: '' }, { access_token: 123 }]) {
      const fetchImpl = stubFetch([{ ok: true, body }]);
      const error = await codeFor({
        provider: 'linkedin',
        code: 'AQT1abcDEF',
        redirectUri: REDIRECT_URI,
        env: ENV,
        fetchImpl: fetchImpl.impl,
      });
      expect(error.code).toBe('EXCHANGE_FAILED');
      // The profile endpoint was never asked, because there was nothing to ask
      // it with.
      expect(fetchImpl.calls).toHaveLength(1);
    }
  });

  // A token that works and a profile endpoint that will not answer is a
  // different sentence for the client than a refused exchange.
  it('reports PROFILE_FAILED when the profile endpoint refuses', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN } },
      { ok: false },
    ]);
    const error = await codeFor({
      provider: 'linkedin',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });
    expect(error.code).toBe('PROFILE_FAILED');
    expect(fetchImpl.calls).toHaveLength(2);
  });

  // A 200 whose body the reader refuses, which is what a payload with no
  // account id is. Same outcome as no answer at all, because a row we cannot
  // key is the same as no row.
  it('reports PROFILE_FAILED when the LinkedIn payload has no sub', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN } },
      { ok: true, body: { name: 'Darius Popescu' } },
    ]);
    const error = await codeFor({
      provider: 'linkedin',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });
    expect(error.code).toBe('PROFILE_FAILED');
  });

  // The same on the Instagram side, which is a separate branch and a separate
  // reader.
  it('reports PROFILE_FAILED when the Instagram payload has no id', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN } },
      { ok: true, body: { username: 'flowstarter' } },
    ]);
    const error = await codeFor({
      provider: 'instagram',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });
    expect(error.code).toBe('PROFILE_FAILED');
  });

  // The happy path, asserted against the shape LinkedIn documents: a form POST
  // with the four fields, then a bearer request to userinfo.
  it('exchanges a LinkedIn code as a form post and reads userinfo with a bearer token', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN, expires_in: 5184000 } },
      { ok: true, body: linkedinUserinfo() },
    ]);
    const profile = await exchangePortraitCode({
      provider: 'linkedin',
      // The fragment has to be stripped before it reaches the provider.
      code: 'AQT1abcDEF#_',
      redirectUri: REDIRECT_URI,
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });

    const [tokenCall, profileCall] = fetchImpl.calls as [
      RecordedCall,
      RecordedCall
    ];
    expect(tokenCall.url).toBe(PORTRAIT_PROVIDER_ENDPOINTS.linkedin.token);
    expect(tokenCall.method).toBe('POST');
    expect(tokenCall.headers['content-type']).toBe(
      'application/x-www-form-urlencoded'
    );
    const form = new URLSearchParams(tokenCall.body);
    expect(form.get('grant_type')).toBe('authorization_code');
    expect(form.get('code')).toBe('AQT1abcDEF');
    expect(form.get('redirect_uri')).toBe(REDIRECT_URI);
    expect(form.get('client_id')).toBe('li-client-id');
    expect(form.get('client_secret')).toBe('li-client-secret');

    expect(profileCall.url).toBe(PORTRAIT_PROVIDER_ENDPOINTS.linkedin.profile);
    expect(profileCall.method).toBe('GET');
    expect(profileCall.headers.authorization).toBe(`Bearer ${TOKEN}`);

    expect(profile.provider).toBe('linkedin');
    expect(profile.accountId).toBe('urn:li:person:AbC123');
    expect(profile.name).toBe('Darius Popescu');
    expect(profile.pictureUrl).toBe(
      'https://media.licdn.com/dms/image/v2/headshot.jpg'
    );
    expect(profile.accountType).toBe('unknown');
  });

  // Instagram wants the token on the query string rather than in a header, and
  // wants the field list named explicitly or it answers with almost nothing.
  it('reads the Instagram profile with the fields list and the token on the query string', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN, user_id: '17841400000000000' } },
      { ok: true, body: instagramMe() },
    ]);
    const profile = await exchangePortraitCode({
      provider: 'instagram',
      code: 'AQT1abcDEF',
      redirectUri: 'https://app.flowstarter.dev/api/connect/instagram/callback',
      env: ENV,
      fetchImpl: fetchImpl.impl,
    });

    const [tokenCall, profileCall] = fetchImpl.calls as [
      RecordedCall,
      RecordedCall
    ];
    expect(tokenCall.url).toBe(PORTRAIT_PROVIDER_ENDPOINTS.instagram.token);
    expect(new URLSearchParams(tokenCall.body).get('client_id')).toBe(
      'ig-app-id'
    );

    const profileUrl = new URL(profileCall.url);
    expect(`${profileUrl.origin}${profileUrl.pathname}`).toBe(
      PORTRAIT_PROVIDER_ENDPOINTS.instagram.profile
    );
    expect(profileUrl.searchParams.get('fields')).toBe(
      'user_id,username,name,account_type,profile_picture_url'
    );
    expect(profileUrl.searchParams.get('access_token')).toBe(TOKEN);
    // No bearer header on this one: Instagram does not read it.
    expect(profileCall.headers.authorization).toBeUndefined();

    expect(profile.provider).toBe('instagram');
    expect(profile.accountId).toBe('17841400000000000');
    expect(profile.accountType).toBe('business');
  });

  // The product needs one picture and two lines of text. An access token that
  // could fetch more of somebody's account is a liability we have no use for,
  // so it is used and dropped: never written to a row, never logged, and never
  // handed back to a caller who might do either by accident.
  it('never returns the access token to the caller', async () => {
    for (const provider of ['linkedin', 'instagram'] as const) {
      const fetchImpl = stubFetch([
        { ok: true, body: { access_token: TOKEN } },
        {
          ok: true,
          body: provider === 'linkedin' ? linkedinUserinfo() : instagramMe(),
        },
      ]);
      const profile = await exchangePortraitCode({
        provider,
        code: 'AQT1abcDEF',
        redirectUri: REDIRECT_URI,
        env: ENV,
        fetchImpl: fetchImpl.impl,
      });
      expect(Object.keys(profile).sort()).toEqual([
        'accountId',
        'accountType',
        'headline',
        'name',
        'pictureUrl',
        'provider',
      ]);
      expect(JSON.stringify(profile)).not.toContain(TOKEN);
      for (const value of Object.values(profile)) {
        expect(String(value)).not.toContain(TOKEN);
      }
    }
  });

  /**
   * A `fetch` that never answers and rejects the way a real one does when its
   * signal is aborted. The only way to exercise the timeout, which is a promise
   * about how long somebody waits rather than a detail of the transport.
   */
  function hangingFetch(): ConnectFetch {
    return (async (_url: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('the request was aborted'));
        });
      })) as unknown as ConnectFetch;
  }

  // A provider that has stopped answering must not hold a visitor on a spinner
  // for as long as the socket stays open. The budget is what ends it.
  it('abandons a token request that outlives the provider budget', async () => {
    await expect(
      exchangePortraitCode({
        provider: 'linkedin',
        code: 'AQT1abcDEF',
        redirectUri: REDIRECT_URI,
        env: { ...ENV, [PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR]: '5' },
        fetchImpl: hangingFetch(),
      })
    ).rejects.toThrow('the request was aborted');
  });

  // The same budget applies to the second request, because a token we cannot
  // spend is no better than a token we never got.
  it('abandons a profile request that outlives the provider budget', async () => {
    let call = 0;
    const impl = (async (_url: unknown, init?: RequestInit) => {
      call += 1;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({ access_token: TOKEN }),
        } as unknown as Response;
      }
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new Error('the request was aborted'));
        });
      });
    }) as unknown as ConnectFetch;

    await expect(
      exchangePortraitCode({
        provider: 'instagram',
        code: 'AQT1abcDEF',
        redirectUri: REDIRECT_URI,
        env: { ...ENV, [PORTRAIT_PROVIDER_TIMEOUT_ENV_VAR]: '5' },
        fetchImpl: impl,
      })
    ).rejects.toThrow('the request was aborted');
    expect(call).toBe(2);
  });

  // The route calls this with neither an environment nor a fetch, so the
  // defaults have to reach the real ones.
  it('falls back to the live environment and the global fetch', async () => {
    const fetchImpl = stubFetch([
      { ok: true, body: { access_token: TOKEN } },
      { ok: true, body: linkedinUserinfo() },
    ]);
    vi.stubEnv('LINKEDIN_CLIENT_ID', 'live-client-id');
    vi.stubEnv('LINKEDIN_CLIENT_SECRET', 'live-client-secret');
    vi.stubGlobal('fetch', fetchImpl.impl);

    const profile = await exchangePortraitCode({
      provider: 'linkedin',
      code: 'AQT1abcDEF',
      redirectUri: REDIRECT_URI,
    });
    expect(profile.accountId).toBe('urn:li:person:AbC123');
    expect(
      new URLSearchParams(fetchImpl.calls[0]?.body ?? '').get('client_id')
    ).toBe('live-client-id');
  });
});
