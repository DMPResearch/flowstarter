/**
 * What a client's plan lets them change themselves, and how much of it is left
 * this month.
 *
 * Pure on purpose: no database, no clock beyond the one it is handed. The edit
 * route, the editor page and the project page all have to agree about "46 of
 * 50 left", and three callers only agree if the arithmetic and the wording
 * live in one place all three import.
 *
 * WHY MONTHLY. The care plans sell a monthly number of edits (Starter 50, Pro
 * 150, see the pricing copy in landing-copy.ts), so the monthly allowance is
 * the promise the client paid for. The daily cap in `site-editor.ts` stays
 * exactly as it was: it is a burst guard against a stuck client or a stuck
 * script, not the thing anybody bought.
 *
 * WHY UTC. `workspaces` already accounts AI usage in UTC calendar months, and
 * a second, local-time notion of "this month" would mean two numbers that
 * disagree on the first of the month for anyone outside UTC.
 */

/** The canonical plan keys `workspaces.tier_name` is normalised onto. */
export type EditTierKey = 'starter' | 'pro' | 'max' | 'ecommerce' | 'admin';

/**
 * Edits included per UTC calendar month.
 *
 * Starter and Pro are the two numbers the marketing copy publishes. No number
 * is published for Max or Ecommerce, so both sit at the Pro figure until one
 * is: quietly giving a more expensive plan fewer edits than Pro would be the
 * one wrong answer. `admin` is us, and is not metered.
 */
export const MONTHLY_EDIT_ALLOWANCE: Record<EditTierKey, number | null> = {
  starter: 50,
  pro: 150,
  max: 150,
  ecommerce: 150,
  admin: null,
};

/**
 * The legacy `tier_name` values the column still accepts, mapped the same way
 * the billing webhook maps them.
 */
const LEGACY_TIERS: Record<string, EditTierKey> = {
  essential: 'starter',
  commerce: 'ecommerce',
  custom: 'admin',
};

const CANONICAL_TIERS = new Set<string>([
  'starter',
  'pro',
  'max',
  'ecommerce',
  'admin',
]);

/**
 * Null is the Starter floor, not an error and not unlimited.
 *
 * A workspace whose subscription ended has `tier_name` set back to null by the
 * Clerk webhook, and an unrecognised string is a column that drifted. Both
 * resolve to the smallest paid allowance, because the failure mode of guessing
 * high is giving away work and the failure mode of guessing low is a client
 * who is told to talk to us.
 */
export function normaliseTierKey(tier: string | null | undefined): EditTierKey {
  const key = (tier ?? '').trim().toLowerCase();
  if (CANONICAL_TIERS.has(key)) return key as EditTierKey;
  return LEGACY_TIERS[key] ?? 'starter';
}

/** Midnight on the first of the current month, UTC. */
export function startOfUtcMonth(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)
  ).toISOString();
}

/**
 * Midnight on the first of the next month, UTC, which is when the allowance
 * comes back. `Date.UTC` rolls month 12 into January of the next year on its
 * own, so December needs no special case.
 */
export function startOfNextUtcMonth(now: Date = new Date()): string {
  return new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1)
  ).toISOString();
}

export interface EditCreditPosition {
  tier: EditTierKey;
  /** Included edits plus any add-on pack, or null when the plan is unmetered. */
  allowance: number | null;
  used: number;
  /** Null when unmetered. Never negative: an overage is still "none left". */
  remaining: number | null;
  /** ISO instant the allowance resets, always the first of the next month. */
  resetsAt: string;
  exhausted: boolean;
}

export interface EditCreditInput {
  tier: string | null | undefined;
  usedThisMonth: number;
  /**
   * Extra edits bought on top of the plan. The copy sells add-on packs but
   * nothing sells them yet and no column holds them, so this is a number a
   * caller may pass and every caller currently passes 0. When a column
   * appears, it reads into here and nothing else changes.
   */
  addOnCredits?: number;
  now?: Date;
}

export function editCreditPosition({
  tier,
  usedThisMonth,
  addOnCredits = 0,
  now = new Date(),
}: EditCreditInput): EditCreditPosition {
  const key = normaliseTierKey(tier);
  const included = MONTHLY_EDIT_ALLOWANCE[key];
  const extra = Math.max(0, Math.trunc(addOnCredits));
  const allowance = included === null ? null : included + extra;
  const used = Math.max(0, Math.trunc(usedThisMonth));

  return {
    tier: key,
    allowance,
    used,
    remaining: allowance === null ? null : Math.max(0, allowance - used),
    resetsAt: startOfNextUtcMonth(now),
    exhausted: allowance !== null && used >= allowance,
  };
}

/**
 * "1 October". The day the client gets their edits back, in the words a client
 * would use for it rather than an ISO instant.
 */
export function formatResetDate(resetsAt: string): string {
  return new Intl.DateTimeFormat('en-GB', {
    day: 'numeric',
    month: 'long',
    timeZone: 'UTC',
  }).format(new Date(resetsAt));
}

/** The line the editor shows under the instruction box. */
export function editCreditsLine(position: EditCreditPosition): string {
  if (position.allowance === null) return 'Unlimited edits on your plan.';
  return (
    `${position.remaining} of ${position.allowance} edits left this month. ` +
    `Resets on ${formatResetDate(position.resetsAt)}.`
  );
}

/**
 * What the edit route says when there is nothing left. Plain, specific about
 * the number and the date, and it ends with a way out that is not a payment
 * page, because there is no add-on purchase path to send anyone to yet.
 */
export function creditsExhaustedMessage(position: EditCreditPosition): string {
  return (
    `You have used all ${position.allowance} edits in your plan this month. ` +
    `Your allowance resets on ${formatResetDate(position.resetsAt)}. ` +
    'Message us if you need more before then.'
  );
}
