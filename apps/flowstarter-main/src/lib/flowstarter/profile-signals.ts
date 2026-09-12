/**
 * What a public profile page is willing to tell us, decided by rule.
 *
 * The intake asks for an Instagram, a LinkedIn and a website. Those links are
 * the cheapest brand evidence there is: a profile picture carries the colours
 * the person already uses, and a bio carries the words they already use. So
 * before the preview is generated we read the public page and take what it
 * exposes without a login, and nothing else.
 *
 * Three rules govern this module, and all three are load bearing.
 *
 * 1. WE READ WHAT IS PUBLIC AND WE STOP THERE. One GET, no session, no
 *    cookies, no API token, no scraping of the JSON payloads a single-page app
 *    happens to ship in its HTML. `readProfileHtml` looks at exactly three
 *    things: the OpenGraph image, the title and the description. If the page
 *    does not offer them to an anonymous reader, the answer is `unavailable`
 *    and we say so to the visitor in plain words.
 *
 * 2. NOTHING IS INVENTED. There is no "well, Instagram usually looks like
 *    this" path. A reading is either evidence we actually received or an
 *    `unavailable` with a reason the visitor can act on. A palette built from
 *    a guess is worse than a palette built from the tone chips, because the
 *    visitor cannot tell which one they got.
 *
 * 3. THE RULES ARE PURE. Everything in this file is a function of its
 *    arguments. The fetch itself lives in `profile-fetch.ts`, which is a thin
 *    `server-only` adapter over these rules: it decides nothing, it only
 *    performs the request and hands the status and the body back here. That is
 *    what lets the exposed / blocked / timeout cases be tested without a
 *    network.
 *
 * WHAT THE NETWORKS ACTUALLY DO, measured 2026-09-12 against the real public
 * pages rather than assumed:
 *
 *   instagram.com/<handle>
 *       HTTP 200 with roughly 600 kB of application shell. Zero `og:` tags of
 *       any kind, no `meta description`, and `<title>Instagram</title>`.
 *       Everything a reader would want is behind the login wall, so this lands
 *       on `login_required`, which is the reason the wizard shows and the
 *       reason the optional picture upload exists at all.
 *
 *   instagram.com/<handle>/?__a=1&__d=dis
 *       HTTP 201 with a zero-byte body and `content-type: text/html`. The
 *       endpoint that used to return the profile JSON has been retired. Note
 *       the shape of that failure: it does not 404, it answers with nothing,
 *       so code that only checks the status believes it worked. This module
 *       therefore does not call it. It was measured, it returns nothing to an
 *       anonymous reader, and a second outbound request that is known never to
 *       succeed is a cost with no upside and a comment that would rot into a
 *       lie. If Instagram reopens it, add it next to the HTML request in
 *       `profile-fetch.ts` and write the 201-with-empty-body test first.
 *
 *   linkedin.com/in/<handle>
 *       Answers anonymous requests with an auth wall or HTTP 999, so it lands
 *       on `blocked`.
 *
 * Both of those are normal, neither is an error, and the visitor is told which
 * one happened rather than being shown an empty palette with no explanation.
 */

// ---------------------------------------------------------------------------
// Links
// ---------------------------------------------------------------------------

export type ProfileNetwork = 'instagram' | 'linkedin' | 'website';

/**
 * Hosts we are willing to request, per network. An allow list rather than a
 * pattern: this module turns a visitor-supplied string into an outbound
 * request from our server, which is the shape of a server-side request forgery
 * if the host is not pinned. `website` is the deliberate exception and is
 * handled by `isPublicHttpUrl` instead.
 */
export const PROFILE_HOSTS: Record<
  Exclude<ProfileNetwork, 'website'>,
  readonly string[]
> = {
  instagram: ['instagram.com', 'www.instagram.com'],
  linkedin: ['linkedin.com', 'www.linkedin.com'],
};

