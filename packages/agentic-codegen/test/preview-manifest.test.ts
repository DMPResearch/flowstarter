/**
 * The manifest hygiene rules, against the run that made them necessary.
 *
 * Workspace `c009105e-f8ec-42bf-bdcf-cf92bb500f45` paid EUR 799 in full on
 * 2026-09-12 and got no site, because its `addedPhrases` were eight lines of
 * an Astro dev server's `dev.json`. The exact eight are in this file, verbatim
 * from `funnel_previews.manifest.appliedEdits[0]`, and every one of them has
 * to be rejected by rule rather than by anybody noticing.
 */
import { describe, expect, it } from 'vitest';
import type { TemplateScaffoldFile } from '../src/flowstarter/types';
import {
  isClientEditablePath,
  isPreviewToolingPath,
  isUsablePhrase,
  orderByRelevance,
  phraseFromLine,
  phrasesFromFiles,
  previewPathRelevance,
  stripPreviewToolingFiles,
  usablePhrases,
} from '../src/flowstarter/preview-manifest';

/** Verbatim, from the failed run's stored audit. */
const DEV_SERVER_PHRASES = [
  '"pid": 97132,',
  '"port": 56092,',
  '"url": "http://localhost:56092",',
  '"network": [',
  '"http://192.168.3.188:56092/"',
  '"networkInterfaceNames": [',
  '"background": false,',
  'startedAt": "2026-09-11T21:51:12.985Z',
];

const HEADLINE = 'I build websites with AI agents, supervised by people';

function file(path: string, content: string): TemplateScaffoldFile {
  return { path, content, type: 'file' };
}

describe('isPreviewToolingPath', () => {
  it('excludes every directory the 2026-09-12 manifest should never have had', () => {
    for (const path of [
      '.astro/dev.json',
      '.astro/settings.json',
      '.astro/types.d.ts',
      'node_modules/astro/package.json',
      'dist/index.html',
      '.git/HEAD',
      '.gitignore',
      '.vite/deps/chunk.js',
      '.cache/whatever',
    ]) {
      expect(isPreviewToolingPath(path)).toBe(true);
    }
  });

  it('excludes lockfiles and logs wherever they sit', () => {
    expect(isPreviewToolingPath('pnpm-lock.yaml')).toBe(true);
    expect(isPreviewToolingPath('package-lock.json')).toBe(true);
    expect(isPreviewToolingPath('yarn.lock')).toBe(true);
    expect(isPreviewToolingPath('bun.lockb')).toBe(true);
    expect(isPreviewToolingPath('logs/astro.log')).toBe(true);
    expect(isPreviewToolingPath('build.LOG')).toBe(true);
  });

  it('excludes a nested tooling directory, not only a top-level one', () => {
    expect(isPreviewToolingPath('packages/site/.astro/dev.json')).toBe(true);
    expect(isPreviewToolingPath('apps/web/node_modules/x/index.js')).toBe(true);
  });

  it('keeps everything the client actually paid for', () => {
    for (const path of [
      'src/content/site-labels.md',
      'src/pages/index.astro',
      'src/components/Hero.astro',
      'src/layouts/Layout.astro',
      'public/images/hero.png',
      'package.json',
      'astro.config.mjs',
    ]) {
      expect(isPreviewToolingPath(path)).toBe(false);
    }
  });

  it('normalises separators and a leading ./ before deciding', () => {
    expect(isPreviewToolingPath('.\\.astro\\dev.json')).toBe(true);
    expect(isPreviewToolingPath('./.astro/dev.json')).toBe(true);
    expect(isPreviewToolingPath('')).toBe(true);
  });
});

describe('stripPreviewToolingFiles', () => {
  it('leaves the site and drops the tooling, order untouched', () => {
    const kept = stripPreviewToolingFiles([
      file('.astro/dev.json', '{"pid": 97132}'),
      file('src/content/site-labels.md', 'title: x'),
      file('node_modules/astro/index.js', 'x'),
      file('src/pages/index.astro', 'x'),
    ]);
    expect(kept.map((entry) => entry.path)).toEqual([
      'src/content/site-labels.md',
      'src/pages/index.astro',
    ]);
  });
});

describe('previewPathRelevance', () => {
  it('ranks content above pages above components above layouts', () => {
    expect(previewPathRelevance('src/content/site-labels.md')).toBe(0);
    expect(previewPathRelevance('src/pages/contact.astro')).toBe(1);
    expect(previewPathRelevance('src/components/Hero.astro')).toBe(2);
    expect(previewPathRelevance('src/layouts/Layout.astro')).toBe(3);
    expect(previewPathRelevance('public/terms.md')).toBe(4);
  });

  it('refuses tooling, declarations and configuration', () => {
    expect(previewPathRelevance('.astro/dev.json')).toBe(Infinity);
    expect(previewPathRelevance('src/env.d.ts')).toBe(Infinity);
    expect(previewPathRelevance('astro.config.mjs')).toBe(Infinity);
    expect(previewPathRelevance('public/favicon.svg')).toBe(Infinity);
    expect(isClientEditablePath('package.json')).toBe(false);
    expect(isClientEditablePath('src/content/site-labels.md')).toBe(true);
  });
});

