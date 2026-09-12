import { beforeEach, describe, expect, it, vi } from 'vitest';

const storeFunnelAsset = vi.fn();
vi.mock('../funnel-assets', () => ({
  storeFunnelAsset: (...args: unknown[]) => storeFunnelAsset(...args),
}));

import {
  MAX_PICTURE_BYTES,
  MIN_PLACEABLE_EDGE,
  captureProfilePicture,
} from '../profile-picture';
import type { ProfileReading } from '../profile-signals';

const PREVIEW = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';

/**
 * A real 256x256 PNG, 177 bytes.
 *
 * Real bytes rather than a fake buffer because the capture path runs them
 * through the same validator the client uploader uses, which sniffs magic
 * bytes and refuses anything under 200px on its longest edge. A made-up
 * buffer would be rejected for the wrong reason and prove nothing, and a 1x1
 * pixel would be rejected for the right reason and still prove nothing.
 */
const PNG_256 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAQAAAAEACAMAAABrrFhUAAAAA1BMVEXIHhj/612rAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAVElEQVR42u3BAQEAAACAkP6v7ggKAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAGAEPAAEccgnDAAAAAElFTkSuQmCC',
  'base64'
);

/** 512x512: over the placeable floor, so it earns roles. */
const PNG_512 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAgAAAAIACAMAAADDpiTIAAAAA1BMVEXIHhj/612rAAAACXBIWXMAAAPoAAAD6AG1e1JrAAABFUlEQVR42u3BMQEAAADCoPVP7WkJoAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA4AYCPAAByZWgVQAAAABJRU5ErkJggg==',
  'base64'
);

/** Under 200px, which the shared validator refuses outright. */
const PNG_TINY = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64'
);

function exposed(
  network: 'instagram' | 'linkedin' | 'website',
  imageUrl: string | null
): ProfileReading {
  return {
    status: 'exposed',
    network,
    url: `https://${
      network === 'website' ? 'flowstarter.net' : network + '.com'
    }/x`,
    title: 'Someone',
    description: 'A description.',
    imageUrl,
  };
}

const WALLED: ProfileReading = {
  status: 'unavailable',
  network: 'instagram',
  url: 'https://instagram.com/darius.flowstarter',
  reason: 'login_required',
};

function responding(
  body: Buffer,
  init: { ok?: boolean; contentLength?: string } = {}
): Response {
  return {
    ok: init.ok ?? true,
    headers: new Headers(
      init.contentLength ? { 'content-length': init.contentLength } : {}
    ),
    arrayBuffer: async () =>
      body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength),
  } as unknown as Response;
}

beforeEach(() => {
  storeFunnelAsset.mockReset();
  storeFunnelAsset.mockImplementation(
    async (input: Record<string, unknown>) => ({
      id: 'asset-1',
      previewId: PREVIEW,
      source: input.source,
      kind: input.kind,
      storagePath: 'funnel/x/assets/a.png',
      sha256: 'abc',
      mime: 'image/png',
      width: 1,
      height: 1,
      usableFor: input.usableFor ?? [],
      rightsConfirmedAt: null,
      claimedAssetId: null,
    })
  );
});

