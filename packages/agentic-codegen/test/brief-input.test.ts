/**
 * The carrier that takes the in-depth brief from the client's dashboard to the
 * build agent.
 *
 * The defect this exists for: everything the brief collected -- the offer, the
 * real projects, the photographs, the design references -- was written to
 * `workspace_briefs` and then never reached generation. `intake.projects` was
 * always absent, so the page-set rule never dropped a work page, the
 * invented-project gate never had a name to check against, and the site was
 * written from four intake answers and a preview. These tests pin the four
 * properties that make the fix safe: the parse is defensive, an empty list is
 * an answer, the merge only touches what the brief owns, and the paragraph the
 * agent reads names every project and every path.
 */
import { describe, expect, it } from 'vitest';
import {
  BRIEF_INPUT_VERSION,
  briefInputAssets,
  describeBriefInput,
  mergeBriefIntoIntake,
  parseBriefInput,
  withoutMissingAssets,
  type BriefInput,
} from '../src/flowstarter/brief-input';
import { buildFullSiteTask } from '../src/flowstarter/prompts';
import type {
  BrandConfig,
  BusinessIntakePayload,
} from '../src/flowstarter/types';

const PORTRAIT_ID = 'b104b1e0-6d4c-4a3e-9230-13cc17b426a0';
const SHOT_ID = 'c2f0f3a1-9b2e-4a7c-8d1f-6b5a4c3d2e10';
const REFERENCE_ID = 'd31f2c44-1a7e-4f5b-9c80-2e6d7a8b9c01';
const PHOTO_ID = 'e4a5b6c7-8d9e-4f01-8234-56789abcdef0';

function asset(
  id: string,
  name: string,
  caption = '',
): Record<string, unknown> {
  return {
    assetId: id,
    publicPath: `/flowstarter-media/${name}`,
    manifestPath: `public/flowstarter-media/${name}`,
    caption,
    mime: 'image/jpeg',
    width: 1600,
    height: 1000,
  };
}

function payload(overrides: Record<string, unknown> = {}): unknown {
  return {
    trigger: 'deposit_paid',
    briefInput: {
      version: BRIEF_INPUT_VERSION,
      composedAt: '2026-09-12T10:00:00.000Z',
      reason: 'brief_ready',
      offer: 'Calm, plain-language accounting for people who hate accounting.',
      projects: [
        {
          name: 'Ereno',
          line: 'A calm inbox for freelance invoices.',
          link: 'https://ereno.example',
          screenshotAssetIds: [SHOT_ID],
          screenshots: [
            asset(SHOT_ID, 'brief-c2f0f3a1.png', 'The Ereno inbox'),
          ],
        },
      ],
      noProjects: false,
      designReferences: [
        asset(REFERENCE_ID, 'brief-d31f2c44.png', 'Airy grid'),
      ],
      photos: [asset(PHOTO_ID, 'brief-e4a5b6c7.jpg', 'The studio')],
      portrait: asset(PORTRAIT_ID, 'brief-b104b1e0.jpg', 'Ana at her desk'),
      pageCount: '5-7',
      tone: { adjectives: ['calm', 'precise', 'warm'], voice: 'Plain words.' },
      ...overrides,
    },
  };
}

function intake(): BusinessIntakePayload {
  return {
    projectId: '0f4e1088-8d8f-4f18-83b1-406cc292b23c',
    business: {
      name: 'Ana Pop',
      niche: 'Bookkeeping',
      location: 'Cluj',
    },
    socialMedia: [],
    locale: 'en',
    submittedAt: '2026-09-01T10:00:00.000Z',
    consent: { publicProfileAnalysis: true, acceptedAt: '2026-09-01' },
  };
}

describe('parseBriefInput', () => {
  it('reads a well-formed brief off a job payload', () => {
    const brief = parseBriefInput(payload());
    expect(brief?.offer).toContain('plain-language accounting');
    expect(brief?.projects.map((project) => project.name)).toEqual(['Ereno']);
    expect(brief?.portrait?.publicPath).toBe(
      '/flowstarter-media/brief-b104b1e0.jpg',
    );
    expect(brief?.tone?.adjectives).toEqual(['calm', 'precise', 'warm']);
  });

  it('returns null for a payload that has no brief, so a pre-brief build is untouched', () => {
    expect(parseBriefInput({ trigger: 'deposit_paid' })).toBeNull();
    expect(parseBriefInput(null)).toBeNull();
    expect(parseBriefInput('nonsense')).toBeNull();
  });

  it('refuses a version it does not understand rather than half-applying it', () => {
    expect(parseBriefInput(payload({ version: 99 }))).toBeNull();
  });

  it('mints the manifest path itself and refuses one outside the media directory', () => {
    const brief = parseBriefInput(
      payload({
        photos: [
          {
            ...asset(PHOTO_ID, 'ok.jpg'),
            // A hand-edited row must not be able to point a build at a path
            // of its choosing.
            manifestPath: '../../etc/passwd',
          },
          { ...asset(REFERENCE_ID, 'x.jpg'), publicPath: '/etc/passwd' },
          {
            ...asset(SHOT_ID, 'y.jpg'),
            publicPath: '/flowstarter-media/../secret.jpg',
          },
        ],
        portrait: null,
      }),
    );
    expect(brief?.photos).toHaveLength(1);
    expect(brief?.photos[0]?.manifestPath).toBe(
      'public/flowstarter-media/ok.jpg',
    );
  });

  it('drops a project link that is not absolute https', () => {
    const brief = parseBriefInput(
      payload({
        projects: [
          {
            name: 'Ereno',
            line: '',
            link: 'javascript:alert(1)',
            screenshotAssetIds: [],
            screenshots: [],
          },
        ],
      }),
    );
    expect(brief?.projects[0]?.link).toBe('');
  });
});

