import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  describePlaceholderImageRepair,
  materializeScaffold,
  PLACEHOLDER_IMAGE_MANIFEST,
  sanitiseSeedPlaceholders,
} from '@flowstarter/agentic-codegen';
import { legacySeedFiles } from '@flowstarter/agentic-codegen/test/lib/legacy-seed';
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

/**
 * The regression this gate needed: a site published before the gate existed.
 *
 * Version 4 of workspace `c009105e-f8ec-42bf-bdcf-cf92bb500f45`, the manifest
 * job `2716f978-b2ed-474b-b485-f0d5584fbda7` ran against. The agent did the
 * requested change correctly and the job still failed at "Checking the build",
 * because the published manifest carries the template's whole `public/images/`
 * library and Astro copies `public/` into `dist/` verbatim — so the gate of
 * record hashed nine pictures the pages never pointed at.
 *
 * Both halves are asserted here, in one place, because either alone would be
 * misleading: the seed as published still fails, and the seed put through
 * `sanitiseSeedPlaceholders` at materialise time passes.
 */
describe('a seed published before the placeholder gate existed', () => {
  /** What Astro does with `public/`: copies it into `dist/`, whole. */
  async function buildLike(
    files: readonly {
      path: string;
      content: string;
      encoding?: 'base64';
    }[],
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), 'flowstarter-legacy-seed-'));
    temporaryDirectories.push(root);
    await materializeScaffold(
      root,
      files.map((file) => ({ ...file, type: 'file' as const })),
    );
    for (const file of files) {
      if (!file.path.startsWith('public/')) continue;
      const out = join(root, 'dist', file.path.slice('public/'.length));
      await mkdir(join(out, '..'), { recursive: true });
      await writeFile(
        out,
        Buffer.from(
          file.content,
          file.encoding === 'base64' ? 'base64' : 'utf8',
        ),
      );
    }
    // One compiled page, so the dist is a site rather than a folder of images.
    await writeFile(
      join(root, 'dist', 'index.html'),
      '<html><body><h1>Halden &amp; Roe</h1></body></html>',
      'utf8',
    );
    return join(root, 'dist');
  }

  it('fails the gate exactly as the real job did', async () => {
    const findings = await findPlaceholderImagesInDir(
      await buildLike(await legacySeedFiles()),
    );
    // Eight gated files, caught twice over — by their catalogued name and by
    // their bytes — which is why no amount of editing the pages ever cleared
    // it.
    expect(
      new Set(findings.map((finding) => finding.path.split('/').pop())),
    ).toEqual(
      new Set([
        'about-me-photo.svg',
        'boutique.png',
        'budget-dark.png',
        'budget-neoMorphism.png',
        'hotBlocks.png',
        'masonry.png',
        'somalia.png',
        'sweet-box.webp',
      ]),
    );
  });

  it('passes the gate once the seed rule has run over it', async () => {
    const sanitised = sanitiseSeedPlaceholders(await legacySeedFiles());
    await expect(
      findPlaceholderImagesInDir(await buildLike(sanitised.files)),
    ).resolves.toEqual([]);
  });

  it('still ships the client’s own picture and the allowed decoration', async () => {
    const sanitised = sanitiseSeedPlaceholders(await legacySeedFiles());
    const dist = await buildLike(sanitised.files);
    await expect(
      stat(join(dist, 'flowstarter-media', 'cr-b104b1e0.jpg')),
    ).resolves.toBeTruthy();
    await expect(
      stat(join(dist, 'images', 'studio-portrait.svg')),
    ).resolves.toBeTruthy();
  });

  it('names the exact files a repair pass may delete', async () => {
    const findings = await findPlaceholderImagesInDir(
      await buildLike(await legacySeedFiles()),
    );
    const brief = describePlaceholderImageRepair(findings);
    // #119's lesson: a repair brief that does not name its targets is an
    // invitation to guess at a paid site.
    expect(brief).toContain('  - public/images/about-me-photo.svg');
    expect(brief).toContain('  - public/images/boutique.png');
    expect(brief).toContain('Delete exactly these and no other file');
    // The one the gate allows is never on the list.
    expect(brief).not.toContain('studio-portrait.svg');
  });
});
