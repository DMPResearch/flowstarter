import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  describePlaceholderImageIssue,
  findPlaceholderImageByFilename,
  findPlaceholderImageByHash,
  findPlaceholderImageMarkersInText,
  findPlaceholderImageReferencesInFiles,
  GATED_PLACEHOLDER_IMAGE_ROLES,
  isGatedPlaceholderImageRole,
  PLACEHOLDER_IMAGE_FILENAME_PREFIX,
  PLACEHOLDER_IMAGE_MANIFEST,
  PLACEHOLDER_IMAGE_MARKER_ATTR,
  PLACEHOLDER_IMAGE_SHIPPED,
  sha256Hex,
} from '../src/flowstarter/placeholder-images';

describe('the manifest', () => {
  it('is non-empty, uniquely identified, and every hash is a sha256 hex digest', () => {
    expect(PLACEHOLDER_IMAGE_MANIFEST.length).toBeGreaterThan(0);
    const ids = PLACEHOLDER_IMAGE_MANIFEST.map((asset) => asset.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const asset of PLACEHOLDER_IMAGE_MANIFEST) {
      expect(asset.sha256).toMatch(/^[0-9a-f]{64}$/);
      expect(asset.why.length).toBeGreaterThan(10);
      expect(asset.path.startsWith('public/')).toBe(true);
    }
  });

  it('carries at least one row for each role, including the allowed ones', () => {
    const roles = new Set(
      PLACEHOLDER_IMAGE_MANIFEST.map((asset) => asset.role),
    );
    expect(roles.has('portrait')).toBe(true);
    expect(roles.has('work-thumb')).toBe(true);
    expect(roles.has('decoration')).toBe(true);
    expect(roles.has('hero')).toBe(true);
  });

  it('gates exactly portrait and work-thumb', () => {
    expect(GATED_PLACEHOLDER_IMAGE_ROLES).toEqual(['portrait', 'work-thumb']);
    expect(isGatedPlaceholderImageRole('portrait')).toBe(true);
    expect(isGatedPlaceholderImageRole('work-thumb')).toBe(true);
    expect(isGatedPlaceholderImageRole('decoration')).toBe(false);
    expect(isGatedPlaceholderImageRole('hero')).toBe(false);
  });

  it('records the incident: creative-portfolio and dorin-portfolio ship the same portrait placeholder', () => {
    const portraits = PLACEHOLDER_IMAGE_MANIFEST.filter(
      (asset) => asset.role === 'portrait',
    );
    expect(portraits.map((asset) => asset.template).sort()).toEqual([
      'creative-portfolio',
      'dorin-portfolio',
    ]);
    expect(new Set(portraits.map((asset) => asset.sha256)).size).toBe(1);
  });
});

describe('findPlaceholderImageByFilename', () => {
  it('catches a known gated asset by basename, wherever it is copied to', () => {
    const finding = findPlaceholderImageByFilename('images/about-me-photo.svg');
    expect(finding?.role).toBe('portrait');
    expect(finding?.reason).toBe('known-asset');
    expect(finding?.asset?.id).toBe('creative-portfolio-about-me-photo');
  });

  it('catches a work-thumb asset by basename', () => {
    const finding = findPlaceholderImageByFilename('dist/images/boutique.png');
    expect(finding?.role).toBe('work-thumb');
  });

  it('does not flag a decoration or hero asset', () => {
    expect(
      findPlaceholderImageByFilename('images/studio-portrait.svg'),
    ).toBeUndefined();
    expect(findPlaceholderImageByFilename('images/hero.png')).toBeUndefined();
  });

  it('recognizes the naming convention for a future template', () => {
    expect(PLACEHOLDER_IMAGE_FILENAME_PREFIX).toBe('placeholder-');
    const portrait = findPlaceholderImageByFilename(
      'images/placeholder-portrait-founder.svg',
    );
    expect(portrait?.role).toBe('portrait');
    expect(portrait?.reason).toBe('filename-convention');

    const workThumb = findPlaceholderImageByFilename(
      'images/placeholder-work-thumb-1.png',
    );
    expect(workThumb?.role).toBe('work-thumb');
  });

  it('does not fire on an honest filename that merely starts with "placeholder-"', () => {
    expect(
      findPlaceholderImageByFilename('images/placeholder-favicon.svg'),
    ).toBeUndefined();
  });

  it('says nothing about a file it has never heard of', () => {
    expect(
      findPlaceholderImageByFilename('images/client-headshot.jpg'),
    ).toBeUndefined();
  });
});

/** Where the live library actually lives, from this package's test dir. */
const TEMPLATES = join(
  __dirname,
  '..',
  '..',
  '..',
  'apps',
  'flowstarter-templates',
);

