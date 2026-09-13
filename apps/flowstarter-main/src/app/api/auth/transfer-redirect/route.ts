import { auth, clerkClient } from '@clerk/nextjs/server';
import { decideAuthTransferDestination } from '@flowstarter/platform-config';
import { NextResponse } from 'next/server';

/**
 * Server-side redirect handler for cross-domain auth.
 *
 * Called by the middleware when an authenticated user needs to be redirected
 * to a cross-domain operator surface (the editor, the library). Mints a
 * short-lived Clerk sign-in token and 302s with `?__clerk_ticket=` so that
 * surface can establish a session.
 *
 * The ticket is a bearer credential, so the destination is decided by
 * `decideAuthTransferDestination` — an allow-list of operator-owned origins —
 * and never by `isSafeRedirectUrl`, which calls every generated client site at
 * `{slug}.{platformDomain}` trustworthy because it shares our root domain.
 *
 * Runs in the Node runtime (not Edge) so clerkClient works fully.
 */

/** A ticket is redeemed within a click. Anything longer is only exposure. */
const TICKET_LIFETIME_SECONDS = 60;

/** Where a refused or failed transfer lands instead. */
const FALLBACK_PATH = '/admin/dashboard';

/**
 * A response carrying a ticket must not be stored by a cache and must not
 * leak the ticket onward in a `Referer`.
 */
function sealed(res: NextResponse): NextResponse {
  res.headers.set('Cache-Control', 'no-store, max-age=0');
  res.headers.set('Referrer-Policy', 'no-referrer');
  return res;
}

export async function GET(req: Request) {
  const url = new URL(req.url);
  const redirectUrl = url.searchParams.get('redirect_url');

  const destination = decideAuthTransferDestination(redirectUrl);
  if (!destination.allowed) {
    console.warn(
      `[transfer-redirect] refused destination origin=${
        destination.origin ?? 'unparsable'
      } reason=${destination.reason}`
    );
    return sealed(NextResponse.redirect(new URL(FALLBACK_PATH, req.url)));
  }

  const { userId } = await auth();
  if (!userId) {
    const login = new URL('/admin/login', req.url);
    login.searchParams.set('redirect_url', destination.url);
    return sealed(NextResponse.redirect(login));
  }

  try {
    const clerk = await clerkClient();
    const token = await clerk.signInTokens.createSignInToken({
      userId,
      expiresInSeconds: TICKET_LIFETIME_SECONDS,
    });

    const target = new URL(destination.url);
    target.searchParams.set('__clerk_ticket', token.token);
    return sealed(NextResponse.redirect(target.toString()));
  } catch (err) {
    console.error('[transfer-redirect] Failed to create sign-in token:', err);
    // No ticket, no forward: a failed mint is not a reason to hand the visitor
    // to another origin. They land on the dashboard and sign in normally.
    return sealed(NextResponse.redirect(new URL(FALLBACK_PATH, req.url)));
  }
}
