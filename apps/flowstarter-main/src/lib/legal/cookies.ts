/**
 * The cookies this product actually sets, as one table the cookie page reads.
 *
 * The old table was hand-written and claimed to be "the complete inventory of
 * cookies". It was wrong in three ways at once:
 *
 *   `fs_country` was missing. `src/middleware.ts` sets it on the first
 *   request from a visitor whose country it can infer, which makes it the one
 *   cookie on the list that is set by our own code rather than a vendor's.
 *
 *   `NEXT_LOCALE` was listed and is never set. Nothing in the app writes it;
 *   it is a Next.js convention this app does not use.
 *
 *   `flowstarter_cookie_consent` was listed as a cookie, and the page told
 *   readers to clear it from their browser's cookie settings to see the
 *   banner again. `src/components/CookieConsent.tsx` writes it to
 *   localStorage. Following the page's own instructions would have done
 *   nothing.
 *
 * All three are the same failure: prose describing code it was never checked
 * against. The table lives here now, `src/lib/legal/__tests__/cookies.test.ts`
 * pins the names against what the source actually writes, and the page can
 * only render what is in it.
 */

export type CookieCategory = 'Strictly necessary' | 'Functional' | 'Analytics';

export interface CookieRow {
  name: string;
  purpose: string;
  category: CookieCategory;
  duration: string;
  /** Where in the source the cookie is written. Not rendered; a grep target. */
  setBy: string;
}

export const COOKIE_INVENTORY: readonly CookieRow[] = [
  {
    name: '__session',
    purpose: 'Keeps you signed in. Set by Clerk after a successful sign-in.',
    category: 'Strictly necessary',
    duration: 'Session, up to 7 days',
    setBy: 'Clerk, via src/middleware.ts',
  },
  {
    name: '__client_uat',
    purpose:
      'Tells the page whether this browser has signed in before, so it knows whether to check for a session at all.',
    category: 'Strictly necessary',
    duration: '1 year',
    setBy: 'Clerk, via src/middleware.ts',
  },
  {
    name: 'fs_country',
    purpose:
      'Remembers which country we inferred you are in, from your browser language or your network, so we do not work it out again on every page.',
    category: 'Functional',
    duration: '30 days',
    setBy: 'src/middleware.ts',
  },
  {
    name: 'flowstarter_theme',
    purpose:
      'Remembers your light or dark theme preference, and carries it across our subdomains so the page does not flash white before it loads.',
    category: 'Functional',
    duration: '1 year',
    setBy: 'src/app/layout.tsx',
  },
];

/**
 * How a reader actually changes the banner choice.
 *
 * Split out from the prose because the old sentence sent people to their
 * cookie settings for a value that was never a cookie.
 */
export const CONSENT_STORAGE_NOTE =
  'Your choice on the cookie banner is stored in your browser’s local ' +
  'storage under flowstarter_cookie_consent, not in a cookie. Clearing site ' +
  'data for this domain in your browser settings resets it and the banner ' +
  'appears again on your next visit.';

type EnvLike = Record<string, string | undefined>;

export type AnalyticsDisclosure =
  | { running: false; statement: string }
  | { running: true; statement: string; measurementId: string };

/**
 * What the cookie page says under "Analytics".
 *
 * The old page said "we currently use Plausible, a privacy-friendly analytics
 * tool" and, two lines later, "We do not run Google Analytics". Plausible has
 * never been installed. Google Analytics was half-installed: `src/env.ts`
 * declared `NEXT_PUBLIC_GA_MEASUREMENT_ID` and `src/lib/google-analytics.ts`
 * held the event helpers, while nothing anywhere loaded the gtag script, so
 * the page's flat denial was true only by accident and would have quietly
 * become false the day somebody wired the loader up.
 *
 * Both dead paths are gone from the app. This function is the rule that keeps
 * the page honest if one ever comes back: it reads the measurement id and
 * says which of the two sentences is true today, rather than the page
 * asserting either one. `src/lib/legal/__tests__/analytics-not-loaded.test.ts`
 * is the other half, and fails if a loader reappears without the disclosure.
 */
export function analyticsDisclosure(
  env: EnvLike = process.env as EnvLike
): AnalyticsDisclosure {
  const measurementId = (env['NEXT_PUBLIC_GA_MEASUREMENT_ID'] ?? '').trim();
  if (!measurementId) {
    return {
      running: false,
      statement:
        'We run no analytics at all. No Google Analytics, no Facebook Pixel, ' +
        'no cross-site advertising tracker, and no privacy-friendly ' +
        'alternative either. Nothing on this site counts your visit.',
    };
  }
  return {
    running: true,
    measurementId,
    statement:
      'We run Google Analytics on the marketing site. It sets its own ' +
      'cookies under the _ga prefix and is loaded only after you accept ' +
      'analytics on the cookie banner. We run no advertising tracker of any ' +
      'kind.',
  };
}
