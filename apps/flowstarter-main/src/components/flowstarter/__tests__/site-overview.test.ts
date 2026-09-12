/**
 * The rules behind the "Your site" tiles.
 *
 * The cases that matter are the ones where a tile could lie: a zero that means
 * "no site yet" rendered as a zero that means "nobody got in touch", a shop
 * tile on a business with no shop, and a number the product does not have.
 */
import { describe, expect, it } from 'vitest';
import { editCreditPosition } from '@/lib/flowstarter/edit-credits';
import {
  siteOverviewTiles,
  type SiteOverviewInput,
  type SiteOverviewTileKey,
} from '../site-overview';

const NOW = new Date('2026-09-10T12:00:00Z');
const EDITOR = '/dashboard/projects/ws-1/editor';
const BOOKING = '/dashboard/projects/ws-1/booking';

function input(overrides: Partial<SiteOverviewInput> = {}): SiteOverviewInput {
  return {
    live: true,
    tier: 'starter',
    credits: editCreditPosition({
      tier: 'starter',
      usedThisMonth: 4,
      now: NOW,
    }),
    enquiries: { total: 12, last30Days: 5, unread: 3 },
    edits: { appliedThisMonth: 2 },
    booking: {
      connected: true,
      href: BOOKING,
      upcoming: 2,
      nextAt: '2026-09-15T09:30:00.000Z',
      last30Days: 6,
    },
    store: { products: 0 },
    editorHref: EDITOR,
    ...overrides,
  };
}

function tile(
  key: SiteOverviewTileKey,
  overrides?: Partial<SiteOverviewInput>
) {
  return siteOverviewTiles(input(overrides)).find((one) => one.key === key);
}

describe('which tiles appear, and in what order', () => {
  it('leads with the allowance, then the things the site does', () => {
    expect(siteOverviewTiles(input()).map((one) => one.key)).toEqual([
      'credits',
      'enquiries',
      'bookings',
      'changes',
    ]);
  });

  it('never invents a visitors or orders tile', () => {
    const keys = siteOverviewTiles(
      input({ tier: 'ecommerce', store: { products: 9 } })
    ).map((one) => one.key);
    expect(keys).not.toContain('visitors');
    expect(keys).not.toContain('orders');
  });
});

describe('the edits tile', () => {
  it('shows what is left and when it comes back', () => {
    expect(tile('credits')).toMatchObject({
      value: '46 of 50',
      note: 'Edits left this month. Resets on 1 October.',
      href: EDITOR,
      tone: 'ok',
    });
  });

  it('asks for attention while there is still time to act on it', () => {
    expect(
      tile('credits', {
        credits: editCreditPosition({
          tier: 'starter',
          usedThisMonth: 45,
          now: NOW,
        }),
      })
    ).toMatchObject({ value: '5 of 50', tone: 'attention' });
  });

  it('asks for attention when there is nothing left', () => {
    expect(
      tile('credits', {
        credits: editCreditPosition({
          tier: 'starter',
          usedThisMonth: 80,
          now: NOW,
        }),
      })
    ).toMatchObject({ value: '0 of 50', tone: 'attention' });
  });

  it('counts nothing on an unmetered plan', () => {
    expect(
      tile('credits', {
        tier: 'admin',
        credits: editCreditPosition({
          tier: 'admin',
          usedThisMonth: 400,
          now: NOW,
        }),
      })
    ).toMatchObject({ value: 'Unlimited', tone: 'ok' });
  });
});

describe('the enquiries tile', () => {
  it('says why it is empty before the site is live', () => {
    expect(tile('enquiries', { live: false })).toMatchObject({
      value: '0',
      note: 'Enquiries from your contact form will show here once your site is live.',
      tone: 'muted',
    });
  });

  it('does not report a stale count from a site nobody can reach', () => {
    expect(
      tile('enquiries', {
        live: false,
        enquiries: { total: 12, last30Days: 5, unread: 3 },
      })?.value
    ).toBe('0');
  });

  it('counts the last thirty days and says how many are waiting', () => {
    expect(tile('enquiries')).toMatchObject({
      value: '5',
      note: 'In the last 30 days. 12 enquiries in total, 3 waiting for a reply.',
      tone: 'attention',
    });
  });

  it('settles down once every enquiry has been answered', () => {
    expect(
      tile('enquiries', {
        enquiries: { total: 4, last30Days: 1, unread: 0 },
      })
    ).toMatchObject({
      note: 'In the last 30 days. 4 enquiries in total, none waiting for a reply.',
      tone: 'ok',
    });
  });

  it('links where it was given a link, live or not', () => {
    // Not live is the state a client is most likely to click from: the tile
    // is telling them nothing has arrived, and the next question is where the
    // form even posts.
    expect(
      tile('enquiries', {
        live: false,
        enquiries: { total: 0, last30Days: 0, unread: 0, href: '/e' },
      })?.href
    ).toBe('/e');
    expect(
      tile('enquiries', {
        enquiries: { total: 12, last30Days: 5, unread: 3, href: '/e/list' },
      })?.href
    ).toBe('/e/list');
  });

  it('carries no link when it was given none', () => {
    expect(tile('enquiries')?.href).toBeUndefined();
    expect(tile('enquiries', { live: false })?.href).toBeUndefined();
  });

  it('says "1 enquiry", not "1 enquiries"', () => {
    expect(
      tile('enquiries', { enquiries: { total: 1, last30Days: 1, unread: 1 } })
        ?.note
    ).toBe('In the last 30 days. 1 enquiry in total, 1 waiting for a reply.');
  });

  it('offers no link, because there is no enquiries page to send anyone to', () => {
    expect(tile('enquiries')?.href).toBeUndefined();
  });
});

