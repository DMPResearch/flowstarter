/**
 * A bio read off a page the client pointed us at, as a proposal.
 *
 * `portrait-auto-fetch.ts` next door does this for a photograph. This does it
 * for words, from the same two automatic sources and under exactly the same
 * law, which docs/portrait-sources.md states and which nothing here weakens:
 *
 *   **Nothing behind a login, and nothing without consent.** Only a link the
 *   client offered in answer to a question that said in plain words what
 *   answering it would do, and only one marked `consented`. A URL we happen
 *   to hold because it is going in their footer is not permission to go and
 *   read it.
 *
 *   **Proposed, never adopted.** What comes back is a quotation with the page
 *   it came from and the instant we read it. It is shown to the client on
 *   their brief with both of those visible, and it may not be published until
 *   they say yes. `adoptedAt` is null here and only the brief route can set
 *   it. The gap between "we found this" and "you approved this" is the whole
 *   feature, because the alternative is a stranger's website quoting them
 *   without their knowing.
 *
 *   **Their words, unedited.** No model rewrites an excerpt, summarises one
 *   or fills a gap in one. What the page said is what the client is shown and
 *   what, if they approve it, the site quotes. A smoothed bio is an invented
 *   one.
 *
 * Two sources, in priority order, for the reasons the portrait table gives:
 *
 *   1. `github-bio`      the profile bio field. Short, unambiguously written
 *                        by the account holder about themselves, public by
 *                        the publisher's own choice, and served by a
 *                        documented JSON endpoint with no credential.
 *   2. `website-about`   their own site. Longer and better when it is there,
 *                        and much harder to be sure about: an about page is
 *                        also where a company writes about itself in the
 *                        third person. Only accepted when the page names
 *                        them, which is the same test `personImageFromHtml`
 *                        applies before it believes a picture is a person.
 *
 * LinkedIn is not a source. Logged out it is a login wall, and the OpenID
 * headline that the connect flow can return is a job title rather than a bio;
 * `linkedin-headline` exists in the type for the day the provider returns
 * one, and nothing here produces it.
 *
 * Every request goes through `fetchPublicResource`: https only, host re-checked
 * before the first request and after every redirect, no credentials in the
 * authority, private and loopback addresses refused at every hop, body capped
 * as it streams. Every URL here is built from a string a visitor typed.
 */
import type {
  PersonLink,
  PersonSourcedBio,
} from '@flowstarter/agentic-codegen/src/flowstarter/person';
import { MIN_STORY_CHARS } from '@flowstarter/agentic-codegen/src/flowstarter/person';
import {
  decodeHtmlEntities,
  readableText,
  stripTagBlocks,
  stripTags,
  tagBlocks,
} from '@flowstarter/agentic-codegen/src/flowstarter/html-scan';
import { fetchPublicResource, type FetchLike } from '@/lib/net/safe-fetch';
import { githubHandleFrom, websiteUrlFrom } from './portrait-auto';

/** What this product is, said out loud, on every request it makes. */
const PRODUCT_URL = 'https://flowstarter.net';

/**
 * How long we wait for one source, and how much of an answer we will read.
 *
 * Small on purpose. This runs while a client is looking at their brief, the
 * answer is a paragraph, and a source that needs more than this is a source
 * that is not going to help them today.
 */
export const BIO_FETCH_TIMEOUT_MS = 6_000;

/** A profile JSON document or an about page. Not a download. */
export const BIO_FETCH_MAX_BYTES = 512 * 1024;

/**
 * The longest excerpt we will carry. A bio, not a memoir: past this the page
 * has stopped being about the person and started being the rest of the site.
 */
export const MAX_BIO_EXCERPT_CHARS = 1_200;

/**
 * How much of an about page's prose may be gathered into one excerpt.
 *
 * Paragraphs are taken in document order until this is reached, because an
 * about page's first paragraphs are the ones about the person and the later
 * ones are usually a call to action.
 */
