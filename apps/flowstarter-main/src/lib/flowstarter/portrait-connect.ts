import 'server-only';

/**
 * The two connect flows, as rules: what we send a provider, what we accept
 * back, and how the round trip is tied to the preview it started from.
 *
 * Everything here is pure apart from the two functions that name themselves as
 * exchanges. The URL building, the state signing and above all the parsing of
 * a provider's answer are ordinary functions of their arguments, so the whole
 * of the security-relevant half can be tested without a network and without a
 * provider account.
 *
 * THE STATE PARAMETER is the load-bearing part of this file.
 *
 * A connect flow leaves our site, spends time on a provider's, and comes back
 * to a callback URL that anybody can request. Without a state that we minted
 * and can verify, a callback is an open invitation: send a victim a link that
 * completes an attacker's authorisation and the attacker's photograph lands in
 * the victim's preview. So the state is an HMAC over a payload that names the
 * provider, the connection, and the preview or workspace it belongs to, with
 * an issue time so a stolen one expires. The callback verifies the signature
 * before it reads a single field, and the binding is what tells it which
 * preview the picture belongs to — it never takes that from a query parameter.
 *
 * The signature is compared with `timingSafeEqual`, over a fixed-length digest,
 * so a mismatch takes the same time to reject whatever the attacker guessed.
 *
 * WHAT EACH PROVIDER ACTUALLY RETURNS, which decides what we store:
 *
 *   LinkedIn, `openid profile email`
 *       `GET https://api.linkedin.com/v2/userinfo` answers with the OpenID
 *       Connect standard claims: `sub`, `name`, `picture`, `email`. A headline
 *       is NOT a standard claim and is absent from most responses; it is read
 *       when the provider includes it and is simply missing otherwise, which
 *       is why nothing downstream treats it as required.
 *
 *   Instagram, `instagram_business_basic`
 *       `GET https://graph.instagram.com/v23.0/me` answers with `user_id`,
 *       `username`, `name`, `account_type` and `profile_picture_url`. Business
 *       and creator accounts only. A personal account cannot be read by any
 *       endpoint since Basic Display was retired, and the honest thing is to
 *       say so rather than to retry.
 *
 * The redirect also arrives with a `#_` fragment on Instagram's side, which
 * some clients append to the code itself. `cleanAuthorizationCode` strips it,
 * because a code with a fragment on the end is a token exchange that fails
 * with a message nobody can act on.
 */
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import {
  type EnvLike,
  type PortraitProvider,
  portraitBudgets,
  portraitProviderCredentials,
} from './portrait-config';

// ---------------------------------------------------------------------------
// Provider endpoints
// ---------------------------------------------------------------------------

/**
 * Every endpoint, in one table. Named rather than inlined so the docs and the
 * tests can assert against the same strings the routes send to.
 */
export const PORTRAIT_PROVIDER_ENDPOINTS: Record<
  PortraitProvider,
  { authorize: string; token: string; profile: string; scope: string }
> = {
  linkedin: {
    authorize: 'https://www.linkedin.com/oauth/v2/authorization',
    token: 'https://www.linkedin.com/oauth/v2/accessToken',
    profile: 'https://api.linkedin.com/v2/userinfo',
    // "Sign In with LinkedIn using OpenID Connect". These three need no app
    // review, which is the whole reason this is the first source.
    scope: 'openid profile email',
  },
  instagram: {
    authorize: 'https://www.instagram.com/oauth/authorize',
    token: 'https://api.instagram.com/oauth/access_token',
    profile: 'https://graph.instagram.com/v23.0/me',
    // The Instagram API with Instagram Login. Business and creator only.
    scope: 'instagram_business_basic',
  },
};

/** The env var that pins the redirect base a provider has on file. */
export const PORTRAIT_REDIRECT_BASE_ENV_VAR =
  'FLOWSTARTER_PORTRAIT_REDIRECT_BASE';

