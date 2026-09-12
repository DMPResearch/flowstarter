/**
 * The three automatic portrait sources as requests, with an injected fetch.
 *
 * The rules are tested next door in `portrait-auto.test.ts`. What is being
 * pinned here is the adapter's one promise, which is that it never throws and
 * never guesses. Two halves of that:
 *
 * A SOURCE THAT DID NOT ANSWER IS AN ABSENT PICTURE. Every failure shape gets
 * its own case, and each one has to leave the other two sources intact, because
 * this runs inside the brand-signals fetch while somebody waits on a preview
 * and one dead network is not a reason to hand them a grey circle where their
 * GitHub avatar would have been.
 *
 * A PICTURE WE COULD NOT MEASURE COMES BACK WITH `width: null`. That is the
 * whole reason the download happens at all: `portrait-source.ts` refuses an
 * unmeasured picture with `size_unknown`, and a picture whose size we assumed
 * from a `?size=` parameter is a picture we are about to upscale into a hero
 * slot on a site somebody paid for. The WebP case proves it, because
 * `probeImageSize` genuinely cannot read one.
 *
 * And one case that is a promise about conduct rather than about code: the
 * Instagram request carries `facebookexternalhit/1.1`, which is the user agent
 * that endpoint documents and the only one it answers with an og:image, while
 * the same request says who we actually are in its Accept and Referer. If that
 * pairing is ever broken apart, this test is where it should fail.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  downloadPortraitPicture,
  readAutomaticPortraitSources,
} from '../portrait-auto-fetch';

/**
 * A throw in the pure rules, on demand. Nothing under `fetchPublicResource`
 * can reject, so the only way to exercise the adapter's outermost guard is to
 * break a rule it calls, which is also the realistic version of the failure:
 * somebody edits `portrait-auto.ts` and a visitor loses their preview.
 */
const hoisted = vi.hoisted(() => ({ githubRuleThrows: false }));

vi.mock('../portrait-auto', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../portrait-auto')>();
  return {
    ...actual,
    githubHandleFrom: (urls: readonly string[]) => {
      if (hoisted.githubRuleThrows) throw new Error('the rule blew up');
      return actual.githubHandleFrom(urls);
    },
  };
});

afterEach(() => {
  hoisted.githubRuleThrows = false;
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const GITHUB_AVATAR = 'https://github.com/darius.png?size=460';
const SITE = 'https://flowstarter.net/';
const SITE_PHOTO = 'https://cdn.flowstarter.net/darius.png';
const INSTAGRAM_PAGE = 'https://www.instagram.com/darius.flowstarter/';
const INSTAGRAM_PHOTO = 'https://scontent.cdninstagram.com/v/t51/ig.png';

const LINKS = [
  'https://www.instagram.com/darius.flowstarter',
  'https://www.linkedin.com/in/darius',
  'https://flowstarter.net/',
  'https://github.com/darius',
];

/** A PNG only as far as its header, which is as far as anything here reads. */
function png(width: number, height: number): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.write('IHDR', 12, 'ascii');
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

/** A WebP header, which `probeImageSize` deliberately cannot read a size out of. */
function webp(): Buffer {
  const bytes = Buffer.alloc(64);
  bytes.write('RIFF', 0, 'ascii');
  bytes.write('WEBPVP8 ', 8, 'ascii');
  return bytes;
}

const SITE_HTML = `<html><head>
  <meta property="og:image" content="https://cdn.flowstarter.net/card.png" />
</head><body>
  <img src="${SITE_PHOTO}" alt="Darius Popescu, founder" />
</body></html>`;

const INSTAGRAM_HTML = `<html><head>
  <meta property="og:image" content="${INSTAGRAM_PHOTO}" />
</head></html>`;

type Init = {
  headers: Record<string, string>;
  redirect: 'manual';
  signal: AbortSignal;
};

function responding(status: number, body: Buffer | string): Response {
  const bytes = typeof body === 'string' ? Buffer.from(body, 'utf-8') : body;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(bytes));
      controller.close();
    },
  });
  return {
    status,
    headers: new Headers(),
    body: stream,
    text: async () => bytes.toString('utf-8'),
  } as unknown as Response;
}