describe('mergeBriefIntoIntake', () => {
  it('lays the brief over the intake without touching what the intake owns', () => {
    const merged = mergeBriefIntoIntake(intake(), parseBriefInput(payload()));
    expect(merged.business.name).toBe('Ana Pop');
    expect(merged.offer).toContain('plain-language accounting');
    expect(merged.projects?.map((project) => project.name)).toEqual(['Ereno']);
    expect(merged.projects?.[0]?.screenshots?.[0]?.publicPath).toBe(
      '/flowstarter-media/brief-c2f0f3a1.png',
    );
    // The portrait is first and is the only photo carrying that kind.
    expect(merged.photos?.[0]?.kind).toBe('portrait');
    expect(merged.designReferences).toHaveLength(1);
    expect(merged.tone?.voice).toBe('Plain words.');
  });

  it('sets projects to an empty array when the client answered "none", because that is the answer the gates read', () => {
    const merged = mergeBriefIntoIntake(
      intake(),
      parseBriefInput(payload({ projects: [], noProjects: true })),
    );
    expect(merged.projects).toEqual([]);
    expect(Array.isArray(merged.projects)).toBe(true);
  });

  it('leaves the intake exactly as it was when there is no brief', () => {
    const original = intake();
    expect(mergeBriefIntoIntake(original, null)).toBe(original);
    expect(mergeBriefIntoIntake(original, null).projects).toBeUndefined();
  });

  it('never overwrites an intake that already carries its own tone or page count', () => {
    const withTone: BusinessIntakePayload = {
      ...intake(),
      business: { ...intake().business, pageCount: 'lt-5' },
      tone: { adjectives: ['bold', 'dry', 'short'], voice: 'Its own.' },
    };
    const merged = mergeBriefIntoIntake(withTone, parseBriefInput(payload()));
    expect(merged.business.pageCount).toBe('lt-5');
    expect(merged.tone?.voice).toBe('Its own.');
  });
});

describe('withoutMissingAssets', () => {
  it('takes out every path the worker could not deliver, and keeps the project', () => {
    const brief = parseBriefInput(payload()) as BriefInput;
    const delivered = new Set(['public/flowstarter-media/brief-e4a5b6c7.jpg']);
    const pruned = withoutMissingAssets(brief, delivered);
    expect(pruned.portrait).toBeNull();
    expect(pruned.projects[0]?.screenshots).toEqual([]);
    // The work is still real; it simply has no picture.
    expect(pruned.projects[0]?.name).toBe('Ereno');
    expect(pruned.photos).toHaveLength(1);
    expect(pruned.designReferences).toEqual([]);
  });
});

describe('briefInputAssets', () => {
  it('lists every file once, portrait first', () => {
    const brief = parseBriefInput(payload()) as BriefInput;
    expect(briefInputAssets(brief).map((asset) => asset.manifestPath)).toEqual([
      'public/flowstarter-media/brief-b104b1e0.jpg',
      'public/flowstarter-media/brief-c2f0f3a1.png',
      'public/flowstarter-media/brief-e4a5b6c7.jpg',
      'public/flowstarter-media/brief-d31f2c44.png',
    ]);
  });

  it('is empty for a workspace with no brief', () => {
    expect(briefInputAssets(null)).toEqual([]);
  });
});

describe('describeBriefInput', () => {
  it('names every project and every asset path the agent is meant to place', () => {
    const digest = describeBriefInput(parseBriefInput(payload()));
    expect(digest).toContain('Ereno');
    expect(digest).toContain('A calm inbox for freelance invoices.');
    expect(digest).toContain('https://ereno.example');
    expect(digest).toContain('/flowstarter-media/brief-c2f0f3a1.png');
    expect(digest).toContain('/flowstarter-media/brief-b104b1e0.jpg');
    expect(digest).toContain('/flowstarter-media/brief-e4a5b6c7.jpg');
    expect(digest).toContain('/flowstarter-media/brief-d31f2c44.png');
    expect(digest).toContain('about section');
    expect(digest).toContain('never place one on the site as content');
  });

  it('states the no-projects case as an instruction rather than an empty list', () => {
    const digest = describeBriefInput(
      parseBriefInput(payload({ projects: [], noProjects: true })),
    );
    expect(digest).toContain('REAL PROJECTS: none');
    expect(digest).toContain('Do not render a work section');
    expect(digest).toContain('never fill the space with stock photography');
  });

  it('says nothing at all when there is no brief', () => {
    expect(describeBriefInput(null)).toBe('');
  });

  it('reaches the build task the agent is actually given', () => {
    const task = buildFullSiteTask({
      projectId: '0f4e1088-8d8f-4f18-83b1-406cc292b23c',
      intake: mergeBriefIntoIntake(intake(), parseBriefInput(payload())),
      brandConfig: { schemaVersion: '1.0' } as unknown as BrandConfig,
      requiredIntegrations: [],
      briefDigest: describeBriefInput(parseBriefInput(payload())),
    });
    expect(task).toContain("THE CLIENT'S BRIEF");
    expect(task).toContain('Ereno');
    expect(task).toContain('/flowstarter-media/brief-b104b1e0.jpg');
  });
});
