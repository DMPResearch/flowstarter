/**
 * What counts as a Cal.com booking link, decided in one place.
 *
 * A client pastes whatever their browser bar shows them. That string ends up
 * in two places that matter: an iframe on their own dashboard, and a script
 * tag on a site we host for them under their own domain. Both are reasons to
 * be strict about the host rather than forgiving: a link that is almost a
 * Cal.com link is not a booking calendar, it is somebody else's page rendered
 * inside our customer's site.
 *
 * So this module is a parser with an allow list, not a regex that hopes. It is
 * pure on purpose: no Supabase, no network, no import of the generator, so the
 * rules can be read and tested as rules. The route and the page phrase; this
 * decides.
 *
 * WHAT IS ACCEPTED
 *   https://cal.com/acme              a user or team page
 *   https://cal.com/acme/intro        a specific event type
 *   https://www.cal.com/acme/intro    the marketing host, same calendar
 *   https://app.cal.com/acme/intro    what a signed-in organiser copies
 *   cal.com/acme/intro                no scheme
 *   acme/intro                        the handle on its own
 *   https://cal.flowstarter.dev/acme/intro-call
 *                                     the platform's own Cal.com, when
 *                                     CAL_BASE_URL names one — this is what
 *                                     the provisioner writes
 *
 * WHAT IS NOT
 *   any other host, including calendly.com and cal.com.evil.example
 *   http, because the embed is loaded into an https document
 *   more than two path segments, which is never a booking page
 *   the reserved first segments Cal.com uses for its own product surface
 */

/** The hosted Cal.com service's own hosts. */
export const CAL_COM_HOSTS = ['cal.com', 'www.cal.com', 'app.cal.com'] as const;

/** The one variable these two read. Narrowed so a test can pass a literal. */
export interface CalHostEnv {
  CAL_BASE_URL?: string;
}

/**
 * The platform's own Cal.com, when there is one.
 *
 * Since the platform provisions booking pages on a Cal.com it hosts itself
 * (`docs/operations/cal.md`), that instance's host is as legitimate a booking
 * host as cal.com — and it is the only one this product ever writes into the
 * column by itself. It is read from `CAL_BASE_URL` rather than listed here so
 * that staging (`cal.flowstarter.dev`) and production (`cal.flowstarter.net`)
 * do not need a code change to differ, and so that an environment with no
 * self-hosted instance keeps exactly the old, narrower allow list.
 *
 * Only the host is taken from the variable. A malformed value yields null
 * rather than throwing: the allow list failing closed is the safe direction.
 */
export function selfHostedCalHost(
  env: CalHostEnv = process.env as CalHostEnv
): string | null {
  const raw = env.CAL_BASE_URL?.trim();
  if (!raw) return null;
  try {
    const url = new URL(raw.includes('://') ? raw : `https://${raw}`);
    if (url.protocol !== 'https:') return null;
    return url.hostname.toLowerCase() || null;
  } catch {
    return null;
  }
}

/** Every host a booking link may live on, in this environment. */
export function calLinkHosts(
  env: CalHostEnv = process.env as CalHostEnv
): readonly string[] {
  const self = selfHostedCalHost(env);
  return self && !(CAL_COM_HOSTS as readonly string[]).includes(self)
    ? [...CAL_COM_HOSTS, self]
    : CAL_COM_HOSTS;
}

/**
 * First path segments that belong to Cal.com's own application rather than to
 * a person. `cal.com/bookings` is a signed-in inbox, not a calendar anyone can
 * book, and embedding it would put an error page inside our client's site.
 * Listed rather than guessed, so a reader can see the whole set.
 */
export const CAL_RESERVED_SEGMENTS = new Set([
  'api',
  'apps',
  'auth',
  'availability',
  'blog',
  'bookings',
  'docs',
  'embed',
  'enterprise',
  'event-types',
  'forgot-password',
  'insights',
  'login',
  'logout',
  'pricing',
  'privacy',
  'router',
  'settings',
  'signup',
  'teams',
  'terms',
  'video',
  'workflows',
]);

/**
 * A Cal.com handle or event slug. Cal.com allows letters, digits, hyphens and
 * underscores; the length cap is ours, and it is generous enough that no real
 * slug reaches it while a pasted paragraph does.
 */
const SEGMENT = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/;

export type CalLinkRejection =
  | 'empty'
  | 'too_long'
  | 'malformed'
  | 'scheme'
  | 'host'
  | 'path'
  | 'reserved';

export interface CalLink {
  /**
   * The host the link was accepted on, lower case. `cal.com` for every hosted
   * link (the `www.`/`app.` variants collapse into it), or the platform's own
   * instance for a link that names it.
   */
  host: string;
  /** Canonical: `https://<host>/...`, never the app or www variant. */
  url: string;
  /** The part after the host, with no leading slash. `acme` or `acme/intro`. */
  path: string;
  /** The user or team handle. */
  handle: string;
  /** The event type, when the link names one. */
  eventSlug: string | null;
}

