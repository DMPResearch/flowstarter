import { describe, expect, it, vi } from 'vitest';

import {
  MAX_REDIRECTS,
  fetchProfileReading,
  readProfileSignals,
} from '../profile-fetch';
import { MAX_PROFILE_BYTES, type ProfileLink } from '../profile-signals';

const INSTAGRAM: ProfileLink = {
  network: 'instagram',
  url: 'https://instagram.com/darius.flowstarter',
  handle: 'darius.flowstarter',
};
const LINKEDIN: ProfileLink = {
  network: 'linkedin',
  url: 'https://linkedin.com/in/darius',
  handle: 'darius',
};
const SITE: ProfileLink = {
  network: 'website',
  url: 'https://flowstarter.net/',
  handle: null,
};

/**
 * A Response whose body streams the given text, so the size cap is exercised.
 *
 * Duck typed rather than a real `Response`: the constructor refuses a status
 * outside 200 to 599, and LinkedIn's 999 is one of the cases that most needs
 * covering. The fetch adapter only ever reads `status`, `headers` and `body`.
 */
function responding(
  status: number,
  body: string,
  headers: Record<string, string> = {}
): Response {
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(body));
      controller.close();
    },
  });
  return {
    status,
    headers: new Headers(headers),
    body: stream,
    text: async () => body,
  } as unknown as Response;
}

const OG_PAGE = `<html><head>
  <meta property="og:title" content="Ereno" />
  <meta property="og:description" content="A calm inbox." />
  <meta property="og:image" content="https://cdn.example.com/a.png" />
</head></html>`;

describe('fetchProfileReading', () => {
  it('reads a page that exposes its OpenGraph tags', async () => {
    const fetchImpl = vi.fn(async () => responding(200, OG_PAGE));
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(reading).toMatchObject({
      status: 'exposed',
      network: 'website',
      title: 'Ereno',
      imageUrl: 'https://cdn.example.com/a.png',
    });
  });

  it('identifies itself rather than pretending to be a browser', async () => {
    const seen: Array<{ headers: Record<string, string>; redirect: string }> =
      [];
    const fetchImpl = vi.fn(
      async (
        _url: string,
        init: { headers: Record<string, string>; redirect: 'manual' }
      ) => {
        seen.push(init);
        return responding(200, OG_PAGE);
      }
    );
    await fetchProfileReading(SITE, { fetchImpl: fetchImpl as never });
    expect(seen[0]?.headers['user-agent']).toContain('Flowstarter');
    expect(seen[0]?.redirect).toBe('manual');
  });

  it("reads Instagram's login wall as login_required, not as a success", async () => {
    // Verbatim shape of what the real page returns to an anonymous reader.
    const fetchImpl = vi.fn(async () =>
      responding(
        200,
        '<!DOCTYPE html><html><head><title>Instagram</title></head><body><div id="react-root"></div></body></html>'
      )
    );
    const reading = await fetchProfileReading(INSTAGRAM, { fetchImpl });
    expect(reading).toEqual({
      status: 'unavailable',
      network: 'instagram',
      url: INSTAGRAM.url,
      reason: 'login_required',
    });
  });

  it("reads LinkedIn's refusal as blocked", async () => {
    const fetchImpl = vi.fn(async () => responding(999, ''));
    const reading = await fetchProfileReading(LINKEDIN, { fetchImpl });
    expect(reading).toMatchObject({ status: 'unavailable', reason: 'blocked' });
  });

  it('reports a timeout as a timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init: { signal: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init.signal.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        })
    );
    const reading = await fetchProfileReading(SITE, {
      fetchImpl: fetchImpl as never,
      timeoutMs: 5,
    });
    expect(reading).toMatchObject({ status: 'unavailable', reason: 'timeout' });
  });

  it('reports a refused connection as a network error, not a timeout', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const reading = await fetchProfileReading(SITE, {
      fetchImpl: fetchImpl as never,
    });
    expect(reading).toMatchObject({
      status: 'unavailable',
      reason: 'network_error',
    });
  });

  it('abandons a body that runs past the cap', async () => {
    const huge = 'x'.repeat(MAX_PROFILE_BYTES + 10);
    const fetchImpl = vi.fn(async () => responding(200, huge));
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(reading).toMatchObject({
      status: 'unavailable',
      reason: 'too_large',
    });
  });

  it('follows a redirect by hand and reads the destination', async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        responding(301, '', { location: 'https://www.flowstarter.net/' })
      )
      .mockResolvedValueOnce(responding(200, OG_PAGE));
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(reading).toMatchObject({ status: 'exposed', title: 'Ereno' });
  });

  it('refuses a redirect that points inside our own network', async () => {
    // The whole reason redirects are followed by hand: a public first hop must
    // not be able to launder a request to the metadata service.
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        responding(302, '', { location: 'https://169.254.169.254/latest/' })
      );
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(reading).toMatchObject({ status: 'unavailable', reason: 'blocked' });
  });

  it('gives up after a bounded number of hops', async () => {
    const fetchImpl = vi.fn(async () =>
      responding(302, '', { location: 'https://flowstarter.net/again' })
    );
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(fetchImpl).toHaveBeenCalledTimes(MAX_REDIRECTS + 1);
    expect(reading).toMatchObject({ status: 'unavailable', reason: 'blocked' });
  });

  it('treats a redirect with no destination as a refusal', async () => {
    const fetchImpl = vi.fn(async () => responding(302, ''));
    const reading = await fetchProfileReading(SITE, { fetchImpl });
    expect(reading).toMatchObject({ status: 'unavailable', reason: 'blocked' });
  });
});

describe('readProfileSignals', () => {
  it('reads every link and folds the results, whatever each one did', async () => {
    const fetchImpl = vi.fn(async (url: string) => {
      if (url.includes('instagram')) {
        return responding(
          200,
          '<html><head><title>Instagram</title></head></html>'
        );
      }
      if (url.includes('linkedin')) return responding(999, '');
      return responding(200, OG_PAGE);
    });
    const signals = await readProfileSignals([INSTAGRAM, LINKEDIN, SITE], {
      fetchImpl,
    });
    expect(signals.anyExposed).toBe(true);
    expect(signals.bioText).toBe('A calm inbox.');
    expect(signals.imageUrls).toEqual(['https://cdn.example.com/a.png']);
    expect(signals.unavailable).toEqual([
      { network: 'instagram', reason: 'login_required' },
      { network: 'linkedin', reason: 'blocked' },
    ]);
  });

  it('says plainly that nothing was readable when nothing was', async () => {
    const fetchImpl = vi.fn(async () => responding(403, ''));
    const signals = await readProfileSignals([INSTAGRAM, LINKEDIN], {
      fetchImpl,
    });
    expect(signals.anyExposed).toBe(false);
    expect(signals.bioText).toBe('');
    expect(signals.unavailable).toHaveLength(2);
  });

  it('reads nothing when there is nothing to read', async () => {
    const fetchImpl = vi.fn();
    const signals = await readProfileSignals([], {
      fetchImpl: fetchImpl as never,
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(signals.readings).toEqual([]);
  });
});
