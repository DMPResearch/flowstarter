import 'server-only';

/**
 * The three requests behind the three automatic portrait sources.
 *
 * `portrait-auto.ts` is the rule: which link names a GitHub handle, which
 * image on a page the page itself says is a person, what URL a handle turns
 * into. This module decides none of that. It performs the requests, under a
 * budget, measures the bytes that come back, and hands the result to
 * `portrait-source.ts` as observations. Same split as `profile-signals.ts` and
 * `profile-fetch.ts`, for the same reason: the judgement is the part worth
 * testing and the network is the part that makes testing it hard.
 *
 * IT NEVER THROWS. A source that did not answer is an absent picture, and
 * `portrait-source.ts` already has a reason for every shape of absence. This
 * runs inside the brand-signals fetch while somebody waits on a preview, and
 * there is no failure here worth costing them the preview for.
 *
 * MEASURING IS THE WHOLE POINT. The rule refuses a picture it has no
 * dimensions for, with reason `size_unknown`, because a placement it cannot
 * justify is a placement that ends as an upscaled headshot on a site the
 * client paid for. So every picture is downloaded and measured with
 * `probeImageSize` over the real bytes. A provider's own claim about the size
 * is not a measurement: `github.com/<handle>.png?size=460` is a request, and
 * the bytes are the answer. Anything we cannot measure comes back with
 * `width: null` and the rule refuses it, which is the correct outcome.
 *
 * THE INSTAGRAM USER AGENT, which is the one part of this that deserves an
 * argument rather than a description. Measured 2026-09-13: the logged out
 * profile page serves an `og:image` to `facebookexternalhit/1.1` and an
 * application shell with no `og:` tags to anything else. Sending that user
 * agent is not a disguise and not a bypass. It is the user agent the network
 * documents for this exact purpose, the picture behind it is the one the
 * network chose to publish to it, we identify the product in the Accept and
 * Referer headers of the same request so anyone reading their logs can see who
 * we are, and we take the published picture and nothing else. The endpoints
 * that require a session are not called at all: `web_profile_info` answers 401
 * and the unsigned CDN URL answers 403, and both of those are a door being
 * closed rather than a lock to pick.
 *
 * SERVER SIDE REQUEST FORGERY is the live risk, because every URL below is
 * built from a string a visitor typed into an intake box. Every one of them
 * goes out through `fetchPublicResource`, which is https only, re-checks the
 * host before the first request and after every redirect, refuses credentials
 * in the authority and private or loopback addresses at every hop, and caps
 * the body as it streams. Handles are validated against the network's own rule
 * in `portrait-auto.ts` before they are ever concatenated into a path.
 */
import { probeImageSize } from '@flowstarter/agentic-codegen/src/flowstarter/preview-assets';
import { assertSafeUploadedImage } from '@flowstarter/agentic-codegen/src/flowstarter/site-media';

import { createHash } from 'node:crypto';

import {
  portraitAutoBudgets,
  portraitBudgets,
  portraitSizeFloors,
  type EnvLike,
  type PortraitAutoBudgets,
} from './portrait-config';
import {
  INSTAGRAM_CRAWLER_USER_AGENT,
  githubAvatarUrl,
  githubHandleFrom,
  instagramHandleFrom,
  instagramProfileUrl,
  personImageFromHtml,
  websiteUrlFrom,
} from './portrait-auto';
import type { PortraitObservations, PortraitPicture } from './portrait-source';
import { fetchPublicResource, type FetchLike } from './profile-fetch';
import { isPublicHttpUrl } from './profile-signals';

/** What this product is, said out loud, on every request it makes. */
const PRODUCT_URL = 'https://flowstarter.net';

/**
 * The headers for a page we read as ourselves. The same identification
 * `profile-fetch.ts` sends: a network that does not want us reading a page is
 * entitled to say so, and we would rather be told than sneak past.
 */
const PAGE_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en',
  'user-agent': `FlowstarterBrandReader/1.0 (+${PRODUCT_URL})`,
};

/**
 * The headers for the Instagram page. The user agent is the crawler one, and
 * the Accept and Referer say who is actually asking. See the module header for
 * why that pairing is the honest way to make this request rather than a
 * loophole in it.
 */
const INSTAGRAM_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en',
  'user-agent': INSTAGRAM_CRAWLER_USER_AGENT,
  referer: `${PRODUCT_URL}/`,
  from: 'hello@flowstarter.net',
};

const IMAGE_HEADERS: Record<string, string> = {
  accept: 'image/*',
  'user-agent': `FlowstarterBrandReader/1.0 (+${PRODUCT_URL})`,
  referer: `${PRODUCT_URL}/`,
};

/**
 * Downloads a picture and measures it.
 *
 * Returns a picture in every case where we hold a URL at all, because the URL
 * itself is evidence the client's brief can print. `width: null` is the honest
 * answer for "we could not measure it", and the rule turns that into
 * `size_unknown` rather than into a placement.
 *
 * A URL we are not willing to request is returned without being requested, so
 * the rule can say `not_public_url` about it. That is a better answer than a
 * silent null: it tells the client we found something and why we left it.
 */
