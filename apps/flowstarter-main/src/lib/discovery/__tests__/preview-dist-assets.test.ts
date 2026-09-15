/**
 * The two rules that decide which pictures reach a preview artifact.
 *
 * `preview-real-build.test.ts` proves the numbers on the real templates. This
 * proves the edges, which a real build does not happen to contain: a reference
 * only a stylesheet makes, a picture Astro compiled itself, an SVG, and the
 * case where re-encoding would make a file bigger.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

vi.mock('server-only', () => ({}));

import { optimisePreviewDistImages, servedPath } from '../preview-dist-assets';

const scratch: string[] = [];

afterEach(async () => {
  while (scratch.length) {
    await rm(scratch.pop() as string, { recursive: true, force: true });
  }
});

async function dist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fs-dist-assets-'));
  scratch.push(root);
  await mkdir(join(root, 'images'), { recursive: true });
  await mkdir(join(root, '_astro'), { recursive: true });
  return root;
}

/**
 * A real PNG, big enough to clear the re-encode floor and photographic enough
 * that WebP actually beats it. A gradient rather than flat colour: flat colour
 * is the one case PNG wins, which would make this test assert the opposite of
 * what it means to.
 */
async function photographicPng(width = 900, height = 900): Promise<Buffer> {
  const sharp = (await import('sharp')).default;
  const pixels = Buffer.alloc(width * height * 3);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const at = (y * width + x) * 3;
      pixels[at] = (x * 7 + y * 3) % 256;
      pixels[at + 1] = (x * x + y) % 256;
      pixels[at + 2] = (x + y * y) % 256;
    }
  }
  return sharp(pixels, { raw: { width, height, channels: 3 } })
    .png({ compressionLevel: 0 })
    .toBuffer();
}

describe('optimisePreviewDistImages', () => {
  it('re-encodes a referenced original and rewrites every reference to it', async () => {
    const root = await dist();
    await writeFile(join(root, 'images', 'hero.png'), await photographicPng());
    await writeFile(
      join(root, 'index.html'),
      '<head></head><img src="/images/hero.png" alt="">'
    );
    await writeFile(
      join(root, 'styles.css'),
      '.hero{background:url("/images/hero.png")}'
    );

    const report = await optimisePreviewDistImages(root);

    expect(report.converted).toHaveLength(1);
    expect(report.converted[0]?.from).toBe('/images/hero.png');
    expect(report.converted[0]?.to).toBe('/images/hero.webp');
    expect(report.bytesAfter).toBeLessThan(report.bytesBefore);

    // The bytes moved...
    expect(existsSync(join(root, 'images', 'hero.webp'))).toBe(true);
    expect(existsSync(join(root, 'images', 'hero.png'))).toBe(false);
    // ...and so did every reference. A rewrite that missed one would leave the
    // page pointing at a file that is not there, which is worse than the
    // oversized artifact this is fixing.
    const html = await readFile(join(root, 'index.html'), 'utf8');
    const css = await readFile(join(root, 'styles.css'), 'utf8');
    expect(html).toContain('/images/hero.webp');
    expect(html).not.toContain('/images/hero.png');
    expect(css).toContain('/images/hero.webp');
    expect(css).not.toContain('/images/hero.png');
  });

  it('drops an image nothing in the built site references', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'images', 'hero-image-wrong.png'),
      await photographicPng(200, 200)
    );
    await writeFile(
      join(root, 'index.html'),
      '<head></head><h1>No images</h1>'
    );

    const report = await optimisePreviewDistImages(root);

    expect(report.removed).toEqual(['/images/hero-image-wrong.png']);
    expect(existsSync(join(root, 'images', 'hero-image-wrong.png'))).toBe(
      false
    );
  });

  /**
   * Conservative on purpose. A page may build a path by concatenation, so the
   * rule matches the BASENAME anywhere in the built text rather than the whole
   * rooted path — the direction that keeps files rather than deleting them.
   */
  it('keeps an image whose name appears only in a script', async () => {
    const root = await dist();
    // Under the re-encode floor, so the only rule in play is the removal one
    // and the file is still at the name the assertion names.
    await writeFile(
      join(root, 'images', 'gallery-3.png'),
      await photographicPng(60, 60)
    );
    await writeFile(
      join(root, 'app.js'),
      "const src = '/images/' + 'gallery-3.png';"
    );
    await writeFile(join(root, 'index.html'), '<head></head>');

    const report = await optimisePreviewDistImages(root);

    expect(report.removed).toEqual([]);
    expect(existsSync(join(root, 'images', 'gallery-3.png'))).toBe(true);
  });

  it("never touches Astro's own compiled output", async () => {
    const root = await dist();
    await writeFile(
      join(root, '_astro', 'hero.a1b2c3.png'),
      await photographicPng()
    );
    await writeFile(
      join(root, 'index.html'),
      '<head></head><img src="/_astro/hero.a1b2c3.png">'
    );

    const report = await optimisePreviewDistImages(root);

    expect(report.converted).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(existsSync(join(root, '_astro', 'hero.a1b2c3.png'))).toBe(true);
  });

  /**
   * SVG is already the optimised form of what it draws, re-encoding it to a
   * bitmap would be a downgrade, and it is the one image type under `public/`
   * that can carry script.
   */
  it('leaves SVG alone', async () => {
    const root = await dist();
    const svg = `<svg xmlns="http://www.w3.org/2000/svg">${'<rect/>'.repeat(
      20_000
    )}</svg>`;
    await writeFile(join(root, 'images', 'logo.svg'), svg);
    await writeFile(
      join(root, 'index.html'),
      '<head></head><img src="/images/logo.svg">'
    );

    await optimisePreviewDistImages(root);

    expect(await readFile(join(root, 'images', 'logo.svg'), 'utf8')).toBe(svg);
  });

  /**
   * Per-file fail-open, and the reason the whole module is written that way: a
   * generated workspace can carry anything the pipeline put in it, and this is
   * an optimisation, not a gate. The budget check is the thing that must never
   * be silent; a picture that cannot be decoded is left exactly as it was and
   * the page keeps pointing at it.
   */
  it('keeps a file it cannot decode, references and all', async () => {
    const root = await dist();
    const notAnImage = Buffer.from('this is not a PNG'.repeat(8_000), 'utf8');
    await writeFile(join(root, 'images', 'broken.png'), notAnImage);
    await writeFile(
      join(root, 'index.html'),
      '<head></head><img src="/images/broken.png">'
    );

    const report = await optimisePreviewDistImages(root);

    expect(report.converted).toEqual([]);
    expect(report.removed).toEqual([]);
    expect(await readFile(join(root, 'images', 'broken.png'))).toEqual(
      notAnImage
    );
    expect(await readFile(join(root, 'index.html'), 'utf8')).toContain(
      '/images/broken.png'
    );
  });

  it('answers an empty report for a dist that is not there', async () => {
    const report = await optimisePreviewDistImages(
      join(tmpdir(), 'fs-dist-assets-nothing-here')
    );
    expect(report).toEqual({
      removed: [],
      converted: [],
      bytesBefore: 0,
      bytesAfter: 0,
    });
  });
});

describe('servedPath', () => {
  it('is the rooted URL a built page carries', () => {
    expect(servedPath('images/hero.png')).toBe('/images/hero.png');
  });
});
