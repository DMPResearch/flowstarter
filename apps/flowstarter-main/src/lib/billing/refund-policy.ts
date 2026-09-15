/**
 * The refund guarantee, as a rule rather than a sentence.
 *
 * Two pages published this promise for months: the terms page ("If you are
 * not happy with the result within 30 days of launch, we refund 50% of the
 * setup fee, no questions asked") and the landing hero ("If you are not happy
 * within 30 days, we refund half your setup fee and you keep the work"). No
 * refund code existed anywhere in the app. `stripe.ts` said only "refunds
 * handled separately by the team via Stripe dashboard", and the operator
 * console's cancel dialog said "Refunds handled separately." Honouring a
 * published guarantee was a manual dashboard operation with no ledger, no
 * client email and no audit trail.
 *
 * This module is the single place the window and the percentage are stated.
 * The operator action reads it to decide what it is allowed to refund; the
 * landing copy and the terms page read it to say what we promise. They cannot
 * drift, because there is nothing to drift from.
 *
 * Both values are environment-overridable so the promise can be changed
 * without a deploy of new prose, and both default to exactly what was already
 * published, because a guarantee already made to real clients is not
 * something a refactor gets to quietly narrow.
 *
 * Pure: no Stripe client, no database, no `server-only`. The landing page
 * imports it into the browser bundle, and the amount rules below are the kind
 * of decision a test should be able to pin exhaustively without mocking
 * anything.
 */

/** Mirrors what terms and the landing hero have promised since launch. */
const DEFAULT_GUARANTEE_WINDOW_DAYS = 30;
const DEFAULT_GUARANTEE_PERCENT = 50;

type EnvLike = Record<string, string | undefined>;

export interface RefundGuarantee {
  /** Days after launch the no-questions-asked guarantee stays open. */
  windowDays: number;
  /** Percent of the agreed setup fee the guarantee returns. */
  percentOfSetupFee: number;
}

function positiveNumber(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw?.trim());
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

/**
 * The published guarantee.
 *
 * Read on every call rather than frozen at module load, so a test can set one
 * and a restarted process picks up a changed promise without a rebuild. A
 * percent above 100 is clamped: a guarantee cannot return more than the fee it
 * is a guarantee on, and a typo in an env file must not become an overpayment.
 *
 * Two names for each value, and the `NEXT_PUBLIC_` one is not decoration. The
 * refund action runs on the server, where `FLOWSTARTER_REFUND_*` is readable;
 * the landing copy is bundled for the browser, where Next replaces every
 * non-public `process.env` read with nothing. Changing only the server name
 * would move the amount the button sends without moving the sentence the
 * client read before they bought, which is the one divergence this whole
 * module exists to prevent. Set both, or set neither and take the published
 * defaults.
 */
export function refundGuarantee(
  env: EnvLike = process.env as EnvLike
): RefundGuarantee {
  return {
    windowDays: positiveNumber(
      env['FLOWSTARTER_REFUND_WINDOW_DAYS'] ??
        env['NEXT_PUBLIC_FLOWSTARTER_REFUND_WINDOW_DAYS'],
      DEFAULT_GUARANTEE_WINDOW_DAYS
    ),
    percentOfSetupFee: Math.min(
      100,
      positiveNumber(
        env['FLOWSTARTER_REFUND_PERCENT'] ??
          env['NEXT_PUBLIC_FLOWSTARTER_REFUND_PERCENT'],
        DEFAULT_GUARANTEE_PERCENT
      )
    ),
  };
}

/** The guarantee as the marketing copy and the terms page say it. */
export function guaranteeSentence(
  guarantee: RefundGuarantee = refundGuarantee()
): string {
  return (
    `If you are not happy with the result within ${guarantee.windowDays} ` +
    `days of launch, we refund ${guarantee.percentOfSetupFee}% of the setup ` +
    'fee, no questions asked, and you keep the work.'
  );
}

/** The shorter hero version of the same promise. */
export function guaranteeHeroSentence(
  guarantee: RefundGuarantee = refundGuarantee()
): string {
  return (
    `First month is free. If you are not happy within ${guarantee.windowDays} ` +
    `days, we refund ${guarantee.percentOfSetupFee}% of your setup fee and ` +
    'you keep the work.'
  );
}

// ─── The amount rule ────────────────────────────────────────────────────────

/** Refusing is a decision with a reason, not a thrown string. */
export type RefundRefusalCode =
  | 'reason_required'
  | 'not_launched'
  | 'window_closed'
  | 'nothing_refundable'
  | 'amount_above_remaining'
  | 'amount_not_guaranteed'
  | 'no_quote';

export type RefundVerdict =
  | {
      allowed: true;
      /** What may be refunded in total, smallest currency unit. */
      amountMinor: number;
      /** Which rule let it through. */
      basis: 'guarantee' | 'override';
    }
  | { allowed: false; code: RefundRefusalCode; message: string };

