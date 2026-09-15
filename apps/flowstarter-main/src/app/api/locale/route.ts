import { NextResponse, type NextRequest } from 'next/server';
import { LOCALE_COOKIE_NAME, isSupportedLocale } from '@/lib/locale-resolution';

/**
 * GET /api/locale?locale=ro&next=/pricing
 *
 * The switcher's whole server side: write the explicit choice, then send the
 * visitor back where they were. A plain link rather than a fetch call on
 * purpose — it works before any JS has loaded, and a redirect is the natural
 * way to re-render the page the visitor is already on in the new language.
 *
 * The cookie this writes is `fs_locale`, the same one `middleware.ts` caches
 * its own Accept-Language inference into. Writing it here is what makes this
 * an explicit choice rather than an inference: the resolution rule
 * (`resolveLocale`) treats any value in this cookie as final, so once a
 * visitor has used the switcher, no header or later inference can override
 * it until they clear their cookies or switch again.
 *
 * Functional, not tracking — see `src/lib/legal/cookies.ts`'s inventory
 * entry — so it is written unconditionally, the same as `flowstarter_theme`
 * and `fs_country`, without waiting on the analytics consent banner.
 */
export async function GET(request: NextRequest): Promise<NextResponse> {
  const url = request.nextUrl;
  const requestedLocale = url.searchParams.get('locale');

  if (!isSupportedLocale(requestedLocale)) {
    return NextResponse.json({ error: 'Unsupported locale' }, { status: 400 });
  }

  // Only a same-origin relative path is a safe redirect target — anything
  // else (an absolute URL, a protocol-relative `//host/...`) could send a
  // visitor off this site from a link they trusted. Falls back to `/`.
  const rawNext = url.searchParams.get('next');
  const next =
    rawNext && rawNext.startsWith('/') && !rawNext.startsWith('//')
      ? rawNext
      : '/';

  const redirectUrl = new URL(next, url.origin);
  const response = NextResponse.redirect(redirectUrl, { status: 303 });
  response.cookies.set(LOCALE_COOKIE_NAME, requestedLocale, {
    path: '/',
    sameSite: 'lax',
    httpOnly: false,
    secure: true,
    maxAge: 60 * 60 * 24 * 365, // 1 year
  });
  return response;
}