export const MAX_ABOUT_PARAGRAPHS = 3;

/** Shorter than this and a paragraph is a caption or a nav label. */
export const MIN_ABOUT_PARAGRAPH_CHARS = 40;

const JSON_HEADERS: Record<string, string> = {
  accept: 'application/vnd.github+json',
  'user-agent': `FlowstarterBrandReader/1.0 (+${PRODUCT_URL})`,
};

const PAGE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en',
  'user-agent': `FlowstarterBrandReader/1.0 (+${PRODUCT_URL})`,
};

export interface ReadBioInput {
  /** The client's profile links, with their consent recorded per link. */
  links: readonly PersonLink[];
  /** Their name, used to decide whether an about page is about them. */
  fullName: string;
  /** When this read happened. A parameter so the rule has no clock in it. */
  now: Date;
  /** Test seam. Production passes nothing. */
  fetchImpl?: FetchLike;
}

// ---------------------------------------------------------------------------
// The rule
// ---------------------------------------------------------------------------

/**
 * The links this client has actually agreed we may read.
 *
 * Exported because it is the rule that matters most in this file and it
 * deserves a test of its own: an unconsented link must never reach a fetch,
 * whatever else is true about it.
 */
export function consentedUrls(links: readonly PersonLink[]): string[] {
  return links
    .filter((link) => link.consented)
    .map((link) => link.url.trim())
    .filter(Boolean);
}

/**
 * A bio proposal from the client's own pages, or null when there is nothing
 * to propose.
 *
 * Never throws and never rejects: a source that times out, answers 404 or
 * returns something unreadable is the same fact from the client's side, which
 * is that there is nothing to show them. A brief page must not fail to render
 * because somebody's personal site is down.
 */
export async function readSourcedBio(
  input: ReadBioInput
): Promise<PersonSourcedBio | null> {
  const urls = consentedUrls(input.links);
  if (urls.length === 0) return null;

  const fetchedAt = input.now.toISOString();

  const github = await never(readGithubBio(urls, input.fetchImpl));
  if (github) return { ...github, fetchedAt, adoptedAt: null };

  const website = await never(
    readWebsiteBio(urls, input.fullName, input.fetchImpl)
  );
  if (website) return { ...website, fetchedAt, adoptedAt: null };

  return null;
}