describe('findPlaceholderImageByHash', () => {
  it('catches the real shipped file by content hash, under any name', async () => {
    const asset = PLACEHOLDER_IMAGE_MANIFEST.find(
      (candidate) => candidate.id === 'creative-portfolio-about-me-photo',
    )!;
    const bytes = await readFile(join(TEMPLATES, asset.template, asset.path));
    expect(sha256Hex(bytes)).toBe(asset.sha256);

    // A hash match fires even when the path gives no hint at all. Both
    // templates ship the identical bytes, so only the role (not which of the
    // two manifest rows) is asserted here.
    const finding = findPlaceholderImageByHash(
      'images/renamed-photo.svg',
      bytes,
    );
    expect(finding?.role).toBe('portrait');
    expect(finding?.asset?.sha256).toBe(asset.sha256);
  });

  it('is keyed off the manifest, not a guess: unrelated bytes never match', () => {
    const bytes = Buffer.from('<svg>an honest, original illustration</svg>');
    expect(findPlaceholderImageByHash('images/x.svg', bytes)).toBeUndefined();
  });

  it('ignores non-image extensions regardless of content', () => {
    expect(
      findPlaceholderImageByHash(
        'images/about-me-photo.svg.txt',
        Buffer.from('x'),
      ),
    ).toBeUndefined();
  });
});

describe('findPlaceholderImageMarkersInText', () => {
  it('catches the marker attribute for a gated role', () => {
    const findings = findPlaceholderImageMarkersInText(
      'dist/about/index.html',
      `<img data-flowstarter-placeholder="portrait" src="/images/inline.svg" />`,
    );
    expect(findings).toHaveLength(1);
    expect(findings[0]?.role).toBe('portrait');
    expect(findings[0]?.reason).toBe('marker-attribute');
    expect(PLACEHOLDER_IMAGE_MARKER_ATTR).toBe('data-flowstarter-placeholder');
  });

  it('catches work-thumb the same way, single or double quoted', () => {
    expect(
      findPlaceholderImageMarkersInText(
        'dist/work/index.html',
        `<div data-flowstarter-placeholder='work-thumb'></div>`,
      ),
    ).toHaveLength(1);
  });

  it('does not treat a self-declared decoration marker as a finding this scanner returns as gated', () => {
    const findings = findPlaceholderImageMarkersInText(
      'dist/index.html',
      `<div data-flowstarter-placeholder="decoration"></div>`,
    );
    expect(findings).toEqual([]);
  });

  it('only reads text-shaped output', () => {
    expect(
      findPlaceholderImageMarkersInText(
        'dist/images/photo.png',
        'data-flowstarter-placeholder="portrait"',
      ),
    ).toEqual([]);
  });
});

describe('findPlaceholderImageReferencesInFiles', () => {
  it('catches a known portrait path referenced from compiled markup', () => {
    const findings = findPlaceholderImageReferencesInFiles([
      {
        path: 'dist/about/index.html',
        content: '<img src="/images/about-me-photo.svg" alt="About" />',
      },
    ]);
    expect(findings.map((finding) => finding.role)).toContain('portrait');
  });

  it('catches a known work-thumb path referenced from a case-study card', () => {
    const findings = findPlaceholderImageReferencesInFiles([
      {
        path: 'dist/work/index.html',
        content: '<img src="/images/somalia.png" alt="Editorial" />',
      },
    ]);
    expect(findings.map((finding) => finding.role)).toContain('work-thumb');
  });

  it('says nothing about a decoration or hero reference — the allowed case', () => {
    const findings = findPlaceholderImageReferencesInFiles([
      {
        path: 'dist/about/index.html',
        content:
          '<img src="/images/studio-portrait.svg" alt="" />' +
          '<img src="/images/hero.png" alt="" />',
      },
    ]);
    expect(findings).toEqual([]);
  });

  it('says nothing about a page with the client’s own photo', () => {
    const findings = findPlaceholderImageReferencesInFiles([
      {
        path: 'dist/about/index.html',
        content: '<img src="/images/client-headshot.jpg" alt="Jane Doe" />',
      },
    ]);
    expect(findings).toEqual([]);
  });
});

describe('describePlaceholderImageIssue', () => {
  it('carries the code, the role and the path', () => {
    const message = describePlaceholderImageIssue(
      findPlaceholderImageReferencesInFiles([
        {
          path: 'dist/about/index.html',
          content: '<img src="/images/about-me-photo.svg" />',
        },
      ]),
    );
    expect(message.startsWith(PLACEHOLDER_IMAGE_SHIPPED)).toBe(true);
    expect(message).toContain('dist/about/index.html');
    expect(message).toContain('portrait');
  });
});