/**
 * The callback URL we send, which must match the one registered with the
 * provider byte for byte.
 *
 * Prefers the pinned base, because staging and production are different apps
 * with different registered URLs and a request's own origin is whatever host
 * header reached us. Falls back to the request origin so a developer running
 * on localhost with a tunnel does not have to set anything.
 */
export function portraitRedirectUri(
  provider: PortraitProvider,
  requestOrigin: string,
  env: EnvLike = process.env
): string {
  const base = (env[PORTRAIT_REDIRECT_BASE_ENV_VAR] ?? '').trim();
  const origin = (base || requestOrigin).replace(/\/+$/, '');
  return `${origin}/api/connect/${provider}/callback`;
}

// ---------------------------------------------------------------------------
// Where the person came from
// ---------------------------------------------------------------------------

/**
 * The longest `returnTo` we will carry. A path back into the funnel, not a
 * document: the intake's own deepest path is well under a hundred characters,
 * and a cap is what stops a signed state from becoming a place to park data.
 */
export const MAX_RETURN_TO_CHARS = 512;

/** Where somebody goes when we have nothing better. The top of the funnel. */
export const DEFAULT_PORTRAIT_RETURN_TO = '/';

/**
 * True when a string is a path on our own origin and nothing else.
 *
 * This is the open-redirect check, and it is written as an allow list rather
 * than a block list because the ways to write "somewhere else" are open ended.
 * A single leading slash and nothing that a browser will re-read as an
 * authority:
 *
 *   `//evil.test`   protocol-relative, resolves to https://evil.test
 *   `/\evil.test`   the same thing with a backslash, which several browsers
 *                   normalise to a forward slash before they parse it
 *   `https://...`   an absolute URL, which does not start with `/` at all
 *
 * A control character is refused too, because a newline in a `Location` header
 * is a response-splitting attempt rather than a path anybody meant to visit.
 */
export function isSafeReturnTo(raw: string): boolean {
  if (!raw || raw.length > MAX_RETURN_TO_CHARS) return false;
  if (!raw.startsWith('/')) return false;
  if (raw.startsWith('//') || raw.startsWith('/\\')) return false;
  // Character codes rather than a regular expression: a control-character
  // class written as an escape range is one a formatter will happily rewrite
  // into the literal bytes, and a check nobody can read is a check nobody
  // will maintain. A newline in a `Location` header is response splitting.
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index);
    if (code < 0x20 || code === 0x7f) return false;
  }
  return true;
}

/**
 * The path to send somebody back to, or the top of the funnel.
 *
 * Total on purpose: a `returnTo` we do not like is not worth a 400 to a person
 * who is halfway through authorising a photograph, it is worth sending them
 * somewhere that works. Applied on the way in, when the start route reads the
 * query string, and again on the way out, when the callback reads the state,
 * so a state minted before this check existed still cannot redirect off site.
 */
export function safeReturnTo(raw: string | null | undefined): string {
  const value = (raw ?? '').trim();
  return isSafeReturnTo(value) ? value : DEFAULT_PORTRAIT_RETURN_TO;
}

// ---------------------------------------------------------------------------
// The state
// ---------------------------------------------------------------------------

/** What the state carries. Nothing secret: it is signed, not encrypted. */
export interface PortraitConnectState {
  /** Bumped if the shape ever changes, so an old state is rejected not misread. */
  v: 1;
  provider: PortraitProvider;
  /** The row in `portrait_connections` this round trip will write. */
  connectionId: string;
  /** The funnel preview the picture belongs to, before anybody is anybody. */
  previewId: string | null;
  /** The workspace, once there is one. Exactly one of the two is set. */
  workspaceId: string | null;
  /**
   * The path on our own origin the person was on when they pressed the button.
   *
   * It rides inside the signature rather than on the callback's query string
   * for the same reason the preview id does: the callback is a URL anybody can
   * request, and a redirect target it reads from its own query string is an
   * open redirect with our domain in front of it. Always a single leading
   * slash; see `isSafeReturnTo`.
   */
  returnTo: string;
  /** Milliseconds since the epoch, so a stolen state stops working. */
  issuedAt: number;
  /** Makes two states minted in the same millisecond different strings. */
  nonce: string;
}

