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

/**
 * `.astro/dev.json` exactly as the Astro dev server writes it, and exactly as
 * it sat in `funnel_previews.manifest` for workspace
 * `c009105e-f8ec-42bf-bdcf-cf92bb500f45` on 2026-09-12. Its eight lines filled
 * the whole phrase budget and the loop never reached the file with the
 * client's headline in it.
 */
const DEV_JSON = `{
  "toolbar": {
    "placement": "bottom-center"
  },
  "pid": 97132,
  "port": 56092,
  "url": "http://localhost:56092",
  "network": [
    "http://192.168.3.188:56092/"
  ],
  "networkInterfaceNames": [
    "en0"
  ],
  "background": false,
  "startedAt": "2026-09-11T21:51:12.985Z"
}
`;

const SITE_LABELS = (title: string) => `---
hero:
  artMark: "D"
  label: "Flowstarter, an AI-driven website studio"
  title: "${title}"
---
`;

describe('the 2026-09-12 false positive', () => {
  it('derives the headline and nothing else from a workspace with .astro in it', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: `Make the hero headline say ${HEADLINE}`,
      before: [
        file('.astro/dev.json', DEV_JSON.replace('97132', '51004')),
        file(
          '.astro/settings.json',
          '{\n  "_variables": {\n    "lastUpdateCheck": 1789139680613\n  }\n}\n'
        ),
        file('src/content/site-labels.md', SITE_LABELS(ORIGINAL)),
      ],
      after: [
        file('.astro/dev.json', DEV_JSON),
        file(
          '.astro/settings.json',
          '{\n  "_variables": {\n    "lastUpdateCheck": 1789162735907\n  }\n}\n'
        ),
        file('src/content/site-labels.md', SITE_LABELS(HEADLINE)),
      ],
    });

    expect(edit.addedPhrases).toEqual([HEADLINE]);
    expect(edit.changedPaths).toEqual(['src/content/site-labels.md']);
  });

  it('reads the content file before the pages, whatever the paths sort like', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'rewrite the hero and the contact line',
      before: [
        file('src/content/site-labels.md', SITE_LABELS(ORIGINAL)),
        file('src/pages/contact.astro', '<p>old</p>'),
      ],
      after: [
        file('src/content/site-labels.md', SITE_LABELS(HEADLINE)),
        file(
          'src/pages/contact.astro',
          '<p>Find me on Instagram at darius.flowstarter</p>'
        ),
      ],
    });

    expect(edit.addedPhrases[0]).toBe(HEADLINE);
    expect(edit.addedPhrases).toHaveLength(2);
  });

  it('never takes a phrase out of a file a client edit cannot reach', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'bump the dependency',
      before: [file('package.json', '{\n  "astro": "5.0.0"\n}\n')],
      after: [
        file(
          'package.json',
          '{\n  "astro": "5.1.0",\n  "description": "A portfolio built with Astro"\n}\n'
        ),
      ],
    });

    expect(edit.addedPhrases).toEqual([]);
    expect(edit.changedPaths).toEqual(['package.json']);
  });

  it('strips the stored dev-server phrases when an old manifest is read back', () => {
    const [edit] = parseAppliedEdits([
      {
        index: 1,
        instruction: `Make the hero headline say ${HEADLINE}`,
        addedPhrases: [
          '"pid": 97132,',
          '"port": 56092,',
          '"url": "http://localhost:56092",',
          '"network": [',
          '"http://192.168.3.188:56092/"',
          '"networkInterfaceNames": [',
          '"background": false,',
          'startedAt": "2026-09-11T21:51:12.985Z',
        ],
        changedPaths: [
          '.astro/dev.json',
          '.astro/settings.json',
          '.astro/types.d.ts',
          'src/content/site-labels.md',
          'src/pages/contact.astro',
        ],
      },
    ]);

    expect(edit?.addedPhrases).toEqual([]);
    expect(edit?.changedPaths).toEqual([
      'src/content/site-labels.md',
      'src/pages/contact.astro',
    ]);
  });
});

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
    const before = [file('src/content/a.md', `  heroHeadline: "${HEADLINE}"`)];
    const after = [file('src/content/a.md', `heroHeadline: '${HEADLINE}'`)];

    expect(
      appliedPreviewEdit({ index: 1, instruction: 'tidy', before, after })
        .addedPhrases
    ).toEqual([]);
  });

  it('does not mistake a moved line for a new one', () => {
    const before = [
      file(
        'src/content/a.md',
        `one: "${HEADLINE}"\ntwo: "Something else here"`
      ),
    ];
    const after = [
      file(
        'src/content/a.md',
        `two: "Something else here"\none: "${HEADLINE}"`
      ),
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
      before: [
        file('src/content/a.md', 'kept'),
        file('src/pages/testimonials.astro', 'x'),
      ],
      after: [file('src/content/a.md', 'kept')],
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
      before: [file('src/content/a.md', '')],
      after: [file('src/content/a.md', body)],
    });

    expect(edit.addedPhrases).toHaveLength(8);
  });

  it('stamps a time when the caller does not', () => {
    const edit = appliedPreviewEdit({
      index: 1,
      instruction: 'x',
      before: [],
      after: [file('src/content/a.md', 'A brand new sentence of copy')],
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

  it('still yields a buildable payload for a claimed fallback preview with no manifest', () => {
    // The JSON-preview fallback's own claim (a workspace whose funnel preview
    // was never persisted with files — see `claim.ts`'s "has no stashed
    // preview manifest" path) has a real, claimed preview id but nothing
    // `derivePreviewIntent` can build an intent from. The deposit CTA must
    // still work on that fallback rather than being hidden or disabled: the
    // worker already treats a missing `previewIntent` as "generate from the
    // intake alone", the same path an operator-created project (no preview
    // at all) takes.
    const previewIntent = derivePreviewIntent({
      previewId: PREVIEW_ID,
      manifest: null,
    });
    expect(previewIntent).toBeNull();

    const payload = depositBuildPayload({
      source: 'payment_intent',
      claimedPreviewId: PREVIEW_ID,
      previewIntent,
    });

    expect(payload).toEqual({
      trigger: 'deposit_paid',
      source: 'payment_intent',
      depositPercent: 20,
      balancePercent: 80,
      claimedPreviewId: PREVIEW_ID,
    });
    expect(payload).not.toHaveProperty('previewIntent');
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
