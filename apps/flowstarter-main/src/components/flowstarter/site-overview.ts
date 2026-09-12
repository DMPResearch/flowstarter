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
import type {
  BriefMissingCode,
  BriefReadiness,
} from '@/lib/flowstarter/brief-readiness';

export type SiteOverviewTileKey =
  | 'credits'
  | 'enquiries'
  | 'bookings'
  | 'changes'
  | 'brief'
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
  enquiries: {
    total: number;
    last30Days: number;
    unread: number;
    /**
     * Where the tile goes. Optional so an existing caller keeps working, and
     * a tile with no link is still a true tile.
     */
    href?: string;
  };
  edits: { appliedThisMonth: number };
  /**
   * `connected` is whether a Cal.com link is saved; the three numbers come
   * from `workspace_bookings`, which only the signed Cal.com webhook writes.
   * `nextAt` is the start of the soonest upcoming booking, ISO, or null.
   */
  booking: {
    connected: boolean;
    href: string;
    upcoming: number;
    nextAt: string | null;
    last30Days: number;
  };
  store: { products: number };
  editorHref: string;
  /**
   * The in-depth brief, when the page that built this input loaded one.
   *
   * Optional, and the tile is omitted when it is absent, because a brief tile
   * that guessed at "0% complete" for a workspace nobody has read the row for
   * would be a made-up number in the one place a client is told what is left
   * to do. `readiness` is `evaluateBriefReadiness`'s own verdict, passed
   * through rather than recomputed, so this tile and the brief page can never
   * disagree about what is outstanding.
   */
  brief?: { href: string; readiness: BriefReadiness };
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

  const brief = briefTile(input);
  if (brief) tiles.push(brief);

  const store = storeTile(input);
  if (store) tiles.push(store);
  return tiles;
}

/**
 * The subject of each ask, in two or three words.
 *
 * `BRIEF_MISSING_MESSAGES` is a paragraph per code, which is right on the
 * brief page where the client is being asked for the thing and wrong in a tile
 * that has one line. Same codes, shorter words, and exhaustive so a new code
 * cannot quietly go unnamed here.
 */
const BRIEF_SUBJECTS: Record<BriefMissingCode, string> = {
  brief_offer_missing: 'what you offer',
  brief_offer_thin: 'more on what you offer',
  brief_projects_unanswered: 'your products or projects',
  brief_project_unnamed: 'a name on every project',
  brief_project_screenshots_missing: 'screenshots of your projects',
  brief_photos_missing: 'photos for your site',
  brief_portrait_missing: 'a portrait of you',
  brief_design_reference_missing: 'a site you like the look of',
};

/** The five things a complete brief has; `completeness` is the share of them. */
const BRIEF_PARTS = 5;

/**
 * How far the brief has got, and the next thing it is waiting on.
 *
 * Blocking items are named before the ones that merely make the site better,
 * because the first sort is what holds the build up and the second sort is
 * not. At most two are named: a tile that lists five asks is a tile nobody
 * reads, and the brief page itself carries the full list.
 */
function briefTile(input: SiteOverviewInput): SiteOverviewTile | null {
  if (!input.brief) return null;
  const { href, readiness } = input.brief;

  if (readiness.ready) {
    return {
      key: 'brief',
      label: 'Your brief',
      value: 'Complete',
      note: 'Everything we need is in. Your build is made from this.',
      href,
      tone: 'ok',
    };
  }

  const ordered = [
    ...readiness.missing.filter((entry) => entry.severity === 'blocking'),
    ...readiness.missing.filter((entry) => entry.severity !== 'blocking'),
  ];
  const named = ordered.slice(0, 2).map((entry) => BRIEF_SUBJECTS[entry.code]);
  const done = Math.round(readiness.completeness * BRIEF_PARTS);

  return {
    key: 'brief',
    label: 'Your brief',
    value: `${done} of ${BRIEF_PARTS}`,
    note:
      named.length > 0
        ? `Still to send: ${named.join(', ')}.`
        : 'A few more details before your build can start.',
    href,
    // Something for the client to do, and until it is done nothing is built.
    tone: 'attention',
  };
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
      ...(enquiries.href ? { href: enquiries.href } : {}),
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
    ...(enquiries.href ? { href: enquiries.href } : {}),
    tone: enquiries.unread > 0 ? 'attention' : 'ok',
  };
}

/**
 * The tile used to say "Connected" or "Not set up", because bookings happened
 * inside Cal.com and this product knew nothing but whether a link was saved.
 * Cal.com's webhook now writes each booking to `workspace_bookings`, so the
 * tile can carry the number it always should have.
 *
 * Three states, and the middle one matters most. A connected calendar with
 * nothing on it is not the same as a calendar nobody has hooked up, and a
 * client who sees "0" with no explanation reads it as "the site is not
 * working". Say which it is.
 */
function bookingsTile({ booking }: SiteOverviewInput): SiteOverviewTile {
  if (!booking.connected) {
    return {
      key: 'bookings',
      label: 'Bookings',
      value: 'Not set up',
      note: 'Connect your booking link so visitors can book you.',
      href: booking.href,
      tone: 'attention',
    };
  }

  if (booking.upcoming === 0) {
    return {
      key: 'bookings',
      label: 'Bookings',
      value: '0',
      note:
        booking.last30Days > 0
          ? `Nothing coming up. ${plural(
              booking.last30Days,
              'booking',
              'bookings'
            )} in the last 30 days.`
          : 'Nothing booked yet. Your calendar is connected and taking bookings.',
      href: booking.href,
      tone: 'muted',
    };
  }

  return {
    key: 'bookings',
    label: 'Bookings',
    value: String(booking.upcoming),
    note: `Coming up. Next on ${formatBookingDay(booking.nextAt)}. ${plural(
      booking.last30Days,
      'booking',
      'bookings'
    )} in the last 30 days.`,
    href: booking.href,
    tone: 'ok',
  };
}

/**
 * The day a booking falls on, written the same way on every machine.
 *
 * Spelled out rather than handed to `toLocaleDateString`, and fixed to UTC.
 * Two reasons, and the second is the one that bit: this string is produced on
 * the server, where there is no reader whose locale it could follow, and
 * `Intl`'s abbreviations move with the ICU build, so the same code says "Sep"
 * on one Node and "Sept" on the next. A tile whose copy depends on which
 * runtime CI happened to pull is a tile whose copy cannot be asserted.
 */
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
];

function formatBookingDay(startAt: string | null): string {
  if (!startAt) return 'a date we were not sent';
  const parsed = Date.parse(startAt);
  if (Number.isNaN(parsed)) return 'a date we were not sent';
  const date = new Date(parsed);
  return `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]}`;
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
