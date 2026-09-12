/**
 * What a paid build is actually made from.
 *
 * The 2026-09-12 review found the brief collected and then discarded: the
 * client wrote their offer, listed their real projects and confirmed the
 * rights on their photographs, and none of it reached generation. This module
 * is the carrier, and the two rules that make it safe are asserted here --
 * `loadUsableAssets` is the only reader, so an unconfirmed file cannot enter a
 * payload; and paths are minted from the asset id rather than taken from
 * anything a client supplied.
 */
import { describe, expect, it } from 'vitest';
import {
  briefAssetPath,
  briefBuildReason,
  composeBriefInput,
} from '../brief-build-input';
import type { BriefView } from '../brief-data';
import type { UsableAsset } from '../generation-assets';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const PORTRAIT_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';
const SHOT_ID = 'c2f0f3a1-9b2e-4a7c-8d1f-6b5a4c3d2e10';
const REFERENCE_ID = 'd31f2c44-1a7e-4f5b-9c80-2e6d7a8b9c01';
const PHOTO_ID = 'e4a5b6c7-8d9e-4f01-8234-56789abcdef0';

function usable(overrides: Partial<UsableAsset> = {}): UsableAsset {
  return {
    id: PORTRAIT_ID,
    storagePath: `tenant/${WORKSPACE_ID}/assets/e1619dc9.jpg`,
    mime: 'image/jpeg',
    width: 1600,
    height: 1600,
    usableFor: ['section'],
    caption: 'Ana at her desk',
    kind: 'portrait',
    ...overrides,
  };
}

function brief(overrides: Partial<BriefView> = {}): BriefView {
  return {
    offer: '  Calm, plain-language bookkeeping for founders.  ',
    projects: [
      {
        name: ' Ereno ',
        line: 'A calm inbox for freelance invoices.',
        link: 'https://ereno.example',
        screenshotAssetIds: [SHOT_ID],
      },
    ],
    noProjects: false,
    designReferenceAssetIds: [REFERENCE_ID],
    photoAssetIds: [PORTRAIT_ID, PHOTO_ID],
    portraitAssetId: PORTRAIT_ID,
    readyAt: '2026-09-12T09:00:00.000Z',
    overrideAt: null,
    ...overrides,
  };
}

const everyAsset: UsableAsset[] = [
  usable(),
  usable({
    id: SHOT_ID,
    storagePath: `tenant/${WORKSPACE_ID}/assets/shot.png`,
    mime: 'image/png',
    caption: 'The Ereno inbox',
    kind: null,
  }),
  usable({
    id: REFERENCE_ID,
    storagePath: `tenant/${WORKSPACE_ID}/assets/reference.png`,
    mime: 'image/png',
    caption: 'Airy grid',
    kind: null,
  }),
  usable({
    id: PHOTO_ID,
    storagePath: `tenant/${WORKSPACE_ID}/assets/studio.jpg`,
    caption: 'The studio',
    kind: null,
  }),
];

describe('briefAssetPath', () => {
  it('mints a path from the asset id and the stored extension', () => {
    expect(briefAssetPath(usable())).toBe(
      '/flowstarter-media/brief-b104b1e0.jpg'
    );
  });

  it('falls back to the mime type when the stored path has no extension', () => {
    expect(
      briefAssetPath(
        usable({ storagePath: `tenant/${WORKSPACE_ID}/assets/e1619dc9` })
      )
    ).toBe('/flowstarter-media/brief-b104b1e0.jpg');
  });

  it('never lets a client-supplied name reach the filename', () => {
    const path = briefAssetPath(
      usable({ caption: '../../etc/passwd', mime: 'image/png' })
    );
    expect(path).toBe('/flowstarter-media/brief-b104b1e0.jpg');
    expect(path).not.toContain('..');
  });
});

