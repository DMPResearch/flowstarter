import 'server-only';

/**
 * Both halves of both connect flows, written once.
 *
 * There are four route files under `api/connect` and exactly two behaviours.
 * LinkedIn and Instagram differ in their endpoints, their scope and the names
 * they give a cancellation, and every one of those differences is a table
 * entry in `portrait-connect.ts` or in `PROVIDER_ERROR_PARAMS` below. Nothing
 * about the refusals, the binding or the redirect is allowed to differ, so
 * none of it is written twice: a security check that exists in one provider's
 * callback and not the other's is a check that does not exist.
 *
 * This file is not a `route.ts`, so Next does not route it. `asset-storage.ts`
 * sits beside `client/assets/[workspaceId]/route.ts` the same way and for the
 * same reason.
 *
 * THE BINDING, which is the point of the whole state parameter.
 *
 * `/start` is where we learn which preview or workspace the picture belongs
 * to, and it is the only place we ever learn it. That answer goes inside an
 * HMAC and comes back to `/callback` inside the same HMAC. The callback is a
 * URL anybody on the internet can request with any query string they like, so
 * a callback that read `previewId` from its own query string would let anyone
 * who can complete a provider authorisation drop their photograph into anyone
 * else's preview. The callback verifies the state before it reads a single
 * other field, and takes the preview id, the workspace id, the connection id
 * and the return path from the verified payload only.
 *
 * NEITHER ROUTE EVER 500s. `/start` answers an unconfigured deployment with a
 * 200 and a machine-readable reason so the button can render disabled, the
 * same convention `generation-availability.ts` and the live preview route's
 * `{ skip: true, reason: 'not-configured' }` already use. `/callback` ends
 * every path, including every failure, in a 302 to a path on our own origin:
 * the person is standing in front of a browser halfway through a flow they
 * started, and a stack trace is not an answer to them.
 *
 * WHAT MAY BE LOGGED. The provider name and the outcome. Never a code, never a
 * token, never a state, never a picture URL: a signed CDN URL in a log line is
 * a credential in a log line.
 *
 * COPY. The intake reads the `?portrait=` value and prints the matching
 * sentence. `ConnectPortrait.tsx` is the reader: `connected` and `cancelled`
 * have their own lines under `landing.discovery.connect.`, every other member
 * of `PortraitOutcome` is looked up as `portrait.reason.<value>`, which is the
 * same key `portrait-source.ts` produces for the same fact, and anything with
 * no entry falls back to `landing.discovery.connect.failed`. The outcome
 * strings are therefore a vocabulary shared with the rule rather than a second
 * list, which is why `PortraitOutcome` derives its skip arm from the store's
 * return type instead of restating it.
 */
import { randomUUID } from 'node:crypto';
import { NextRequest, NextResponse } from 'next/server';

import {
  type PortraitProvider,
  portraitBudgets,
  portraitProviderCredentials,
  portraitStateSecret,
} from '@/lib/flowstarter/portrait-config';
import {
  DEFAULT_PORTRAIT_RETURN_TO,
  PortraitConnectError,
  decodePortraitState,
  encodePortraitState,
  exchangePortraitCode,
  portraitAuthorizeUrl,
  portraitRedirectUri,
  safeReturnTo,
} from '@/lib/flowstarter/portrait-connect';
import { portraitProviderAvailabilityFor } from '@/lib/flowstarter/portrait-availability';
import { capturePortraitFromProvider } from '@/lib/flowstarter/portrait-store';

/**
 * The same uuid shape `brand-signals/picture/route.ts` accepts, so a preview
 * id that is good enough to upload a logo against is good enough to bind a
 * portrait to. Anything else never reaches a query.
 */
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

/**
 * Per address, per minute, on `/start` only.
 *
 * Eight, rather than the picture route's six, because a person really can go
 * round this loop a few times in a minute without doing anything wrong: press
 * LinkedIn, change their mind at the provider, come back, press Instagram
 * instead. What it stops is the other use of the endpoint, which is asking us
 * to mint signed states in bulk. The callback is deliberately NOT rate limited
 * by address: a provider redirect arrives from the person's own browser, and a
 * limiter there would drop the completion of a flow somebody actually finished
 * while doing nothing about a forged state, which the signature already
 * handles for free.
 */
const START_RATE_LIMIT = 8;
const START_RATE_WINDOW_MS = 60_000;
const startRateLimitMap = new Map<string, { count: number; resetAt: number }>();

function isRateLimited(ip: string): boolean {
  const now = Date.now();
  const entry = startRateLimitMap.get(ip);
  if (!entry || now > entry.resetAt) {
    startRateLimitMap.set(ip, {
      count: 1,
      resetAt: now + START_RATE_WINDOW_MS,
    });
    return false;
  }
  entry.count += 1;
  return entry.count > START_RATE_LIMIT;
}