export interface RefundRequest {
  /** The agreed project price, smallest currency unit. */
  quoteMinor: number;
  /** What the client has actually paid us and not yet had back. */
  remainingRefundableMinor: number;
  /** When the site went live, ISO. Null when it never has. */
  launchedAt: string | null;
  /** Now, injected so the window rule is testable to the millisecond. */
  now: Date;
  /** Why. Always required, and stored on the ledger row. */
  reason: string;
  /**
   * An operator's stated reason for going outside the guarantee: a different
   * amount, a closed window, or a site that never launched. Its presence is
   * what turns a refusal into an `override`, and its absence is what keeps
   * the guarantee a rule rather than a suggestion.
   */
  overrideReason?: string | null;
  /**
   * An explicit amount in minor units. Under the guarantee it must equal the
   * guaranteed amount, so a mistyped figure is refused rather than paid; with
   * an override it may be anything up to what remains.
   */
  requestedAmountMinor?: number | null;
}

/** Shortest reason we will accept. Under this is not a reason, it is a key press. */
export const MIN_REASON_CHARS = 8;
/** Long enough for a paragraph, short enough to stay readable in a ledger row. */
export const MAX_REASON_CHARS = 500;

function refuse(code: RefundRefusalCode, message: string): RefundVerdict {
  return { allowed: false, code, message };
}

/** Whole days between two instants, floored. */
export function daysSince(from: Date, to: Date): number {
  const ms = to.getTime() - from.getTime();
  return Math.floor(ms / 86_400_000);
}

/**
 * What this operator is allowed to refund, and on what basis.
 *
 * Two paths, and the difference between them is the whole point:
 *
 *   The guarantee. The site launched, we are inside the window, and the
 *   amount is the published percentage of the agreed price. Nothing is
 *   negotiable here, including the amount: an operator who types a different
 *   figure is refused and told to state an override reason, because a
 *   "no questions asked" refund that quietly pays a different number than the
 *   one on the pricing page is not the thing that was promised.
 *
 *   The override. Anything else: outside the window, before launch, a
 *   different amount, a full refund. Allowed, but only with a written reason,
 *   which lands on the ledger row and in nothing else. That reason is the
 *   audit trail the Stripe dashboard never produced.
 *
 * Both are capped by what the client actually paid and has not already had
 * back, because Stripe will refuse anything more and a rule that lets an
 * operator ask for it has moved the failure to the worst possible place.
 */
export function decideRefund(
  input: RefundRequest,
  guarantee: RefundGuarantee = refundGuarantee()
): RefundVerdict {
  const reason = input.reason.trim();
  if (reason.length < MIN_REASON_CHARS) {
    return refuse(
      'reason_required',
      `Give a reason of at least ${MIN_REASON_CHARS} characters. It is stored ` +
        'with the refund and is the only record of why the money went back.'
    );
  }

  const remaining = Math.floor(input.remainingRefundableMinor);
  if (!Number.isFinite(remaining) || remaining <= 0) {
    return refuse(
      'nothing_refundable',
      'There is nothing left to refund on this workspace. Either no payment ' +
        'has settled yet, or every settled payment has already been refunded.'
    );
  }

  const override = input.overrideReason?.trim();
  const requested =
    typeof input.requestedAmountMinor === 'number' &&
    Number.isFinite(input.requestedAmountMinor)
      ? Math.floor(input.requestedAmountMinor)
      : null;

  if (override) {
    const amount = requested ?? remaining;
    if (amount <= 0) {
      return refuse(
        'nothing_refundable',
        'An override refund still has to be a positive amount.'
      );
    }
    if (amount > remaining) {
      return refuse(
        'amount_above_remaining',
        `That is more than the ${remaining} minor units still refundable on ` +
          'this workspace.'
      );
    }
    return { allowed: true, amountMinor: amount, basis: 'override' };
  }

  const quote = Math.floor(input.quoteMinor);
  if (!Number.isFinite(quote) || quote <= 0) {
    return refuse(
      'no_quote',
      'This workspace has no agreed price, so the guarantee has no percentage ' +
        'to take. Set the project value, or state an override reason and an ' +
        'amount.'
    );
  }

  if (!input.launchedAt) {
    return refuse(
      'not_launched',
      'The guarantee runs from launch and this site has not launched, so the ' +
        'window has not started. State an override reason to refund anyway.'
    );
  }
  const launched = new Date(input.launchedAt);
  if (Number.isNaN(launched.getTime())) {
    return refuse(
      'not_launched',
      'The launch date on this workspace could not be read, so the window ' +
        'cannot be measured. State an override reason to refund anyway.'
    );
  }
  const elapsed = daysSince(launched, input.now);
  if (elapsed > guarantee.windowDays) {
    return refuse(
      'window_closed',
      `The guarantee window is ${guarantee.windowDays} days and this site ` +
        `launched ${elapsed} days ago. State an override reason to refund ` +
        'anyway.'
    );
  }

  const guaranteed = Math.min(
    remaining,
    Math.round((quote * guarantee.percentOfSetupFee) / 100)
  );
  if (guaranteed <= 0) {
    return refuse(
      'nothing_refundable',
      'The guaranteed amount rounds to nothing on this project value.'
    );
  }
  if (requested !== null && requested !== guaranteed) {
    return refuse(
      'amount_not_guaranteed',
      `The guarantee refunds ${guaranteed} minor units on this project, not ` +
        `${requested}. State an override reason to refund a different amount.`
    );
  }

  return { allowed: true, amountMinor: guaranteed, basis: 'guarantee' };
}