/** Every URL that answers, and what it answers with. Anything else 404s. */
function router(routes: Record<string, () => Response | Promise<Response>>) {
  const seen: Array<{ url: string; headers: Record<string, string> }> = [];
  const fetchImpl = vi.fn(async (url: string, init: Init) => {
    seen.push({ url, headers: init.headers });
    const route = routes[url];
    if (!route) return responding(404, 'not found');
    return await route();
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, seen };
}

const ALL_THREE: Record<string, () => Response> = {
  [GITHUB_AVATAR]: () => responding(200, png(460, 460)),
  [SITE]: () => responding(200, SITE_HTML),
  [SITE_PHOTO]: () => responding(200, png(800, 800)),
  [INSTAGRAM_PAGE]: () => responding(200, INSTAGRAM_HTML),
  [INSTAGRAM_PHOTO]: () => responding(200, png(100, 100)),
};

// ---------------------------------------------------------------------------

describe('readAutomaticPortraitSources', () => {
  it('reads and measures all three sources', async () => {
    const { fetchImpl } = router(ALL_THREE);
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });

    expect(observations.github).toEqual({
      handle: 'darius',
      picture: { url: GITHUB_AVATAR, width: 460, height: 460 },
    });
    expect(observations.website).toEqual({
      picture: { url: SITE_PHOTO, width: 800, height: 800 },
      saysPerson: true,
    });
    expect(observations.instagramPublic).toEqual({
      picture: { url: INSTAGRAM_PHOTO, width: 100, height: 100 },
    });
  });

  it('measures the bytes rather than believing the size it asked for', async () => {
    // GitHub was asked for 460 and answered with 128. The measurement wins,
    // which is the only thing standing between a small avatar and a hero slot.
    const { fetchImpl } = router({
      ...ALL_THREE,
      [GITHUB_AVATAR]: () => responding(200, png(128, 128)),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.github?.picture).toEqual({
      url: GITHUB_AVATAR,
      width: 128,
      height: 128,
    });
  });

  it('carries the crawler user agent to Instagram, and says who we are alongside it', async () => {
    const { fetchImpl, seen } = router(ALL_THREE);
    await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });

    const request = seen.find((entry) => entry.url === INSTAGRAM_PAGE);
    expect(request?.headers['user-agent']).toBe('facebookexternalhit/1.1');
    expect(request?.headers.referer).toContain('flowstarter.net');
    expect(request?.headers.accept).toContain('text/html');

    // And nowhere else. The client's own site is read as ourselves.
    const site = seen.find((entry) => entry.url === SITE);
    expect(site?.headers['user-agent']).toContain('FlowstarterBrandReader');
  });

  it('never calls the endpoints that need a session', async () => {
    const { fetchImpl, seen } = router(ALL_THREE);
    await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(seen.map((entry) => entry.url)).not.toContain(
      'https://www.instagram.com/api/v1/users/web_profile_info'
    );
    // LinkedIn is a consent flow or it is nothing. No automatic request.
    expect(
      seen.filter((entry) => entry.url.includes('linkedin.com'))
    ).toHaveLength(0);
  });

  it('says no handle when no link names a GitHub profile', async () => {
    const { fetchImpl } = router(ALL_THREE);
    const observations = await readAutomaticPortraitSources({
      urls: ['https://flowstarter.net/'],
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.github).toEqual({ handle: null, picture: null });
  });

  it('leaves the website and the Instagram page absent when no link named one', async () => {
    const { fetchImpl } = router(ALL_THREE);
    const observations = await readAutomaticPortraitSources({
      urls: ['https://github.com/darius'],
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    // Undefined rather than an empty reading: the rule tells "you did not give
    // us this one" apart from "it had nothing on it".
    expect(observations.website).toBeUndefined();
    expect(observations.instagramPublic).toBeUndefined();
  });

  it('loses only GitHub when only GitHub fails', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [GITHUB_AVATAR]: () => responding(404, 'no such user'),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.github?.picture).toEqual({
      url: GITHUB_AVATAR,
      width: null,
      height: null,
    });
    expect(observations.website?.picture?.width).toBe(800);
    expect(observations.instagramPublic?.picture?.width).toBe(100);
  });

  it('loses only the website when the site will not answer', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [SITE]: () => responding(500, 'down'),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.website).toEqual({ picture: null, saysPerson: false });
    expect(observations.github?.picture?.width).toBe(460);
    expect(observations.instagramPublic?.picture?.width).toBe(100);
  });

  it('loses only the website when the page has no picture worth taking', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [SITE]: () => responding(200, '<html><body>nothing here</body></html>'),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.website).toEqual({ picture: null, saysPerson: false });
  });

  it('carries saysPerson false off an og:image, so the rule can refuse it', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [SITE]: () =>
        responding(
          200,
          `<head><meta property="og:image" content="https://cdn.flowstarter.net/card.png" /></head>`
        ),
      'https://cdn.flowstarter.net/card.png': () =>
        responding(200, png(1200, 630)),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.website).toEqual({
      picture: {
        url: 'https://cdn.flowstarter.net/card.png',
        width: 1200,
        height: 630,
      },
      saysPerson: false,
    });
  });

  it('loses only Instagram when the page comes back without an og:image', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      // This is what a non-crawler user agent gets, measured 2026-09-13: an
      // application shell with no `og:` tags in it at all.
      [INSTAGRAM_PAGE]: () =>
        responding(200, '<html><head><title>Instagram</title></head></html>'),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.instagramPublic).toEqual({ picture: null });
    expect(observations.github?.picture?.width).toBe(460);
    expect(observations.website?.picture?.width).toBe(800);
  });

  it('refuses an og:image that would point the next request somewhere private', async () => {
    const { fetchImpl, seen } = router({
      ...ALL_THREE,
      [INSTAGRAM_PAGE]: () =>
        responding(
          200,
          `<head><meta property="og:image" content="http://169.254.169.254/latest.png" /></head>`
        ),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.instagramPublic).toEqual({ picture: null });
    expect(seen.map((entry) => entry.url)).not.toContain(
      'http://169.254.169.254/latest.png'
    );
  });

  it('shrugs off an og:image that is not a URL, and one with no content on it', async () => {
    for (const tag of [
      `<meta property="og:image" content="https://[" />`,
      `<meta property="og:image" content="" />`,
      `<meta property="og:image" />`,
    ]) {
      const { fetchImpl } = router({
        ...ALL_THREE,
        [INSTAGRAM_PAGE]: () => responding(200, `<head>${tag}</head>`),
      });
      const observations = await readAutomaticPortraitSources({
        urls: LINKS,
        fullName: 'Darius Popescu',
        fetchImpl,
      });
      expect(observations.instagramPublic).toEqual({ picture: null });
    }
  });

  it('resolves a relative og:image against the profile page it came off', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [INSTAGRAM_PAGE]: () =>
        responding(
          200,
          `<head><meta property='og:image' content='/pic.png?a=1&amp;b=2' /></head>`
        ),
      'https://www.instagram.com/pic.png?a=1&b=2': () =>
        responding(200, png(100, 100)),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.instagramPublic?.picture).toEqual({
      url: 'https://www.instagram.com/pic.png?a=1&b=2',
      width: 100,
      height: 100,
    });
  });

  it('comes back with no measurement for a picture it cannot measure', async () => {
    const { fetchImpl } = router({
      ...ALL_THREE,
      [GITHUB_AVATAR]: () => responding(200, webp()),
    });
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    // The rule turns this into `size_unknown` and places nothing.
    expect(observations.github?.picture).toEqual({
      url: GITHUB_AVATAR,
      width: null,
      height: null,
    });
  });

  it('gives up on a source that runs past its budget', async () => {
    const hang = (signal: AbortSignal) =>
      new Promise<Response>((_, reject) => {
        signal.addEventListener('abort', () =>
          reject(new Error('aborted by the budget'))
        );
      });
    const seen: string[] = [];
    const fetchImpl = vi.fn(async (url: string, init: Init) => {
      seen.push(url);
      if (url === GITHUB_AVATAR) return await hang(init.signal);
      const route = ALL_THREE[url];
      return route ? route() : responding(404, 'not found');
    }) as unknown as typeof fetch;

    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
      env: { FLOWSTARTER_PORTRAIT_AUTO_TIMEOUT_MS: '5' },
    });

    expect(observations.github?.picture).toEqual({
      url: GITHUB_AVATAR,
      width: null,
      height: null,
    });
    // The other two still answered. A slow network costs one source.
    expect(observations.website?.picture?.width).toBe(800);
    expect(observations.instagramPublic?.picture?.width).toBe(100);
  });

  it('turns a rule that throws into an absent source rather than an exception', async () => {
    hoisted.githubRuleThrows = true;
    const { fetchImpl } = router(ALL_THREE);
    const observations = await readAutomaticPortraitSources({
      urls: LINKS,
      fullName: 'Darius Popescu',
      fetchImpl,
    });
    expect(observations.github).toEqual({ handle: null, picture: null });
    expect(observations.website?.picture?.width).toBe(800);
  });

  it('reads its budgets out of the environment it is handed', async () => {
    const { fetchImpl, seen } = router({
      ...ALL_THREE,
      'https://github.com/darius.png?size=96': () =>
        responding(200, png(96, 96)),
    });
    const observations = await readAutomaticPortraitSources({
      urls: ['https://github.com/darius'],
      fullName: 'Darius Popescu',
      fetchImpl,
      env: { FLOWSTARTER_PORTRAIT_GITHUB_EDGE: '96' },
    });
    expect(seen[0]?.url).toBe('https://github.com/darius.png?size=96');
    expect(observations.github?.picture?.width).toBe(96);
  });
});

