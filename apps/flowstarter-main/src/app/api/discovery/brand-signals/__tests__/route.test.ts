/**
 * POST /api/discovery/brand-signals, the portrait half.
 *
 * The route's whole contract is that it cannot fail the funnel: a visitor is
 * sitting in front of the wizard waiting on a preview, and every step of this
 * endpoint is a nicety they did not ask for by name. The portrait block is the
 * newest and most expensive of those niceties, so the two cases below are the
 * two that matter.
 *
 * The first proves it is there: the full table of sources, in priority order,
 * with the reason each one is or is not usable, plus the one we chose. The
 * table is the product, not the winner, because four of the five rows are
 * normally a sentence the client can act on.
 *
 * The second proves it cannot hurt anybody. The automatic sources throw, and
 * the palette, the tone, the unavailable list and the profile picture all come
 * back exactly as they would have, with an empty portrait table beside them.
 * If that ever stops being true, this is the test that should go red rather
 * than a visitor getting a 500.
 *
 * Everything below the route is mocked, deliberately and at the module edge:
 * this file is about what the route does with the answers, and the answers
 * themselves are pinned next door in the `lib/flowstarter` suites.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { NextRequest } from 'next/server';

import { POST } from '../route';

vi.mock('server-only', () => ({}));

const readAutomaticPortraitSources = vi.fn();
const downloadPortraitPicture = vi.fn();
vi.mock('@/lib/flowstarter/portrait-auto-fetch', () => ({
  readAutomaticPortraitSources: (input: unknown) =>
    readAutomaticPortraitSources(input),
  downloadPortraitPicture: (input: unknown) => downloadPortraitPicture(input),
}));

const storeFunnelAsset = vi.fn();
const signFunnelAsset = vi.fn();
vi.mock('@/lib/flowstarter/funnel-assets', () => ({
  listFunnelAssets: async () => [],
  readFunnelAssetBytes: async () => null,
  signFunnelAsset: (path: string) => signFunnelAsset(path),
  storeFunnelAsset: (input: unknown) => storeFunnelAsset(input),
}));

vi.mock('@/lib/flowstarter/profile-fetch', () => ({
  readProfileSignals: async () => ({
    readings: [],
    anyExposed: true,
    bioText: 'A calm inbox.',
    imageUrls: [],
    unavailable: [{ network: 'linkedin', reason: 'blocked' }],
  }),
}));

vi.mock('@/lib/flowstarter/profile-picture', () => ({
  captureProfilePicture: async () => ({
    status: 'skipped' as const,
    reason: 'no_image' as const,
  }),
}));

vi.mock('@/lib/flowstarter/profile-image', () => ({
  decodeBitmap: async () => null,
  fetchImageBitmap: async () => null,
}));

vi.mock('@/lib/flowstarter/brand-tone', () => ({
  phraseTone: async () => ({
    adjectives: ['calm'],
    voice: 'Plain and warm.',
    source: 'model',
  }),
}));

const PREVIEW_ID = '11111111-2222-4333-8444-555555555555';

let ipCounter = 0;

function request(body: Record<string, unknown>): NextRequest {
  ipCounter += 1;
  return new NextRequest('http://localhost/api/discovery/brand-signals', {
    method: 'POST',
    body: JSON.stringify(body),
    headers: {
      'content-type': 'application/json',
      'x-forwarded-for': `10.9.0.${ipCounter}`,
    },
  });
}

/** What the three automatic sources look like on a good day. */
function observations() {
  return {
    github: {
      handle: 'darius',
      picture: {
        url: 'https://github.com/darius.png?size=460',
        width: 460,
        height: 460,
      },
    },
    website: { picture: null, saysPerson: false },
    instagramPublic: {
      picture: {
        url: 'https://scontent.cdninstagram.com/ig.png',
        width: 100,
        height: 100,
      },
    },
  };
}

beforeEach(() => {
  readAutomaticPortraitSources.mockReset();
  downloadPortraitPicture.mockReset();
  storeFunnelAsset.mockReset();
  signFunnelAsset.mockReset();
  readAutomaticPortraitSources.mockResolvedValue(observations());
  downloadPortraitPicture.mockResolvedValue({
    bytes: Buffer.alloc(8),
    extension: 'png',
    mime: 'image/png',
    sha256: 'a'.repeat(64),
    width: 460,
    height: 460,
  });
  storeFunnelAsset.mockResolvedValue({
    id: 'asset-1',
    storagePath: 'funnel/preview/asset-1.png',
  });
  signFunnelAsset.mockResolvedValue('https://signed.test/asset-1.png');
});