export interface ProfileLink {
  network: ProfileNetwork;
  /** Always absolute and always https. */
  url: string;
  /** The handle, when the path shape gives one. */
  handle: string | null;
}

/** Hosts that are never fetched: loopback, link-local and the private ranges. */
const PRIVATE_HOST_RE =
  /^(localhost$|127\.|10\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.|\[?::1\]?$|0\.0\.0\.0$)/i;

/**
 * True when a URL is safe to request from the server: https, a real hostname,
 * not a private or loopback address, and no credentials in the authority.
 */
export function isPublicHttpUrl(raw: string): boolean {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  if (url.username || url.password) return false;
  if (!url.hostname.includes('.') && url.hostname !== 'localhost') return false;
  return !PRIVATE_HOST_RE.test(url.hostname);
}

function normaliseUrl(raw: string | null | undefined): URL | null {
  const trimmed = (raw ?? '').trim();
  if (!trimmed) return null;
  const withScheme = /^https?:\/\//i.test(trimmed)
    ? trimmed.replace(/^http:\/\//i, 'https://')
    : `https://${trimmed}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

function hostMatches(host: string, allowed: readonly string[]): boolean {
  const lower = host.toLowerCase();
  return allowed.some(
    (entry) => lower === entry || lower.endsWith(`.${entry}`)
  );
}

/**
 * The handle, from the path. Instagram puts it first, LinkedIn puts it after
 * `in` or `company`. Anything else returns null rather than a guess.
 */
function handleFor(network: ProfileNetwork, url: URL): string | null {
  const parts = url.pathname.split('/').filter(Boolean);
  if (parts.length === 0) return null;
  if (network === 'instagram') return parts[0] ?? null;
  if (network === 'linkedin') {
    if (parts[0] === 'in' || parts[0] === 'company') return parts[1] ?? null;
    return null;
  }
  return null;
}

/**
 * The links we will actually read, from whatever the intake stored.
 *
 * A link on the wrong host is dropped silently rather than reported: the
 * intake's own regexes already only write an Instagram URL into the Instagram
 * field, so a mismatch here means a hand-edited draft, and there is nothing
 * useful to say about it to the visitor.
 */
export function parseProfileLinks(input: {
  instagramUrl?: string | null;
  linkedinUrl?: string | null;
  websiteUrl?: string | null;
}): ProfileLink[] {
  const links: ProfileLink[] = [];

  const instagram = normaliseUrl(input.instagramUrl);
  if (instagram && hostMatches(instagram.host, PROFILE_HOSTS.instagram)) {
    links.push({
      network: 'instagram',
      url: instagram.toString(),
      handle: handleFor('instagram', instagram),
    });
  }

  const linkedin = normaliseUrl(input.linkedinUrl);
  if (linkedin && hostMatches(linkedin.host, PROFILE_HOSTS.linkedin)) {
    links.push({
      network: 'linkedin',
      url: linkedin.toString(),
      handle: handleFor('linkedin', linkedin),
    });
  }

  const website = normaliseUrl(input.websiteUrl);
  if (website && isPublicHttpUrl(website.toString())) {
    links.push({ network: 'website', url: website.toString(), handle: null });
  }

  return links;
}

// ---------------------------------------------------------------------------
// Readings
// ---------------------------------------------------------------------------

/**
 * Why we have nothing. Every one of these is shown to the visitor as a
 * sentence, so the set is closed and each member means one distinguishable
 * thing.
 */
export type ProfileUnavailableReason =
  /** The visitor did not give us this link. */
  | 'not_given'
  /** The page answered, but it exposes nothing to a reader without a login. */
  | 'login_required'
  /** The network refused us: 401, 403, 429, or LinkedIn's 999. */
  | 'blocked'
  /** 404 or 410. The handle is wrong, or the profile is gone. */
  | 'not_found'
  /** The request did not finish inside the budget. */
  | 'timeout'
  /** DNS, TLS, a reset connection. */
  | 'network_error'
  /** The network is having a bad day: any other 5xx. */
  | 'server_error'
  /** The body was larger than we are willing to read. */
  | 'too_large';

export interface ProfileExposure {
  status: 'exposed';
  network: ProfileNetwork;
  url: string;
  /** The page title, with the network's own boilerplate removed. */
  title: string | null;
  /** `og:description`, else `meta[name=description]`. */
  description: string | null;
  /** `og:image`, absolute, https only. */
  imageUrl: string | null;
}

export interface ProfileUnavailable {
  status: 'unavailable';
  network: ProfileNetwork;
  url: string;
  reason: ProfileUnavailableReason;
}

export type ProfileReading = ProfileExposure | ProfileUnavailable;

/** The largest body we will parse. A profile page that needs more is not one. */
export const MAX_PROFILE_BYTES = 1_500_000;

/** How long a profile fetch may take before we give up and move on. */
export const PROFILE_FETCH_TIMEOUT_MS = 4_000;

/**
 * Titles that are the network's name and nothing else. A page that comes back
 * with one of these has told us nothing, whatever its status code said.
 */
const EMPTY_TITLES = new Set([
  'instagram',
  'linkedin',
  'sign up',
  'log in',
  'login',
  'linkedin: log in or sign up',
  'sign up | linkedin',
  'security verification',
]);

function decodeEntities(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&');
}

function clean(value: string | null): string | null {
  if (value === null) return null;
  const text = decodeEntities(value).replace(/\s+/g, ' ').trim();
  return text.length > 0 ? text : null;
}

/**
 * Reads one meta tag. Deliberately a scan rather than an HTML parse: we want
 * three attributes out of a document that is frequently megabytes of minified
 * script, and a regex that only ever matches inside a `<meta>` tag cannot be
 * tricked into executing anything.
 */
function metaContent(html: string, selector: RegExp): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!selector.test(tag)) continue;
    const content =
      /content\s*=\s*"([^"]*)"/i.exec(tag) ??
      /content\s*=\s*'([^']*)'/i.exec(tag);
    const value = clean(content?.[1] ?? null);
    if (value) return value;
  }
  return null;
}

function titleOf(html: string): string | null {
  return clean(
    /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html)?.[1] ?? null
  );
}

/** An `og:image` we are willing to fetch: absolute, https, public host. */
function usableImage(raw: string | null, base: string): string | null {
  if (!raw) return null;
  let absolute: string;
  try {
    absolute = new URL(raw, base).toString();
  } catch {
    return null;
  }
  return isPublicHttpUrl(absolute) ? absolute : null;
}

/**
 * The status codes each map to one reason. Anything not listed falls through
 * to the ranges below, so a new code the networks invent still lands somewhere
 * honest instead of being read as a success.
 */
function reasonForStatus(status: number): ProfileUnavailableReason | null {
  if (status >= 200 && status < 300) return null;
  if (status === 404 || status === 410) return 'not_found';
  // 999 is LinkedIn's own "we know what you are and no".
  if (status === 401 || status === 403 || status === 429 || status === 999) {
    return 'blocked';
  }
  if (status >= 500 && status < 600) return 'server_error';
  return 'blocked';
}

/**
 * Turns an HTTP result into a reading. Pure: no network, no clock.
 *
 * A 200 is not a success on its own. Instagram answers every anonymous profile
 * request with 200 and an application shell that carries no OpenGraph tags at
 * all, which is a login wall wearing a success code. The rule is therefore
 * about the content: a page that exposes no image, no description and no title
 * beyond the network's own name has told us nothing, and `login_required` is
 * the honest word for it.
 */
export function readProfileHtml(input: {
  network: ProfileNetwork;
  url: string;
  status: number;
  html: string;
}): ProfileReading {
  const { network, url, status, html } = input;
  const statusReason = reasonForStatus(status);
  if (statusReason)
    return { status: 'unavailable', network, url, reason: statusReason };

  const title = titleOf(html);
  const description =
    metaContent(html, /property\s*=\s*["']og:description["']/i) ??
    metaContent(html, /name\s*=\s*["']description["']/i);
  const imageUrl = usableImage(
    metaContent(html, /property\s*=\s*["']og:image["']/i),
    url
  );
  const ogTitle = metaContent(html, /property\s*=\s*["']og:title["']/i);

  const bestTitle = ogTitle ?? title;
  const meaningfulTitle =
    bestTitle && !EMPTY_TITLES.has(bestTitle.toLowerCase()) ? bestTitle : null;

  if (!imageUrl && !description && !meaningfulTitle) {
    return { status: 'unavailable', network, url, reason: 'login_required' };
  }

  return {
    status: 'exposed',
    network,
    url,
    title: meaningfulTitle,
    description,
    imageUrl,
  };
}

// ---------------------------------------------------------------------------
// The bio text a tone may be phrased from
// ---------------------------------------------------------------------------

/**
 * Longest bio we carry forward. A profile description is one or two lines; a
 * website meta description that runs past this is a keyword stuffing exercise
 * and is worth less than the visitor's own sentence.
 */
export const MAX_BIO_CHARS = 400;

/**
 * The prose a reading contributes, or '' when it contributes none.
 *
 * The title is included only when it is not simply the handle again: "Darius
 * Popescu (@darius.flowstarter)" says nothing a tone can be built from, and a
 * model given it as evidence will write about the name.
 */
export function bioTextFrom(readings: readonly ProfileReading[]): string {
  const parts: string[] = [];
  for (const reading of readings) {
    if (reading.status !== 'exposed') continue;
    if (reading.description) parts.push(reading.description);
  }
  return parts.join(' ').replace(/\s+/g, ' ').trim().slice(0, MAX_BIO_CHARS);
}

/** Every image a reading exposed, in reading order, deduplicated. */
export function imageUrlsFrom(readings: readonly ProfileReading[]): string[] {
  const seen = new Set<string>();
  const urls: string[] = [];
  for (const reading of readings) {
    if (reading.status !== 'exposed') continue;
    if (!reading.imageUrl || seen.has(reading.imageUrl)) continue;
    seen.add(reading.imageUrl);
    urls.push(reading.imageUrl);
  }
  return urls;
}

// ---------------------------------------------------------------------------
// The whole answer
// ---------------------------------------------------------------------------

export interface ProfileSignals {
  readings: ProfileReading[];
  /** True when at least one network gave us something. */
  anyExposed: boolean;
  /** The bio text, for the tone step. '' when nothing was readable. */
  bioText: string;
  /** Image URLs worth fetching for the palette. */
  imageUrls: string[];
  /**
   * The networks we could not read, with why. The wizard prints one line per
   * entry, which is the "says plainly when a network could not be read" half
   * of the contract.
   */
  unavailable: Array<{
    network: ProfileNetwork;
    reason: ProfileUnavailableReason;
  }>;
}

/** Folds a set of readings into the shape the wizard and the brief carry. */
export function summariseProfileSignals(
  readings: readonly ProfileReading[]
): ProfileSignals {
  return {
    readings: [...readings],
    anyExposed: readings.some((reading) => reading.status === 'exposed'),
    bioText: bioTextFrom(readings),
    imageUrls: imageUrlsFrom(readings),
    unavailable: readings
      .filter(
        (reading): reading is ProfileUnavailable =>
          reading.status === 'unavailable'
      )
      .map((reading) => ({ network: reading.network, reason: reading.reason })),
  };
}

/**
 * The locale key for a reason, so the wizard prints the network's own story
 * rather than "something went wrong".
 */
export function unavailableCopyKey(reason: ProfileUnavailableReason): string {
  return `landing.discovery.brand.unavailable.${reason}`;
}