// ---------------------------------------------------------------------------

describe('downloadPortraitPicture', () => {
  it('verifies, hashes and measures the bytes it files', async () => {
    const { fetchImpl } = router({
      [GITHUB_AVATAR]: () => responding(200, png(460, 460)),
    });
    const download = await downloadPortraitPicture({
      url: GITHUB_AVATAR,
      fetchImpl,
    });
    expect(download).toMatchObject({
      extension: 'png',
      mime: 'image/png',
      width: 460,
      height: 460,
    });
    expect(download?.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(download?.bytes.byteLength).toBe(64);
  });

  it('takes a picture at the avatar floor, which the uploader would refuse', async () => {
    // Instagram's hundred pixel picture is under `site-media`'s own 200px
    // floor. The portrait rule already admitted it as an avatar, so the floor
    // that applies here is the rule's, not the uploader's.
    const { fetchImpl } = router({
      [INSTAGRAM_PHOTO]: () => responding(200, png(100, 100)),
    });
    const download = await downloadPortraitPicture({
      url: INSTAGRAM_PHOTO,
      fetchImpl,
    });
    expect(download?.width).toBe(100);
  });

  it('refuses a URL it is not willing to request, without requesting it', async () => {
    const { fetchImpl, seen } = router({});
    expect(
      await downloadPortraitPicture({
        url: 'http://169.254.169.254/latest.png',
        fetchImpl,
      })
    ).toBeNull();
    expect(seen).toHaveLength(0);
  });

  it('refuses bytes that are not an image', async () => {
    const { fetchImpl } = router({
      [GITHUB_AVATAR]: () => responding(200, 'not a picture at all'),
    });
    expect(
      await downloadPortraitPicture({ url: GITHUB_AVATAR, fetchImpl })
    ).toBeNull();
  });

  it('refuses a picture below the avatar floor', async () => {
    const { fetchImpl } = router({
      [GITHUB_AVATAR]: () => responding(200, png(32, 32)),
    });
    expect(
      await downloadPortraitPicture({ url: GITHUB_AVATAR, fetchImpl })
    ).toBeNull();
  });

  it('files nothing when the provider will not answer', async () => {
    const { fetchImpl } = router({
      [GITHUB_AVATAR]: () => responding(503, 'later'),
    });
    expect(
      await downloadPortraitPicture({ url: GITHUB_AVATAR, fetchImpl })
    ).toBeNull();
  });

  it('keeps an unmeasurable but valid image, with no dimensions on it', async () => {
    const { fetchImpl } = router({
      [GITHUB_AVATAR]: () => responding(200, webp()),
    });
    const download = await downloadPortraitPicture({
      url: GITHUB_AVATAR,
      fetchImpl,
      env: {},
    });
    expect(download).toMatchObject({
      extension: 'webp',
      mime: 'image/webp',
      width: null,
      height: null,
    });
  });
});
