import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { PLACEHOLDER_IMAGE_MANIFEST } from '@flowstarter/agentic-codegen';
import { findPlaceholderImagesInDir } from '../src/output-placeholder-images';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function dist(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-placeholder-dist-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'about'), { recursive: true });
  await mkdir(join(root, 'images'), { recursive: true });
  await writeFile(join(root, 'index.html'), '<h1>Halden & Roe</h1>', 'utf8');
  await writeFile(join(root, 'about', 'index.html'), '<h1>About</h1>', 'utf8');
  return root;
}

const portrait = PLACEHOLDER_IMAGE_MANIFEST.find(
  (asset) => asset.id === 'creative-portfolio-about-me-photo',
)!;
const workThumb = PLACEHOLDER_IMAGE_MANIFEST.find(
  (asset) => asset.id === 'creative-portfolio-somalia',
)!;
const decoration = PLACEHOLDER_IMAGE_MANIFEST.find(
  (asset) => asset.role === 'decoration',
)!;
const hero = PLACEHOLDER_IMAGE_MANIFEST.find((asset) => asset.role === 'hero')!;

describe('findPlaceholderImagesInDir', () => {
  it('passes a paid build that carries no placeholder', async () => {
    await expect(findPlaceholderImagesInDir(await dist())).resolves.toEqual([]);
  });

  it('catches the portrait placeholder by filename, referenced from the About page', async () => {
    const root = await dist();
    const basename = portrait.path.split('/').pop()!;
    await writeFile(join(root, 'images', basename), '<svg></svg>', 'utf8');
    await writeFile(
      join(root, 'about', 'index.html'),
      `<img src="/images/${basename}" alt="About" />`,
      'utf8',
    );
    const findings = await findPlaceholderImagesInDir(root);
    expect(findings.some((finding) => finding.role === 'portrait')).toBe(true);
    expect(
      findings.some((finding) => finding.path === `images/${basename}`),
    ).toBe(true);
  });

  it('catches a work-thumb placeholder by content hash, even renamed', async () => {
    const root = await dist();
    // A different name, but the exact bytes of a manifest-listed work-thumb
    // asset: this is the case the by-hash half of the gate exists for.
    const { readFile } = await import('node:fs/promises');
    const realBytes = await readFile(
      join(
        __dirname,
        '..',
        '..',
        'flowstarter-templates',
        workThumb.template,
        workThumb.path,
      ),
    );
    await writeFile(join(root, 'images', 'case-study-1.png'), realBytes);

    const findings = await findPlaceholderImagesInDir(root);
    expect(
      findings.some(
        (finding) =>
          finding.role === 'work-thumb' &&
          finding.path === 'images/case-study-1.png',
      ),
    ).toBe(true);
  });

  it('catches the naming convention for a template not yet in the manifest', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'images', 'placeholder-portrait-founder.svg'),
      '<svg></svg>',
      'utf8',
    );
    const findings = await findPlaceholderImagesInDir(root);
    expect(findings).toEqual([
      {
        path: 'images/placeholder-portrait-founder.svg',
        role: 'portrait',
        reason: 'filename-convention',
      },
    ]);
  });

  it('catches the marker attribute on an inline stand-in', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'about', 'index.html'),
      '<svg data-flowstarter-placeholder="work-thumb"></svg>',
      'utf8',
    );
    const findings = await findPlaceholderImagesInDir(root);
    expect(findings).toEqual([
      {
        path: 'about/index.html',
        role: 'work-thumb',
        reason: 'marker-attribute',
      },
    ]);
  });

  it('allows a decoration placeholder — abstract shapes ship freely', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'images', decoration.path.split('/').pop()!),
      '<svg><!-- abstract --></svg>',
      'utf8',
    );
    await writeFile(
      join(root, 'index.html'),
      `<img src="/images/${decoration.path.split('/').pop()}" />`,
      'utf8',
    );
    await expect(findPlaceholderImagesInDir(root)).resolves.toEqual([]);
  });

  it('allows the hero role — template atmosphere, not a promise about the client', async () => {
    const root = await dist();
    await writeFile(
      join(root, 'index.html'),
      `<img src="/images/${hero.path.split('/').pop()}" />`,
      'utf8',
    );
    await expect(findPlaceholderImagesInDir(root)).resolves.toEqual([]);
  });

  it('never walks node_modules and ignores unrelated images', async () => {
    const root = await dist();
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(
      join(root, 'node_modules', 'about-me-photo.svg'),
      '<svg></svg>',
      'utf8',
    );
    await writeFile(
      join(root, 'images', 'client-headshot.jpg'),
      'not-a-real-image-but-not-a-known-hash-either',
      'utf8',
    );
    await expect(findPlaceholderImagesInDir(root)).resolves.toEqual([]);
  });
});
