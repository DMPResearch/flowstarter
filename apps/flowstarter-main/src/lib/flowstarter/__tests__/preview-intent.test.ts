/**
 * The two free changes, from the preview to the payload.
 *
 * On 2026-09-11 a client asked for "make the hero headline say I build
 * websites with AI agents, supervised by people", watched it land in the
 * preview, paid, and got the pre-edit sentence on the site. The record of what
 * they approved is derived here, and it is derived from the files rather than
 * from their sentence — a build can only be held to text that actually exists.
 */
import { describe, expect, it } from 'vitest';
import type {
  BusinessIntakePayload,
  TemplateScaffoldFile,
} from '@flowstarter/agentic-codegen/src/flowstarter/types';
import {
  appliedPreviewEdit,
  briefSnapshot,
  depositBuildPayload,
  derivePreviewIntent,
  normalizePhrase,
  parseAppliedEdits,
  phraseFromLine,
} from '../preview-intent';

const PREVIEW_ID = 'ccb48228-2fca-4cae-b1ed-7fcf9ce6a48a';
const HEADLINE = 'I build websites with AI agents, supervised by people';
const ORIGINAL =
  'Websites for service businesses, built by AI and checked by a person ' +
  'before they ship.';

function file(path: string, content: string): TemplateScaffoldFile {
  return { path, content, type: 'file' };
}

function labels(headline: string): TemplateScaffoldFile[] {
  return [
    file(
      'src/content/site-labels.md',
      `---\nheroHeadline: "${headline}"\nheroSub: "Four pages, no hype."\n---\n`
    ),
    file('src/pages/index.astro', '<h1>{labels.heroHeadline}</h1>'),
  ];
}

describe('phraseFromLine', () => {
  it('takes the value out of a keyed content line', () => {
    expect(phraseFromLine(`  heroHeadline: "${HEADLINE}"`)).toBe(HEADLINE);
  });

  it('strips list bullets and markdown emphasis', () => {
    expect(phraseFromLine('- **A confident opening line**')).toBe(
      'A confident opening line'
    );
  });

  it('drops anything too short to be evidence', () => {
    expect(phraseFromLine('title: Home')).toBeNull();
    expect(phraseFromLine('   ')).toBeNull();
  });

  it('drops values that are not prose', () => {
    expect(phraseFromLine('accent: "#0f766eff"')).toBeNull();
    expect(
      phraseFromLine('url: https://example.com/a/very/long/path')
    ).toBeNull();
    expect(phraseFromLine('spacing: 1.25 2.50 3.75 4.00')).toBeNull();
    expect(phraseFromLine('---------------------')).toBeNull();
  });

  it('truncates a phrase that is longer than a verbatim check can survive', () => {
    expect(phraseFromLine(`body: "${'word '.repeat(80)}"`)).toHaveLength(200);
  });
});

describe('normalizePhrase', () => {
  it('collapses whitespace and folds case', () => {
    expect(normalizePhrase('  A   Line\nBroken ')).toBe('a line broken');
  });
});

