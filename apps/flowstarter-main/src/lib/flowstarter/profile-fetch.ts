import 'server-only';

/**
 * The one place that performs a profile request, and the only thing in the
 * brand pipeline that touches the network.
 *
 * It decides nothing. Every judgement about what came back lives in
 * `profile-signals.ts`, which is pure; this module performs the GET, enforces
 * the budget, and hands the status and the body over to be read. That split is
 * what lets the exposed, blocked and timeout cases be tested without a network
 * and without a fixture server.
 *
 * The budget is deliberately small. A visitor is sitting in front of the
 * wizard waiting for a preview, and a social network that is slow to answer an
 * anonymous request is a network that is about to refuse it anyway. Four
 * seconds and 1.5 MB, once, no retry: if it does not land in that, the palette
 * comes from the tone chips and the visitor is told which network went quiet.
 *
 * Safety, because this turns a visitor-supplied string into an outbound
 * request from our server:
 *
 *   - the host is checked against the allow list in `profile-signals.ts`
 *     before the request and again after every redirect,
 *   - https only, no credentials in the authority, no private or loopback
 *     address at any hop,
 *   - redirects are followed by hand, at most three, so a redirect to
 *     169.254.169.254 cannot be laundered through a public first hop,
 *   - the body is read in chunks and abandoned the moment it passes the cap,
 *     so a hostile endpoint cannot stream us out of memory.
 */
import {
  MAX_PROFILE_BYTES,
  PROFILE_FETCH_TIMEOUT_MS,
  type ProfileLink,
  type ProfileReading,
  isPublicHttpUrl,
  readProfileHtml,
  summariseProfileSignals,
  type ProfileSignals,
} from './profile-signals';

/** At most this many hops before we call it a redirect loop. */
export const MAX_REDIRECTS = 3;

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

export type FetchLike = (
  input: string,
  init: {
    headers: Record<string, string>;
    redirect: 'manual';
    signal: AbortSignal;
  }
) => Promise<Response>;

/** Reads at most `MAX_PROFILE_BYTES`, then stops pulling from the stream. */
async function readCapped(response: Response): Promise<string | 'too_large'> {
  const body = response.body;
  if (!body) return await response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > MAX_PROFILE_BYTES) return 'too_large';
      chunks.push(value);
    }
  } finally {
    await reader.cancel().catch(() => undefined);
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(
    Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)))
  );
}

/**
 * Fetches one profile and reads it. Never throws: a reading is the return
 * value in every case, including the ones where nothing came back.
 */
export async function fetchProfileReading(
  link: ProfileLink,
  options: { fetchImpl?: FetchLike; timeoutMs?: number } = {}
): Promise<ProfileReading> {
  const fetchImpl = (options.fetchImpl ?? fetch) as FetchLike;
  const timeoutMs = options.timeoutMs ?? PROFILE_FETCH_TIMEOUT_MS;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    let url = link.url;
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
      if (!isPublicHttpUrl(url)) {
        return {
          status: 'unavailable',
          network: link.network,
          url: link.url,
          reason: 'blocked',
        };
      }
      const response = await fetchImpl(url, {
        headers: REQUEST_HEADERS,
        redirect: 'manual',
        signal: controller.signal,
      });

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get('location');
        if (!location) break;
        try {
          url = new URL(location, url).toString();
        } catch {
          break;
        }
        continue;
      }

      const html = await readCapped(response);
      if (html === 'too_large') {
        return {
          status: 'unavailable',
          network: link.network,
          url: link.url,
          reason: 'too_large',
        };
      }
      return readProfileHtml({
        network: link.network,
        url: link.url,
        status: response.status,
        html,
      });
    }
    // Out of hops, or a redirect with nowhere to go.
    return {
      status: 'unavailable',
      network: link.network,
      url: link.url,
      reason: 'blocked',
    };
  } catch (error) {
    const aborted =
      controller.signal.aborted ||
      (error instanceof Error && error.name === 'AbortError');
    return {
      status: 'unavailable',
      network: link.network,
      url: link.url,
      reason: aborted ? 'timeout' : 'network_error',
    };
  } finally {
    clearTimeout(timer);
  }
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