async function measurePicture(
  url: string,
  options: { fetchImpl?: typeof fetch; maxBytes: number; timeoutMs: number }
): Promise<PortraitPicture> {
  const unmeasured: PortraitPicture = { url, width: null, height: null };
  if (!isPublicHttpUrl(url)) return unmeasured;

  const outcome = await fetchPublicResource({
    url,
    headers: IMAGE_HEADERS,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl as FetchLike | undefined,
  });
  if (outcome.status !== 'ok') return unmeasured;
  if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) return unmeasured;

  const size = probeImageSize(outcome.bytes);
  if (!size || size.width <= 0 || size.height <= 0) return unmeasured;
  return { url, width: size.width, height: size.height };
}

/** The decoded body of a page, or null when it did not answer with one. */
async function readPage(
  url: string,
  headers: Record<string, string>,
  options: { fetchImpl?: typeof fetch; maxBytes: number; timeoutMs: number }
): Promise<string | null> {
  const outcome = await fetchPublicResource({
    url,
    headers,
    maxBytes: options.maxBytes,
    timeoutMs: options.timeoutMs,
    fetchImpl: options.fetchImpl as FetchLike | undefined,
  });
  if (outcome.status !== 'ok') return null;
  if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) return null;
  return new TextDecoder('utf-8', { fatal: false }).decode(outcome.bytes);
}

interface SourceOptions {
  fetchImpl?: typeof fetch;
  auto: PortraitAutoBudgets;
  maxImageBytes: number;
}

/**
 * GitHub. Only when a link actually named a handle: the rule in
 * `portrait-source.ts` says `no_github_handle` otherwise, and guessing a
 * handle from a name is how we would put a stranger's face on a client's site.
 */
async function readGithub(
  urls: readonly string[],
  options: SourceOptions
): Promise<PortraitObservations['github']> {
  const handle = githubHandleFrom(urls);
  if (!handle) return { handle: null, picture: null };
  const picture = await measurePicture(
    githubAvatarUrl(handle, options.auto.githubAvatarEdge),
    {
      fetchImpl: options.fetchImpl,
      maxBytes: options.maxImageBytes,
      timeoutMs: options.auto.timeoutMs,
    }
  );
  return { handle, picture };
}

/**
 * The client's own site. Two requests: the page, then the picture the page
 * pointed at. `saysPerson` travels with it, because the rule refuses an image
 * the page does not identify, and a logo in a portrait slot is worse than an
 * empty portrait slot.
 */
async function readWebsite(
  urls: readonly string[],
  fullName: string,
  options: SourceOptions
): Promise<PortraitObservations['website']> {
  const websiteUrl = websiteUrlFrom(urls);
  // Undefined rather than an empty reading: the rule distinguishes "you did
  // not give us a site" from "your site had nothing on it", and the client can
  // act on the first by giving us one.
  if (!websiteUrl) return undefined;

  const html = await readPage(websiteUrl, PAGE_HEADERS, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.auto.maxHtmlBytes,
    timeoutMs: options.auto.timeoutMs,
  });
  if (html === null) return { picture: null, saysPerson: false };

  const reading = personImageFromHtml({
    html,
    baseUrl: websiteUrl,
    fullName,
    caps: options.auto,
  });
  if (!reading) return { picture: null, saysPerson: false };

  const picture = await measurePicture(reading.url, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.maxImageBytes,
    timeoutMs: options.auto.timeoutMs,
  });
  return { picture, saysPerson: reading.saysPerson };
}

/** The only `og:` tag a logged out Instagram profile exposes, to a crawler. */
const OG_IMAGE_RE = /<meta\b[^>]*property\s*=\s*["']og:image["'][^>]*>/i;

function ogImageFrom(html: string, baseUrl: string): string | null {
  const tag = OG_IMAGE_RE.exec(html)?.[0];
  if (!tag) return null;
  const content =
    /content\s*=\s*"([^"]*)"/i.exec(tag)?.[1] ??
    /content\s*=\s*'([^']*)'/i.exec(tag)?.[1] ??
    null;
  if (!content) return null;
  const decoded = content.replace(/&amp;/g, '&').trim();
  if (!decoded) return null;
  let absolute: string;
  try {
    absolute = new URL(decoded, baseUrl).toString();
  } catch {
    return null;
  }
  return isPublicHttpUrl(absolute) ? absolute : null;
}

/**
 * Instagram's public picture. A hundred pixels of face, which is a favicon
 * with a person on it and is ranked last for exactly that reason. It is still
 * real evidence and it still clears the avatar floor, so it is still worth the
 * one request.
 */
async function readInstagramPublic(
  urls: readonly string[],
  options: SourceOptions
): Promise<PortraitObservations['instagramPublic']> {
  const handle = instagramHandleFrom(urls);
  if (!handle) return undefined;

  const profileUrl = instagramProfileUrl(handle);
  const html = await readPage(profileUrl, INSTAGRAM_HEADERS, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.auto.maxHtmlBytes,
    timeoutMs: options.auto.timeoutMs,
  });
  if (html === null) return { picture: null };

  const imageUrl = ogImageFrom(html, profileUrl);
  if (!imageUrl) return { picture: null };

  const picture = await measurePicture(imageUrl, {
    fetchImpl: options.fetchImpl,
    maxBytes: options.maxImageBytes,
    timeoutMs: options.auto.timeoutMs,
  });
  return { picture };
}