describe('appliedPreviewEdit', () => {
  it('records the file that changed and the text the runner introduced', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: `  Make the hero headline say ${HEADLINE}  `,
      before: labels(ORIGINAL),
      after: labels(HEADLINE),
      appliedAt: '2026-09-11T18:30:00.000Z',
    });

    expect(edit.index).toBe(1);
    expect(edit.instruction).toBe(`Make the hero headline say ${HEADLINE}`);
    expect(edit.changedPaths).toEqual(['src/content/site-labels.md']);
    expect(edit.addedPhrases).toEqual([HEADLINE]);
    expect(edit.appliedAt).toBe('2026-09-11T18:30:00.000Z');
  });

  it('never reports the lines an edit left alone', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'Change the headline',
      before: labels(ORIGINAL),
      after: labels(HEADLINE),
    });

    expect(edit.addedPhrases).not.toContain('Four pages, no hype.');
  });

  it('does not mistake re-indenting or re-quoting for a new phrase', () => {
    const before = [file('a.md', `  heroHeadline: "${HEADLINE}"`)];
    const after = [file('a.md', `heroHeadline: '${HEADLINE}'`)];

    expect(
      appliedPreviewEdit({ index: 1, instruction: 'tidy', before, after })
        .addedPhrases
    ).toEqual([]);
  });

  it('does not mistake a moved line for a new one', () => {
    const before = [
      file('a.md', `one: "${HEADLINE}"\ntwo: "Something else here"`),
    ];
    const after = [
      file('a.md', `two: "Something else here"\none: "${HEADLINE}"`),
    ];

    expect(
      appliedPreviewEdit({ index: 1, instruction: 'reorder', before, after })
        .addedPhrases
    ).toEqual([]);
  });

  it('records a file the edit deleted', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'Drop the testimonials page',
      before: [file('a.md', 'kept'), file('src/pages/testimonials.astro', 'x')],
      after: [file('a.md', 'kept')],
    });

    expect(edit.changedPaths).toEqual(['src/pages/testimonials.astro']);
  });

  it('ignores binary assets, whose bytes are never a phrase', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'swap the hero image',
      before: [
        { path: 'hero.png', content: 'AAAA', encoding: 'base64', type: 'file' },
      ],
      after: [
        { path: 'hero.png', content: 'BBBB', encoding: 'base64', type: 'file' },
      ],
    });

    expect(edit.changedPaths).toEqual([]);
    expect(edit.addedPhrases).toEqual([]);
  });

  it('caps the phrases and paths one edit can carry', () => {
    const body = Array.from(
      { length: 40 },
      (_, index) => `line${index}: "A distinct sentence number ${index} here"`
    ).join('\n');
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'rewrite everything',
      before: [file('a.md', '')],
      after: [file('a.md', body)],
    });

    expect(edit.addedPhrases).toHaveLength(8);
  });

  it('stamps a time when the caller does not', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'x',
      before: [],
      after: [file('a.md', 'A brand new sentence of copy')],
    });

    expect(Date.parse(edit.appliedAt)).toBeGreaterThan(0);
  });
});

describe('parseAppliedEdits', () => {
  it('reads back what was written', () => {
    const stored = [
      {
        index: 1,
        instruction: 'Change the headline',
        changedPaths: ['src/content/site-labels.md'],
        addedPhrases: [HEADLINE],
        appliedAt: '2026-09-11T18:30:00.000Z',
      },
    ];

    expect(parseAppliedEdits(stored)).toEqual(stored);
  });

  it('drops junk rather than putting it on a build payload', () => {
    expect(
      parseAppliedEdits([
        null,
        'a string',
        { instruction: '   ' },
        {
          instruction: 'kept',
          changedPaths: 'not an array',
          addedPhrases: [1, 2],
        },
      ])
    ).toEqual([
      {
        index: 1,
        instruction: 'kept',
        changedPaths: [],
        addedPhrases: [],
        appliedAt: new Date(0).toISOString(),
      },
    ]);
  });

  it('is empty for anything that is not a list', () => {
    expect(parseAppliedEdits(undefined)).toEqual([]);
    expect(parseAppliedEdits({ edits: [] })).toEqual([]);
  });

  it('caps how many edits it will carry', () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      index: index + 1,
      instruction: `edit ${index}`,
    }));

    expect(parseAppliedEdits(many)).toHaveLength(8);
  });
});

describe('briefSnapshot', () => {
  it('keeps the facts a build needs and nothing else', () => {
    expect(briefSnapshot(intake())).toEqual({
      businessName: 'Darius Mihai Popescu',
      niche: 'Creative & design',
      location: 'Remote',
      description: 'A personal portfolio site.',
      targetAudience: 'Founders and small business owners',
      primaryGoal: 'Get enquiries / leads',
      locale: 'en-GB',
    });
  });

  it('does not invent fields for an intake that has none', () => {
    expect(briefSnapshot(undefined)).toEqual({
      businessName: '',
      niche: '',
      location: '',
    });
  });
});

