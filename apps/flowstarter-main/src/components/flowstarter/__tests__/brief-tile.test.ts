/**
 * The "Your brief" tile.
 *
 * A separate file from `site-overview.test.ts` only because that suite belongs
 * to the tiles that were already there. The rules under test are the same kind:
 * what the tile says, and when it says nothing at all.
 *
 * The one that matters is the omission. A workspace whose page never loaded a
 * brief row gets no tile, because "0 of 5" invented from an absent row would
 * be a made-up number in the one place a client is told what is left to do.
 */
import { describe, expect, it } from 'vitest';
import { siteOverviewTiles, type SiteOverviewInput } from '../site-overview';
import { evaluateBriefReadiness } from '@/lib/flowstarter/brief-readiness';

const WORKSPACE = '0f4e1088-8d8f-4f18-83b1-406cc292b23c';
const HREF = `/dashboard/projects/${WORKSPACE}/brief`;

const GOOD_OFFER =
  'We fit and service gas boilers for homes across the county, and we take on ' +
  'the emergency call-outs nobody else will.';

function input(overrides: Partial<SiteOverviewInput> = {}): SiteOverviewInput {
  return {
    live: true,
    tier: 'starter',
    credits: {
      tier: 'starter',
      allowance: 20,
      remaining: 15,
      used: 5,
      resetsAt: '2026-10-01T00:00:00.000Z',
      exhausted: false,
    },
    enquiries: { total: 0, last30Days: 0, unread: 0 },
    edits: { appliedThisMonth: 0 },
    booking: {
      connected: false,
      href: '/booking',
      upcoming: 0,
      nextAt: null,
      last30Days: 0,
    },
    store: { products: 0 },
    editorHref: '/editor',
    ...overrides,
  };
}

/** The real rule, so no fixture here is a hand-written fiction. */
function readiness(overrides: Parameters<typeof evaluateBriefReadiness>[0]) {
  return evaluateBriefReadiness(overrides);
}

function briefTile(brief?: SiteOverviewInput['brief']) {
  return siteOverviewTiles(input({ brief })).find(
    (tile) => tile.key === 'brief'
  );
}

describe('the brief tile', () => {
  it('is omitted when the page did not load a brief', () => {
    expect(briefTile(undefined)).toBeUndefined();
  });

  it('leaves the tiles that were already there alone', () => {
    expect(siteOverviewTiles(input()).map((tile) => tile.key)).toEqual([
      'credits',
      'enquiries',
      'bookings',
      'changes',
    ]);
  });

  it('counts how far the brief has got and names the next two asks', () => {
    const tile = briefTile({
      href: HREF,
      readiness: readiness({ offer: '', projects: [], noProjects: false }),
    });
    expect(tile?.label).toBe('Your brief');
    expect(tile?.value).toBe('0 of 5');
    expect(tile?.note).toBe(
      'Still to send: what you offer, your products or projects.'
    );
    expect(tile?.href).toBe(HREF);
    // Nothing is built until this is done, so it is something to do.
    expect(tile?.tone).toBe('attention');
  });

  it('names what is blocking before what merely helps', () => {
    const tile = briefTile({
      href: HREF,
      readiness: readiness({ offer: '', projects: [], noProjects: true }),
    });
    // `noProjects` answers the projects ask, so the next two are the offer
    // (blocking) and then the first degrading one, in the rule's own order.
    expect(tile?.value).toBe('1 of 5');
    expect(tile?.note).toBe(
      'Still to send: what you offer, photos for your site.'
    );
  });

  it('says so plainly once nothing is outstanding', () => {
    const tile = briefTile({
      href: HREF,
      readiness: readiness({
        offer: GOOD_OFFER,
        projects: [],
        noProjects: true,
        designReferenceAssetIds: ['reference'],
        photos: [
          {
            assetId: 'one',
            kind: 'portrait',
            width: 2400,
            height: 1600,
            rightsConfirmed: true,
          },
          {
            assetId: 'two',
            kind: null,
            width: 2400,
            height: 1600,
            rightsConfirmed: true,
          },
        ],
      }),
    });
    expect(tile?.value).toBe('Complete');
    expect(tile?.note).toBe(
      'Everything we need is in. Your build is made from this.'
    );
    expect(tile?.tone).toBe('ok');
  });
});
