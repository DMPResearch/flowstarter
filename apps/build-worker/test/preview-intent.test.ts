/**
 * What the client approved, off an untrusted job payload.
 *
 * The deposit webhook writes `previewIntent` onto the FULL_SITE_BUILD row so
 * the build can be held to the free changes the client made to their preview.
 * The column is jsonb and an operator can edit a row, so the worker parses it
 * defensively: a malformed intent degrades to "nothing was approved" rather
 * than reaching the prompt, or the dropped-edit gate, as junk.
 */
import { describe, expect, it } from 'vitest';
import { ProjectState } from '@flowstarter/agentic-codegen';
import {
  buildJobFromRows,
  JobArtifactError,
  parseApprovedPreviewFiles,
  parsePreviewIntent,
  type JobLedgerRow,
} from '../src/job-store';

const WORKSPACE_ID = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const PREVIEW_ID = 'ccb48228-2fca-4cae-b1ed-7fcf9ce6a48a';
const HEADLINE = 'I build websites with AI agents, supervised by people';

function intent(overrides: Record<string, unknown> = {}) {
  return {
    previewId: PREVIEW_ID,
    manifest: {
      ref: `funnel_previews:${PREVIEW_ID}`,
      artifactPath: `funnel/${PREVIEW_ID}/site.tar.gz`,
      templateSlug: 'creative-portfolio',
      fileCount: 69,
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
    brief: {
      businessName: 'Darius Mihai Popescu',
      niche: 'Creative & design',
      location: 'Remote',
      description: 'A personal portfolio site.',
      targetAudience: 'Founders',
      primaryGoal: 'Get enquiries / leads',
      locale: 'en-GB',
    },
    capturedAt: '2026-09-11T18:52:18.000Z',
    ...overrides,
  };
}

function ledgerRow(overrides: Partial<JobLedgerRow> = {}): JobLedgerRow {
  return {
    id: '4f9d5bf2-1c4a-4a2f-9d4a-4c0f0a7c2f11',
    workspace_id: WORKSPACE_ID,
    kind: 'FULL_SITE_BUILD',
    status: 'queued',
    attempt_count: 0,
    payload: {},
    ...overrides,
  };
}

function artifacts(overrides: Record<string, unknown> = {}) {
  return {
    intake_payload: {
      projectId: WORKSPACE_ID,
      business: { name: 'Darius Mihai Popescu' },
    },
    brand_config: { schemaVersion: '1.0' },
    preview_manifest: {
      files: [
        {
          path: 'src/content/site-labels.md',
          content: `heroHeadline: "${HEADLINE}"`,
        },
      ],
    },
    ...overrides,
  };
}

describe('parsePreviewIntent', () => {
  it('reads back the whole intent the deposit webhook wrote', () => {
    expect(parsePreviewIntent({ previewIntent: intent() })).toEqual(intent());
  });

  it('is nothing for an operator-created project with no claimed preview', () => {
    expect(parsePreviewIntent({ trigger: 'deposit_paid' })).toBeNull();
    expect(parsePreviewIntent({ previewIntent: null })).toBeNull();
    expect(parsePreviewIntent(null)).toBeNull();
    expect(parsePreviewIntent('a string')).toBeNull();
    expect(parsePreviewIntent([])).toBeNull();
  });

  it('refuses an intent whose preview id is not a uuid', () => {
    expect(
      parsePreviewIntent({
        previewIntent: intent({ previewId: '../../etc/passwd' }),
      }),
    ).toBeNull();
  });

  it('falls back to a derived manifest reference rather than trusting a blank', () => {
    const parsed = parsePreviewIntent({
      previewIntent: intent({ manifest: { fileCount: 'lots' } }),
    });

    expect(parsed?.manifest).toEqual({
      ref: `funnel_previews:${PREVIEW_ID}`,
      artifactPath: null,
      templateSlug: null,
      fileCount: 0,
    });
  });

  it('drops edits that carry no instruction, and normalizes the rest', () => {
    const parsed = parsePreviewIntent({
      previewIntent: intent({
        edits: [
          { instruction: '   ' },
          { addedPhrases: ['orphan'] },
          {
            instruction: 'kept',
            changedPaths: 'not an array',
            addedPhrases: 7,
          },
        ],
      }),
    });

    expect(parsed?.edits).toEqual([
      {
        index: 1,
        instruction: 'kept',
        changedPaths: [],
        addedPhrases: [],
        appliedAt: '',
      },
    ]);
  });

  it('caps the edits and the phrases an untrusted payload can carry', () => {
    const parsed = parsePreviewIntent({
      previewIntent: intent({
        edits: Array.from({ length: 30 }, (_, index) => ({
          index: index + 1,
          instruction: `edit ${index}`,
          addedPhrases: Array.from({ length: 30 }, (_, n) => `phrase ${n}`),
        })),
      }),
    });

    expect(parsed?.edits).toHaveLength(8);
    expect(parsed?.edits[0]?.addedPhrases).toHaveLength(8);
  });

  it('truncates text rather than letting a payload write an essay into a prompt', () => {
    const parsed = parsePreviewIntent({
      previewIntent: intent({
        edits: [
          { instruction: 'x'.repeat(9_000), addedPhrases: ['y'.repeat(900)] },
        ],
      }),
    });

    expect(parsed?.edits[0]?.instruction).toHaveLength(2_000);
    expect(parsed?.edits[0]?.addedPhrases[0]).toHaveLength(200);
  });

  it('omits optional brief fields that were not supplied', () => {
    const parsed = parsePreviewIntent({
      previewIntent: intent({ brief: { businessName: 'Just a name' } }),
    });

    expect(parsed?.brief).toEqual({
      businessName: 'Just a name',
      niche: '',
      location: '',
    });
  });
});

describe('buildJobFromRows and the approved preview', () => {
  it('hands the worker the intent off the payload', () => {
    const job = buildJobFromRows({
      job: ledgerRow({ payload: { previewIntent: intent() } }),
      projectState: ProjectState.DEPOSIT_PAID,
      artifacts: artifacts(),
    });

    expect(job.previewIntent).toEqual(intent());
  });

  it('leaves the field off entirely for a project with no preview', () => {
    const job = buildJobFromRows({
      job: ledgerRow(),
      projectState: ProjectState.DEPOSIT_PAID,
      artifacts: artifacts(),
    });

    expect(job).not.toHaveProperty('previewIntent');
  });
});

describe('parseApprovedPreviewFiles and binary assets', () => {
  it('carries the base64 flag, so an image is not materialized as its own text', () => {
    expect(
      parseApprovedPreviewFiles({
        files: [
          { path: 'src/index.astro', content: '<h1>hi</h1>' },
          { path: 'public/hero.png', content: 'AAAA', encoding: 'base64' },
        ],
      }),
    ).toEqual([
      { path: 'src/index.astro', content: '<h1>hi</h1>', type: 'file' },
      {
        path: 'public/hero.png',
        content: 'AAAA',
        encoding: 'base64',
        type: 'file',
      },
    ]);
  });

  it('refuses an encoding the materializer would not understand', () => {
    expect(() =>
      parseApprovedPreviewFiles({
        files: [{ path: 'a.png', content: 'x', encoding: 'rot13' }],
      }),
    ).toThrow(JobArtifactError);
  });
});
