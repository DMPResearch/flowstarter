import { describe, expect, it } from 'vitest';
import {
  ASSET_NOT_BINARY,
  describeAssetProblems,
  findNonBinaryAssets,
  inspectRasterAsset,
  isPrintableAscii,
  rasterExtension,
  RASTER_EXTENSIONS,
} from '../src/binary-assets';

/**
 * Real leading bytes, one per format the gate owns. These are headers, not
 * whole images: the gate only ever reads this far, so a fixture that goes
 * further would be testing something the production path never looks at.
 */
const HEADERS: Record<string, Uint8Array> = {
  png: new Uint8Array([
    0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d,
  ]),
  jpg: new Uint8Array([
    0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  ]),
  jpeg: new Uint8Array([
    0xff, 0xd8, 0xff, 0xdb, 0x00, 0x43, 0x00, 0x08, 0x06, 0x06, 0x07, 0x06,
  ]),
  gif: new Uint8Array([
    ...Buffer.from('GIF89a', 'ascii'),
    0x10,
    0x00,
    0x10,
    0x00,
    0x80,
    0x00,
  ]),
  webp: new Uint8Array([
    ...Buffer.from('RIFF', 'ascii'),
    0x24,
    0x00,
    0x00,
    0x00,
    ...Buffer.from('WEBPVP8 ', 'ascii'),
  ]),
  avif: new Uint8Array([
    0x00,
    0x00,
    0x00,
    0x20,
    ...Buffer.from('ftypavif', 'ascii'),
    0x00,
    0x00,
    0x00,
    0x00,
  ]),
  ico: new Uint8Array([
    0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x10, 0x10, 0x00, 0x00, 0x01, 0x00,
  ]),
};

/** The defect, exactly as it shipped: a PNG's base64, written as an ASCII file. */
const BASE64_TEXT = Buffer.from(HEADERS['png'] as Uint8Array).toString(
  'base64',
);

const SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24"></svg>';

describe('rasterExtension', () => {
  it('claims every extension the gate owns', () => {
    for (const ext of RASTER_EXTENSIONS) {
      expect(rasterExtension(`assets/hero.${ext}`)).toBe(ext);
    }
  });

  it('is case insensitive and ignores a cache-busting query', () => {
    expect(rasterExtension('assets/Hero.PNG')).toBe('png');
    expect(rasterExtension('assets/hero.png?v=2')).toBe('png');
    expect(rasterExtension('assets/hero.png#top')).toBe('png');
  });

  it('leaves text formats alone', () => {
    expect(rasterExtension('assets/logo.svg')).toBeNull();
    expect(rasterExtension('index.html')).toBeNull();
    expect(rasterExtension('fonts/inter.woff2')).toBeNull();
    expect(rasterExtension('README')).toBeNull();
  });
});

