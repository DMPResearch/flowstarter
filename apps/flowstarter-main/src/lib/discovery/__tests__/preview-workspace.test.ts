/**
 * What a preview workspace hands to the manifest of record.
 *
 * The Astro dev server keeps its process id, port, LAN URL and start time in
 * `.astro/dev.json`, rewrites them on every restart, and until 2026-09-12 the
 * reader walked straight into that directory. Those seven paths travelled into
 * `funnel_previews.manifest`, into `flowstarter_project_artifacts`, onto the
 * build worker, and finally into the phrase list a paid build was failed for
 * not containing.
 */
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  isBinaryPreviewPath,
  readPreviewWorkspaceFiles,
} from '../preview-workspace';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true }))
  );
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'fs-preview-'));
  roots.push(root);
  const write = async (path: string, content: string) => {
    const absolute = join(root, path);
    await mkdir(join(absolute, '..'), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  };
  await write('.astro/dev.json', '{\n  "pid": 97132,\n  "port": 56092\n}\n');
  await write('.astro/settings.json', '{}\n');
  await write('.astro/types.d.ts', 'declare module "astro:content" {}\n');
  await write('node_modules/astro/package.json', '{"name":"astro"}\n');
  await write('dist/index.html', '<h1>stale</h1>\n');
  await write('.git/HEAD', 'ref: refs/heads/main\n');
  await write('.gitignore', 'dist\n');
  await write('pnpm-lock.yaml', 'lockfileVersion: 9\n');
  await write('astro.log', 'watching for changes\n');
  await write('src/content/site-labels.md', 'title: "A real headline here"\n');
  await write('src/pages/index.astro', '<h1>Home</h1>\n');
  await write('package.json', '{"name":"site"}\n');
  return root;
}

describe('readPreviewWorkspaceFiles', () => {
  it('reads the client site and none of the tooling around it', async () => {
    const files = await readPreviewWorkspaceFiles(await workspace());

    expect(files.map((file) => file.path).sort()).toEqual([
      'package.json',
      'src/content/site-labels.md',
      'src/pages/index.astro',
    ]);
  });

  it('does not descend into a pruned directory at all', async () => {
    const files = await readPreviewWorkspaceFiles(await workspace());

    expect(
      files.some(
        (file) =>
          file.path.startsWith('.astro/') ||
          file.path.startsWith('node_modules/') ||
          file.path.startsWith('dist/')
      )
    ).toBe(false);
  });

  it('still packs a binary asset as base64', async () => {
    const root = await mkdtemp(join(tmpdir(), 'fs-preview-bin-'));
    roots.push(root);
    await mkdir(join(root, 'public/images'), { recursive: true });
    await writeFile(
      join(root, 'public/images/hero.png'),
      Buffer.from([0x89, 0x50, 0x4e, 0x47])
    );

    const files = await readPreviewWorkspaceFiles(root);

    expect(files).toEqual([
      {
        path: 'public/images/hero.png',
        content: Buffer.from([0x89, 0x50, 0x4e, 0x47]).toString('base64'),
        encoding: 'base64',
        type: 'file',
      },
    ]);
  });

  it('knows which extensions must never be read as text', () => {
    expect(isBinaryPreviewPath('public/images/hero.PNG')).toBe(true);
    expect(isBinaryPreviewPath('src/content/site-labels.md')).toBe(false);
    expect(isBinaryPreviewPath('noextension')).toBe(false);
  });
});
