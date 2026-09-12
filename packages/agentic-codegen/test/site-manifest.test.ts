import { mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { deepTempDir } from './helpers';
import {
  isBinaryManifestPath,
  readSiteWorkspaceFiles,
} from '../src/flowstarter/site-manifest';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function workspace(): Promise<string> {
  const root = await deepTempDir('flowstarter-site-manifest');
  temporaryDirectories.push(root);
  return root;
}

describe('isBinaryManifestPath', () => {
  it('knows the bytes that must never be read as text', () => {
    expect(isBinaryManifestPath('public/hero.jpg')).toBe(true);
    expect(isBinaryManifestPath('public/hero.WEBP')).toBe(true);
    expect(isBinaryManifestPath('src/content/site.md')).toBe(false);
    expect(isBinaryManifestPath('README')).toBe(false);
  });
});

describe('readSiteWorkspaceFiles', () => {
  it('reads text as text and images as flagged base64', async () => {
    const root = await workspace();
    await mkdir(join(root, 'src/content'), { recursive: true });
    await mkdir(join(root, 'public/flowstarter-media'), { recursive: true });
    await writeFile(join(root, 'src/content/site.md'), 'hero: Real copy');
    // A PNG header: real bytes, and NUL-bearing, which is exactly what a
    // UTF-8 read would mangle into something Postgres jsonb refuses.
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    await writeFile(join(root, 'public/flowstarter-media/cr-1.png'), png);

    const files = await readSiteWorkspaceFiles(root);
    const text = files.find((file) => file.path === 'src/content/site.md');
    const image = files.find(
      (file) => file.path === 'public/flowstarter-media/cr-1.png',
    );
    expect(text?.content).toBe('hero: Real copy');
    expect(text?.encoding).toBeUndefined();
    expect(image?.encoding).toBe('base64');
    expect(Buffer.from(image!.content, 'base64')).toEqual(png);
  });

  it('skips tooling and build state rather than recording it', async () => {
    // The 2026-09-12 failure in one test: a dev server's scratch directory in
    // the manifest of record is how a paid build came to be failed for not
    // containing a process id.
    const root = await workspace();
    await mkdir(join(root, '.astro'), { recursive: true });
    await mkdir(join(root, 'node_modules/left-pad'), { recursive: true });
    await mkdir(join(root, 'dist'), { recursive: true });
    await writeFile(join(root, '.astro/dev.json'), '{"pid":97132}');
    await writeFile(join(root, 'node_modules/left-pad/index.js'), 'module');
    await writeFile(join(root, 'dist/index.html'), '<html></html>');
    await writeFile(join(root, 'site.md'), 'kept');

    const files = await readSiteWorkspaceFiles(root);
    expect(files.map((file) => file.path)).toEqual(['site.md']);
  });
});