/** Same reader the other anonymous funnel routes use. */
function clientIp(request: NextRequest): string {
  const forwarded = request.headers.get('x-forwarded-for');
  return (
    forwarded?.split(',')[0]?.trim() ||
    request.headers.get('x-real-ip') ||
    'unknown'
  );
}

/**
 * The error parameters each provider sends back when it will not give us a
 * code, and which of their values mean "the person said no".
 *
 * Read from a table rather than branched on inline so that adding a provider
 * is a row here and not another `if (provider === ...)` inside the callback.
 */
const PROVIDER_ERROR_PARAMS: Record<
  PortraitProvider,
  { params: readonly string[]; declined: readonly string[] }
> = {
  linkedin: {
    params: ['error', 'error_description'],
    // LinkedIn's own spelling, both of which mean the person stopped.
    declined: ['user_cancelled_authorize', 'user_cancelled_login'],
  },
  instagram: {
    params: ['error', 'error_reason', 'error_description'],
    // The OAuth 2 standard spelling, plus the reason Instagram sends with it.
    declined: ['access_denied', 'user_denied'],
  },
};

/**
 * What the intake is told happened, as one query parameter.
 *
 * `connected` and `cancelled` and `failed` are this file's. Everything else is
 * a skip reason from `capturePortraitFromProvider`, carried through verbatim
 * so the sentence the client reads comes from the rule that made the decision
 * rather than from a translation of it made here.
 */
type CaptureResult = Awaited<ReturnType<typeof capturePortraitFromProvider>>;
type CaptureSkipReason = Extract<
  CaptureResult,
  { status: 'skipped' }
>['reason'];
export type PortraitOutcome =
  | 'connected'
  | 'cancelled'
  | 'failed'
  | CaptureSkipReason;

/**
 * Every exit from the callback. A path on our own origin, an outcome, and the
 * provider it was about.
 *
 * `returnTo` is passed through `safeReturnTo` once more here even though the
 * state decoder already did it, because this function is the last thing
 * between a string and a `Location` header and that is the wrong place to be
 * relying on a check made somewhere else.
 */
function outcomeRedirect(
  origin: string,
  returnTo: string,
  provider: PortraitProvider,
  outcome: PortraitOutcome
): NextResponse {
  const url = new URL(safeReturnTo(returnTo), origin);
  url.searchParams.set('portrait', outcome);
  url.searchParams.set('portraitProvider', provider);
  return NextResponse.redirect(url, 302);
}

/** One body for every refusal, so the response never says which check failed. */
function refused(): NextResponse {
  return NextResponse.json(
    {
      error: 'That is not a connection we can start.',
      code: 'BAD_REQUEST',
    },
    { status: 400 }
  );
}

/**
 * GET /api/connect/<provider>/start
 *
 * Binds this round trip to one preview or one workspace, mints the signed
 * state that carries the binding, and sends the person to the provider.
 */
export async function startConnect(
  request: NextRequest,
  provider: PortraitProvider
): Promise<NextResponse> {
  if (isRateLimited(clientIp(request))) {
    return NextResponse.json(
      { error: 'Too many attempts. Give it a minute.', code: 'RATE_LIMITED' },
      { status: 429 }
    );
  }

  const params = request.nextUrl.searchParams;
  const previewId = (params.get('previewId') ?? '').trim();
  const workspaceId = (params.get('workspaceId') ?? '').trim();

  // Exactly one. A request naming both is asking us to bind one photograph to
  // two places and we would have to pick; a request naming neither has nowhere
  // to put the answer, so the round trip would end in a row with no owner.
  if (Boolean(previewId) === Boolean(workspaceId)) return refused();
  if (previewId && !UUID.test(previewId)) return refused();
  if (workspaceId && !UUID.test(workspaceId)) return refused();

  // A path, never a URL. Anything else is somebody trying to borrow our domain
  // for their redirect, and it degrades to the top of the funnel rather than
  // to a 400: the person pressed a button, they should end up somewhere.
  const returnTo = safeReturnTo(params.get('returnTo'));

  const availability = portraitProviderAvailabilityFor(provider);
  if (!availability.available) {
    // Not a 500 and not a redirect to a provider that would refuse us. A 200
    // with a machine-readable reason is what lets the intake render a disabled
    // button with an explanation instead of a broken flow. Names only: see
    // `portrait-availability.ts`.
    console.info(`[connect] ${provider} start refused: not configured`);
    return NextResponse.json(
      {
        available: false,
        reason: 'not_configured',
        missing: availability.missing,
      },
      { status: 200 }
    );
  }

  const credentials = portraitProviderCredentials(provider);
  const connectionId = randomUUID();
  // `portraitStateSecret` falls back to the provider's own client secret, and
  // `availability.available` is exactly "both halves of the credential are
  // present", so the secret here cannot be empty and `encodePortraitState`
  // cannot refuse to sign.
  const state = encodePortraitState(
    {
      provider,
      connectionId,
      previewId: previewId || null,
      workspaceId: workspaceId || null,
      returnTo,
    },
    portraitStateSecret(provider)
  );

  const target = portraitAuthorizeUrl({
    provider,
    clientId: credentials.clientId,
    redirectUri: portraitRedirectUri(provider, request.nextUrl.origin),
    state,
  });

  console.info(`[connect] ${provider} start: sending the person to authorise`);
  return NextResponse.redirect(target, 302);
}