describe('POST /api/discovery/brand-signals, the portrait block', () => {
  it('answers with every source, its reason, and the one it chose', async () => {
    const response = await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        websiteUrl: 'https://flowstarter.net',
        fullName: 'Darius Popescu',
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();

    expect(body.portrait.candidates).toHaveLength(5);
    expect(
      body.portrait.candidates.map(
        (candidate: { source: string; reason: string }) => [
          candidate.source,
          candidate.reason,
        ]
      )
    ).toEqual([
      ['linkedin-openid', 'not_configured'],
      ['instagram-login', 'not_configured'],
      ['github-avatar', 'usable'],
      ['website-about', 'no_picture'],
      ['instagram-public-og', 'usable'],
    ]);
    // Ranked, so the wizard prints them in the rule's own order rather than
    // inventing one.
    expect(
      body.portrait.candidates.map(
        (candidate: { rank: number }) => candidate.rank
      )
    ).toEqual([1, 2, 3, 4, 5]);

    expect(body.portrait.chosen).toMatchObject({
      source: 'github-avatar',
      verdict: 'portrait',
      placements: ['hero', 'about', 'avatar'],
      width: 460,
      height: 460,
    });
    // Nothing was filed, because no preview was named to file it against.
    expect(body.portrait.chosen.assetId).toBeNull();
    expect(body.portrait.chosen.url).toBe(
      'https://github.com/darius.png?size=460'
    );
    expect(storeFunnelAsset).not.toHaveBeenCalled();
  });

  it('hands the client name and every link it was given to the sources', async () => {
    await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        linkedinUrl: 'https://linkedin.com/in/darius',
        websiteUrl: 'https://flowstarter.net',
        fullName: 'Darius Popescu',
      })
    );
    expect(readAutomaticPortraitSources).toHaveBeenCalledWith({
      urls: [
        'https://instagram.com/darius.flowstarter',
        'https://linkedin.com/in/darius',
        'https://flowstarter.net',
      ],
      fullName: 'Darius Popescu',
    });
  });

  it('files the chosen picture without a rights confirmation, and signs it', async () => {
    const response = await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        fullName: 'Darius Popescu',
        previewId: PREVIEW_ID,
      })
    );
    const body = await response.json();

    expect(storeFunnelAsset).toHaveBeenCalledTimes(1);
    const filed = storeFunnelAsset.mock.calls[0]?.[0];
    expect(filed).toMatchObject({
      previewId: PREVIEW_ID,
      kind: 'photo',
      source: 'github',
      usableFor: ['section', 'portrait'],
      // The load-bearing assertion in this file. An automatic source is not
      // consent; the client taps "Use this" on the brief and that tap is what
      // writes a confirmation.
      rights: null,
    });
    expect(filed.provenance.sourceUrl).toBe(
      'https://github.com/darius.png?size=460'
    );
    expect(typeof filed.provenance.fetchedAt).toBe('string');

    expect(body.portrait.chosen.assetId).toBe('asset-1');
    expect(body.portrait.chosen.url).toBe('https://signed.test/asset-1.png');
  });

  it('still answers when the chosen picture will not download', async () => {
    downloadPortraitPicture.mockResolvedValue(null);
    const response = await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        previewId: PREVIEW_ID,
      })
    );
    const body = await response.json();
    expect(storeFunnelAsset).not.toHaveBeenCalled();
    expect(body.portrait.chosen.assetId).toBeNull();
    expect(body.portrait.chosen.url).toBe(
      'https://github.com/darius.png?size=460'
    );
  });

  it('reports a table with no winner rather than a silence', async () => {
    readAutomaticPortraitSources.mockResolvedValue({
      github: { handle: null, picture: null },
      website: {
        picture: { url: 'https://cdn.test/card.png', width: 1200, height: 630 },
        saysPerson: false,
      },
      instagramPublic: undefined,
    });
    const response = await POST(request({ websiteUrl: 'https://acme.test' }));
    const body = await response.json();

    expect(body.portrait.chosen).toBeNull();
    expect(
      body.portrait.candidates.find(
        (candidate: { source: string }) => candidate.source === 'website-about'
      )
    ).toMatchObject({ usable: false, reason: 'not_a_person' });
    expect(
      body.portrait.candidates.find(
        (candidate: { source: string }) => candidate.source === 'github-avatar'
      )
    ).toMatchObject({ reason: 'no_github_handle' });
  });

  it('leaves the rest of the answer intact when the automatic sources throw', async () => {
    readAutomaticPortraitSources.mockRejectedValue(
      new Error('the whole portrait step fell over')
    );
    const response = await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        brandTone: 'calm, warm',
        fullName: 'Darius Popescu',
      })
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.portrait).toEqual({ candidates: [], chosen: null });
    // And every other field is the one it would have been.
    expect(body.palette.primary).toBeTruthy();
    expect(body.tone.voice).toBe('Plain and warm.');
    expect(body.unavailable).toEqual([
      { network: 'linkedin', reason: 'blocked' },
    ]);
    expect(body.anyExposed).toBe(true);
    expect(body.picture).toBeNull();
  });

  it('leaves the rest of the answer intact when filing the picture throws', async () => {
    storeFunnelAsset.mockRejectedValue(new Error('the bucket is on fire'));
    const response = await POST(
      request({
        instagramUrl: 'https://instagram.com/darius.flowstarter',
        previewId: PREVIEW_ID,
      })
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.portrait).toEqual({ candidates: [], chosen: null });
    expect(body.tone.voice).toBe('Plain and warm.');
  });

  it('refuses a name longer than the schema allows', async () => {
    const response = await POST(request({ fullName: 'a'.repeat(201) }));
    expect(response.status).toBe(400);
  });
});
