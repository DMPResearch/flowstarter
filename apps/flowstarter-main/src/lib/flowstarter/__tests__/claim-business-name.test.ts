/**
 * The Onyx incident, replayed end to end at the payload level.
 *
 * A real visitor typed "Arome Coffee, a specialty roastery in Cluj" as their
 * "what you do" answer and pasted `https://onyxcoffeelab.com` as their one
 * link — a competitor's site, kept as a reference, never claimed as their
 * own. The old `deriveBusinessName` trusted every pasted website as "theirs"
 * and named the workspace "Onyxcoffeelab", slugged it `onyxcoffeelab-mhn89e`,
 * and the generated site introduced itself as "Onyx Coffee Lab": another
 * company's trademark, on a site we built and hosted.
 *
 * These cases run the fix through `claimPreview` itself — the one function
 * that turns a funnel answer set into a named, slugged workspace and an
 * artifacts row — rather than unit-testing `deriveBusinessName` in isolation,
 * so a regression in how the pieces are wired (not just the rule itself)
 * fails here too.
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

const savedArtifacts: Array<Record<string, unknown>> = [];
vi.mock('../preview-artifacts', () => ({
  savePreviewArtifacts: vi.fn(async (input: Record<string, unknown>) => {
    savedArtifacts.push(input);
    return { advanced: true };
  }),
  PreviewArtifactError: class extends Error {},
}));

import { claimPreview, rememberClaimablePreview } from '../claim';

const PREVIEW_ID = 'a1b2c3d4-2222-4222-8222-222222222222';
const ONYX_DESCRIPTION = 'Arome Coffee, a specialty roastery in Cluj';
const ONYX_REFERENCE_SITE = 'https://onyxcoffeelab.com';

const FILES = [
  { path: 'index.html', content: '<h1>Preview</h1>', type: 'file' as const },
];

/**
 * The preview as it existed the instant generation ran, with `business.name`
 * left exactly as the OLD, buggy rule would have derived it -- the hostname,
 * trusted unconditionally. Claim time is the authoritative naming moment, so
 * a claim has to correct this rather than merely agree with whatever
 * generation happened to freeze, which is what proves the fix is not just "a
 * lucky coincidence because both sides run the same buggy function".
 */
function onyxPreviewInput() {
  return {
    previewId: PREVIEW_ID,
    intake: {
      projectId: PREVIEW_ID,
      business: {
        name: 'Onyxcoffeelab',
        niche: 'Hospitality & food',
        location: 'Not provided',
        description: ONYX_DESCRIPTION,
        existingWebsiteUrl: ONYX_REFERENCE_SITE,
      },
      socialMedia: [],
      locale: 'en',
      submittedAt: new Date().toISOString(),
      consent: { publicProfileAnalysis: false, acceptedAt: '' },
    },
    brandConfig: { schemaVersion: '1.0' },
    template: { slug: 'hospitality-food', reason: 'fits' },
    files: FILES,
    previewUrl: 'https://sandbox.example.com',
  };
}

beforeEach(() => {
  db.reset();
  savedArtifacts.length = 0;
  vi.clearAllMocks();
});

describe('claimPreview — the Onyx transcript', () => {
  it('names the workspace "Arome Coffee", never the unconfirmed reference site', async () => {
    await rememberClaimablePreview(onyxPreviewInput() as never);

    const result = await claimPreview({
      previewId: PREVIEW_ID,
      clerkUserId: 'user_andrei',
      clientName: 'Andrei Ionescu',
      // No `businessName`: the quick intake never asked for one directly, the
      // same gap that made this rule matter in the first place.
      description: ONYX_DESCRIPTION,
      websiteUrl: ONYX_REFERENCE_SITE,
      // No `websiteIsOwnSite` either: the reference was never confirmed as
      // theirs, which is the honest state a real visitor who pasted a
      // competitor's site for reference, not for its address, was in.
      tier: 'pro',
    });

    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === result.workspaceId);
    expect(workspace?.name).toBe('Arome Coffee');
    expect(String(workspace?.slug)).toMatch(/^arome-coffee-/);
    expect(String(workspace?.slug)).not.toMatch(/onyx/i);

    // The generated site's title and the claim's workspace name read the
    // same derived value: both are "Arome Coffee", not the "Onyxcoffeelab"
    // the stale generation-time guess carried.
    expect(savedArtifacts).toHaveLength(1);
    const business = (
      savedArtifacts[0].intake as { business: { name: string } }
    ).business;
    expect(business.name).toBe('Arome Coffee');
    expect(business.name).not.toMatch(/onyx/i);
  });

  it('still prefers a name stated in the description over a website that IS confirmed as their own', async () => {
    // Not the Onyx case exactly, but the adjacent one a fix like this has to
    // get right too: even a visitor who *does* own the pasted site is named
    // from what they said they do, not from the domain, when both are given.
    const previewId = 'a1b2c3d4-4444-4444-8444-444444444444';
    await rememberClaimablePreview({
      ...onyxPreviewInput(),
      previewId,
    } as never);

    const result = await claimPreview({
      previewId,
      clerkUserId: 'user_own_site',
      clientName: 'Andrei Ionescu',
      description: ONYX_DESCRIPTION,
      websiteUrl: ONYX_REFERENCE_SITE,
      websiteIsOwnSite: 'yes',
      tier: 'pro',
    });

    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === result.workspaceId);
    expect(workspace?.name).toBe('Arome Coffee');
  });

  it('falls back to the visitor’s own name when neither a stated name nor a confirmed website is given', async () => {
    await rememberClaimablePreview({
      ...onyxPreviewInput(),
      previewId: 'a1b2c3d4-3333-4333-8333-333333333333',
    } as never);

    const result = await claimPreview({
      previewId: 'a1b2c3d4-3333-4333-8333-333333333333',
      clerkUserId: 'user_no_signal',
      clientName: 'Maria Popescu',
      description: '',
      tier: 'starter',
    });

    const workspace = db
      .rows('workspaces')
      .find((row) => row.id === result.workspaceId);
    expect(workspace?.name).toBe('Maria Popescu');
  });
});