function base64url(value: Buffer): string {
  return value
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromBase64url(value: string): Buffer {
  const padded = value.replace(/-/g, '+').replace(/_/g, '/');
  return Buffer.from(padded, 'base64');
}

function sign(payload: string, secret: string): string {
  return base64url(createHmac('sha256', secret).update(payload).digest());
}

export class PortraitConnectError extends Error {
  constructor(message: string, readonly code: string) {
    super(message);
    this.name = 'PortraitConnectError';
  }
}

/**
 * Mints a state for one round trip.
 *
 * Refuses to sign with an empty secret rather than producing a state that
 * anybody can forge. A connect flow that cannot be made safe does not run.
 */
export function encodePortraitState(
  state: Omit<PortraitConnectState, 'v' | 'issuedAt' | 'nonce' | 'returnTo'> & {
    issuedAt?: number;
    nonce?: string;
    /** Defaults to the top of the funnel when the caller has nowhere better. */
    returnTo?: string;
  },
  secret: string
): string {
  if (!secret) {
    throw new PortraitConnectError(
      'The connect state cannot be signed in this environment.',
      'NOT_CONFIGURED'
    );
  }
  const full: PortraitConnectState = {
    v: 1,
    provider: state.provider,
    connectionId: state.connectionId,
    previewId: state.previewId,
    workspaceId: state.workspaceId,
    // Normalised before it is signed, so an unsafe path never becomes a
    // signed one and the callback's own check has less to catch.
    returnTo: safeReturnTo(state.returnTo),
    issuedAt: state.issuedAt ?? Date.now(),
    nonce: state.nonce ?? randomUUID(),
  };
  const payload = base64url(Buffer.from(JSON.stringify(full), 'utf8'));
  return `${payload}.${sign(payload, secret)}`;
}

/**
 * Reads a state back, or null when it is not one of ours.
 *
 * Null rather than a thrown error for every failure — bad shape, bad
 * signature, expired, wrong provider — because the callback's answer to all of
 * them is the same redirect, and a caller that can tell them apart is a caller
 * that can be turned into an oracle.
 */
export function decodePortraitState(
  raw: string,
  options: {
    secret: string;
    provider: PortraitProvider;
    ttlMs: number;
    now?: number;
  }
): PortraitConnectState | null {
  if (!options.secret) return null;
  const parts = raw.split('.');
  if (parts.length !== 2) return null;
  const [payload, signature] = parts as [string, string];
  if (!payload || !signature) return null;

  const expected = Buffer.from(sign(payload, options.secret), 'utf8');
  const given = Buffer.from(signature, 'utf8');
  if (expected.length !== given.length) return null;
  if (!timingSafeEqual(expected, given)) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(fromBase64url(payload).toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const state = parsed as Partial<PortraitConnectState>;
  if (state.v !== 1) return null;
  if (state.provider !== options.provider) return null;
  if (typeof state.connectionId !== 'string' || !state.connectionId)
    return null;
  if (typeof state.issuedAt !== 'number') return null;

  const now = options.now ?? Date.now();
  // Also rejects a state from the future, which is a clock that cannot be
  // trusted to expire anything.
  if (state.issuedAt > now + 60_000) return null;
  if (now - state.issuedAt > options.ttlMs) return null;

  return {
    v: 1,
    provider: state.provider,
    connectionId: state.connectionId,
    previewId: typeof state.previewId === 'string' ? state.previewId : null,
    workspaceId:
      typeof state.workspaceId === 'string' ? state.workspaceId : null,
    // Re-checked rather than trusted. The signature proves we minted this
    // state, not that the path inside it is still one we are willing to send
    // a browser to, and a state minted before `isSafeReturnTo` existed would
    // otherwise be an open redirect with a valid signature on it. An unsafe
    // path degrades to the top of the funnel; it does not void the state,
    // because the binding to the preview is the part that matters.
    returnTo: safeReturnTo(
      typeof state.returnTo === 'string' ? state.returnTo : null
    ),
    issuedAt: state.issuedAt,
    nonce: typeof state.nonce === 'string' ? state.nonce : '',
  };
}

// ---------------------------------------------------------------------------
// The authorisation URL
// ---------------------------------------------------------------------------

/**
 * Where we send the person, with the state already on it.
 *
 * `URLSearchParams` rather than string concatenation throughout: a redirect
 * URI is a URL inside a URL, and hand-rolled escaping of one is how an open
 * redirect gets built by accident.
 */
export function portraitAuthorizeUrl(input: {
  provider: PortraitProvider;
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const endpoints = PORTRAIT_PROVIDER_ENDPOINTS[input.provider];
  const url = new URL(endpoints.authorize);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', input.clientId);
  url.searchParams.set('redirect_uri', input.redirectUri);
  url.searchParams.set('scope', endpoints.scope);
  url.searchParams.set('state', input.state);
  return url.toString();
}

/**
 * Instagram's redirect carries a `#_` fragment, and some clients hand it to us
 * glued to the code. A code with a fragment on the end fails the exchange with
 * a message nobody can act on, so it is removed here rather than debugged in
 * production.
 */
export function cleanAuthorizationCode(raw: string): string {
  return raw.split('#')[0]?.trim() ?? '';
}

// ---------------------------------------------------------------------------
// What a provider tells us about a person
// ---------------------------------------------------------------------------

export interface PortraitProfile {
  provider: PortraitProvider;
  /** The provider's own id for the account, so a reconnect updates one row. */
  accountId: string;
  /** Their name as the provider holds it. '' when the provider had none. */
  name: string;
  /**
   * A line of their own prose about themselves. Absent from LinkedIn's
   * standard OpenID Connect claims and from Instagram entirely, so '' is the
   * normal case rather than a failure.
   */
  headline: string;
  /** The picture URL, or '' when the account has no picture. */
  pictureUrl: string;
  /**
   * Instagram only. `personal` is the terminal case the rule needs to name;
   * LinkedIn has no equivalent and reports `unknown`.
   */
  accountType: 'business' | 'creator' | 'personal' | 'unknown';
}

function text(value: unknown, max: number): string {
  return typeof value === 'string' ? value.trim().slice(0, max) : '';
}

/** How long a stored name or headline may be. A bio, not an essay. */
export const MAX_PROFILE_NAME_CHARS = 120;
export const MAX_PROFILE_HEADLINE_CHARS = 300;
export const MAX_PROFILE_URL_CHARS = 1000;

/**
 * LinkedIn's userinfo response, read into our shape.
 *
 * Returns null when there is no `sub`: without the provider's own id we cannot
 * tell a reconnect from a second person, and a connection row we cannot key is
 * worse than no row.
 */
export function readLinkedinProfile(payload: unknown): PortraitProfile | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const accountId = text(raw.sub, MAX_PROFILE_NAME_CHARS);
  if (!accountId) return null;
  const given = text(raw.given_name, MAX_PROFILE_NAME_CHARS);
  const family = text(raw.family_name, MAX_PROFILE_NAME_CHARS);
  return {
    provider: 'linkedin',
    accountId,
    name:
      text(raw.name, MAX_PROFILE_NAME_CHARS) ||
      [given, family].filter(Boolean).join(' '),
    headline: text(raw.headline, MAX_PROFILE_HEADLINE_CHARS),
    pictureUrl: text(raw.picture, MAX_PROFILE_URL_CHARS),
    accountType: 'unknown',
  };
}

/** Instagram's `me` response, read into our shape. */
export function readInstagramProfile(payload: unknown): PortraitProfile | null {
  if (!payload || typeof payload !== 'object') return null;
  const raw = payload as Record<string, unknown>;
  const accountId =
    text(raw.user_id, MAX_PROFILE_NAME_CHARS) ||
    text(raw.id, MAX_PROFILE_NAME_CHARS);
  if (!accountId) return null;
  const declared = text(raw.account_type, 32).toLowerCase();
  const accountType: PortraitProfile['accountType'] =
    declared === 'business' || declared === 'creator' || declared === 'personal'
      ? declared
      : 'unknown';
  return {
    provider: 'instagram',
    accountId,
    name:
      text(raw.name, MAX_PROFILE_NAME_CHARS) ||
      text(raw.username, MAX_PROFILE_NAME_CHARS),
    headline: '',
    pictureUrl: text(raw.profile_picture_url, MAX_PROFILE_URL_CHARS),
    accountType,
  };
}

// ---------------------------------------------------------------------------
// The exchanges
// ---------------------------------------------------------------------------

/** The one thing in this file that touches the network. Injectable for tests. */
export type ConnectFetch = typeof fetch;

async function postForm(
  url: string,
  body: Record<string, string>,
  options: { fetchImpl: ConnectFetch; timeoutMs: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(body).toString(),
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PortraitConnectError(
        'The provider refused the exchange.',
        'EXCHANGE_FAILED'
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function getJson(
  url: string,
  init: { headers?: Record<string, string> },
  options: { fetchImpl: ConnectFetch; timeoutMs: number }
): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const response = await options.fetchImpl(url, {
      headers: init.headers ?? {},
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new PortraitConnectError(
        'The provider would not tell us who that is.',
        'PROFILE_FAILED'
      );
    }
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Code in, profile out.
 *
 * The access token is used and dropped. It is never written to a row, never
 * logged, and never returned to the caller: the product needs one picture and
 * two lines of text, so holding a credential that could fetch more of somebody's
 * account would be storing a liability we have no use for.
 */
export async function exchangePortraitCode(input: {
  provider: PortraitProvider;
  code: string;
  redirectUri: string;
  env?: EnvLike;
  fetchImpl?: ConnectFetch;
}): Promise<PortraitProfile> {
  const env = input.env ?? process.env;
  const credentials = portraitProviderCredentials(input.provider, env);
  if (!credentials.configured) {
    throw new PortraitConnectError(
      'That connection is not available in this environment.',
      'NOT_CONFIGURED'
    );
  }
  const code = cleanAuthorizationCode(input.code);
  if (!code) {
    throw new PortraitConnectError(
      'The provider sent us back without an authorisation code.',
      'NO_CODE'
    );
  }

  const endpoints = PORTRAIT_PROVIDER_ENDPOINTS[input.provider];
  const options = {
    fetchImpl: input.fetchImpl ?? fetch,
    timeoutMs: portraitBudgets(env).providerTimeoutMs,
  };

  const token = (await postForm(
    endpoints.token,
    {
      grant_type: 'authorization_code',
      code,
      redirect_uri: input.redirectUri,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    },
    options
  )) as { access_token?: unknown };

  const accessToken = text(token?.access_token, 4096);
  if (!accessToken) {
    throw new PortraitConnectError(
      'The provider did not give us a token.',
      'EXCHANGE_FAILED'
    );
  }

  if (input.provider === 'linkedin') {
    const payload = await getJson(
      endpoints.profile,
      { headers: { authorization: `Bearer ${accessToken}` } },
      options
    );
    const profile = readLinkedinProfile(payload);
    if (!profile) {
      throw new PortraitConnectError(
        'The provider would not tell us who that is.',
        'PROFILE_FAILED'
      );
    }
    return profile;
  }

  // Instagram wants the token on the query string rather than in a header, and
  // wants the field list named explicitly or it returns almost nothing.
  const url = new URL(endpoints.profile);
  url.searchParams.set(
    'fields',
    'user_id,username,name,account_type,profile_picture_url'
  );
  url.searchParams.set('access_token', accessToken);
  const payload = await getJson(url.toString(), {}, options);
  const profile = readInstagramProfile(payload);
  if (!profile) {
    throw new PortraitConnectError(
      'The provider would not tell us who that is.',
      'PROFILE_FAILED'
    );
  }
  return profile;
}
