/**
 * The free changes have to reach the record, not just the screen.
 *
 * `rememberClaimablePreview` runs once, when the generator finishes. The two
 * free changes a visitor makes happen after that, against the running preview
 * workspace — and until `recordClaimablePreviewEdit` existed, nothing wrote
 * them back. The claim copied the pre-edit manifest into the artifacts row,
 * the build worker seeds its worktree from exactly that row, and the site the
 * client paid for was built from the version they had already rejected. On
 * 2026-09-11 that cost a real client the headline he asked for.
 *
 * These cases pin the write-back: the edited files become the manifest of
 * record, and the change is recorded next to them in the client's own words.
 *
 * Static imports: vi.mock is hoisted above them, and the app's tsconfig does
 * not allow top-level await in tests.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createFakeHostingSupabase } from '@/lib/hosting/__tests__/fake-hosting-supabase';

vi.mock('server-only', () => ({}));

const db = createFakeHostingSupabase();
vi.mock('@/supabase-clients/server', () => ({
  createSupabaseServiceRoleClient: () => db.client,
}));

vi.mock('../membership', () => ({
  ensureClientMembership: vi.fn(async () => ({ created: true })),
}));
vi.mock('../messaging', () => ({
  appendClientReplyToCorpus: vi.fn(async () => true),
}));
vi.mock('../intake-submission', () => ({
  recordIntakeSubmission: vi.fn(async () => ({})),
}));
vi.mock('../preview-artifacts', () => ({
  savePreviewArtifacts: vi.fn(async () => ({ advanced: true })),
  PreviewArtifactError: class extends Error {},
}));

import {
  clearClaimablePreviews,
  getClaimablePreview,
  recordClaimablePreviewEdit,
  rememberClaimablePreview,
} from '../claim';

const PREVIEW_ID = 'ccb48228-2fca-4cae-b1ed-7fcf9ce6a48a';
const HEADLINE = 'I build websites with AI agents, supervised by people';
const ORIGINAL =
  'Websites for service businesses, built by AI and checked by a person ' +
  'before they ship.';

function labels(headline: string) {
  return [
    {
      path: 'src/content/site-labels.md',
      content: `---\nheroHeadline: "${headline}"\n---\n`,
      type: 'file' as const,
    },
  ];
}

function previewInput(files = labels(ORIGINAL)) {
  return {
    previewId: PREVIEW_ID,
    intake: {
      projectId: PREVIEW_ID,
      business: { name: 'Darius Mihai Popescu', niche: 'Creative & design' },
      socialMedia: [],
      locale: 'en-GB',
      submittedAt: '2026-09-11T18:00:00.000Z',
      consent: { publicProfileAnalysis: true, acceptedAt: '2026-09-11' },
    },
    brandConfig: { schemaVersion: '1.0' },
    template: { slug: 'creative-portfolio', reason: 'fits' },
    files,
    previewUrl: 'https://sandbox.example.com',
  } as never;
}

beforeEach(() => {
  db.reset();
  clearClaimablePreviews();
});

describe('recordClaimablePreviewEdit', () => {
  it('makes the edited files the manifest a paid build will seed from', async () => {
    await rememberClaimablePreview(previewInput());

    const edit = await recordClaimablePreviewEdit({
      previewId: PREVIEW_ID,
      instruction: `Make the hero headline say ${HEADLINE}`,
      files: labels(HEADLINE),
      appliedAt: '2026-09-11T18:30:00.000Z',
    });

    expect(edit).toEqual({
      index: 1,
      instruction: `Make the hero headline say ${HEADLINE}`,
      changedPaths: ['src/content/site-labels.md'],
      addedPhrases: [HEADLINE],
      appliedAt: '2026-09-11T18:30:00.000Z',
    });

    // The record, read the way a claim on any other instance would read it.
    clearClaimablePreviews();
    const stored = await getClaimablePreview(PREVIEW_ID);
    expect(stored?.files[0]?.content).toContain(HEADLINE);
    expect(stored?.files[0]?.content).not.toContain(ORIGINAL);
    expect(stored?.appliedEdits).toEqual([edit]);
  });

  it('numbers a second free change after the first and keeps both', async () => {
    await rememberClaimablePreview(previewInput());
    await recordClaimablePreviewEdit({
      previewId: PREVIEW_ID,
      instruction: 'Change the headline',
      files: labels(HEADLINE),
    });

    const second = await recordClaimablePreviewEdit({
      previewId: PREVIEW_ID,
      instruction: 'Add my Instagram handle darius.flowstarter',
      files: [
        ...labels(HEADLINE),
        {
          path: 'src/content/contact.md',
          content: 'Follow along at @darius.flowstarter every week',
          type: 'file' as const,
        },
      ],
    });

    expect(second?.index).toBe(2);
    expect(second?.changedPaths).toEqual(['src/content/contact.md']);
    expect(second?.addedPhrases).toEqual([
      'Follow along at @darius.flowstarter every week',
    ]);

    clearClaimablePreviews();
    const stored = await getClaimablePreview(PREVIEW_ID);
    expect(stored?.appliedEdits).toHaveLength(2);
    expect(stored?.files).toHaveLength(2);
  });

  it('keeps everything else about the preview intact', async () => {
    await rememberClaimablePreview(previewInput());

    await recordClaimablePreviewEdit({
      previewId: PREVIEW_ID,
      instruction: 'Change the headline',
      files: labels(HEADLINE),
    });

    clearClaimablePreviews();
    const stored = await getClaimablePreview(PREVIEW_ID);
    expect(stored?.template.slug).toBe('creative-portfolio');
    expect(stored?.intake.business.name).toBe('Darius Mihai Popescu');
    expect(stored?.previewUrl).toBe('https://sandbox.example.com');
  });

  it('does nothing for a preview nobody remembered', async () => {
    expect(
      await recordClaimablePreviewEdit({
        previewId: PREVIEW_ID,
        instruction: 'Change the headline',
        files: labels(HEADLINE),
      })
    ).toBeNull();
  });

  it('refuses an id that is not a preview and an empty workspace read', async () => {
    await rememberClaimablePreview(previewInput());

    expect(
      await recordClaimablePreviewEdit({
        previewId: 'not-a-uuid',
        instruction: 'x',
        files: labels(HEADLINE),
      })
    ).toBeNull();
    expect(
      await recordClaimablePreviewEdit({
        previewId: PREVIEW_ID,
        instruction: 'x',
        files: [],
      })
    ).toBeNull();

    // The record is untouched by either refusal.
    clearClaimablePreviews();
    expect(
      (await getClaimablePreview(PREVIEW_ID))?.files[0]?.content
    ).toContain(ORIGINAL);
  });
});
