import {
  mkdtemp,
  mkdir,
  readdir,
  readFile,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { injectPreviewTeaser } from '../src/flowstarter/preview-teaser';
import {
  describePreviewTeaserIssue,
  findPreviewTeaserReferences,
  isPreviewTeaserAsset,
  PREVIEW_TEASER_ASSETS,
  PREVIEW_TEASER_MARKER,
  stripPreviewTeaserFromFiles,
  stripPreviewTeaserFromText,
  TEASER_IN_PAID_BUILD,
} from '../src/flowstarter/teaser-rule';
import type { TemplateScaffoldFile } from '../src/flowstarter/types';

const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

const LAYOUT = [
  '---',
  'const { title } = Astro.props;',
  '---',
  '<html>',
  '  <head>',
  '    <title>{title}</title>',
  '  </head>',
  '  <body><slot /></body>',
  '</html>',
  '',
].join('\n');

/**
 * The injector and the rule have to agree on one marker string. Reading the
 * teaser the injector actually writes, rather than restating it, is what makes
 * that a fact instead of a convention.
 */
async function injectedPreview(): Promise<TemplateScaffoldFile[]> {
  const root = await mkdtemp(join(tmpdir(), 'flowstarter-teaser-'));
  temporaryDirectories.push(root);
  await mkdir(join(root, 'src', 'layouts'), { recursive: true });
  await writeFile(join(root, 'src', 'layouts', 'Layout.astro'), LAYOUT, 'utf8');
  await injectPreviewTeaser(root, { keepHomeSections: 2 });

  const files: TemplateScaffoldFile[] = [
    {
      path: 'src/layouts/Layout.astro',
      content: await readFile(
        join(root, 'src', 'layouts', 'Layout.astro'),
        'utf8',
      ),
      type: 'file',
    },
  ];
  for (const name of await readdir(join(root, 'public'))) {
    files.push({
      path: `public/${name}`,
      content: await readFile(join(root, 'public', name), 'utf8'),
      type: 'file',
    });
  }
  return files;
}

describe('what the injector leaves behind', () => {
  it('writes both assets and patches every layout, which is what a paid build inherits', async () => {
    const files = await injectedPreview();
    const paths = files.map((file) => file.path).sort();
    expect(paths).toEqual(
      [...PREVIEW_TEASER_ASSETS]
        .sort()
        .concat('src/layouts/Layout.astro')
        .sort(),
    );

    const layout = files.find(
      (file) => file.path === 'src/layouts/Layout.astro',
    );
    expect(layout?.content).toContain(PREVIEW_TEASER_MARKER);
    expect(layout?.content).toContain(`/${PREVIEW_TEASER_MARKER}.js`);
  });
});

describe('isPreviewTeaserAsset', () => {
  it('knows the teaser assets by name, at the source path and at the built path', () => {
    expect(isPreviewTeaserAsset(`public/${PREVIEW_TEASER_MARKER}.js`)).toBe(
      true,
    );
    expect(isPreviewTeaserAsset(`public/${PREVIEW_TEASER_MARKER}.css`)).toBe(
      true,
    );
    // In a built dist the file sits at the root, not under public/.
    expect(isPreviewTeaserAsset(`${PREVIEW_TEASER_MARKER}.js`)).toBe(true);
    expect(isPreviewTeaserAsset(`./${PREVIEW_TEASER_MARKER}.css`)).toBe(true);
    expect(isPreviewTeaserAsset('public/favicon.svg')).toBe(false);
  });
});

describe('stripPreviewTeaserFromText', () => {
  it('takes out the comment, the stylesheet and the script and nothing else', async () => {
    const files = await injectedPreview();
    const layout = files.find(
      (file) => file.path === 'src/layouts/Layout.astro',
    )?.content as string;

    const stripped = stripPreviewTeaserFromText(layout);
    expect(stripped).not.toContain(PREVIEW_TEASER_MARKER);
    expect(stripped).toContain('</head>');
    expect(stripped).toContain('<title>{title}</title>');
    expect(stripped).toContain('<slot />');
  });

  it('handles the snippet folded onto one line with its neighbours', () => {
    const folded =
      `<head><meta charset="utf-8" /><!-- ${PREVIEW_TEASER_MARKER} -->` +
      `<link rel="stylesheet" href="/${PREVIEW_TEASER_MARKER}.css" />` +
      `<script defer src="/${PREVIEW_TEASER_MARKER}.js"></script></head>`;
    expect(stripPreviewTeaserFromText(folded)).toBe(
      '<head><meta charset="utf-8" /></head>',
    );
  });

  it('leaves a clean file byte identical', () => {
    expect(stripPreviewTeaserFromText(LAYOUT)).toBe(LAYOUT);
  });
});

describe('stripPreviewTeaserFromFiles', () => {
  it('gives a paid build a seed with no teaser in it', async () => {
    const preview = [
      ...(await injectedPreview()),
      {
        path: 'src/content/site-labels.md',
        content: 'Calm Path Therapy',
        type: 'file' as const,
      },
      {
        path: 'public/hero.png',
        content: 'iVBORw0KGgo=',
        encoding: 'base64' as const,
        type: 'file' as const,
      },
    ];

    const stripped = stripPreviewTeaserFromFiles(preview);
    expect(stripped.removedPaths.sort()).toEqual(
      [...PREVIEW_TEASER_ASSETS].sort(),
    );
    expect(stripped.cleanedPaths).toEqual(['src/layouts/Layout.astro']);
    expect(findPreviewTeaserReferences(stripped.files)).toEqual([]);
    // The client's own content and images are untouched.
    expect(
      stripped.files.find((file) => file.path === 'public/hero.png')?.content,
    ).toBe('iVBORw0KGgo=');
    expect(
      stripped.files.find((file) => file.path === 'src/content/site-labels.md')
        ?.content,
    ).toBe('Calm Path Therapy');
  });

  it('is a no-op on a manifest that never had a teaser', () => {
    const clean = [
      {
        path: 'src/layouts/Layout.astro',
        content: LAYOUT,
        type: 'file' as const,
      },
    ];
    const stripped = stripPreviewTeaserFromFiles(clean);
    expect(stripped.removedPaths).toEqual([]);
    expect(stripped.cleanedPaths).toEqual([]);
    expect(stripped.files).toEqual(clean);
  });
});

describe('findPreviewTeaserReferences', () => {
  it('catches the script reference a built page carries', () => {
    expect(
      findPreviewTeaserReferences([
        {
          path: 'dist/about/index.html',
          content: `<script defer src="/${PREVIEW_TEASER_MARKER}.js"></script>`,
        },
      ]),
    ).toEqual(['dist/about/index.html']);
  });

  it('catches the overlay markup even with the script renamed away', () => {
    expect(
      findPreviewTeaserReferences([
        {
          path: 'dist/index.html',
          content:
            '<section class="fs-teaser-locked"><a class="fs-teaser-veil"></a></section>',
        },
      ]),
    ).toEqual(['dist/index.html']);
  });

  it('catches the asset file itself, wherever the build put it', () => {
    expect(
      findPreviewTeaserReferences([
        { path: `${PREVIEW_TEASER_MARKER}.js`, content: '' },
      ]),
    ).toEqual([`${PREVIEW_TEASER_MARKER}.js`]);
  });

  it('says nothing about an ordinary built page', () => {
    expect(
      findPreviewTeaserReferences([
        { path: 'dist/index.html', content: '<h1>Calm Path Therapy</h1>' },
      ]),
    ).toEqual([]);
  });
});

describe('describePreviewTeaserIssue', () => {
  it('carries the code, the reason and the offending paths', () => {
    const message = describePreviewTeaserIssue([
      'index.html',
      'about/index.html',
    ]);
    expect(message.startsWith(TEASER_IN_PAID_BUILD)).toBe(true);
    expect(message).toContain('already paid for');
    expect(message).toContain('about/index.html');
  });

  it('caps the list rather than printing a whole ten-page site', () => {
    const paths = Array.from(
      { length: 14 },
      (_, index) => `page-${index}.html`,
    );
    const message = describePreviewTeaserIssue(paths);
    expect(message).toContain('and 4 more');
  });
});