/**
 * The three automatic sources, read in parallel, each under its own budget.
 *
 * Parallel because the budget is per source and the visitor waits for the
 * slowest rather than the sum. `Promise.all` is safe here precisely because
 * each reader is wrapped so it cannot reject.
 */
export async function readAutomaticPortraitSources(input: {
  /** Every link the client gave: instagram, linkedin, website, and anything in the brief. */
  urls: readonly string[];
  fullName: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<
  Pick<PortraitObservations, 'github' | 'website' | 'instagramPublic'>
> {
  const env: EnvLike = input.env ?? process.env;
  const options: SourceOptions = {
    fetchImpl: input.fetchImpl,
    auto: portraitAutoBudgets(env),
    maxImageBytes: portraitBudgets(env).maxBytes,
  };

  const [github, website, instagramPublic] = await Promise.all([
    never(readGithub(input.urls, options), { handle: null, picture: null }),
    never(readWebsite(input.urls, input.fullName, options), undefined),
    never(readInstagramPublic(input.urls, options), undefined),
  ]);

  return { github, website, instagramPublic };
}

/**
 * The promise this module's contract is built on: a rejection becomes the
 * absent answer rather than an exception that reaches the route.
 *
 * `fetchPublicResource` already cannot reject, so this catches the things
 * beneath it: a `sharp`-less environment, a URL constructor given something
 * pathological, an out-of-memory decode. All of them are the same fact from
 * the client's side, which is that this source produced no picture.
 */
async function never<T>(promise: Promise<T>, fallback: T): Promise<T> {
  try {
    return await promise;
  } catch {
    return fallback;
  }
}

// ---------------------------------------------------------------------------
// Filing the one we chose
// ---------------------------------------------------------------------------

/** Bytes that have been verified as a real image, ready for `storeFunnelAsset`. */
export interface PortraitDownload {
  bytes: Buffer;
  extension: string;
  mime: string;
  sha256: string;
  width: number | null;
  height: number | null;
}

/**
 * The type for an extension the magic byte check recognised.
 *
 * Derived from the extension rather than read from the response, because a
 * `content-type` header is a claim by the server and the extension came from
 * the bytes themselves. `storeFunnelAsset` writes this onto the object, so it
 * is what a browser will later be told the file is.
 */
const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
};

/**
 * Downloads the chosen picture again, verified and measured, ready to file.
 *
 * Yes, again: the same bytes were already pulled once to measure them. Holding
 * three image buffers in memory through the whole judgement in order to save
 * one request on the one that wins is the wrong trade, because two of the
 * three are always discarded and the route is the most expensive anonymous
 * endpoint in the funnel already. One extra request against a URL that has
 * just answered is the cheap half of that bargain.
 *
 * The magic byte check is the same one the client uploader uses. A social
 * network's CDN is not a trusted source of image bytes; nothing that arrives
 * over the wire is, and a content-type header is a claim rather than a fact.
 *
 * Never throws. Null means the picture is not one we can file.
 */
export async function downloadPortraitPicture(input: {
  url: string;
  fetchImpl?: typeof fetch;
  env?: Record<string, string | undefined>;
}): Promise<PortraitDownload | null> {
  const env: EnvLike = input.env ?? process.env;
  const auto = portraitAutoBudgets(env);
  if (!isPublicHttpUrl(input.url)) return null;

  try {
    const outcome = await fetchPublicResource({
      url: input.url,
      headers: IMAGE_HEADERS,
      maxBytes: portraitBudgets(env).maxBytes,
      timeoutMs: auto.timeoutMs,
      fetchImpl: input.fetchImpl as FetchLike | undefined,
    });
    if (outcome.status !== 'ok') return null;
    if (outcome.httpStatus < 200 || outcome.httpStatus >= 300) return null;

    // The avatar floor rather than the uploader's own: the rule has already
    // said this picture is large enough to be worth placing somewhere, and
    // Instagram's hundred pixel picture is precisely the case it admits.
    const verified = assertSafeUploadedImage(outcome.bytes, {
      minEdge: portraitSizeFloors(env).avatarEdge,
    });
    const mime = MIME_BY_EXTENSION[verified.extension.toLowerCase()];
    if (!mime) return null;
    const size = probeImageSize(outcome.bytes);
    return {
      bytes: outcome.bytes,
      extension: verified.extension,
      mime,
      // Content addressed, the same way an upload is, so the same picture
      // arriving twice for one preview resolves to one row.
      sha256: createHash('sha256').update(outcome.bytes).digest('hex'),
      width: size?.width ?? null,
      height: size?.height ?? null,
    };
  } catch {
    // `assertSafeUploadedImage` throws on anything that is not a raster image
    // it recognises. A PDF somebody renamed is not a portrait, and it is not
    // worth a failed funnel either.
    return null;
  }
}
