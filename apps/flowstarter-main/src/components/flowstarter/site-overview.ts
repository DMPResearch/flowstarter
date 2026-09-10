/**
 * What a client's own site is doing for them, as four or five small tiles.
 *
 * Rules, not rendering. Every decision about which tile appears, what number
 * it carries and which words go under it is made here, from data the page
 * already loaded, so the component underneath has nothing to decide and the
 * copy can be asserted without rendering anything.
 *
 * WHAT IS NOT HERE, AND WHY. There is no visitors tile and no orders tile.
 * Nothing in this product records a page view, and there is no orders table,
 * so either tile would be a number invented to fill a grid. A client acting on
 * a made-up figure is worse off than a client who was told nothing.
 *
 * EVERY NUMBER IS THIS WORKSPACE'S. The counts arrive from
 * `lib/flowstarter/site-overview-data.ts`, which filters every query by the
 * workspace the page already authorised.
 */
import {
  formatResetDate,
  normaliseTierKey,
  type EditCreditPosition,
} from '@/lib/flowstarter/edit-credits';

export type SiteOverviewTileKey =
  | 'credits'
  | 'enquiries'
  | 'bookings'
  | 'changes'
  | 'store';

/**
 * `attention` is "there is something for you to do", not "something is wrong",
 * and `muted` is "this is not switched on yet". Neither is an error state.
 */
export type SiteOverviewTone = 'ok' | 'attention' | 'muted';

export interface SiteOverviewTile {
  key: SiteOverviewTileKey;
  label: string;
  value: string;
  note: string;
  href?: string;
  tone: SiteOverviewTone;
}

export interface SiteOverviewInput {
  /** Whether anything is actually being served at a hostname yet. */
  live: boolean;
  /**
   * Where the live site is, when there is one. Carried because the page has it
   * and a tile may want to point at it; no rule reads it today.
   */
  siteHref?: string;
  /** Raw `workspaces.tier_name`, normalised here. */
  tier: string | null | undefined;
  credits: EditCreditPosition;
  enquiries: { total: number; last30Days: number; unread: number };
  edits: { appliedThisMonth: number };
  booking: { connected: boolean; href: string };
  store: { products: number };
  editorHref: string;
}

/**
 * The share of the monthly allowance below which the credits tile starts
 * asking for attention. A client who notices at five left can still plan the
 * month; a client who notices at zero has already been stopped.
 */
const LOW_CREDIT_SHARE = 0.1;

function plural(count: number, one: string, many: string): string {
  return `${count} ${count === 1 ? one : many}`;
}

export function siteOverviewTiles(
  input: SiteOverviewInput
): SiteOverviewTile[] {
  const tiles: SiteOverviewTile[] = [
    creditsTile(input),
    enquiriesTile(input),
    bookingsTile(input),
    changesTile(input),
  ];

  const store = storeTile(input);
  if (store) tiles.push(store);
  return tiles;
}

function creditsTile({
  credits,
  editorHref,
}: SiteOverviewInput): SiteOverviewTile {
  if (credits.allowance === null || credits.remaining === null) {
    return {
      key: 'credits',
      label: 'Edits',
      value: 'Unlimited',
      note: 'Your plan does not limit how much you change.',
      href: editorHref,
      tone: 'ok',
    };
  }

  const low =
    credits.remaining === 0 ||
    credits.remaining <= credits.allowance * LOW_CREDIT_SHARE;

  return {
    key: 'credits',
    label: 'Edits',
    value: `${credits.remaining} of ${credits.allowance}`,
    note: `Edits left this month. Resets on ${formatResetDate(
      credits.resetsAt
    )}.`,
    href: editorHref,
    tone: low ? 'attention' : 'ok',
  };
}

function enquiriesTile({
  live,
  enquiries,
}: SiteOverviewInput): SiteOverviewTile {
  // Before anything is served, a zero is a fact about the site not existing
  // yet, not a fact about how the business is doing. Say which one it is.
  if (!live) {
    return {
      key: 'enquiries',
      label: 'Enquiries',
      value: '0',
      note: 'Enquiries from your contact form will show here once your site is live.',
      tone: 'muted',
    };
  }

  const waiting =
    enquiries.unread > 0
      ? `${enquiries.unread} waiting for a reply`
      : 'none waiting for a reply';

  return {
    key: 'enquiries',
    label: 'Enquiries',
    value: String(enquiries.last30Days),
    note: `In the last 30 days. ${plural(
      enquiries.total,
      'enquiry',
      'enquiries'
    )} in total, ${waiting}.`,
    tone: enquiries.unread > 0 ? 'attention' : 'ok',
  };
}

function bookingsTile({ booking }: SiteOverviewInput): SiteOverviewTile {
  // There is no booking data to report: bookings happen inside Cal.com, and
  // the only thing this product knows is whether the link is set. So the tile
  // reports exactly that, rather than a count it cannot have.
  if (booking.connected) {
    return {
      key: 'bookings',
      label: 'Bookings',
      value: 'Connected',
      note: 'Bookings go straight to your Cal.com calendar.',
      href: booking.href,
      tone: 'ok',
    };
  }

  return {
    key: 'bookings',
    label: 'Bookings',
    value: 'Not set up',
    note: 'Connect your booking link so visitors can book you.',
    href: booking.href,
    tone: 'attention',
  };
}

function changesTile({
  edits,
  editorHref,
}: SiteOverviewInput): SiteOverviewTile {
  return {
    key: 'changes',
    label: 'Changes made',
    value: String(edits.appliedThisMonth),
    note: 'Changes you made in the editor this month.',
    href: editorHref,
    tone: 'ok',
  };
}

/**
 * Only for a shop. A catalogue tile on a plumber's brochure site is clutter,
 * so it appears for an Ecommerce plan (where an empty catalogue is a job to
 * finish) or for anyone who actually has products.
 */
function storeTile(input: SiteOverviewInput): SiteOverviewTile | null {
  const isShop = normaliseTierKey(input.tier) === 'ecommerce';
  if (!isShop && input.store.products === 0) return null;

  return {
    key: 'store',
    label: 'Your shop',
    value: String(input.store.products),
    note:
      input.store.products === 0
        ? 'No products in your catalogue yet.'
        : `${plural(
            input.store.products,
            'product',
            'products'
          )} in your catalogue.`,
    tone: input.store.products === 0 ? 'muted' : 'ok',
  };
}
