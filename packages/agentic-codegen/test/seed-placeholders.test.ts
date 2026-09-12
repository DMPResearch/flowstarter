import { describe, expect, it } from 'vitest';
import {
  classifyPlaceholderSlot,
  describeSeedPlaceholderSanitisation,
  findPlaceholderImageReferencesInFiles,
  isGatedPlaceholderImageRole,
  PLACEHOLDER_IMAGE_MANIFEST,
  sanitiseSeedPlaceholders,
  sha256Hex,
} from '../src';
import {
  LEGACY_SEED_CLIENT_ASSET,
  LEGACY_SEED_IMAGES,
  legacySeedFiles,
} from './lib/legacy-seed';

/** The gate's own question, asked of a seed: does anything point at one? */
function gatedReferences(
  files: readonly { path: string; content: string; encoding?: 'base64' }[],
): string[] {
  return findPlaceholderImageReferencesInFiles(
    files.filter((file) => file.encoding !== 'base64'),
  )
    .filter((finding) => isGatedPlaceholderImageRole(finding.role))
    .map((finding) => finding.path);
}

/** Every gated placeholder still present in a seed, by content hash. */
function gatedFiles(
  files: readonly { path: string; content: string; encoding?: 'base64' }[],
): string[] {
  const hashes = new Set(
    PLACEHOLDER_IMAGE_MANIFEST.filter((asset) =>
      isGatedPlaceholderImageRole(asset.role),
    ).map((asset) => asset.sha256),
  );
  return files
    .filter((file) =>
      hashes.has(
        sha256Hex(
          Buffer.from(
            file.content,
            file.encoding === 'base64' ? 'base64' : 'utf8',
          ),
        ),
      ),
    )
    .map((file) => file.path)
    .sort();
}

