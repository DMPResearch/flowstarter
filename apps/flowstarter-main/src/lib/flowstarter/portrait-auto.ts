/**
 * Reading a portrait out of the three sources nobody has to press a button for.
 *
 * `portrait-source.ts` is the rule that decides which of five sources a
 * client's face may come from. Two of those five are consent flows, where the
 * person authorises us and the provider hands over a full size picture. The
 * other three are the ones this module reads: a GitHub avatar, an image on the
 * client's own site, and Instagram's public OpenGraph picture. They cost
 * nothing to try, they run inside the brand-signals fetch while the visitor is
 * already waiting, and between them they are the difference between a preview
 * with the client's face on it and a preview with a grey circle.
 *
 * Everything here is pure: no network, no clock, no storage, no `server-only`.
 * The requests live in `portrait-auto-fetch.ts`, which decides nothing and only
 * performs them. That is the same split `profile-signals.ts` and
 * `profile-fetch.ts` use, and it is what lets every branch below be exercised
 * with a string fixture rather than a fixture server, which matters because the
 * branches are the product: each one ends as a sentence the client reads about
 * why we do or do not have a picture of them.
 *
 * WHAT THE NETWORKS ACTUALLY DO, measured 2026-09-13 against the real
 * endpoints rather than assumed. These are the facts the module is shaped
 * around, and if they change the shape has to change with them.
 *
 *   instagram.com/<handle>, logged out
 *       Serves an `og:image` of 100x100, and ONLY to a crawler user agent.
 *       To anything else it serves an application shell with no `og:` tags at
 *       all, which is why `profile-signals.ts` reports `login_required` for
 *       Instagram and why this module exists alongside it rather than inside
 *       it: the two are reading the same page with different user agents for
 *       different purposes, and folding them together would mean the brand
 *       reader quietly started identifying itself as a crawler.
 *   www.instagram.com/api/v1/users/web_profile_info
 *       401 without a session. Not called. See `portrait-source.ts`.
 *   the unsigned full size Instagram CDN URL
 *       403. The signature is the access control, and guessing at it is not a
 *       source, it is a break-in attempt. Not constructed.
 *   linkedin.com/in/<handle>, logged out
 *       Login wall. There is no public LinkedIn portrait at any size, so there
 *       is no automatic LinkedIn path here at all; LinkedIn is a consent flow
 *       or it is nothing.
 *   github.com/<handle>.png
 *       Public, no credential, and it honours `?size=`. The one automatic
 *       source that reliably clears the portrait floor.
 *
 * EVERY READING BELOW IS A REGEX SCAN OVER THE TEXT, NOT AN HTML PARSE, for
 * exactly the reason `profile-signals.ts` gives in its `metaContent` comment:
 * we want two attributes out of a document that is frequently megabytes of
 * minified script, a parser would cost more than the whole request it is
 * reading, and a regex that only ever matches inside a tag cannot be tricked
 * into executing anything. The cost of that choice is that the scans are
 * approximate about structure, which is why "the nearest heading" is defined
 * as a bounded window of preceding characters rather than as an ancestor.
 */
import {
  DEFAULT_MAX_IMG_TAGS_SCANNED,
  DEFAULT_MAX_PORTRAIT_HTML_BYTES,
  DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
} from './portrait-config';
import { isPublicHttpUrl } from './profile-signals';

/**
 * The user agent Instagram will actually answer with an og:image.
 *
 * Not a disguise. This is the user agent Meta documents for exactly this
 * purpose, the picture behind it is the one the network chose to publish to
 * it, and `portrait-auto-fetch.ts` identifies the product in the Accept and
 * Referer headers of the same request. We take the published picture and
 * nothing else.
 */
export const INSTAGRAM_CRAWLER_USER_AGENT = 'facebookexternalhit/1.1';

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

/**
 * Paths on github.com that are the product rather than a person.
 *
 * `github.com/pricing` is a page, not a handle, and asking for
 * `github.com/pricing.png` gets a picture that is nobody's face. GitHub itself
 * keeps a much longer reserved list; this one covers the paths a client
 * actually pastes into an intake box by accident.
 */
const GITHUB_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'orgs',
  'settings',
  'features',
  'about',
  'pricing',
  'marketplace',
  'explore',
  'topics',
  'collections',
  'events',
  'sponsors',
  'enterprise',
  'login',
  'join',
  'apps',
]);