describe('composeBriefInput', () => {
  it('carries the offer, the projects and every file with its public path', () => {
    const input = composeBriefInput({
      brief: brief(),
      assets: everyAsset,
      reason: 'brief_ready',
      pageCount: '5-7',
      now: new Date('2026-09-12T10:00:00.000Z'),
    });

    expect(input.version).toBe(1);
    expect(input.composedAt).toBe('2026-09-12T10:00:00.000Z');
    expect(input.reason).toBe('brief_ready');
    expect(input.offer).toBe('Calm, plain-language bookkeeping for founders.');
    expect(input.projects).toHaveLength(1);
    expect(input.projects[0]?.name).toBe('Ereno');
    expect(input.projects[0]?.screenshots[0]).toMatchObject({
      assetId: SHOT_ID,
      publicPath: '/flowstarter-media/brief-c2f0f3a1.png',
      manifestPath: 'public/flowstarter-media/brief-c2f0f3a1.png',
      role: 'project-screenshot',
      caption: 'The Ereno inbox',
    });
    expect(input.portrait?.publicPath).toBe(
      '/flowstarter-media/brief-b104b1e0.jpg'
    );
    expect(input.designReferences.map((asset) => asset.role)).toEqual([
      'design-reference',
    ]);
    expect(input.pageCount).toBe('5-7');
  });

  it('lists the portrait once, as the portrait', () => {
    const input = composeBriefInput({
      brief: brief(),
      assets: everyAsset,
      reason: 'brief_ready',
    });
    expect(input.photos.map((photo) => photo.assetId)).toEqual([PHOTO_ID]);
    expect(input.portrait?.assetId).toBe(PORTRAIT_ID);
  });

  it('never carries a file whose rights are not confirmed', () => {
    // `loadUsableAssets` is the only reader, and it filters on
    // `rights_confirmed_at`. An id the client named that is not in its answer
    // is a file we hold and may not publish.
    const withoutPortrait = everyAsset.filter(
      (asset) => asset.id !== PORTRAIT_ID
    );
    const input = composeBriefInput({
      brief: brief(),
      assets: withoutPortrait,
      reason: 'brief_ready',
    });
    expect(input.portrait).toBeNull();
    expect(input.photos.map((photo) => photo.assetId)).toEqual([PHOTO_ID]);
    expect(JSON.stringify(input).includes('brief-b104b1e0')).toBe(false);
  });

  it('keeps "asked, and they have none" distinguishable from "nobody asked"', () => {
    const none = composeBriefInput({
      brief: brief({ projects: [], noProjects: true }),
      assets: everyAsset,
      reason: 'brief_ready',
    });
    expect(none.projects).toEqual([]);
    expect(none.noProjects).toBe(true);

    const waived = composeBriefInput({
      brief: brief({
        projects: [],
        noProjects: false,
        readyAt: null,
        overrideAt: '2026-09-12T09:00:00.000Z',
      }),
      assets: everyAsset,
      reason: 'operator_override',
    });
    // An operator waiving a brief must not be dressed up as the client saying
    // they have no work: the gate reads those two differently.
    expect(waived.noProjects).toBe(false);
    expect(waived.reason).toBe('operator_override');
  });

  it('drops a project with no name rather than shipping an empty heading', () => {
    const input = composeBriefInput({
      brief: brief({
        projects: [
          { name: '   ', line: 'x', link: '', screenshotAssetIds: [] },
          { name: 'Ereno', line: '', link: '', screenshotAssetIds: [] },
        ],
      }),
      assets: everyAsset,
      reason: 'brief_ready',
    });
    expect(input.projects.map((project) => project.name)).toEqual(['Ereno']);
  });
});

describe('briefBuildReason', () => {
  it('is the same two conditions the build worker checks', () => {
    expect(briefBuildReason({ readyAt: 'now', overrideAt: null })).toBe(
      'brief_ready'
    );
    expect(briefBuildReason({ readyAt: null, overrideAt: 'now' })).toBe(
      'operator_override'
    );
    expect(briefBuildReason({ readyAt: null, overrideAt: null })).toBeNull();
  });

  it('prefers a completed brief over an override that preceded it', () => {
    expect(briefBuildReason({ readyAt: 'later', overrideAt: 'earlier' })).toBe(
      'brief_ready'
    );
  });
});
