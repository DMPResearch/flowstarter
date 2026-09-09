/**
 * The one place a user-supplied value turns into a navigation target.
 *
 * Sign-in surfaces read `redirect_url` and `next` from the query string, so
 * both are attacker-controlled: a link like
 * `/login?redirect_url=https://evil.example` would otherwise hand the visitor
 * to another site the moment the session becomes active (CWE-601).
 *
 * Two shapes are allowed, and nothing else:
 *
 *   - `toSameOriginPath` returns a path that is provably on this origin
 *     (`/dashboard`, `/admin/dashboard?tab=x`). Only this result may reach
 *     `window.location`.
 *   - `toTrustedHandoffUrl` returns an absolute URL on a platform origin
 *     (`isSafeRedirectUrl` from the platform config decides). It exists for the
 *     cross-domain session hand-off and is only ever handed to the
 *     transfer-token endpoint, never to `window.location` directly: the browser
 *     follows the URL that endpoint mints, not the one the query string asked
 *     for.
 *
 * Anything else resolves to `null` and the caller falls back to the default
 * after-sign-in path.
 */

import { isSafeRedirectUrl } from '@flowstarter/platform-config';

/** Where a client lands after signing in when no valid target was asked for. */
export const CLIENT_REDIRECT_PATH = '/dashboard';

/** Where a team member lands after signing in when no valid target was asked for. */
export const TEAM_REDIRECT_PATH = '/admin/dashboard';

/** `https:`, `javascript:`, `data:`: any scheme prefix at all. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * An encoded slash or backslash. `/%2f%2fevil.example` survives a naive
 * `startsWith('//')` test and turns into `//evil.example` once a server or a
 * router decodes it.
 */
const ENCODED_SEPARATOR = /%2f|%5c/i;

/** `/@evil.example`, `/user:pass@evil.example`: an authority wearing a path. */
const AUTHORITY_IN_FIRST_SEGMENT = /^\/[^/]*@/;

/** The origin of the current document, or null outside the browser. */
export function currentOrigin(): string | null {
  if (typeof window === 'undefined') return null;
  const origin = window.location.origin;
  return typeof origin === 'string' && origin !== '' ? origin : null;
}

/**
 * Narrows a user-supplied redirect to a path on this exact origin.
 *
 * Returns `null` for a protocol-relative URL (`//evil.example`), an absolute
 * URL on another origin (`https://evil.example`), a backslash authority
 * (`/\evil.example`), an encoded separator (`%2f%2fevil`), a non-http scheme
 * (`javascript:alert(1)`) and anything that does not start at the root.
 */
export function toSameOriginPath(
  candidate: string | null | undefined,
  origin: string | null = currentOrigin(),
): string | null {
  if (typeof candidate !== 'string' || origin === null) return null;

  const value = candidate.trim();
  if (value === '') return null;
  if (value.includes('\\')) return null;
  if (ENCODED_SEPARATOR.test(value)) return null;
  if (AUTHORITY_IN_FIRST_SEGMENT.test(value)) return null;

  // Either a root-relative path, or an absolute URL that we are about to
  // require to name this origin. Nothing else is even parsed.
  const rooted = value.startsWith('/') && !value.startsWith('//');
  if (!rooted && !HAS_SCHEME.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value, origin);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (parsed.origin !== origin) return null;

  const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
  if (!path.startsWith('/') || path.startsWith('//')) return null;
  return path;
}

/**
 * Narrows a user-supplied redirect to an absolute URL on a platform origin,
 * for the cross-domain session hand-off. Same-origin values return `null`:
 * they need no hand-off and belong in `toSameOriginPath`.
 */
export function toTrustedHandoffUrl(
  candidate: string | null | undefined,
  origin: string | null = currentOrigin(),
): string | null {
  if (typeof candidate !== 'string') return null;

  const value = candidate.trim();
  if (value === '' || !HAS_SCHEME.test(value)) return null;

  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username !== '' || parsed.password !== '') return null;
  if (origin !== null && parsed.origin === origin) return null;

  const hostname = origin === null ? undefined : safeHostname(origin);
  if (!isSafeRedirectUrl(parsed.href, hostname)) return null;

  return parsed.href;
}

function safeHostname(origin: string): string | undefined {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
}
