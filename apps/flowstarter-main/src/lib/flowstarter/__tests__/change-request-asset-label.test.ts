/**
 * `changeRequestAssetLabel`: how the operator's change-request asset picker
 * names one of a client's pictures.
 *
 * PR #119's picker fell back to a storage path's basename, which is a sha256
 * content hash (`assetObjectPath`) — meaningless to an operator ticking a box
 * on a paid change request. This function's signature does not even accept a
 * storage path, so that regression is not just fixed but impossible to
 * reintroduce here; the last test below is the belt-and-braces proof.
 */
import { describe, expect, it } from 'vitest';
import { changeRequestAssetLabel } from '../change-request-asset-label';

const SHA256_RUN = /[0-9a-f]{64}/i;

describe('changeRequestAssetLabel', () => {
  it('uses the caption alone when there is one, ignoring everything else', () => {
    expect(
      changeRequestAssetLabel({
        caption: '  The workshops room  ',
        originalName: 'IMG_4821.jpg',
        width: 4032,
        height: 3024,
        createdAt: '2026-09-01T00:00:00.000Z',
      })
    ).toBe('The workshops room');
  });

  it('falls back to filename, dimensions, and upload date, in that order', () => {
    expect(
      changeRequestAssetLabel({
        caption: null,
        originalName: 'front-of-shop.jpg',
        width: 1200,
        height: 750,
        createdAt: '2026-09-12T08:00:00.000Z',
      })
    ).toBe('front-of-shop.jpg — 1200x750 — 12 Sep 2026');
  });

  it('treats a blank caption the same as no caption', () => {
    expect(
      changeRequestAssetLabel({
        caption: '   ',
        originalName: 'front-of-shop.jpg',
        width: 1200,
        height: 750,
        createdAt: '2026-09-12T08:00:00.000Z',
      })
    ).toBe('front-of-shop.jpg — 1200x750 — 12 Sep 2026');
  });

  it('omits dimensions when only one of width/height is known', () => {
    expect(
      changeRequestAssetLabel({
        caption: null,
        originalName: 'front-of-shop.jpg',
        width: 1200,
        height: null,
        createdAt: '2026-09-12T08:00:00.000Z',
      })
    ).toBe('front-of-shop.jpg — 12 Sep 2026');
  });

  it('omits the date when the upload time is unknown', () => {
    expect(
      changeRequestAssetLabel({
        caption: null,
        originalName: 'front-of-shop.jpg',
        width: 1200,
        height: 750,
        createdAt: null,
      })
    ).toBe('front-of-shop.jpg — 1200x750');
  });

  it('uses "Untitled picture" in place of a filename when there is none', () => {
    expect(
      changeRequestAssetLabel({
        caption: null,
        originalName: null,
        width: 1200,
        height: 750,
        createdAt: '2026-09-12T08:00:00.000Z',
      })
    ).toBe('Untitled picture — 1200x750 — 12 Sep 2026');
  });

  it('is "Untitled picture" alone when nothing at all is known', () => {
    expect(
      changeRequestAssetLabel({
        caption: null,
        originalName: null,
        width: null,
        height: null,
        createdAt: null,
      })
    ).toBe('Untitled picture');
  });

  it('never turns a sha256-shaped storage basename into a label', () => {
    // The regression the function's signature makes impossible: it has no
    // storage path parameter at all, so there is nothing for it to fall back
    // to here even with caption and originalName both empty.
    const label = changeRequestAssetLabel({
      caption: null,
      originalName: null,
      width: null,
      height: null,
      createdAt: null,
    });
    expect(label).not.toMatch(SHA256_RUN);
  });
});