describe('inspectRasterAsset', () => {
  for (const [ext, bytes] of Object.entries(HEADERS)) {
    it(`accepts a real ${ext} header`, () => {
      expect(inspectRasterAsset(`images/hero.${ext}`, bytes)).toBeNull();
    });
  }

  it('accepts a cursor-flavoured ico reserved word', () => {
    const cursor = new Uint8Array([0x00, 0x00, 0x02, 0x00, 0x01, 0x00]);
    expect(inspectRasterAsset('favicon.ico', cursor)).toBeNull();
  });

  it('rejects base64 text behind every raster extension', () => {
    for (const ext of RASTER_EXTENSIONS) {
      const problem = inspectRasterAsset(
        `images/hero.${ext}`,
        new Uint8Array(Buffer.from(BASE64_TEXT, 'utf8')),
      );
      expect(problem?.reason).toBe('printable-ascii');
      expect(problem?.extension).toBe(ext);
      expect(problem?.message).toContain(ASSET_NOT_BINARY);
    }
  });

  it('rejects a RIFF container that is not WebP', () => {
    const wav = new Uint8Array([
      ...Buffer.from('RIFF', 'ascii'),
      0x24,
      0x00,
      0x00,
      0x00,
      ...Buffer.from('WAVEfmt ', 'ascii'),
    ]);
    expect(inspectRasterAsset('images/hero.webp', wav)?.reason).toBe(
      'wrong-magic',
    );
  });

  it('rejects an ISO container whose brand is not an image', () => {
    const mp4 = new Uint8Array([
      0x00,
      0x00,
      0x00,
      0x20,
      ...Buffer.from('ftypmp42', 'ascii'),
      0x00,
      0x00,
      0x00,
      0x00,
    ]);
    expect(inspectRasterAsset('images/clip.avif', mp4)?.reason).toBe(
      'wrong-magic',
    );
  });

  it('rejects a png whose bytes are a jpeg', () => {
    const problem = inspectRasterAsset(
      'images/hero.png',
      HEADERS['jpg'] as Uint8Array,
    );
    expect(problem?.reason).toBe('wrong-magic');
  });

  it('rejects an empty file', () => {
    expect(
      inspectRasterAsset('images/hero.png', new Uint8Array())?.reason,
    ).toBe('empty');
  });

  it('never looks at an SVG, which is text and is meant to be', () => {
    expect(
      inspectRasterAsset(
        'images/logo.svg',
        new Uint8Array(Buffer.from(SVG, 'utf8')),
      ),
    ).toBeNull();
  });

  it('never looks at a file with no raster extension', () => {
    expect(
      inspectRasterAsset(
        'index.html',
        new Uint8Array(Buffer.from('<!doctype html>', 'utf8')),
      ),
    ).toBeNull();
  });
});

describe('isPrintableAscii', () => {
  it('accepts base64, tabs and newlines', () => {
    expect(
      isPrintableAscii(
        new Uint8Array(Buffer.from(`${BASE64_TEXT}\n\t`, 'utf8')),
      ),
    ).toBe(true);
  });

  it('rejects a byte no editor prints, and rejects nothing at all', () => {
    expect(isPrintableAscii(HEADERS['png'] as Uint8Array)).toBe(false);
    expect(isPrintableAscii(new Uint8Array())).toBe(false);
  });
});

describe('findNonBinaryAssets', () => {
  it('passes a manifest whose images carry the base64 flag', () => {
    const problems = findNonBinaryAssets([
      {
        path: 'images/hero.png',
        content: Buffer.from(HEADERS['png'] as Uint8Array).toString('base64'),
        encoding: 'base64',
      },
      { path: 'images/logo.svg', content: SVG },
      { path: 'index.html', content: '<!doctype html>' },
    ]);
    expect(problems).toEqual([]);
  });

  it('catches the image whose base64 lost its encoding flag', () => {
    const problems = findNonBinaryAssets([
      { path: 'images/hero.png', content: BASE64_TEXT },
      {
        path: 'images/shot.webp',
        content: Buffer.from(HEADERS['webp'] as Uint8Array).toString('base64'),
        encoding: 'base64',
      },
    ]);
    expect(problems).toHaveLength(1);
    expect(problems[0]?.path).toBe('images/hero.png');
    expect(problems[0]?.reason).toBe('printable-ascii');
  });
});

describe('describeAssetProblems', () => {
  it('names every broken file in one operator-readable line', () => {
    const problems = findNonBinaryAssets([
      { path: 'images/a.png', content: BASE64_TEXT },
      { path: 'images/b.webp', content: BASE64_TEXT },
    ]);
    const message = describeAssetProblems(problems);
    expect(message.startsWith(ASSET_NOT_BINARY)).toBe(true);
    expect(message).toContain('2 images');
    expect(message).toContain('images/a.png');
    expect(message).toContain('images/b.webp');
  });

  it('uses the singular for one file', () => {
    const problems = findNonBinaryAssets([
      { path: 'images/a.png', content: BASE64_TEXT },
    ]);
    expect(describeAssetProblems(problems)).toContain('1 image in the build');
  });
});