/** A rejection becomes the absent answer rather than an exception. */
async function never<T>(promise: Promise<T | null>): Promise<T | null> {
  try {
    return await promise;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// GitHub
// ---------------------------------------------------------------------------

type BioCandidate = Pick<PersonSourcedBio, 'excerpt' | 'source' | 'sourceUrl'>;

/**
 * The `bio` field on a public GitHub profile.
 *
 * No credential, because the profile endpoint answers without one for a
 * public account, and holding a token that could read more of somebody's
 * account would be storing a liability we have no use for. The handle is
 * validated against GitHub's own rule by `githubHandleFrom` before it is ever
 * concatenated into a path.
 */
async function readGithubBio(
  urls: readonly string[],
  fetchImpl?: FetchLike
): Promise<BioCandidate | null> {
  const handle = githubHandleFrom(urls);
  if (!handle) return null;

  const api = `https://api.github.com/users/${encodeURIComponent(handle)}`;
  const outcome = await fetchPublicResource({
    url: api,
    headers: JSON_HEADERS,
    maxBytes: BIO_FETCH_MAX_BYTES,
    timeoutMs: BIO_FETCH_TIMEOUT_MS,
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  if (outcome.status !== 'ok' || outcome.httpStatus !== 200) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(outcome.bytes.toString('utf8'));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const bio = (parsed as Record<string, unknown>)['bio'];
  const excerpt = collapse(typeof bio === 'string' ? bio : '');
  // A one-word bio is a job title, and a job title is exactly the generic
  // material the person section exists to replace.
  if (excerpt.length < MIN_STORY_CHARS) return null;

  return {
    excerpt: excerpt.slice(0, MAX_BIO_EXCERPT_CHARS),
    source: 'github-bio',
    // The profile page, not the API endpoint. This URL is shown to the client
    // as "we read this", and an api.github.com path is not something they can
    // check by clicking it.
    sourceUrl: `https://github.com/${handle}`,
  };
}

// ---------------------------------------------------------------------------
// Their own site
// ---------------------------------------------------------------------------

/**
 * Where an about page lives on somebody's own site, in the two languages this
 * product sells in. Tried in order after the offered URL itself.
 */
const ABOUT_PATHS: readonly string[] = [
  '/about',
  '/about-me',
  '/despre',
  '/despre-mine',
];

/**
 * Prose off the client's own about page, but only when the page names them.
 *
 * The name test is the whole of the honesty here, and it is the same one the
 * portrait reader applies before it believes an image is a person: an about
 * page that never mentions the client is an agency's about page, a template's
 * demo text, or the wrong site, and quoting any of those to a client as "your
 * bio" would be worse than showing them nothing.
 */
async function readWebsiteBio(
  urls: readonly string[],
  fullName: string,
  fetchImpl?: FetchLike
): Promise<BioCandidate | null> {
  const site = websiteUrlFrom(urls);
  if (!site) return null;

  const candidates = [site, ...ABOUT_PATHS.map((path) => absolute(site, path))];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const outcome = await fetchPublicResource({
      url: candidate,
      headers: PAGE_HEADERS,
      maxBytes: BIO_FETCH_MAX_BYTES,
      timeoutMs: BIO_FETCH_TIMEOUT_MS,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    if (outcome.status !== 'ok' || outcome.httpStatus !== 200) continue;

    const excerpt = personParagraphs(outcome.bytes.toString('utf8'), fullName);
    if (!excerpt) continue;
    return {
      excerpt,
      source: 'website-about',
      sourceUrl: outcome.url,
    };
  }
  return null;
}

/**
 * The first few paragraphs of a page that names this person, joined.
 *
 * Pure and exported: the extraction is the part worth testing, and testing it
 * against a fixture string is better than testing it against a live site that
 * changes.
 */
export function personParagraphs(html: string, fullName: string): string {
  const name = collapse(fullName).toLowerCase();
  if (!name) return '';

  // Scanned, not matched. This reads a page at a URL a visitor typed, so a
  // lazy `<script[\s\S]*?</script>` would be quadratic in the number of
  // `<script` openings the page happens to contain, and would miss
  // `</script >` entirely -- letting a script body be quoted back to a client
  // as their own bio. `tagBlocks` closes a tag the way the spec does.
  const body = stripTagBlocks(html, ['script', 'style']);

  // The page has to name them somewhere, in full or by first name, before any
  // of its prose is treated as being about them.
  const flat = collapse(readableText(body)).toLowerCase();
  const firstName = name.split(' ')[0] ?? '';
  const named =
    flat.includes(name) || (firstName.length > 2 && flat.includes(firstName));
  if (!named) return '';

  const paragraphs: string[] = [];
  for (const block of tagBlocks(body, 'p')) {
    const text = collapse(decodeHtmlEntities(stripTags(block.inner)));
    if (text.length < MIN_ABOUT_PARAGRAPH_CHARS) continue;
    paragraphs.push(text);
    if (paragraphs.length >= MAX_ABOUT_PARAGRAPHS) break;
  }

  const joined = paragraphs.join('\n\n').slice(0, MAX_BIO_EXCERPT_CHARS);
  return joined.replace(/\s+/g, ' ').trim().length >= MIN_STORY_CHARS
    ? joined
    : '';
}

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

function collapse(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}

function absolute(base: string, path: string): string | null {
  try {
    return new URL(path, base).toString();
  } catch {
    return null;
  }
}