/**
 * GET /api/connect/<provider>/callback
 *
 * Where the provider sends the person back. Verifies the state, then acts on
 * it, and ends in a redirect whatever happens.
 */
export async function finishConnect(
  request: NextRequest,
  provider: PortraitProvider
): Promise<NextResponse> {
  const params = request.nextUrl.searchParams;
  const origin = request.nextUrl.origin;

  // THE STATE IS VERIFIED FIRST, before any other parameter is read and before
  // a single row is touched. This callback is a URL anybody can request. A
  // handler that acted on an unverified state (exchanged its code, wrote its
  // connection row, believed its `previewId`) is how one person's photograph
  // ends up in another person's preview, and no check made later can undo a
  // write made here.
  const raw = (params.get('state') ?? '').trim();
  const state = raw
    ? decodePortraitState(raw, {
        secret: portraitStateSecret(provider),
        provider,
        ttlMs: portraitBudgets().stateTtlMs,
      })
    : null;
  if (!state) {
    // Missing, malformed, signed with the wrong secret, expired, or minted for
    // the other provider: one answer for all of them. A caller who can tell
    // those apart is a caller who can use this route as an oracle.
    console.warn(`[connect] ${provider} callback: unverified state, refused`);
    return outcomeRedirect(
      origin,
      DEFAULT_PORTRAIT_RETURN_TO,
      provider,
      'failed'
    );
  }

  // From here on, everything that matters comes out of the verified payload.
  const returnTo = state.returnTo;

  const errors = PROVIDER_ERROR_PARAMS[provider];
  const reported = errors.params
    .map((name) => (params.get(name) ?? '').trim().toLowerCase())
    .filter(Boolean);
  if (reported.length > 0) {
    // Somebody deciding not to is an answer, not an error. They looked at what
    // we were asking for and said no, which is the consent mechanism working,
    // so it gets its own outcome and its own sentence rather than being
    // reported back to them as a failure they should retry.
    if (reported.some((value) => errors.declined.includes(value))) {
      console.info(`[connect] ${provider} callback: the person declined`);
      return outcomeRedirect(origin, returnTo, provider, 'cancelled');
    }
    console.warn(`[connect] ${provider} callback: the provider refused`);
    return outcomeRedirect(origin, returnTo, provider, 'failed');
  }

  const code = params.get('code') ?? '';
  if (!code.trim()) {
    console.warn(`[connect] ${provider} callback: no code and no error`);
    return outcomeRedirect(origin, returnTo, provider, 'failed');
  }

  try {
    const profile = await exchangePortraitCode({
      provider,
      code,
      // Must match the one `/start` sent byte for byte, which is why both
      // sides build it with the same function rather than writing it out.
      redirectUri: portraitRedirectUri(provider, origin),
    });

    const result = await capturePortraitFromProvider({
      connectionId: state.connectionId,
      profile,
      // From the state. Never from `params`. See the header.
      previewId: state.previewId,
      workspaceId: state.workspaceId,
    });

    if (result.status === 'captured') {
      console.info(`[connect] ${provider} callback: captured`);
      return outcomeRedirect(origin, returnTo, provider, 'connected');
    }
    console.info(`[connect] ${provider} callback: skipped, ${result.reason}`);
    return outcomeRedirect(origin, returnTo, provider, result.reason);
  } catch (error) {
    // Every throw, not only `PortraitConnectError`. A timeout, a provider
    // outage and a bug all leave the person in the same place: back where they
    // were, told we could not get the picture. The code is logged; the
    // message is not, because a provider's message can quote the URL it was
    // given and that URL carries a token.
    console.warn(
      `[connect] ${provider} callback failed: ` +
        (error instanceof PortraitConnectError ? error.code : 'UNKNOWN')
    );
    return outcomeRedirect(origin, returnTo, provider, 'failed');
  }
}