describe('captureProfilePicture', () => {
  it('does nothing when no network exposed an image', async () => {
    const outcome = await captureProfilePicture({
      previewId: PREVIEW,
      readings: [WALLED],
    });
    expect(outcome).toEqual({ status: 'skipped', reason: 'no_image' });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
  });

  it('does nothing when a reading is exposed but carries no picture', async () => {
    const outcome = await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('website', null)],
    });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'no_image' });
  });

  it('files an exposed picture against the preview', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    const outcome = await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('website', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toMatchObject({ status: 'captured', network: 'website' });
    expect(storeFunnelAsset).toHaveBeenCalledTimes(1);
  });

  it('files it with NO rights confirmation, which is the whole point', async () => {
    // A picture read off a public profile is not a picture the visitor gave
    // us. Without `rights_confirmed_at` the row is invisible to
    // `loadUsableAssets`, so a paid build cannot publish it by construction.
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('instagram', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    const call = storeFunnelAsset.mock.calls[0]?.[0] as { rights: unknown };
    expect(call.rights).toBeNull();
  });

  it('records which network the picture came from', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('linkedin', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      source: 'linkedin',
      kind: 'photo',
    });
  });

  it("files a visitor's own website picture as an OpenGraph read", async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('website', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({ source: 'og' });
  });

  it('prefers Instagram, then LinkedIn, then the website', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    await captureProfilePicture({
      previewId: PREVIEW,
      readings: [
        exposed('website', 'https://cdn.example.com/site.png'),
        exposed('linkedin', 'https://cdn.example.com/li.png'),
        exposed('instagram', 'https://cdn.example.com/ig.png'),
      ],
      fetchImpl: fetchImpl as never,
    });
    expect((fetchImpl.mock.calls[0] as unknown as string[])?.[0]).toBe(
      'https://cdn.example.com/ig.png'
    );
  });

  it('marks a big enough picture as placeable in an about section', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_512));
    await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('instagram', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    // 512 clears the placeable floor, so the picture gets roles. Roles are not
    // rights: it is still unpublishable until the claim page asks.
    expect(MIN_PLACEABLE_EDGE).toBeLessThanOrEqual(512);
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      usableFor: ['section', 'portrait'],
      rights: null,
    });
  });

  it('keeps a small avatar for the palette but gives it no placeable role', async () => {
    // 256 is a real picture and carries a real colour, so it is worth filing.
    // It is too soft to put in an about section, so it is filed without the
    // roles that would let the generator place it.
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    const outcome = await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('instagram', 'https://cdn.example.com/a.png')],
      fetchImpl: fetchImpl as never,
    });
    expect(outcome).toMatchObject({ status: 'captured' });
    expect(storeFunnelAsset.mock.calls[0]?.[0]).toMatchObject({
      usableFor: [],
    });
  });

  it('refuses an avatar too small to be worth anything', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_TINY));
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('instagram', 'https://cdn.example.com/a.png')],
        fetchImpl: fetchImpl as never,
      })
    ).toMatchObject({ status: 'skipped', reason: 'not_an_image' });
  });

  it('refuses a picture that is not on a public host', async () => {
    const outcome = await captureProfilePicture({
      previewId: PREVIEW,
      readings: [exposed('website', 'https://127.0.0.1/secret.png')],
    });
    expect(outcome).toMatchObject({ status: 'skipped', reason: 'unreadable' });
  });

  it('refuses a body larger than the cap, on the header and on the bytes', async () => {
    const byHeader = vi.fn(async () =>
      responding(PNG_256, { contentLength: String(MAX_PICTURE_BYTES + 1) })
    );
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.png')],
        fetchImpl: byHeader as never,
      })
    ).toMatchObject({ reason: 'too_large' });

    const byBytes = vi.fn(async () =>
      responding(Buffer.alloc(MAX_PICTURE_BYTES + 1))
    );
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.png')],
        fetchImpl: byBytes as never,
      })
    ).toMatchObject({ reason: 'too_large' });
  });

  it('refuses bytes that are not an image, whatever the CDN said', async () => {
    const fetchImpl = vi.fn(async () =>
      responding(Buffer.from('<svg onload=alert(1)></svg>'))
    );
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.svg')],
        fetchImpl: fetchImpl as never,
      })
    ).toMatchObject({ status: 'skipped', reason: 'not_an_image' });
    expect(storeFunnelAsset).not.toHaveBeenCalled();
  });

  it('treats a non-ok response as nothing to file', async () => {
    const fetchImpl = vi.fn(async () => responding(PNG_256, { ok: false }));
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.png')],
        fetchImpl: fetchImpl as never,
      })
    ).toMatchObject({ reason: 'unreadable' });
  });

  it('never throws when the network or the store fails', async () => {
    const thrower = vi.fn(async () => {
      throw new Error('socket hang up');
    });
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.png')],
        fetchImpl: thrower as never,
      })
    ).toMatchObject({ status: 'skipped' });

    storeFunnelAsset.mockRejectedValue(new Error('bucket down'));
    const fetchImpl = vi.fn(async () => responding(PNG_256));
    expect(
      await captureProfilePicture({
        previewId: PREVIEW,
        readings: [exposed('website', 'https://cdn.example.com/a.png')],
        fetchImpl: fetchImpl as never,
      })
    ).toMatchObject({ status: 'skipped' });
  });
});
