import 'server-only';

/**
 * The one place that performs a profile request.
 *
 * It decides nothing and it no longer transports anything either. Every
 * judgement about what came back lives in `profile-signals.ts`, which is pure;
 * every rule about where a request may go lives in `lib/net/safe-fetch.ts`,
 * which is shared with the picture and image paths and with the portrait
 * pipeline. What is left here is the translation between the two: a link in,
 * a `ProfileReading` out, with the adapter's four failure reasons mapped onto
 * the vocabulary the wizard already prints to the visitor.
 *
 * THE BUDGET is deliberately small. A visitor is sitting in front of the
 * wizard waiting for a preview, and a social network that is slow to answer an
 * anonymous request is a network that is about to refuse it anyway. Four
 * seconds and 1.5 MB, once, no retry: if it does not land in that, the palette
 * comes from the tone chips and the visitor is told which network went quiet.
 *
 * SAFETY, because this turns a visitor-supplied string into an outbound
 * request from our server, is now one import rather than three copies of a
 * hostname regex. `fetchPublicResource` is https only, port 443 only, refuses
 * credentials in the authority, resolves the name and checks EVERY address it
 * answers with, pins the connection to the address it checked so a rebinding
 * cannot swap it, follows redirects by hand and re-validates each hop in full,
 * holds one deadline across headers and body, and abandons the body the moment
 * it passes the cap. That is Codex F02 and the size half of F07, in the module
 * whose job it is.
 */
import {
  fetchPublicResource,
  type FetchLike,
  type PublicFetchFailure,
} from '@/lib/net/safe-fetch';

import {
  MAX_PROFILE_BYTES,
  PROFILE_FETCH_TIMEOUT_MS,
  type ProfileLink,
  type ProfileReading,
  type ProfileUnavailableReason,
  readProfileHtml,
  summariseProfileSignals,
  type ProfileSignals,
} from './profile-signals';

/**
 * Re-exported so the modules that grew up importing the request from here keep
 * working, and so a caller who needs raw bytes under the same discipline has
 * one obvious place to get them. The implementation is
 * `lib/net/safe-fetch.ts`; there is no second copy.
 */
export {
  fetchPublicResource,
  isFetchableUrl,
  type FetchLike,
  type PublicFetchFailure,
  type PublicFetchOutcome,
} from '@/lib/net/safe-fetch';

export { DEFAULT_MAX_REDIRECTS as MAX_REDIRECTS } from '@/lib/net/net-config';

/**
 * A browser-ish Accept header. Not a disguise: we send our own user agent and
 * identify the product, because a network that does not want us reading a page
 * is entitled to say so and we would rather be told than sneak past.
 */
const REQUEST_HEADERS: Record<string, string> = {
  accept: 'text/html,application/xhtml+xml',
  'accept-language': 'en',
  'user-agent': 'FlowstarterBrandReader/1.0 (+https://flowstarter.net)',
};

/**
 * The adapter's four reasons, in the wizard's own words. A straight mapping
 * rather than a clever one: each of these ends as a sentence a visitor reads
 * about one of their own links, so the two vocabularies are kept the same
 * length on purpose.
 */
function reasonFor(failure: PublicFetchFailure): ProfileUnavailableReason {
  if (failure === 'timeout') return 'timeout';
  if (failure === 'too_large') return 'too_large';
  if (failure === 'network_error') return 'network_error';
  return 'blocked';
}

/**
 * Fetches one profile and reads it. Never throws: a reading is the return
 * value in every case, including the ones where nothing came back.
 */
export async function fetchProfileReading(
  link: ProfileLink,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ProfileReading> {
  const outcome = await fetchPublicResource({
    url: link.url,
    headers: REQUEST_HEADERS,
    maxBytes: MAX_PROFILE_BYTES,
    timeoutMs: options.timeoutMs ?? PROFILE_FETCH_TIMEOUT_MS,
    fetchImpl: options.fetchImpl,
  });

  if (outcome.status !== 'ok') {
    return {
      status: 'unavailable',
      network: link.network,
      url: link.url,
      reason: reasonFor(outcome.reason),
    };
  }

  return readProfileHtml({
    network: link.network,
    url: link.url,
    status: outcome.httpStatus,
    // `fatal: false` on purpose: a page that is half mis-encoded still has its
    // meta tags, and a replacement character in a bio is a better outcome for
    // the visitor than no reading at all.
    html: new TextDecoder('utf-8', { fatal: false }).decode(outcome.bytes),
  });
}

/**
 * Reads every link the visitor gave, in parallel, and folds the results.
 *
 * Parallel because the budget is per request and the visitor waits for the
 * slowest, not the sum. `Promise.all` is safe here precisely because
 * `fetchProfileReading` cannot reject.
 */
export async function readProfileSignals(
  links: readonly ProfileLink[],
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ProfileSignals> {
  const readings = await Promise.all(
    links.map((link) => fetchProfileReading(link, options))
  );
  return summariseProfileSignals(readings);
}