/** The hosts a GitHub profile lives on. Nothing else, gists included. */
const GITHUB_HOSTS: ReadonlySet<string> = new Set([
  'github.com',
  'www.github.com',
]);

/**
 * GitHub's own rule for a handle: alphanumerics and single hyphens, never
 * leading or trailing, at most 39 characters. Written as one expression so
 * there is one place to correct it if GitHub ever relaxes it.
 */
const GITHUB_HANDLE_RE = /^[a-z\d](?:[a-z\d]|-(?=[a-z\d])){0,38}$/i;

/**
 * Absolute https URL from whatever the client typed, or null.
 *
 * Mirrors the normalisation `profile-signals.ts` does before its own host
 * check, which is private to that module: a bare `github.com/darius` gets a
 * scheme, and an `http://` link is upgraded rather than rejected, because a
 * client pasting an http link has still told us their handle and the request
 * we make from it is ours to make over TLS.
 */
function absoluteHttpsUrl(raw: string | null | undefined): URL | null {
  const value = (raw ?? '').trim();
  if (!value) return null;
  const withScheme = /^https?:\/\//i.test(value)
    ? value.replace(/^http:\/\//i, 'https://')
    : `https://${value}`;
  try {
    return new URL(withScheme);
  } catch {
    return null;
  }
}

/**
 * A GitHub handle named by one of the client's links, or null. We never guess
 * one from a name.
 *
 * A second path segment is taken rather than refused. `github.com/owner/repo`
 * is a repository, not a profile, but the owner of a repository is still a
 * person or an organisation and `github.com/<owner>.png` is the same avatar
 * either way, so a client who pastes the link to their own project has still
 * told us who they are. The reserved words are rejected at the same segment
 * for the same reason they are rejected on their own: `github.com/orgs/acme`
 * names an organisation page, and `orgs` is not its handle.
 */
export function githubHandleFrom(urls: readonly string[]): string | null {
  for (const raw of urls) {
    const url = absoluteHttpsUrl(raw);
    if (!url) continue;
    if (!GITHUB_HOSTS.has(url.hostname.toLowerCase())) continue;
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (!first) continue;
    const handle = decodeURIComponent(first);
    if (GITHUB_RESERVED_PATHS.has(handle.toLowerCase())) continue;
    if (!GITHUB_HANDLE_RE.test(handle)) continue;
    return handle;
  }
  return null;
}

/**
 * The public avatar URL for a handle, at a given edge.
 *
 * The size is a request and not an answer: GitHub serves whatever the person
 * uploaded, scaled down to at most this edge, so a handle with a 128 pixel
 * avatar answers a 460 pixel ask with 128 pixels. `portrait-auto-fetch.ts`
 * measures the bytes that arrive and the rule reads the measurement.
 */
export function githubAvatarUrl(handle: string, size: number): string {
  return `https://github.com/${encodeURIComponent(handle)}.png?size=${size}`;
}

// ---------------------------------------------------------------------------
// Instagram
// ---------------------------------------------------------------------------

/** Instagram paths that are the product rather than a person. */
const INSTAGRAM_RESERVED_PATHS: ReadonlySet<string> = new Set([
  'explore',
  'reels',
  'reel',
  'p',
  'tv',
  'stories',
  'accounts',
  'directory',
  'about',
  'developer',
  'legal',
  'privacy',
  'terms',
]);

const INSTAGRAM_HOSTS: ReadonlySet<string> = new Set([
  'instagram.com',
  'www.instagram.com',
]);

/**
 * Instagram's own rule: letters, digits, full stops and underscores, at most
 * 30 characters. Tighter than it needs to be on purpose, because the handle is
 * pasted straight into a URL we then request.
 */
const INSTAGRAM_HANDLE_RE = /^[a-z\d._]{1,30}$/i;

/**
 * The Instagram handle named by one of the client's links, or null.
 *
 * Same shape as `githubHandleFrom` and for the same reason: the handle becomes
 * a path in an outbound request, so it is validated against the network's own
 * rule before it is ever concatenated into a URL.
 */
export function instagramHandleFrom(urls: readonly string[]): string | null {
  for (const raw of urls) {
    const url = absoluteHttpsUrl(raw);
    if (!url) continue;
    if (!INSTAGRAM_HOSTS.has(url.hostname.toLowerCase())) continue;
    const first = url.pathname.split('/').filter(Boolean)[0];
    if (!first) continue;
    const handle = decodeURIComponent(first);
    if (INSTAGRAM_RESERVED_PATHS.has(handle.toLowerCase())) continue;
    if (!INSTAGRAM_HANDLE_RE.test(handle)) continue;
    return handle;
  }
  return null;
}

/** The public profile page, which is the only Instagram URL we request. */
export function instagramProfileUrl(handle: string): string {
  return `https://www.instagram.com/${encodeURIComponent(handle)}/`;
}

// ---------------------------------------------------------------------------
// The client's own site
// ---------------------------------------------------------------------------

/**
 * Hosts that are somebody else's network rather than the client's own site.
 *
 * The route hands this module every link the client gave, in one list, because
 * the brief collects links without asking which is which. The website source
 * is "the client's own page", so a link to a network we already have a named
 * source for, or a network we deliberately do not read, is not it.
 */
const NETWORK_HOSTS: readonly string[] = [
  'instagram.com',
  'linkedin.com',
  'github.com',
  'facebook.com',
  'twitter.com',
  'x.com',
  'tiktok.com',
  'youtube.com',
  'youtu.be',
  'threads.net',
  'pinterest.com',
  'behance.net',
  'dribbble.com',
];

function isNetworkHost(hostname: string): boolean {
  const lower = hostname.toLowerCase();
  return NETWORK_HOSTS.some(
    (entry) => lower === entry || lower.endsWith(`.${entry}`)
  );
}

/**
 * The client's own site among the links, or null.
 *
 * First wins. A client who lists two sites has told us the first one matters
 * more, and reading both would double the cost of a step that already runs
 * three requests while somebody waits.
 */
export function websiteUrlFrom(urls: readonly string[]): string | null {
  for (const raw of urls) {
    const url = absoluteHttpsUrl(raw);
    if (!url) continue;
    if (isNetworkHost(url.hostname)) continue;
    const absolute = url.toString();
    if (!isPublicHttpUrl(absolute)) continue;
    return absolute;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Reading a person out of a page
// ---------------------------------------------------------------------------

export interface PersonImageReading {
  url: string;
  /** The page said this image is a person: alt text or a nearby heading matched the name. */
  saysPerson: boolean;
}

/**
 * The caps the scan runs under. Passed in rather than read from the
 * environment here, because this module is pure and an environment read is a
 * hidden input; `portrait-auto-fetch.ts` calls `portraitAutoBudgets` and hands
 * the numbers down.
 */
export interface PortraitScanCaps {
  maxHtmlBytes: number;
  maxImgTags: number;
  headingWindowChars: number;
}

const DEFAULT_SCAN_CAPS: PortraitScanCaps = {
  maxHtmlBytes: DEFAULT_MAX_PORTRAIT_HTML_BYTES,
  maxImgTags: DEFAULT_MAX_IMG_TAGS_SCANNED,
  headingWindowChars: DEFAULT_PORTRAIT_HEADING_WINDOW_CHARS,
};

/**
 * The shortest part of a name we will match on its own.
 *
 * Deliberately here and not in `portrait-config.ts`. The numbers in that file
 * are budgets, which an operator may reasonably retune from a restart script.
 * This one is part of the rule: lower it and "Jo Li" starts matching the alt
 * text "logo", which is not a slower funnel, it is a wrong answer. Changing it
 * needs a test, not an environment variable.
 */
export const MIN_NAME_PART_CHARS = 3;

/**
 * The entities that appear in alt text and headings often enough to matter.
 * The same short list `profile-signals.ts` decodes, duplicated rather than
 * exported from there: it is five replaces, and widening that module's public
 * surface to share them would couple the brand reader's text handling to this
 * one for no benefit.
 */
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

/**
 * The characters a name may be spelled with.
 *
 * Written as explicit ranges rather than as `\p{L}` because this app compiles
 * to es5, where TypeScript refuses the `u` flag that unicode property escapes
 * need. The ranges are ASCII, the Latin-1 supplement and Latin Extended-A and
 * B, Greek, and Cyrillic, which is every alphabet a European client has typed
 * their own name in so far. A name in a script outside them normalises to
 * nothing and simply does not match, which costs a portrait and never puts the
 * wrong face on a site.
 */
const NOT_A_NAME_CHARACTER = /[^a-z0-9À-ɏͰ-ϿЀ-ӿ]+/gi;

/**
 * Text reduced to the words in it: entities decoded, case folded, and every
 * run of anything that is not a letter or a digit collapsed to one space.
 *
 * This is what makes the match whole-word without a regex per name part:
 * "Darius Popescu, founder" and "photo-of-darius-popescu" both normalise to a
 * token list containing `darius` and `popescu`, while "dariusz" does not.
 */
function normalise(value: string): string {
  return decodeEntities(value)
    .toLowerCase()
    .replace(NOT_A_NAME_CHARACTER, ' ')
    .trim();
}

function tokensOf(value: string): string[] {
  const text = normalise(value);
  return text ? text.split(' ') : [];
}

/** True when `needle` appears in `haystack` as a run of consecutive tokens. */
function containsSequence(
  haystack: readonly string[],
  needle: readonly string[]
): boolean {
  if (needle.length === 0 || needle.length > haystack.length) return false;
  for (let start = 0; start <= haystack.length - needle.length; start += 1) {
    let matched = true;
    for (let offset = 0; offset < needle.length; offset += 1) {
      if (haystack[start + offset] !== needle[offset]) {
        matched = false;
        break;
      }
    }
    if (matched) return true;
  }
  return false;
}

/**
 * True when a piece of the page names the client.
 *
 * The whole name in order counts, and so does any single part of at least
 * `MIN_NAME_PART_CHARS`, because a page about Darius Popescu writes "Darius" in
 * the heading and "Popescu" nowhere. The length floor is the whole reason a
 * two-letter part is refused on its own: "Bo" would match "bio", "Al" would
 * match a caption about a mural, and a wrong face on a paid site is worse than
 * no face at all.
 */
export function nameAppearsIn(text: string, fullName: string): boolean {
  const nameTokens = tokensOf(fullName);
  if (nameTokens.length === 0) return false;
  const textTokens = tokensOf(text);
  if (textTokens.length === 0) return false;
  if (containsSequence(textTokens, nameTokens)) return true;
  return nameTokens.some(
    (part) => part.length >= MIN_NAME_PART_CHARS && textTokens.includes(part)
  );
}

/**
 * One attribute off one tag. Quoted either way, absent is ''.
 *
 * The name has to be preceded by whitespace rather than by a word boundary.
 * There is a boundary between the hyphen and the `s` of `data-src`, so a
 * pattern written `\bsrc=` reads a lazy-loading placeholder as if it were the
 * real source, and the difference between those two is a one pixel spacer GIF
 * in a portrait slot.
 */
function attribute(tag: string, name: string): string {
  const pattern = new RegExp(`\\s${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const match = pattern.exec(tag);
  if (!match) return '';
  return match[2] ?? match[3] ?? '';
}

/**
 * One meta tag's content. The same scan `profile-signals.ts` uses, for the
 * same reason, duplicated for the same reason `decodeEntities` is.
 */
function metaContent(html: string, selector: RegExp): string | null {
  const tags = html.match(/<meta\b[^>]*>/gi) ?? [];
  for (const tag of tags) {
    if (!selector.test(tag)) continue;
    const content = attribute(tag, 'content');
    const value = decodeEntities(content).replace(/\s+/g, ' ').trim();
    if (value) return value;
  }
  return null;
}

/** An image URL we are willing to request: absolute, https, public host. */
function usableImageUrl(raw: string, baseUrl: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  let absolute: string;
  try {
    absolute = new URL(value, baseUrl).toString();
  } catch {
    return null;
  }
  return isPublicHttpUrl(absolute) ? absolute : null;
}

/**
 * The last `<h1>` to `<h3>` in a stretch of markup, or ''.
 *
 * "Nearest preceding" with a regex scan means "last one inside the window",
 * which is an approximation of the ancestor relationship a parser would give
 * us. It is the right approximation for the shape this rule cares about: a
 * team card is a heading with the person's name followed immediately by their
 * photograph, and a heading that is two thousand characters away is a
 * different card.
 */
function nearestHeadingIn(window: string): string {
  const headings = window.match(/<h[1-3]\b[^>]*>([\s\S]{0,400}?)<\/h[1-3]>/gi);
  if (!headings || headings.length === 0) return '';
  const last = headings[headings.length - 1] as string;
  return last.replace(/<[^>]*>/g, ' ');
}

/**
 * Words in a section's id or class that say the section is about a person.
 *
 * These are the names people give the part of a marketing page that carries
 * their own photograph. A picture inside one of them, under a heading with
 * their name on it, is the person; the same picture inside `<section
 * id="clients">` is a customer logo.
 */
const PERSON_SECTION_RE = /\b(about|team|founder|bio|profile|author)\b/i;

/** True when the markup just before an image opens a section about a person. */
function inPersonSection(window: string): boolean {
  const opens = window.match(
    /<(?:section|div|article|aside|main|header|figure)\b[^>]*>/gi
  );
  if (!opens) return false;
  return opens.some((tag) => {
    const id = attribute(tag, 'id');
    const className = attribute(tag, 'class');
    const dataTestId = attribute(tag, 'data-testid');
    return PERSON_SECTION_RE.test(`${id} ${className} ${dataTestId}`);
  });
}

interface ScannedImage {
  url: string;
  altSaysPerson: boolean;
  headingSaysPerson: boolean;
  inPersonSection: boolean;
}

/**
 * The image on a page that is most likely to be the person, judged only by
 * what the page itself says.
 *
 * The preference order is the rule, and it is an order of evidence rather than
 * an order of prominence:
 *
 *   1. an `<img>` whose alt text names the client. Alt text is the page
 *      author telling a screen reader what the picture is, which is the
 *      closest thing to a caption a machine can trust.
 *   2. an `<img>` inside a section the page calls about, team, founder, bio or
 *      profile, under a heading that names the client. Two weak signals that
 *      only agree when the picture really is the person.
 *   3. the page's `og:image`, with `saysPerson: false`.
 *
 * Case three is deliberate and load bearing. `portrait-source.ts` will refuse
 * it with reason `not_a_person`, and that refusal is the point: it lets the
 * brief say "we found a picture on your site and did not use it, because
 * nothing on the page says it is you", which a client can act on by sending a
 * photograph. Returning null instead would produce silence, and silence is the
 * one answer a client cannot do anything with.
 */
export function personImageFromHtml(input: {
  html: string;
  baseUrl: string;
  fullName: string;
  /** Defaults to the documented caps; the fetch adapter passes the env's. */
  caps?: PortraitScanCaps;
}): PersonImageReading | null {
  const caps = input.caps ?? DEFAULT_SCAN_CAPS;
  const html = input.html.slice(0, caps.maxHtmlBytes);
  const fullName = input.fullName;

  const scanned: ScannedImage[] = [];
  const tagPattern = /<img\b[^>]*>/gi;
  let match: RegExpExecArray | null;
  while (
    scanned.length < caps.maxImgTags &&
    (match = tagPattern.exec(html)) !== null
  ) {
    const tag = match[0];
    const src = attribute(tag, 'src') || attribute(tag, 'data-src');
    const url = usableImageUrl(src, input.baseUrl);
    if (!url) continue;
    const windowStart = Math.max(0, match.index - caps.headingWindowChars);
    const window = html.slice(windowStart, match.index);
    scanned.push({
      url,
      altSaysPerson: nameAppearsIn(attribute(tag, 'alt'), fullName),
      headingSaysPerson: nameAppearsIn(nearestHeadingIn(window), fullName),
      inPersonSection: inPersonSection(window),
    });
  }

  const byAlt = scanned.find((image) => image.altSaysPerson);
  if (byAlt) return { url: byAlt.url, saysPerson: true };

  const bySection = scanned.find(
    (image) => image.inPersonSection && image.headingSaysPerson
  );
  if (bySection) return { url: bySection.url, saysPerson: true };

  const og = metaContent(html, /property\s*=\s*["']og:image["']/i);
  const ogUrl = og ? usableImageUrl(og, input.baseUrl) : null;
  if (ogUrl) return { url: ogUrl, saysPerson: false };

  return null;
}
