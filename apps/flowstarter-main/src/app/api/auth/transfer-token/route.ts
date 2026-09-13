import { apiError } from '@/lib/api-errors';
import { auth, clerkClient } from '@clerk/nextjs/server';
import {
  authTransferAllowList,
  decideAuthTransferDestination,
} from '@flowstarter/platform-config';
import { NextResponse } from 'next/server';

/**
 * Mints a Clerk sign-in token that establishes a session on a cross-domain
 * operator surface (the editor, the library).
 *
 * Called by `AuthRedirectWrapper` and the login forms before they hand the
 * browser over. The token comes back as `?__clerk_ticket=` on the destination.
 *
 * Two rules guard it, and both are about the same thing — a sign-in ticket is
 * a bearer credential, so it may only ever travel between the operator's own
 * origins:
 *
 *   1. The destination is decided by `decideAuthTransferDestination`, an
 *      allow-list of operator-owned origins. Never by `isSafeRedirectUrl`,
 *      which trusts any host sharing our root domain — every generated client
 *      site included, since those are served at `{slug}.{platformDomain}`.
 *   2. The ticket is only handed to a browser that is already on one of those
 *      origins: the request's `Origin` header has to name one. A tenant page
 *      cannot fetch a ticket for itself, whatever it puts in the body.
 */

/** A ticket is redeemed within a click. Anything longer is only exposure. */
const TICKET_LIFETIME_SECONDS = 60;

/** The ticket travels in a JSON body; nothing may store it. */
const SEALED_HEADERS = {
  'Cache-Control': 'no-store, max-age=0',
  'Referrer-Policy': 'no-referrer',
} as const;

export async function POST(req: Request) {
  // Rule 2, before anything else: an unknown caller learns nothing, not even
  // whether the session exists.
  const requestOrigin = req.headers.get('origin');
  const callerAllowed =
    !!requestOrigin &&
    authTransferAllowList().some((entry) => entry.origin === requestOrigin);
  if (!callerAllowed) {
    console.warn(
      `[transfer-token] refused caller origin=${requestOrigin ?? 'absent'}`
    );
    return apiError('Untrusted request origin', 'FORBIDDEN');
  }

  const { userId } = await auth();
  if (!userId) {
    return apiError('Not authenticated', 'UNAUTHORIZED');
  }

  let body: { redirectUrl?: unknown };
  try {
    body = await req.json();
  } catch {
    return apiError('Invalid JSON', 'BAD_REQUEST');
  }

  // Rule 1: the allow-list decides where a credential may land.
  const destination = decideAuthTransferDestination(body?.redirectUrl);
  if (!destination.allowed) {
    console.warn(
      `[transfer-token] refused destination origin=${
        destination.origin ?? 'unparsable'
      } reason=${destination.reason} caller=${requestOrigin}`
    );
    return apiError('Untrusted redirect URL', 'FORBIDDEN');
  }

  try {
    const clerk = await clerkClient();
    const token = await clerk.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_LIFETIME_SECONDS,
    });

    const url = new URL(destination.url);
    url.searchParams.set('__clerk_ticket', token.token);

    return NextResponse.json(
      { url: url.toString() },
      { headers: SEALED_HEADERS }
    );
  } catch (err) {
    console.error('[transfer-token] Failed to create sign-in token:', err);
    return apiError('Failed to create token', 'INTERNAL_ERROR');
  }
}