describe('the bookings tile', () => {
  it('counts what is coming up and says when the next one is', () => {
    expect(tile('bookings')).toMatchObject({
      value: '2',
      note: 'Coming up. Next on 15 Sep. 6 bookings in the last 30 days.',
      href: BOOKING,
      tone: 'ok',
    });
  });

  it('says one booking, not 1 bookings', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: true,
          href: BOOKING,
          upcoming: 1,
          nextAt: '2026-09-11T18:00:00.000Z',
          last30Days: 1,
        },
      })
    ).toMatchObject({
      value: '1',
      note: 'Coming up. Next on 11 Sep. 1 booking in the last 30 days.',
    });
  });

  it('asks the client to finish the setup when the link is missing', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: false,
          href: BOOKING,
          upcoming: 0,
          nextAt: null,
          last30Days: 0,
        },
      })
    ).toMatchObject({
      value: 'Not set up',
      note: 'Connect your booking link so visitors can book you.',
      href: BOOKING,
      tone: 'attention',
    });
  });

  // The case the old tile could not tell apart: a calendar nobody has hooked
  // up and a calendar nobody has booked are different facts about a business.
  it('separates a connected but empty calendar from an unconnected one', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: true,
          href: BOOKING,
          upcoming: 0,
          nextAt: null,
          last30Days: 0,
        },
      })
    ).toMatchObject({
      value: '0',
      note: 'Nothing booked yet. Your calendar is connected and taking bookings.',
      tone: 'muted',
    });
  });

  it('still credits the last 30 days when the diary ahead is empty', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: true,
          href: BOOKING,
          upcoming: 0,
          nextAt: null,
          last30Days: 4,
        },
      })
    ).toMatchObject({
      value: '0',
      note: 'Nothing coming up. 4 bookings in the last 30 days.',
      tone: 'muted',
    });
  });

  // A start time we were not sent must never render as "Invalid Date".
  it('does not print a broken date when the start time is missing', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: true,
          href: BOOKING,
          upcoming: 1,
          nextAt: null,
          last30Days: 0,
        },
      })?.note
    ).toBe(
      'Coming up. Next on a date we were not sent. 0 bookings in the last 30 days.'
    );
  });

  it('does not print a broken date when the start time is nonsense', () => {
    expect(
      tile('bookings', {
        booking: {
          connected: true,
          href: BOOKING,
          upcoming: 1,
          nextAt: 'whenever',
          last30Days: 0,
        },
      })?.note
    ).toBe(
      'Coming up. Next on a date we were not sent. 0 bookings in the last 30 days.'
    );
  });
});

describe('the changes tile', () => {
  it('counts the changes the client actually kept this month', () => {
    expect(tile('changes', { edits: { appliedThisMonth: 7 } })).toMatchObject({
      value: '7',
      note: 'Changes you made in the editor this month.',
      href: EDITOR,
    });
  });
});

describe('the shop tile', () => {
  it('stays away from a business that does not sell anything', () => {
    expect(tile('store', { tier: 'starter', store: { products: 0 } })).toBe(
      undefined
    );
  });

  it('appears for an ecommerce plan even before the catalogue is filled', () => {
    expect(
      tile('store', { tier: 'ecommerce', store: { products: 0 } })
    ).toMatchObject({ value: '0', tone: 'muted' });
  });

  it('appears for the legacy commerce tier too', () => {
    expect(
      tile('store', { tier: 'commerce', store: { products: 0 } })
    ).toBeDefined();
  });

  it('appears for anyone who has products, whatever their plan says', () => {
    expect(
      tile('store', { tier: 'pro', store: { products: 3 } })
    ).toMatchObject({
      value: '3',
      note: '3 products in your catalogue.',
      tone: 'ok',
    });
  });

  it('says "1 product", not "1 products"', () => {
    expect(tile('store', { tier: 'pro', store: { products: 1 } })?.note).toBe(
      '1 product in your catalogue.'
    );
  });
});

describe('the words a client reads', () => {
  it('never shows a column name or a plan enum', () => {
    const text = siteOverviewTiles(
      input({ tier: 'ecommerce', store: { products: 2 } })
    )
      .flatMap((one) => [one.label, one.value, one.note])
      .join(' ');
    expect(text).not.toMatch(
      /tier_name|workspace_id|site_edit|cal_com_url|ecommerce|status/i
    );
  });
});
