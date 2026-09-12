import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  injectCalComPreviewDemo,
  type FileMap,
} from '@flowstarter/agentic-codegen';
import { findCalPreviewInDir } from '../src/output-cal-preview';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-cal-preview-dist-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'contact'), { recursive: true });
  await mkdir(join(root, '_astro'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>Calm Path</h1>', 'utf8');
  await writeFile(
    join(root, 'contact', 'index.html'),
    '<h1>Contact</h1>',
    'utf8',
  );
  await writeFile(join(root, '_astro', 'site.css'), 'body{margin:0}', 'utf8');
  return root;
}

/** The real, rendered demo block `injectCalComPreviewDemo` writes into a page. */
function renderedPreviewDemo(): string {
  const files: FileMap = {
    'src/pages/contact.astro':
      '<main class="contact-page"><h1>Contact</h1></main>',
  };
  return injectCalComPreviewDemo(files)['src/pages/contact.astro']!;
}

describe('findCalPreviewInDir', () => {
  it('passes a paid build that carries no preview demo', async () => {
    await expect(findCalPreviewInDir(await dist())).resolves.toEqual([]);
  });

  it('catches the demo the 2026-09-12 portfolio shipped on its contact page', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'contact', 'index.html'),
      renderedPreviewDemo(),
      'utf8',
    );

    await expect(findCalPreviewInDir(root)).resolves.toEqual([
      'contact/index.html',
    ]);
  });

  it('catches a bare marker attribute even without the full rendered block', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'index.html'),
      '<div data-flowstarter-cal-preview="true">stray</div>',
      'utf8',
    );
    await expect(findCalPreviewInDir(root)).resolves.toEqual(['index.html']);
  });

  it('does not fire on a clean live embed', async () => {
    const root = await dist();
    await mkdir(join(root, 'book'), { recursive: true });
    await writeFile(
      join(root, 'book', 'index.html'),
      '<div data-flowstarter-cal-embed="true"><iframe src="https://cal.com/acme/intro/embed"></iframe></div>',
      'utf8',
    );
    await expect(findCalPreviewInDir(root)).resolves.toEqual([]);
  });

  it('never opens an image, and never walks node_modules', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'hero.png'),
      'data-flowstarter-cal-preview="true"',
      'utf8',
    );
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'index.html'),
      '<div data-flowstarter-cal-preview="true"></div>',
      'utf8',
    );
    await expect(findCalPreviewInDir(root)).resolves.toEqual([]);
  });
});