describe('derivePreviewIntent', () => {
  it('carries the manifest reference, the edits and the brief', () => {
    const derived = derivePreviewIntent({
      previewId: PREVIEW_ID,
      manifest: {
        files: labels(HEADLINE),
        intake: intake(),
        appliedEdits: [
          {
            index: 1,
            instruction: `Make the hero headline say ${HEADLINE}`,
            changedPaths: ['src/content/site-labels.md'],
            addedPhrases: [HEADLINE],
            appliedAt: '2026-09-11T18:30:00.000Z',
          },
        ],
      },
      artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
      templateSlug: 'creative-portfolio',
      capturedAt: '2026-09-11T18:52:18.000Z',
    });

    expect(derived).toEqual({
      previewId: PREVIEW_ID,
      manifest: {
        ref: `funnel_previews:${PREVIEW_ID}`,
        artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
        templateSlug: 'creative-portfolio',
        fileCount: 2,
      },
      edits: [
        {
          index: 1,
          instruction: `Make the hero headline say ${HEADLINE}`,
          changedPaths: ['src/content/site-labels.md'],
          addedPhrases: [HEADLINE],
          appliedAt: '2026-09-11T18:30:00.000Z',
        },
      ],
      brief: briefSnapshot(intake()),
      capturedAt: '2026-09-11T18:52:18.000Z',
    });
  });

  it('is still an intent when the client made no free changes', () => {
    const derived = derivePreviewIntent({
      previewId: PREVIEW_ID,
      manifest: { files: labels(ORIGINAL), intake: intake() },
    });

    expect(derived?.edits).toEqual([]);
    expect(derived?.manifest.artifactPath).toBeNull();
    expect(derived?.manifest.templateSlug).toBeNull();
  });

  it('is nothing for a workspace with no claimed preview', () => {
    expect(
      derivePreviewIntent({ previewId: null, manifest: { files: labels('x') } })
    ).toBeNull();
    expect(
      derivePreviewIntent({ previewId: 'not-a-uuid', manifest: {} })
    ).toBeNull();
  });

  it('is nothing for a manifest a build could not be held to', () => {
    expect(
      derivePreviewIntent({ previewId: PREVIEW_ID, manifest: { files: [] } })
    ).toBeNull();
    expect(
      derivePreviewIntent({ previewId: PREVIEW_ID, manifest: null })
    ).toBeNull();
  });
});

describe('depositBuildPayload', () => {
  it('carries the claimed preview and the intent alongside the money split', () => {
    const previewIntent = derivePreviewIntent({
      previewId: PREVIEW_ID,
      manifest: { files: labels(HEADLINE), intake: intake() },
      capturedAt: '2026-09-11T18:52:18.000Z',
    });

    expect(
      depositBuildPayload({
        source: 'payment_intent',
        claimedPreviewId: PREVIEW_ID,
        previewIntent,
      })
    ).toEqual({
      trigger: 'deposit_paid',
      source: 'payment_intent',
      depositPercent: 20,
      balancePercent: 80,
      claimedPreviewId: PREVIEW_ID,
      previewIntent,
    });
  });

  it('is exactly the payload this path always wrote when there is no preview', () => {
    expect(
      depositBuildPayload({
        source: 'deposit_invoice',
        claimedPreviewId: null,
        previewIntent: null,
      })
    ).toEqual({
      trigger: 'deposit_paid',
      source: 'deposit_invoice',
      depositPercent: 20,
      balancePercent: 80,
    });
  });

  it('refuses a claimed preview id that is not a uuid', () => {
    const payload = depositBuildPayload({
      source: 'payment_intent',
      claimedPreviewId: '../../etc/passwd',
    });

    expect(payload).not.toHaveProperty('claimedPreviewId');
  });
});

function intake(): BusinessIntakePayload {
  return {
    projectId: '5c188ef5-4a59-485e-8231-3aaf924d08dd',
    business: {
      name: 'Darius Mihai Popescu',
      niche: 'Creative & design',
      location: 'Remote',
      description: 'A personal portfolio site.',
      targetAudience: 'Founders and small business owners',
      primaryGoal: 'Get enquiries / leads',
    },
    socialMedia: [],
    locale: 'en-GB',
    submittedAt: '2026-09-11T18:00:00.000Z',
    consent: {
      publicProfileAnalysis: true,
      acceptedAt: '2026-09-11T18:00:00.000Z',
    },
  };
}
