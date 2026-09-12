/**
 * The claim, for a portrait the visitor connected before the preview existed.
 *
 * The LinkedIn and Instagram connect flows run at the links question, which is
 * the fourth thing a visitor answers and is minutes before generation has
 * minted a preview id. So the picture they authorise is filed under a
 * namespace the wizard minted for it, not under the preview id everything else
 * in the funnel is keyed on.
 *
 * That is a quiet way to lose a feature. `claimFunnelAssets` lists by preview
 * id, so without a second call the claim carries the logo, the palette source
 * and the uploaded photograph into the new workspace, and leaves the client's
 * own face behind in an orphaned row that the reaper eventually deletes. The
 * visitor would see their face on the free preview and not on the site they
 * paid for, which is the worst possible order to do that in.
 *
 * These cases pin three things:
 *
 *   1. the connected portrait is carried across when the claim names it,
 *   2. nothing is carried when it does not, so a claim cannot be talked into
 *      adopting a picture that belongs to somebody else's connection,
 *   3. the connection row learns which workspace it ended up in, because the
 *      first question anybody asks about a photograph is where it came from.
 *
 * No rights confirmation is asserted here, and that absence is deliberate: a
 * connected portrait already carries one, written by the connect action when
 * the person approved it at the provider. `confirmFetchedPictureRights` is the
 * claim page's question about a picture we READ off a public page, and it must
 * not fire for a picture somebody handed us on purpose.
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

/**
 * The two funnel-asset calls are mocked rather than faked, because what is
 * under test is WHICH namespace each one is asked about, not what storage does
 * with the answer. `funnel-assets.ts` has its own suite for the copy itself.
 */
const claimed: Array<{ previewId: string; workspaceId: string }> = [];
const confirmed: Array<{ previewId: string }> = [];
vi.mock('../funnel-assets', () => ({
  claimFunnelAssets: vi.fn(
    async (input: { previewId: string; workspaceId: string }) => {
      claimed.push(input);
      return { moved: 1, alreadyClaimed: 0, failed: [] };
    }
  ),
  confirmFetchedPictureRights: vi.fn(async (input: { previewId: string }) => {
    confirmed.push(input);
    return { confirmed: 1 };
  }),
}));

import { claimFunnelAssets } from '../funnel-assets';
import {
  claimPreview,
  clearClaimablePreviews,
  rememberClaimablePreview,
} from '../claim';

const PREVIEW_ID = 'b1b2c3d4-1111-4111-8111-111111111111';
const PORTRAIT_PREVIEW_ID = 'c1b2c3d4-2222-4222-8222-222222222222';

function previewInput() {
  return {
    previewId: PREVIEW_ID,
    intake: {
      projectId: PREVIEW_ID,
      business: { name: 'Calm Path', niche: 'Therapy' },
      socialMedia: [],
      locale: 'en',
      submittedAt: new Date().toISOString(),
      consent: { publicProfileAnalysis: false, acceptedAt: '' },
    },
    brandConfig: { schemaVersion: '1.0' },
    template: { slug: 'wellness-therapy', reason: 'fits' },
    files: [
      { path: 'index.html', content: '<h1>Calm Path</h1>', type: 'file' },
    ],
    previewUrl: 'https://sandbox.example.com',
  } as never;
}

function claimInput(extra: Record<string, unknown> = {}) {
  return {
    previewId: PREVIEW_ID,
    clerkUserId: 'user_portrait_1',
    clientEmail: 'ana@example.test',
    clientName: 'Ana Ionescu',
    businessName: 'Calm Path',
    ...extra,
  } as never;
}

beforeEach(async () => {
  db.reset();
  claimed.length = 0;
  confirmed.length = 0;
  vi.mocked(claimFunnelAssets).mockClear();
  clearClaimablePreviews();
  await rememberClaimablePreview(previewInput());
});

describe('the claim and a connected portrait', () => {
  it('carries the connected portrait across as well as the preview pictures', async () => {
    // Two namespaces, two calls. The wizard minted one for the connect round
    // trip because generation had not started; the preview id is the other.
    const result = await claimPreview(
      claimInput({ portraitPreviewId: PORTRAIT_PREVIEW_ID })
    );
    const workspaceId = result.workspaceId;
    expect(workspaceId).toBeTruthy();

    const asked = claimed.map((call) => call.previewId);
    expect(asked).toContain(PORTRAIT_PREVIEW_ID);
    expect(asked).toContain(PREVIEW_ID);
    for (const call of claimed) {
      expect(call.workspaceId).toBe(workspaceId);
    }
  });

  it('asks about nothing but the preview when no portrait was connected', async () => {
    // A claim that does not name a connection cannot adopt one. The id is a
    // lookup key the wizard carries, not a field the server guesses at.
    await claimPreview(claimInput());
    expect(claimed.map((call) => call.previewId)).toEqual([PREVIEW_ID]);
  });

  it('ignores a portrait namespace that is not a uuid', async () => {
    // Anything that is not a v4 uuid did not come from the wizard, and a
    // storage lookup built from it is a request we have no reason to make.
    await claimPreview(claimInput({ portraitPreviewId: 'not-a-uuid' }));
    expect(claimed.map((call) => call.previewId)).toEqual([PREVIEW_ID]);
  });

  it('does not re-ask for rights over a picture the person already authorised', async () => {
    // The connect action wrote `rights_confirmed_at` at the provider. The
    // claim page's one picture question is about a picture we READ off a
    // public page, and firing it here would be asking somebody to consent
    // twice to the same thing.
    await claimPreview(claimInput({ portraitPreviewId: PORTRAIT_PREVIEW_ID }));
    expect(confirmed).toEqual([]);
  });

  it('records which workspace the connection ended up in', async () => {
    // The first question anybody asks when a rights complaint arrives is where
    // the picture came from, and the answer has to be reachable from the
    // workspace rather than from a preview id nobody kept.
    db.seed('portrait_connections', [
      {
        id: 'd1b2c3d4-3333-4333-8333-333333333333',
        provider: 'linkedin',
        provider_account_id: 'sub-1',
        preview_id: PORTRAIT_PREVIEW_ID,
        workspace_id: null,
      },
    ]);
    const result = await claimPreview(
      claimInput({ portraitPreviewId: PORTRAIT_PREVIEW_ID })
    );
    expect(db.rows('portrait_connections')[0]).toMatchObject({
      workspace_id: result.workspaceId,
    });
  });

  it('still claims the workspace when the portrait could not be carried', async () => {
    // A portrait that did not make the crossing is a site that falls back to
    // initials. It is not a reason to lose a workspace somebody is about to
    // pay against.
    vi.mocked(claimFunnelAssets).mockImplementationOnce(async () => {
      throw new Error('storage is having a day');
    });
    const result = await claimPreview(
      claimInput({ portraitPreviewId: PORTRAIT_PREVIEW_ID })
    );
    expect(result.workspaceId).toBeTruthy();
  });
});
