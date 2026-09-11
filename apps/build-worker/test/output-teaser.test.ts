import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PREVIEW_TEASER_MARKER } from '@flowstarter/agentic-codegen';
import { findPreviewTeaserInDir } from '../src/output-teaser';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-teaser-dist-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'about'), { recursive: true });
  await mkdir(join(root, '_astro'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>Calm Path</h1>', 'utf8');
  await writeFile(join(root, 'about', 'index.html'), '<h1>About</h1>', 'utf8');
  await writeFile(join(root, '_astro', 'site.css'), 'body{margin:0}', 'utf8');
  return root;
}

describe('findPreviewTeaserInDir', () => {
  it('passes a paid build that carries no teaser', async () => {
    await expect(findPreviewTeaserInDir(await dist())).resolves.toEqual([]);
  });

  it('catches the teaser script the 2026-09-11 portfolio shipped on every page', async () => {
    const root = await dist();
    await writeFile(
      join(root, `${PREVIEW_TEASER_MARKER}.js`),
      '/* teaser */',
      'utf8',
    );
    for (const page of ['index.html', 'about/index.html']) {
      await writeFile(
        join(root, page),
        `<html><head><script defer src="/${PREVIEW_TEASER_MARKER}.js"></script></head></html>`,
        'utf8',
      );
    }

    await expect(findPreviewTeaserInDir(root)).resolves.toEqual([
      'about/index.html',
      `${PREVIEW_TEASER_MARKER}.js`,
      'index.html',
    ]);
  });

  it('catches the overlay markup on its own', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'index.html'),
      '<section class="fs-teaser-locked"><a class="fs-teaser-veil"></a></section>',
      'utf8',
    );
    await expect(findPreviewTeaserInDir(root)).resolves.toEqual(['index.html']);
  });

  it('catches the teaser stylesheet bundled into a built CSS file', async () => {
    const root = await dist();
    await writeFile(
      join(root, '_astro', 'site.css'),
      '.fs-teaser-chip{border-radius:999px}',
      'utf8',
    );
    await expect(findPreviewTeaserInDir(root)).resolves.toEqual([
      '_astro/site.css',
    ]);
  });

  it('never opens an image, and never walks node_modules', async () => {
    const root = await dist();
    await writeFile(join(root, 'hero.png'), 'fs-teaser-locked', 'utf8');
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'index.html'),
      `<script src="/${PREVIEW_TEASER_MARKER}.js"></script>`,
      'utf8',
    );
    await expect(findPreviewTeaserInDir(root)).resolves.toEqual([]);
  });
});
