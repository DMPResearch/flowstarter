/**
 * The one rule that decides which language a visitor gets, shared by
 * `middleware.ts` (which resolves it once per request and caches the answer
 * in a cookie), the `/api/locale` switcher route (which writes an explicit
 * choice), and this file's own tests.
 *
 * The rule, in order:
 *   1. An explicit choice — the `fs_locale` cookie — always wins. It is set
 *      either by a visitor picking a language in the switcher, or by
 *      `middleware.ts` caching an inferred value so it is not recomputed on
 *      every request (the same pattern `fs_country` already uses).
 *   2. Otherwise, the `Accept-Language` header's best match among the
 *      locales this app actually ships copy for.
 *   3. Otherwise, English.
 *
 * Never a guess from page or brief content — this module never sees either
 * one, only a cookie value and a header string, on purpose.
 */

/** The only two locales this app has translated copy for. */
export const SUPPORTED_LOCALES = ['en', 'ro'] as const;
export type SupportedLocale = (typeof SUPPORTED_LOCALES)[number];

export const DEFAULT_LOCALE: SupportedLocale = 'en';

/**
 * The cookie an explicit choice lives in. Functional, not tracking: it holds
 * nothing but which of two languages to render, set either by the visitor
 * choosing in the switcher or by `middleware.ts` caching its own inference.
 * See `src/lib/legal/cookies.ts` for the inventory entry and
 * `src/app/api/locale/route.ts` for the switcher that writes it explicitly.
 */
export const LOCALE_COOKIE_NAME = 'fs_locale';

/** The request header `middleware.ts` forwards the resolved locale on, so any
 * already-dynamic server code downstream (route handlers, nested layouts)
 * can read it without recomputing the rule. See the `x-nonce` pattern in
 * `middleware.ts` for the same forwarding technique. */
export const LOCALE_HEADER_NAME = 'x-flowstarter-locale';

export function isSupportedLocale(
  value: string | null | undefined
): value is SupportedLocale {
  if (!value) return false;
  return (SUPPORTED_LOCALES as readonly string[]).includes(value);
}

/**
 * The highest-quality locale in an `Accept-Language` header that this app
 * supports, or `null` when nothing in the header matches. Parses the
 * standard `tag;q=value` list (RFC 4647-ish, not a full BCP 47 parser — this
 * app ships exactly two locales, so matching on the primary subtag is
 * enough), sorted by quality, highest first.
 */
export function bestSupportedLocaleFromAcceptLanguage(
  header: string | null | undefined
): SupportedLocale | null {
  if (!header) return null;

  const entries = header
    .split(',')
    .map((part) => {
      const [rawTag, ...params] = part.trim().split(';');
      const tag = (rawTag ?? '').trim().toLowerCase();
      const qParam = params
        .map((p) => p.trim())
        .find((p) => p.startsWith('q='));
      const parsedQ = qParam ? parseFloat(qParam.slice(2)) : 1;
      const q = Number.isFinite(parsedQ) ? parsedQ : 1;
      return { tag, q };
    })
    .filter((entry) => entry.tag.length > 0)
    .sort((a, b) => b.q - a.q);

  for (const { tag } of entries) {
    const primary = tag.split('-')[0];
    if (isSupportedLocale(primary)) return primary;
  }
  return null;
}

/**
 * The resolution rule itself. See the file doc comment for the precedence:
 * cookie, then header, then the default.
 */
export function resolveLocale(input: {
  cookie?: string | null;
  acceptLanguage?: string | null;
}): SupportedLocale {
  if (isSupportedLocale(input.cookie)) return input.cookie;
  return (
    bestSupportedLocaleFromAcceptLanguage(input.acceptLanguage) ??
    DEFAULT_LOCALE
  );
}