describe('sanitiseSeedPlaceholders: the seed of a site published before #110', () => {
  it('takes the template library out of version 4 of the real workspace', async () => {
    const seed = await legacySeedFiles();

    // The bug, stated as a test first: this manifest carries eight gated
    // placeholder files, and Astro copies every one of them into `dist/`.
    expect(gatedFiles(seed)).toHaveLength(8);

    const result = sanitiseSeedPlaceholders(seed);

    // Every one of the eight is gone, referenced or not.
    expect(gatedFiles(result.files)).toEqual([]);
    expect(result.removed.map((entry) => entry.path).sort()).toEqual([
      'public/images/about-me-photo.svg',
      'public/images/boutique.png',
      'public/images/budget-dark.png',
      'public/images/budget-neoMorphism.png',
      'public/images/hotBlocks.png',
      'public/images/masonry.png',
      'public/images/somalia.png',
      'public/images/sweet-box.webp',
    ]);
    // Seven of them nothing ever pointed at; one was a live case-study cover.
    expect(result.removed.filter((entry) => entry.wasReferenced)).toHaveLength(
      1,
    );
    expect(result.removed.find((entry) => entry.wasReferenced)?.path).toBe(
      'public/images/boutique.png',
    );
  });

  it('leaves the site with nothing for the gate to find', async () => {
    const seed = await legacySeedFiles();
    expect(gatedReferences(seed)).toEqual(['src/content/site-labels.md']);

    const result = sanitiseSeedPlaceholders(seed);
    expect(gatedReferences(result.files)).toEqual([]);
  });

  it('rewrites the live cover to the typographic tile, not to a broken image', async () => {
    const result = sanitiseSeedPlaceholders(await legacySeedFiles());
    const labels = result.files.find(
      (file) => file.path === 'src/content/site-labels.md',
    );

    // An empty value, never a deleted line: `imageSrc` is the fourth key of a
    // list item, and deleting it would leave the two keys under it orphaned
    // and the frontmatter unparseable. Empty is what `CaseStudyCard.astro`
    // renders its typographic tile from.
    expect(labels?.content).toContain('imageSrc: ""');
    expect(labels?.content).not.toContain('/images/boutique.png');
    // The project itself is untouched — it is real work the client paid to
    // have written up, and only its picture was the template's.
    expect(labels?.content).toContain('Sable Coffee Roasters');
    expect(labels?.content).toContain('category: "Identity & Retail"');

    expect(result.rewritten).toEqual([
      {
        file: 'src/content/site-labels.md',
        reference: '/images/boutique.png',
        slot: 'project-cover',
        section: 'caseStudies',
      },
    ]);
  });

  it('leaves a decoration the site does render exactly where it is', async () => {
    // `studio-portrait.svg` is catalogued `decoration` — a label-free abstract
    // composition that claims nothing about the client — so #110 lets it
    // ship and this rule has no business removing it.
    const result = sanitiseSeedPlaceholders(await legacySeedFiles());
    expect(
      result.files.some(
        (file) => file.path === 'public/images/studio-portrait.svg',
      ),
    ).toBe(true);
    const labels = result.files.find(
      (file) => file.path === 'src/content/site-labels.md',
    );
    expect(labels?.content).toContain('/images/studio-portrait.svg');
  });

  it('says what it did on the timeline, in plain words', async () => {
    const result = sanitiseSeedPlaceholders(await legacySeedFiles());
    expect(result.summary).toBe(
      'Removed 7 template placeholder images the site never referenced; ' +
        'replaced the template project cover with the typographic tile.',
    );
  });

  it('never touches the client’s own picture', async () => {
    const seed = await legacySeedFiles();
    const client = seed.find((file) => file.path === LEGACY_SEED_CLIENT_ASSET)!;
    const result = sanitiseSeedPlaceholders(seed, {
      clientAssetPaths: [
        LEGACY_SEED_CLIENT_ASSET,
        '/flowstarter-media/cr-b104b1e0.jpg',
      ],
    });
    expect(
      result.files.find((file) => file.path === LEGACY_SEED_CLIENT_ASSET),
    ).toBe(client);
  });

  it('refuses to remove a client file even when it is byte-for-byte a placeholder', () => {
    // A client may legitimately upload the very picture the template shipped
    // — it is on their own delivered site, after all. A rights record beats a
    // hash match every time: deleting a file the client owns to satisfy a
    // gate is a worse failure than the one being fixed.
    const portrait = PLACEHOLDER_IMAGE_MANIFEST.find(
      (asset) => asset.id === 'creative-portfolio-about-me-photo',
    )!;
    const bytes = '<svg>placeholder</svg>';
    const files = [
      {
        path: 'public/flowstarter-media/cr-1.svg',
        content: bytes,
        type: 'file' as const,
      },
      {
        path: 'public/images/about-me-photo.svg',
        content: bytes,
        type: 'file' as const,
      },
    ];
    const result = sanitiseSeedPlaceholders(files, {
      manifest: [{ ...portrait, sha256: sha256Hex(bytes) }],
    });
    expect(result.files.map((file) => file.path)).toEqual([
      'public/flowstarter-media/cr-1.svg',
    ]);
  });

  it('is a no-op on a clean seed, down to the objects themselves', () => {
    const files = [
      {
        path: 'src/pages/index.astro',
        content: '<img src="/flowstarter-media/cr-1.jpg" alt="a shopfront" />',
        type: 'file' as const,
      },
      {
        path: 'public/images/hero.png',
        content: Buffer.from('an honest photograph').toString('base64'),
        encoding: 'base64' as const,
        type: 'file' as const,
      },
    ];
    const result = sanitiseSeedPlaceholders(files);
    expect(result.files).toBe(files);
    expect(result.removed).toEqual([]);
    expect(result.rewritten).toEqual([]);
    expect(result.summary).toBeNull();
  });

  it('removes the element rather than leaving an img with no source', () => {
    const bytes = '<svg>work thumb</svg>';
    const manifest = [
      {
        id: 'test-thumb',
        template: 'test',
        path: 'public/images/thumb.svg',
        role: 'work-thumb' as const,
        sha256: sha256Hex(bytes),
        why: 'a stand-in',
      },
    ];
    const result = sanitiseSeedPlaceholders(
      [
        {
          path: 'public/images/thumb.svg',
          content: bytes,
          type: 'file' as const,
        },
        {
          path: 'src/pages/work.astro',
          content:
            '<section>\n  <img src="/images/thumb.svg" alt="A project" />\n  <h2>Halden Press</h2>\n</section>\n',
          type: 'file' as const,
        },
        {
          path: 'src/styles/work.css',
          content:
            '.tile {\n  background-image: url("/images/thumb.svg");\n  color: red;\n}\n',
          type: 'file' as const,
        },
      ],
      { manifest },
    );

    const astro = result.files.find(
      (file) => file.path === 'src/pages/work.astro',
    );
    expect(astro?.content).not.toContain('<img');
    expect(astro?.content).toContain('<h2>Halden Press</h2>');

    const css = result.files.find(
      (file) => file.path === 'src/styles/work.css',
    );
    expect(css?.content).not.toContain('url(');
    expect(css?.content).toContain('color: red;');

    expect(result.rewritten.map((entry) => entry.slot)).toEqual([
      'project-cover',
      'project-cover',
    ]);
  });

  it('blanks a component prop, so the component renders its own fallback', () => {
    const bytes = '<svg>portrait</svg>';
    const result = sanitiseSeedPlaceholders(
      [
        {
          path: 'public/images/face.svg',
          content: bytes,
          type: 'file' as const,
        },
        {
          path: 'src/pages/about.astro',
          content: '<AboutStory imageSrc="/images/face.svg" name="Roe" />\n',
          type: 'file' as const,
        },
      ],
      {
        manifest: [
          {
            id: 'test-portrait',
            template: 'test',
            path: 'public/images/face.svg',
            role: 'portrait' as const,
            sha256: sha256Hex(bytes),
            why: 'a stand-in',
          },
        ],
      },
    );
    const about = result.files.find(
      (file) => file.path === 'src/pages/about.astro',
    );
    expect(about?.content).toBe('<AboutStory imageSrc="" name="Roe" />\n');
    expect(result.rewritten[0]?.slot).toBe('portrait');
  });
});