export type CalLinkResult =
  | { ok: true; link: CalLink }
  | { ok: false; reason: CalLinkRejection };

/** Longer than any real Cal.com link, short enough to stop a paste bomb. */
const MAX_INPUT = 400;

/**
 * Parse a pasted Cal.com link into its canonical form, or say why not.
 *
 * Query strings and fragments are dropped rather than refused: people copy
 * `?month=2026-09` out of the address bar constantly, and it carries no
 * meaning once the embed opens.
 */
export function parseCalLink(
  raw: string,
  options: { hosts?: readonly string[] } = {}
): CalLinkResult {
  const hosts = options.hosts ?? calLinkHosts();
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return { ok: false, reason: 'empty' };
  if (trimmed.length > MAX_INPUT) return { ok: false, reason: 'too_long' };

  // A bare `acme/intro` is not a URL, and `new URL` would read `acme:` as a
  // scheme. Supply a host only when the input does not already carry one.
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed);
  const looksHosted = /^(www\.|app\.)?cal\.com(\/|$)/i.test(trimmed);
  let candidate: string;
  if (hasScheme) {
    candidate = trimmed;
  } else if (looksHosted) {
    candidate = `https://${trimmed}`;
  } else {
    candidate = `https://cal.com/${trimmed.replace(/^\/+/, '')}`;
  }

  let url: URL;
  try {
    url = new URL(candidate);
  } catch {
    return { ok: false, reason: 'malformed' };
  }

  if (url.protocol !== 'https:') {
    // `http://cal.com/acme` resolves, but the embed runs inside an https
    // document and storing a link we would then rewrite is worse than saying
    // so. The fix is one character and the client can see it.
    return { ok: false, reason: 'scheme' };
  }

  const host = url.hostname.toLowerCase();
  if (!hosts.includes(host)) {
    return { ok: false, reason: 'host' };
  }
  // The `www.`/`app.` variants are the same calendar as `cal.com`, so they
  // collapse; a self-hosted instance is its own host and keeps its name.
  const canonicalHost = (CAL_COM_HOSTS as readonly string[]).includes(host)
    ? 'cal.com'
    : host;

  const segments = url.pathname.split('/').filter((part) => part.length > 0);
  if (segments.length < 1 || segments.length > 2) {
    return { ok: false, reason: 'path' };
  }

  const decoded: string[] = [];
  for (const segment of segments) {
    let value: string;
    try {
      value = decodeURIComponent(segment);
    } catch {
      return { ok: false, reason: 'path' };
    }
    if (!SEGMENT.test(value)) return { ok: false, reason: 'path' };
    decoded.push(value);
  }

  const handle = decoded[0];
  const eventSlug = decoded.length > 1 ? decoded[1] : null;
  if (CAL_RESERVED_SEGMENTS.has(handle.toLowerCase())) {
    return { ok: false, reason: 'reserved' };
  }

  const path = eventSlug ? `${handle}/${eventSlug}` : handle;
  return {
    ok: true,
    link: {
      host: canonicalHost,
      url: `https://${canonicalHost}/${path}`,
      path,
      handle,
      eventSlug,
    },
  };
}

/** True when the input is a Cal.com link this product will store. */
export function isCalLink(raw: string): boolean {
  return parseCalLink(raw).ok;
}

/**
 * The one sentence a client reads when their paste was refused.
 *
 * Phrased from the reason rather than assembled at each call site, so the
 * booking page and the API say the same thing about the same mistake.
 */
export function calLinkRejectionMessage(reason: CalLinkRejection): string {
  switch (reason) {
    case 'empty':
      return 'Paste your Cal.com link first.';
    case 'too_long':
      return 'That link is too long to be a Cal.com booking link.';
    case 'scheme':
      return 'Use the https version of your Cal.com link.';
    case 'host':
      return 'Only cal.com links work here. Copy the link from your Cal.com event type.';
    case 'reserved':
      return 'That is a Cal.com settings page, not a booking page. Copy the link from your event type instead.';
    case 'path':
      return 'That link has no booking page on it. It should look like https://cal.com/your-name or https://cal.com/your-name/intro.';
    case 'malformed':
    default:
      return 'That does not look like a Cal.com link. Use https://cal.com/your-name or https://cal.com/your-name/intro.';
  }
}

/**
 * The embed source for a parsed link, used by the dashboard preview.
 *
 * Built from the link's own host, not from a literal: a self-hosted booking
 * page embedded from cal.com would render somebody else's 404 inside our
 * client's dashboard.
 */
export function calEmbedSrc(link: CalLink): string {
  return `https://${link.host}/${link.path}/embed?layout=month_view&theme=light`;
}