describe('orderByRelevance', () => {
  it('puts the file with the headline in it first, tooling nowhere', () => {
    expect(
      orderByRelevance([
        '.astro/settings.json',
        'src/pages/contact.astro',
        '.astro/dev.json',
        'src/content/site-labels.md',
        '.astro/types.d.ts',
      ]),
    ).toEqual(['src/content/site-labels.md', 'src/pages/contact.astro']);
  });

  it('breaks ties alphabetically so two runs agree', () => {
    expect(
      orderByRelevance(['src/pages/work.astro', 'src/pages/about.astro']),
    ).toEqual(['src/pages/about.astro', 'src/pages/work.astro']);
  });
});

describe('isUsablePhrase', () => {
  it('rejects all eight phrases the failed build was held to', () => {
    for (const phrase of DEV_SERVER_PHRASES) {
      expect(isUsablePhrase(phrase)).toBe(false);
    }
    expect(usablePhrases(DEV_SERVER_PHRASES)).toEqual([]);
  });

  it('accepts the sentence the client actually asked for', () => {
    expect(isUsablePhrase(HEADLINE)).toBe(true);
    expect(usablePhrases([HEADLINE, HEADLINE])).toEqual([HEADLINE]);
  });

  it('rejects a url, a timestamp, a json key and a line of digits', () => {
    expect(isUsablePhrase('https://cal.com/darius/intro')).toBe(false);
    expect(isUsablePhrase('Updated 2026-09-11T21:51:12.985Z')).toBe(false);
    expect(isUsablePhrase('"heroHeadline": "x"')).toBe(false);
    expect(isUsablePhrase('1 234 567 890 12')).toBe(false);
  });

  it('rejects anything too short to be evidence', () => {
    expect(isUsablePhrase('Contact us')).toBe(false);
  });
});

describe('phraseFromLine', () => {
  it('takes the value out of a keyed content line', () => {
    expect(phraseFromLine(`  title: "${HEADLINE}"`)).toBe(HEADLINE);
  });

  it('strips bullets, quotes and markdown emphasis', () => {
    expect(phraseFromLine('- **A confident opening line**')).toBe(
      'A confident opening line',
    );
    expect(phraseFromLine('## A heading long enough to count')).toBe(
      'A heading long enough to count',
    );
  });

  it('returns null for blanks, short lines and bare punctuation', () => {
    expect(phraseFromLine('   ')).toBeNull();
    expect(phraseFromLine('title: Home')).toBeNull();
    expect(phraseFromLine('----------------')).toBeNull();
    expect(phraseFromLine('https://example.com/a/b/c')).toBeNull();
  });
});

describe('phrasesFromFiles', () => {
  const files = [
    file('.astro/dev.json', `{\n  "pid": 97132,\n  "port": 56092\n}`),
    file(
      'src/content/site-labels.md',
      `---\nhero:\n  artMark: "D"\n  title: "${HEADLINE}"\n---\n`,
    ),
    file('src/pages/contact.astro', '<p>Reach me on Instagram any day</p>'),
    {
      path: 'images/hero.png',
      content: 'QUFB',
      encoding: 'base64' as const,
      type: 'file' as const,
    },
  ];

  it('reads the content file before the page and never the tooling', () => {
    expect(phrasesFromFiles(files, { limit: 8 })).toEqual([
      HEADLINE,
      // Markup and all: a phrase is the source line as it stands, which is
      // why the content collection is read before any page.
      '<p>Reach me on Instagram any day</p>',
    ]);
  });

  it('honours an explicit path list and skips paths not in the manifest', () => {
    expect(
      phrasesFromFiles(files, {
        paths: ['.astro/dev.json', 'src/content/site-labels.md', 'gone.md'],
        limit: 8,
      }),
    ).toEqual([HEADLINE]);
  });

  it("leads with the line the client's own sentence names", () => {
    // The 2026-09-12 shape: the content file's meta title and description
    // come first by position, and the headline the client asked for comes
    // last. Ranking by the instruction is what puts it back in front.
    const labels = [
      file(
        'src/content/site-labels.md',
        `siteMeta:\n  title: "Darius Mihai Popescu, product builder"\n` +
          `  description: "An AI-driven website studio for service businesses"\n` +
          `hero:\n  title: "${HEADLINE}"\n`,
      ),
    ];

    expect(
      phrasesFromFiles(labels, {
        limit: 8,
        instruction: `Make the hero headline say ${HEADLINE}`,
      })[0],
    ).toBe(HEADLINE);
    // Without the instruction it is still found, just not first.
    expect(phrasesFromFiles(labels, { limit: 8 })[0]).toBe(
      'Darius Mihai Popescu, product builder',
    );
  });

  it('stops at the limit', () => {
    expect(phrasesFromFiles(files, { limit: 1 })).toEqual([HEADLINE]);
  });

  it('skips packed bytes rather than reading base64 as prose', () => {
    expect(
      phrasesFromFiles(
        [
          {
            path: 'src/content/a.md',
            content: 'QUJDREVGR0hJSktMTU5PUFFS',
            encoding: 'base64',
            type: 'file',
          },
        ],
        { limit: 8 },
      ),
    ).toEqual([]);
  });
});