describe('classifyPlaceholderSlot', () => {
  it('reads the slot off the content key before the asset’s own role', () => {
    // A portrait placeholder used as the hero leaves a hero with no image,
    // not an initials disc: what renders is decided by the slot, not by what
    // the picture was drawn to be.
    expect(
      classifyPlaceholderSlot({
        role: 'portrait',
        section: 'hero',
        key: 'image',
      }),
    ).toBe('hero');
    expect(
      classifyPlaceholderSlot({
        role: 'work-thumb',
        section: 'aboutStory',
        key: 'imageSrc',
      }),
    ).toBe('portrait');
    expect(
      classifyPlaceholderSlot({
        role: 'portrait',
        section: 'caseStudies',
        key: 'imageSrc',
      }),
    ).toBe('project-cover');
  });

  it('falls back to the role when the context says nothing', () => {
    expect(classifyPlaceholderSlot({ role: 'portrait' })).toBe('portrait');
    expect(classifyPlaceholderSlot({ role: 'work-thumb' })).toBe(
      'project-cover',
    );
    expect(classifyPlaceholderSlot({ role: 'hero' })).toBe('hero');
    expect(classifyPlaceholderSlot({ role: 'decoration' })).toBe('image');
  });
});

describe('describeSeedPlaceholderSanitisation', () => {
  it('says nothing at all when nothing happened', () => {
    expect(describeSeedPlaceholderSanitisation([], [])).toBeNull();
  });

  it('counts in the singular when there is one of a thing', () => {
    expect(
      describeSeedPlaceholderSanitisation(
        [
          {
            path: 'public/images/somalia.png',
            reference: '/images/somalia.png',
            role: 'work-thumb',
            assetId: 'creative-portfolio-somalia',
            wasReferenced: false,
          },
        ],
        [
          {
            file: 'src/content/site-labels.md',
            reference: '/images/about-me-photo.svg',
            slot: 'portrait',
            section: 'aboutStory',
          },
        ],
      ),
    ).toBe(
      'Removed 1 template placeholder image the site never referenced; ' +
        'replaced the template portrait with the no-photo layout.',
    );
  });

  it('groups repeats rather than repeating itself', () => {
    const rewrites = (['project-cover', 'project-cover', 'hero'] as const).map(
      (slot, index) => ({
        file: `src/pages/${index}.astro`,
        reference: '/images/x.png',
        slot,
        section: 'markup',
      }),
    );
    expect(describeSeedPlaceholderSanitisation([], rewrites)).toBe(
      'replaced 2 template project covers with typographic tiles; ' +
        'removed the template hero image.',
    );
  });
});

describe('the fixture itself', () => {
  it('is the nine files the failure named', async () => {
    const seed = await legacySeedFiles();
    expect(
      seed
        .filter((file) => file.path.startsWith('public/images/'))
        .map((file) => file.path.split('/').pop()),
    ).toEqual([...LEGACY_SEED_IMAGES]);
  });
});
